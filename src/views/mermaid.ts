// T50 · Mermaid 渲染（知识库 / 任务笔记共用）。
//
// 口径与三条既有约定对齐：
//  1) **存储仍是 Markdown**：图就是一段 ```mermaid 围栏代码块，没有任何"图对象"进 vault。
//     谁来写（人还是模型）、谁来读（编辑器、导出 HTML、Obsidian）看到的都是同一份文本。
//  2) **离线优先**：mermaid 引擎打进单文件产物（构建体积因此从 1.2MB 涨到约 5–6MB，
//     这是本项目"双击即开、零网络请求"的必然代价，不是漏优化）。因此这里用**动态 import**：
//     没写过 mermaid 的库在启动时不会初始化这套引擎，首屏不受影响。
//  3) **渲染结果与 DOM 分离**：`renderMermaidSvg()` 只返回 SVG 字符串，
//     编辑器（装饰性预览）与导出（自包含 HTML）复用同一份实现——两处画风必然一致。
//
// 安全：securityLevel 固定 'strict'。导出文件会被分享出去，图里写的 HTML 标签不该变成可执行内容。

import type { Node as PMNode } from '@tiptap/pm/model'

/** 导出范式（与 GanttExporter 同口径）：字体用显式系统栈，不引 webfont。 */
export const MERMAID_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

/**
 * 配色取 theme.css 的字面量值（SVG 呈现属性不解析 var()，导出时也没有 CSS 变量可用）：
 * 靛蓝主色 #5e5ce6、正文 #1d1d1f、发丝线 #c7c7cc、画布白。
 */
const MERMAID_THEME_VARIABLES = {
  fontFamily: MERMAID_FONT_STACK,
  fontSize: '13px',
  background: '#ffffff',
  primaryColor: '#eef0ff',
  primaryBorderColor: '#5e5ce6',
  primaryTextColor: '#1d1d1f',
  secondaryColor: '#f4f5f8',
  secondaryBorderColor: '#c7c7cc',
  secondaryTextColor: '#3a3a3c',
  tertiaryColor: '#ffffff',
  tertiaryBorderColor: '#e5e5ea',
  tertiaryTextColor: '#3a3a3c',
  lineColor: '#8e8e93',
  textColor: '#1d1d1f',
  nodeBorder: '#5e5ce6',
  clusterBkg: '#f7f7fa',
  clusterBorder: '#d1d1d6',
  edgeLabelBackground: '#ffffff',
  actorBkg: '#eef0ff',
  actorBorder: '#5e5ce6',
  actorTextColor: '#1d1d1f',
  actorLineColor: '#8e8e93',
  signalColor: '#3a3a3c',
  signalTextColor: '#1d1d1f',
  labelBoxBkgColor: '#eef0ff',
  labelBoxBorderColor: '#5e5ce6',
  noteBkgColor: '#fff9db',
  noteBorderColor: '#e5c07b',
  noteTextColor: '#1d1d1f',
} as const

export interface MermaidRenderOk {
  ok: true
  svg: string
}
export interface MermaidRenderFail {
  ok: false
  /** 给用户看的短原因（mermaid 的报错原文可能很长，界面上只留第一行）。 */
  error: string
  /** 完整报错，导出与排查用。 */
  detail: string
}
export type MermaidRenderResult = MermaidRenderOk | MermaidRenderFail

/** 语言标记：`mermaid` 是官方写法，`mmd` 是常见简写（Obsidian 两者都认）。 */
export function isMermaidLanguage(language: unknown): boolean {
  if (typeof language !== 'string') return false
  const normalized = language.trim().toLowerCase()
  return normalized === 'mermaid' || normalized === 'mmd'
}

/** 渲染前的归一：去掉首尾空行与行尾空白——只影响渲染，**不回写文档**。 */
export function normalizeMermaidCode(code: string): string {
  const lines = code.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift()
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
  return lines.map((line) => line.replace(/[ \t]+$/, '')).join('\n')
}

/** 文档里所有 mermaid 代码块的位置与源码（编辑器据此挂预览）。 */
export interface MermaidBlockRef {
  /** 代码块节点结束处（预览插在这里，紧跟代码块之后）。 */
  after: number
  code: string
}

export function mermaidBlockRefs(doc: PMNode): MermaidBlockRef[] {
  const refs: MermaidBlockRef[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true
    if (!isMermaidLanguage(node.attrs.language)) return true
    const code = normalizeMermaidCode(node.textContent)
    if (code === '') return true
    refs.push({ after: pos + node.nodeSize, code })
    return true
  })
  return refs
}

