// T50 · 笔记本导出：Markdown → 自包含 HTML（单篇 / 整本 / 打印为 PDF）。
//
// 为什么默认是 HTML 而不是 .docx：
//  · 用户要的是"能直接看和分享的成品"，HTML + 浏览器打印能拿到版式 100% 一致的结果；
//  · T60 起另有「导出为 Markdown」：不作为成品，而是交接 / 迁移时拿到原文（不过本管线）；
//  · .docx 需要引入一个转换库，而它只能把结构化 HTML 压成 Word 的段落流：
//    表格、任务列表、mermaid 图（还得先位图化）都会走形。同一个需求，
//    HTML + 浏览器打印（= PDF）能拿到版式 100% 一致的结果，且零新依赖。
//
// 三条硬约束：
//  1) **自包含**：不引任何外链 CSS/JS/图片。图片按 assets/ 引用读出来转 data URI，
//     mermaid 代码块渲染成内联 SVG——把 .html 发给别人，双击就能看，图不会碎。
//  2) **与编辑器同一套 schema**：Markdown → HTML 走 tiptap 的 `getHTML()`，
//     不另写一个 markdown 渲染器（两套解析器迟早会在表格、任务列表、软换行上分叉）。
//  3) **样式字面量**：导出文件脱离应用运行，拿不到 `--oe-*` 变量，颜色与字体栈一律写死。
//
// 图片宽度有个不显眼的坑：编辑器里存的是 `<img width="62%">`，而 HTML 的 width 属性
// 只接受像素（百分比被浏览器当非法值忽略）→ 导出时必须改写成 `style="width:62%"`。
// 少了这一步，所有手动缩放过的大图在导出文件里都会变成原尺寸。

import { Editor } from '@tiptap/core'

import { createNoteExtensions } from './NoteEditor'
import type { NoteAssetsPort } from './NoteEditor'
import { triggerDownload } from './GanttExporter'
import { renderMermaidSvg, scopeSvgIds } from './mermaid'
import { highlightCode, tokenClassNames } from '../domain/codeHighlight'

/** 与 GanttExporter / mermaid 同一套字体栈：导出文件不引 webfont。 */
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

export interface ExportDocInput {
  title: string
  content: string
  /** 文档树深度（0 = 顶层）。整本导出时用来生成缩进目录与标题层级。 */
  depth: number
}

export interface NotebookExportMeta {
  /** 来源应用名（页脚那句"由 OffEarly 导出"）。 */
  appName: string
  /** 导出时间，`YYYY-MM-DD HH:mm`（调用方给，测试才能确定化）。 */
  exportedAt: string
  kind: 'doc' | 'notebook'
  /** 整本导出时的笔记本名（单篇导出省略）。 */
  notebookName?: string
  /** 语言，只影响 `<html lang>`。 */
  locale: 'zh' | 'en'
  /** 界面上的一句话说明（导出文件里不出现 UI 文案，这里只用于打印按钮与空态）。 */
  labels?: {
    print: string
    empty: string
    exportedAt: string
    notebook: string
  }
}

export interface NotebookExportRequest {
  docs: readonly ExportDocInput[]
  meta: NotebookExportMeta
  /**
   * `assets/<id>.<ext>` → data URI。读不到时返回 null（保留相对路径，
   * 让文件至少还能在同目录有 assets/ 的情况下打开——总比碎图强）。
   */
  resolveAsset?: (src: string) => Promise<string | null>
}

/** 文件名消毒：去掉各平台的非法字符，保留中文（用户库里的标题就是中文）。 */
export function sanitizeExportFilename(name: string, fallback = 'note'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (cleaned === '') return fallback
  // 各平台都对超长文件名不友好；留 80 字符余量足够表达标题
  return cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned
}

/** HTML 实体还原：mermaid 里 `A --> B` 会被序列化成 `A --&gt; B`，不还原就渲染失败。 */
export function unescapeHtmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Markdown → HTML，复用编辑器的 schema（表格 / 任务列表 / 双链 / 图片宽度都在里面）。
 * 不需要 DOM 容器：tiptap 允许无 element 的 Editor（`getHTML()` 只读 schema）。
 */
export function markdownToExportHtml(markdown: string): string {
  if (markdown.trim() === '') return ''
  const editor = new Editor({
    extensions: createNoteExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
  try {
    return editor.getHTML()
  } finally {
    editor.destroy()
  }
}

/**
 * `<img width="62%">` → `<img style="width:62%">`。
 * HTML 的 width 属性只认像素，百分比会被浏览器丢弃（见文件头注释）。
 */
export function restoreImageWidths(html: string): string {
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    const matched = /\swidth="(\d{1,3})%"/.exec(tag)
    if (matched === null) return tag
    const percent = Math.min(100, Math.max(1, Number(matched[1])))
    const without = tag.replace(/\swidth="\d{1,3}%"/, '')
    return without.replace(/\s*\/?>$/, ` style="width:${percent}%;max-width:100%;height:auto">`)
  })
}

/**
 * T63 · 代码块着色：在导出 HTML 上把 `<pre><code>` 的内容重新拼成带 span 的版本。
 *
 * 为什么不在编辑器里取现成的：着色是 ProseMirror 的 inline decoration，**只存在于视图**，
 * `getHTML()` 拿到的是干净文本。而导出的文件是要发出去给人读的，
 * 所以这里必须再走一遍同一份 `highlightCode()`——两处共用扫描器，配色共用类名。
 */
function highlightCodeBlocks(html: string): string {
  return html.replace(
    /<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
    (match, attributes: string, inner: string) => {
      const language = /\blanguage-([\w+#-]+)/.exec(attributes)?.[1] ?? null
      const code = unescapeHtmlText(inner)
      const tokens = highlightCode(code, language)
      if (tokens.length === 0) return match
      const parts: string[] = []
      let cursor = 0
      for (const token of tokens) {
        if (token.from > cursor) parts.push(escapeHtml(code.slice(cursor, token.from)))
        parts.push(`<span class="${tokenClassNames(token.cls)}">${escapeHtml(code.slice(token.from, token.to))}</span>`)
        cursor = token.to
      }
      if (cursor < code.length) parts.push(escapeHtml(code.slice(cursor)))
      return `<pre><code${attributes}>${parts.join('')}</code></pre>`
    },
  )
}

/** 双链在导出文件里没有可跳的目标：退化成普通文字，别留一个点了没反应的标记。 */export function flattenWikiLinks(html: string): string {
  return html.replace(
    /<span[^>]*data-wiki-target="([^"]*)"[^>]*>\[\[([\s\S]*?)\]\]<\/span>/g,
    (_match, target: string) => `<span class="wiki">${unescapeHtmlText(target)}</span>`,
  )
}

/**
 * 正文开头的 H1 如果就是文档标题，导出时剥掉。
 *
 * 编辑器里「标题输入框 + 正文 H1」并排是有意义的（一个是元数据、一个是排版）；
 * 导出后页头已经写着标题，再来一行同名的特大号字就是重复（实测截图里非常显眼）。
 * 只剥第一处、且必须完全相同：正文里后面的同名 H1 是章节分隔，动它就是改内容。
 */
export function stripLeadingHeading(html: string, title: string): string {
  const trimmed = html.trimStart()
  const matched = /^<h1[^>]*>([\s\S]*?)<\/h1>\s*/.exec(trimmed)
  if (matched === null) return html
  const text = unescapeHtmlText(matched[1] ?? '')
    .replace(/<[^>]+>/g, '')
    .trim()
  if (text !== title.trim()) return html
  return trimmed.slice(matched[0].length)
}

/** 把 assets/ 图片内联成 data URI（自包含的唯一办法）。 */
export async function inlineAssetImages(
  html: string,
  resolve?: (src: string) => Promise<string | null>,
): Promise<string> {
  if (resolve === undefined) return html
  const sources = new Set<string>()
  for (const matched of html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/g)) {
    const src = matched[1]
    if (src !== undefined && src.startsWith('assets/')) sources.add(src)
  }
  if (sources.size === 0) return html
  const resolved = new Map<string, string>()
  for (const src of sources) {
    const dataUrl = await resolve(src).catch(() => null)
    if (dataUrl !== null && dataUrl !== '') resolved.set(src, dataUrl)
  }
  let out = html
  for (const [src, dataUrl] of resolved) {
    out = out.split(`src="${src}"`).join(`src="${dataUrl}"`)
  }
  return out
}