/**
 * 给 SVG 里的 id 加作用域。
 *
 * mermaid 生成的 SVG 自带 `id="oe-mermaid-x-flowchart-..."`、`marker id`、`url(#…)` 引用，
 * **而且把节点配色写在 `<style>` 里的 `#id .node rect{fill:…}` 选择器上**。
 * 同一段代码在两处出现（缓存命中的常见结果）时，这些 id 会在同一个文档里撞车——
 * 轻则两个图共用一个箭头标记，重则引用了另一个图的渐变 / 滤镜。
 *
 * 这里最容易踩的坑：只改 `id="…"` 而不改样式选择器 → 所有 `#id .node` 规则失配，
 * 节点退回 `<rect>` 的浏览器默认样式（纯黑填充），整张图变成一团黑块（实测如此）。
 * 所以四处一起改：`id`、`url(#…)`、`href="#…"`、以及 CSS 里的 `#id` 选择器。
 *
 * 替换顺序与边界：长 id 先替换；选择器那条用「后面不能紧跟标识符字符」的负向断言，
 * 否则短 id 会吃掉长 id 的前缀（`#a` 命中 `#a-arrow`）。
 */
export function scopeSvgIds(svg: string, scope: string): string {
  const ids = new Set<string>()
  for (const matched of svg.matchAll(/\sid="([^"]+)"/g)) {
    const id = matched[1]
    if (id !== undefined && id !== '') ids.add(id)
  }
  // 引用侧也一起收：mermaid 的渐变 / 滤镜定义不一定在同一段 SVG 里出现（例如 e2e 主题类），
  // 只要文档里出现 `url(#x)` / `href="#x"`，这个 x 就必须一起改，否则会指向另一个图。
  for (const matched of svg.matchAll(/url\(#([^)]+)\)/g)) {
    const id = matched[1]
    if (id !== undefined && id !== '') ids.add(id)
  }
  for (const matched of svg.matchAll(/href="#([^"]+)"/g)) {
    const id = matched[1]
    if (id !== undefined && id !== '') ids.add(id)
  }
  let out = svg
  const ordered = [...ids].sort((a, b) => b.length - a.length)
  for (const id of ordered) {
    const scoped = `${id}-${scope}`
    out = out.split(`id="${id}"`).join(`id="${scoped}"`)
    out = out.split(`url(#${id})`).join(`url(#${scoped})`)
    out = out.split(`href="#${id}"`).join(`href="#${scoped}"`)
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // CSS 选择器：`#id` 后不能紧跟标识符字符，否则那是更长的 id
    out = out.replace(new RegExp(`#${escaped}(?![\\w-])`, 'g'), `#${scoped}`)
  }
  return out
}

/** mermaid 引擎的最小面（只用到 initialize + render，避免把整个类型树拉进来）。 */
interface MermaidApi {
  initialize: (config: Record<string, unknown>) => unknown
  render: (id: string, text: string) => Promise<{ svg: string }>
}

let engine: Promise<MermaidApi> | null = null
let sequence = 0

async function loadEngine(): Promise<MermaidApi> {
  if (engine === null) {
    engine = import('mermaid')
      .then((module) => {
        const api = ((module as { default?: MermaidApi }).default ??
          (module as unknown as MermaidApi)) as MermaidApi
        api.initialize({
          startOnLoad: false,
          theme: 'base',
          // 导出会分享出去：图里写的 HTML 不该变成可执行内容
          securityLevel: 'strict',
          themeVariables: MERMAID_THEME_VARIABLES,
          // 错误图不画（我们自己显示一条可读的错误提示）
          suppressErrorRendering: true,
          flowchart: { curve: 'basis', htmlLabels: false, useMaxWidth: true },
          sequence: { useMaxWidth: true },
          gantt: { useMaxWidth: true },
          er: { useMaxWidth: true },
          class: { useMaxWidth: true },
          state: { useMaxWidth: true },
          mindmap: { useMaxWidth: true },
        })
        return api
      })
      .catch((error: unknown) => {
        // 加载失败不缓存：下次进来还能再试（例如打包产物被截断后重新打开）
        engine = null
        throw error
      })
  }
  return engine
}

/** 已渲染结果的缓存：同一段代码在一次会话里只渲染一次（编辑器每次事务都会重算装饰）。 */
const cache = new Map<string, MermaidRenderResult>()

/** 测试用：清空缓存与引擎句柄。 */
export function resetMermaidCache(): void {
  cache.clear()
  engine = null
  sequence = 0
}

function firstLine(text: string): string {
  const line = text.split('\n').map((item) => item.trim()).find((item) => item !== '')
  return line ?? 'render failed'
}

/**
 * 渲染一段 mermaid 源码。
 * 失败**不是异常**：语法写错的代码块在编辑器里是常态，返回 `ok:false` 让调用方显示一行提示。
 */
export async function renderMermaidSvg(code: string): Promise<MermaidRenderResult> {
  const normalized = normalizeMermaidCode(code)
  if (normalized === '') return { ok: false, error: 'empty diagram', detail: 'empty diagram' }
  const cached = cache.get(normalized)
  if (cached !== undefined) return cached

  let result: MermaidRenderResult
  try {
    const api = await loadEngine()
    sequence += 1
    // id 必须每次不同：mermaid 用它在文档里建临时节点，也用它给内部 marker 命名
    const rendered = await api.render(`oe-mermaid-${sequence}`, normalized)
    result = { ok: true, svg: rendered.svg }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    result = { ok: false, error: firstLine(detail), detail }
  }
  cache.set(normalized, result)
  return result
}