const MERMAID_PATTERN =
  /<pre><code[^>]*class="[^"]*language-(?:mermaid|mmd)[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/g

/**
 * 导出的图是**真 SVG**（不是截图）：矢量、可打印、体积远小于 PNG。
 * 渲染失败时保留原始代码块——导出文件里能看见"这段图画不出来"，比悄悄消失好。
 */
export async function renderMermaidInHtml(html: string): Promise<string> {
  const blocks = [...html.matchAll(MERMAID_PATTERN)]
  if (blocks.length === 0) return html
  const rendered: string[] = []
  for (const [index, block] of blocks.entries()) {
    const code = unescapeHtmlText(block[1] ?? '')
    const result = await renderMermaidSvg(code)
    if (!result.ok) {
      rendered.push(block[0] ?? '')
      continue
    }
    rendered.push(
      `<figure class="diagram">${scopeSvgIds(result.svg, `export-${index}`)}</figure>`,
    )
  }
  let cursor = 0
  return html.replace(MERMAID_PATTERN, () => {
    const next = rendered[cursor] ?? ''
    cursor += 1
    return next
  })
}

/** 一遍处理完：宽度还原 → 双链降级 → 标题去重 → mermaid 渲染 → 图片内联。顺序有依赖，别换。 */
export async function transformDocHtml(
  markdown: string,
  resolve?: (src: string) => Promise<string | null>,
  title?: string,
): Promise<string> {
  let html = markdownToExportHtml(markdown)
  html = flattenWikiLinks(html)
  html = restoreImageWidths(html)
  // 着色放在 mermaid 之前：mermaid 围栏不是它的语言，扫描器会原样放过，
  // 而 mermaid 替换靠的是「干净的 `<pre><code class="language-mermaid">`」这条正则。
  html = highlightCodeBlocks(html)
  if (title !== undefined) html = stripLeadingHeading(html, title)
  html = await renderMermaidInHtml(html)
  html = await inlineAssetImages(html, resolve)
  return html
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 导出文件的排版：与 `.oe-prose` 同一套比例，但颜色/字体全部写成字面量。 */
const EXPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #f4f5f8; }
body {
  font-family: ${FONT_STACK};
  color: #1d1d1f;
  font-size: 15px;
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
.page {
  max-width: 780px;
  margin: 32px auto 64px;
  padding: 40px 48px 36px;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 14px;
}
.page-head { border-bottom: 1px solid rgba(0, 0, 0, 0.07); padding-bottom: 16px; margin-bottom: 22px; }
.doc-title { font-size: 26px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.3; }
.doc-meta { margin-top: 6px; font-size: 12px; color: #98989d; }
.toc { margin: 0 0 26px; padding: 12px 16px; background: #f7f7fa; border-radius: 10px; font-size: 13px; }
.toc-head { font-size: 11px; font-weight: 650; letter-spacing: 0.04em; color: #98989d; text-transform: uppercase; margin-bottom: 6px; }
.toc a { color: #5e5ce6; text-decoration: none; }
.toc a:hover { text-decoration: underline; }
.toc li { list-style: none; margin: 3px 0; }
.toc ul { margin: 0; padding: 0; }
.doc-section + .doc-section { margin-top: 34px; padding-top: 26px; border-top: 1px solid rgba(0, 0, 0, 0.07); }
.doc-section-title { font-size: 20px; font-weight: 650; margin: 0 0 10px; line-height: 1.35; }
.doc-section[data-depth='1'] .doc-section-title { font-size: 17px; color: #3a3a3c; }
.doc-section[data-depth='2'] .doc-section-title { font-size: 16px; color: #3a3a3c; }
.note p { margin: 0; }
.note > * + * { margin-top: 0.72em; }
.note h1, .note h2, .note h3, .note h4, .note h5, .note h6 { margin: 0; font-weight: 650; line-height: 1.35; }
.note h1 { font-size: 1.45em; letter-spacing: -0.01em; }
.note h2 { font-size: 1.22em; }
.note h3 { font-size: 1.08em; }
.note h4, .note h5, .note h6 { font-size: 1em; color: #3a3a3c; }
.note ul, .note ol { margin: 0; padding-left: 1.5em; }
.note li { margin: 0.2em 0; }
.note li::marker { color: #98989d; }
.note li > p { margin: 0; }
.note blockquote { margin: 0; padding: 0.1em 0 0.1em 0.9em; border-left: 3px solid rgba(0, 0, 0, 0.12); color: #3a3a3c; }
.note code { font-family: ${MONO_STACK}; font-size: 0.9em; padding: 0.1em 0.35em; background: rgba(120, 120, 128, 0.12); border-radius: 4px; }
.note pre { margin: 0; padding: 12px 14px; background: #f7f7fa; border: 1px solid rgba(0, 0, 0, 0.06); border-radius: 10px; overflow-x: auto; }
.note pre code { padding: 0; background: transparent; font-size: 0.86em; line-height: 1.7; }
.note .oe-hl-kw { color: #4038c8; font-weight: 600; }
.note .oe-hl-str { color: #1a7f4b; }
.note .oe-hl-num { color: #a85400; }
.note .oe-hl-prop { color: #0a6ea8; }
.note .oe-hl-com { color: #98989d; font-style: italic; }
.note hr { border: none; border-top: 1px solid rgba(0, 0, 0, 0.1); margin: 1.4em 0; }
.note a { color: #5e5ce6; text-underline-offset: 2px; }
.note .wiki { color: #5e5ce6; border-bottom: 1px dashed rgba(94, 92, 230, 0.5); }
.note img { max-width: 100%; height: auto; border-radius: 8px; vertical-align: middle; }
.note table { width: 100%; border-collapse: collapse; font-size: 0.94em; }
.note th, .note td { border: 1px solid rgba(0, 0, 0, 0.1); padding: 6px 9px; text-align: left; vertical-align: top; }
.note th { background: rgba(120, 120, 128, 0.08); font-weight: 600; }
.note ul[data-type='taskList'] { list-style: none; padding-left: 0.2em; }
.note ul[data-type='taskList'] > li { display: flex; align-items: flex-start; gap: 0.5em; }
.note ul[data-type='taskList'] > li > label { flex: 0 0 auto; padding-top: 0.3em; }
.note ul[data-type='taskList'] > li > div { flex: 1 1 auto; min-width: 0; }
.note ul[data-type='taskList'] input { pointer-events: none; }
.note figure.diagram { margin: 0.9em 0; padding: 10px 12px; background: #ffffff; border: 1px solid rgba(0, 0, 0, 0.06); border-radius: 10px; overflow-x: auto; text-align: center; }
.note figure.diagram > svg { max-width: 100%; height: auto; }
.doc-footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid rgba(0, 0, 0, 0.07); font-size: 11px; color: #98989d; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.print-button {
  position: fixed; right: 20px; bottom: 20px; padding: 8px 16px;
  font-family: inherit; font-size: 13px; color: #ffffff; background: #5e5ce6;
  border: none; border-radius: 999px; cursor: pointer; box-shadow: 0 6px 18px rgba(94, 92, 230, 0.32);
}
.print-button:hover { background: #4038c8; }
.empty { color: #98989d; font-size: 13px; }
@media print {
  html, body { background: #ffffff; }
  .page { max-width: none; margin: 0; padding: 0; border: none; border-radius: 0; }
  .print-button { display: none; }
  .doc-section { break-inside: auto; }
  .doc-section-title { break-after: avoid; }
  .note pre, .note table, .note figure.diagram { break-inside: avoid; }
  @page { margin: 18mm 16mm; }
}
`

/**
 * 拼一份完整的自包含 HTML。
 * 单篇：页头是文档标题；整本：页头是笔记本名 + 目录 + 每篇一节（文档树缩进保留为标题层级）。
 */
export async function buildExportHtml(request: NotebookExportRequest): Promise<{ html: string; filename: string }> {
  const { docs, meta } = request
  const labels = {
    print: meta.locale === 'en' ? 'Print / Save as PDF' : '打印 / 另存为 PDF',
    empty: meta.locale === 'en' ? 'This section is empty.' : '这一篇还没有内容。',
    exportedAt: meta.locale === 'en' ? 'Exported' : '导出于',
    notebook: meta.locale === 'en' ? 'Notebook' : '笔记本',
    toc: meta.locale === 'en' ? 'Contents' : '目录',
    ...meta.labels,
  }
  const title =
    meta.kind === 'notebook' ? (meta.notebookName ?? docs[0]?.title ?? '') : (docs[0]?.title ?? '')
  const sections: string[] = []
  for (const [index, doc] of docs.entries()) {
    const body = await transformDocHtml(doc.content, request.resolveAsset, doc.title)
    const anchor = `doc-${index + 1}`
    const heading =
      meta.kind === 'notebook'
        ? `<h1 class="doc-section-title">${escapeHtml(doc.title)}</h1>`
        : ''
    sections.push(
      `<section class="doc-section" id="${anchor}" data-depth="${Math.min(doc.depth, 3)}">${heading}<div class="note">${
        body === '' ? `<p class="empty">${escapeHtml(labels.empty)}</p>` : body
      }</div></section>`,
    )
  }

  const toc =
    meta.kind === 'notebook' && docs.length > 1
      ? `<nav class="toc"><div class="toc-head">${escapeHtml(labels.toc)}</div><ul>${docs
          .map(
            (doc, index) =>
              `<li style="padding-left:${Math.min(doc.depth, 6) * 16}px"><a href="#doc-${index + 1}">${escapeHtml(doc.title)}</a></li>`,
          )
          .join('')}</ul></nav>`
      : ''

  const headMeta =
    meta.kind === 'notebook'
      ? `${escapeHtml(labels.notebook)} · ${escapeHtml(labels.exportedAt)} ${escapeHtml(meta.exportedAt)}`
      : `${escapeHtml(labels.exportedAt)} ${escapeHtml(meta.exportedAt)}`

  const html = `<!doctype html>
<html lang="${meta.locale === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${escapeHtml(meta.appName)}">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<main class="page">
<header class="page-head">
<div class="doc-title">${escapeHtml(title)}</div>
<div class="doc-meta">${headMeta}</div>
</header>
${toc}
${sections.join('\n')}
<footer class="doc-footer">
<span>${escapeHtml(title)}</span>
<span>${escapeHtml(meta.appName)} · ${escapeHtml(labels.exportedAt)} ${escapeHtml(meta.exportedAt)}</span>
</footer>
</main>
<button class="print-button" type="button" onclick="window.print()">${escapeHtml(labels.print)}</button>
</body>
</html>
`
  return { html, filename: `${sanitizeExportFilename(title)}.html` }
}

/** 构内容 → blob → 下载（与甘特导出同一条落点，避免两套下载实现）。 */
export async function exportNotebookHtml(
  request: NotebookExportRequest,
): Promise<{ filename: string; bytes: number }> {
  const { html, filename } = await buildExportHtml(request)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  triggerDownload(blob, filename)
  return { filename, bytes: blob.size }
}

/**
 * 打印当前导出内容 → 用户在打印对话框里选「另存为 PDF」。
 *
 * 为什么要藏一个 iframe 而不是 `window.open`：新窗口会被弹窗拦截，而且用户看到的是
 * 一份"还没打开完就弹打印"的空页；iframe 是同步写入的，打印时内容一定在。
 * 打印完把 iframe 摘掉（afterprint + 兜底定时器），不让它留在 DOM 里。
 */
export function printHtmlDocument(html: string): boolean {
  if (typeof document === 'undefined') return false
  const frame = document.createElement('iframe')
  frame.setAttribute('data-testid', 'note-print-frame')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('title', 'print')
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
  document.body.appendChild(frame)
  const cleanup = (): void => {
    window.setTimeout(() => frame.remove(), 500)
  }
  try {
    const doc = frame.contentDocument
    const view = frame.contentWindow
    if (doc === null || view === null) {
      frame.remove()
      return false
    }
    doc.open()
    doc.write(html)
    doc.close()
    window.setTimeout(() => {
      try {
        view.focus()
        if (typeof view.print === 'function') view.print()
      } finally {
        cleanup()
      }
    }, 80)
    return true
  } catch {
    frame.remove()
    return false
  }
}

/** `assets/<id>.<ext>` → 可显示 URL：缓存没有就等一次异步读取（最多等 2 秒）。 */
export async function waitForAssetUrl(
  port: NoteAssetsPort,
  src: string,
  timeoutMs = 2000,
): Promise<string | null> {
  const cached = port.resolve(src)
  if (cached !== null) return cached
  const subscribe = port.subscribe
  if (subscribe === undefined) return null
  return await new Promise<string | null>((resolve) => {
    let settled = false
    let timer = 0
    let unsubscribe = (): void => undefined
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }
    timer = window.setTimeout(() => finish(port.resolve(src)), timeoutMs)
    unsubscribe = subscribe(() => {
      const url = port.resolve(src)
      if (url !== null) finish(url)
    })
    const late = port.resolve(src)
    if (late !== null) finish(late)
  })
}

/** URL → data URI（导出时把图片真的塞进文件里）。 */
export async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    const blob = await response.blob()
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/** 视图层的合并入口：拿到 port 就能把一张 `assets/…` 图变成内联 data URI。 */
export function createAssetResolver(port: NoteAssetsPort | undefined): ((src: string) => Promise<string | null>) | undefined {
  if (port === undefined) return undefined
  return async (src: string) => {
    const url = await waitForAssetUrl(port, src)
    if (url === null) return null
    return await urlToDataUrl(url)
  }
}
