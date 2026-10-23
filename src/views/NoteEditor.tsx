// T24 · NoteEditor：任务笔记 / 知识库文档共用的富文本编辑器（spec 6.4；T49 增强）。
//
// 存储口径：`Task.note` 与 `NoteDoc.content` 永远存 Markdown 纯文本（可读、可迁移、能被 Obsidian 直读）。
// 编辑器内部是 ProseMirror 文档，进出都经官方 @tiptap/markdown（MarkedJS）转换；
// 往返不丢内容的口径由 `roundTripNoteMarkdown()` 固化（导出供单测直接断言）。
//
// 四处刻意取舍（都是为了「不丢内容」或不越界）：
//  1) 自补 SafeCodeBlock —— 官方 codeBlock 的 markdown 读写有两个已知缺陷（见其定义处注释），
//     会把嵌套围栏 / 前导空格的围栏代码块写坏或吞掉；这里覆写两个 handler 修掉。
//  2) 自补任务列表快捷语法 `[] ` —— StarterKit / TaskItem 3.32 未内置该输入规则（实测无 addInputRules）。
//  3) 图片渲染走 React 节点视图（blob URL 是异步来的），markdown 读写由扩展负责。
//  4) 图片缩放（T49，2026-10-22 改按高度）：**没缩放过**的图不设宽度，只给「智能限高」
//     （`max-width:100%` + `max-height:62vh`）——截图这类长图不该一插入就吃掉整屏。
//     手动缩放的落点仍是 `<img width="62%">`：标准 Markdown 没有尺寸位，塞进 title 会污染悬浮提示；
//     HTML img 是 Typora / Obsidian 都认的既有约定，读回来仍是 `image` 节点（`parseHTML` 自带 width 映射）。
//     百分比的含义是「占编辑区内容宽度的百分之多少」——等比缩放，高度自动跟随，所以它同时就是高度。
//
// 写路径：编辑 debounce 后 onCommit（宿主用 patchTaskCommand / patchNoteDocCommand 落库 →
// 进 CommandBus 撤销栈）；组件自己不碰 store、不碰文件系统。撤销粒度 = 一个 debounce 窗口一条命令。
// 可挂载性：默认导出 + 显式 props（value / onCommit / linkTargets / t 全部由外部传入）。

import {
  Editor,
  Extension,
  InputRule,
  mergeAttributes,
  Node,
} from '@tiptap/core'
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
} from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { CodeBlock } from '@tiptap/extension-code-block'
import { Image } from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from 'react'

import { createI18n } from '../locales/i18n'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import type { AssetRejectReason } from '../persistence/assetStore'
import { Icon } from './IconSprite'
import type { IconName } from './IconSprite'
import { Lightbox } from './Lightbox'
import { isMermaidLanguage, mermaidBlockRefs, normalizeMermaidCode, renderMermaidSvg, scopeSvgIds } from './mermaid'
import { highlightCode, tokenClassNames } from '../domain/codeHighlight'
import { NOTE_FONT_SIZE_DEFAULT, NOTE_FONT_SIZE_MAX, NOTE_FONT_SIZE_MIN } from '../domain/types'
import { fs, sp, px } from '../styles/scale'

const BORDER = 'var(--oe-border)'
const SEPARATOR = 'var(--oe-separator)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const SURFACE = 'var(--oe-surface)'
const FILL = 'var(--oe-fill)'
const INDIGO = 'var(--oe-accent)'
const BODY_FONT = 'var(--oe-font)'
const RADIUS_CONTROL = 'var(--oe-radius-control)'
const RADIUS_CARD = 'var(--oe-radius-card)'
const RADIUS_OVERLAY = 'var(--oe-radius-overlay)'

/** 默认 debounce：400ms 是「停手即落库」与「撤销栈不被逐字刷满」之间的折中。 */
const DEFAULT_DEBOUNCE_MS = 400
/** 双链候选上限（避免长笔记里弹层过长）。 */
const LINK_MENU_LIMIT = 8
/** 文件选择器过滤；与 AssetStore 白名单同源（真正的判定仍在 AssetStore 一处）。 */
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml'
/** 插入失败的提示停留时长。 */
const HINT_MS = 3000

// ── T49 · 图片缩放（百分比宽度 = 等比缩放，高度自动跟随） ──────────────────
// 为什么用百分比而不是像素：同一个笔记在任务弹窗（760 宽）与知识库（更宽）里显示，
// 像素宽度在其中一处必然过窄/过宽；百分比跟着正文宽度走，且窗口缩放后仍然合理。
// 为什么百分比是相对**编辑区**而不是原图：早期版本把 `width:50%` 直接给 `<img>`，而它的包含块
// 是 shrink-to-fit 的 inline-block 包装层 → 50% 算出来是「原图宽度的一半」（实测 480px 的图
// 选 50% 得到 240px，比编辑区一半的 316px 窄一大截），用户手感就是「比例不听话」。
// 现在百分比落在**包装层**上（其包含块是段落 = 编辑区宽度），图片自身 `width:100%`。
// min 15% 是「还看得清是什么图」的下限，再小不如删掉。

export const NOTE_IMAGE_WIDTH_MIN = 15
export const NOTE_IMAGE_WIDTH_MAX = 100
export const NOTE_IMAGE_WIDTH_PRESETS = [25, 50, 75, 100] as const
/**
 * 没被手动缩放的图片的高度上限。
 * 这个值不进文档、不进设置——它只是「长截图不该一插入就占满一屏」的兜底：
 * 超了就按比例缩到这么高，宽度跟着收，绝不变形（`width:auto` + 双 max 约束由浏览器等比取舍）。
 */
const AUTO_MAX_HEIGHT_RATIO = 0.62
export const NOTE_IMAGE_AUTO_MAX_HEIGHT = `${Math.round(AUTO_MAX_HEIGHT_RATIO * 100)}vh`
/**
 * 智能限高的「宁可高，不可糊」下限（css px）。
 * 一张 400×2400 的整页截图压到 62vh 后只剩 74px 宽，等于看不见内容——
 * 那种情况不如不压：按可用宽度显示，高就高，点开灯箱还能放大看细节。
 */
export const NOTE_IMAGE_MIN_READABLE_WIDTH = 300

/** 把 markdown / HTML 里的宽度写法归一成 15–100 的整数百分比；无法识别返回 null（= 原始尺寸）。 */
export function parseImageWidth(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(NOTE_IMAGE_WIDTH_MAX, Math.max(NOTE_IMAGE_WIDTH_MIN, Math.round(raw)))
  }
  if (typeof raw !== 'string') return null
  const matched = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(raw)
  if (matched === null) return null
  const value = Number(matched[1])
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(NOTE_IMAGE_WIDTH_MAX, Math.max(NOTE_IMAGE_WIDTH_MIN, Math.round(value)))
}

/** 宽度的落盘写法（HTML img 的 width 属性）。 */
export function formatImageWidth(percent: number): string {
  return `${parseImageWidth(percent) ?? NOTE_IMAGE_WIDTH_MAX}%`
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 图片的 markdown 写法：有宽度 → HTML `<img>`（标准 Markdown 没有尺寸位）；
 * 没有宽度 → 常规 `![alt](src)`，保证「没缩放过」的笔记保持最干净的可读形态。
 */
export function imageMarkdown(attrs: { src: string; alt?: string | null; width?: unknown }): string {
  const src = attrs.src
  const alt = attrs.alt ?? ''
  const width = parseImageWidth(attrs.width)
  if (width === null) return `![${alt}](${src})`
  return `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}" width="${width}%">`
}

/**
 * 字数（非空白字符数）：只是给写作者一个体量提示，不追求语言学的「词」。
 * 图片语法与 HTML 标签不计入——它们不是正文。
 */
export function countNoteChars(markdown: string): number {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[#*`~]/g, '')
    .replace(/\s+/g, '')
    .length
}

/** 从剪贴板 / 拖放载荷里挑出图片文件（粗筛：只看是不是 image/*）。 */
export function imageFilesOf(transfer: DataTransfer | null | undefined): File[] {
  if (transfer === null || transfer === undefined) return []
  const files = Array.from(transfer.files ?? [])
  return files.filter((file) => typeof file.type === 'string' && file.type.startsWith('image/'))
}

/** 被拒原因 → 提示文案键（spec 6.4 的两条限制各有一句话）。 */
const REJECT_KEY: Record<AssetRejectReason | 'failed', MsgKey> = {
  type: 'asset.unsupported',
  size: 'asset.tooLarge',
  empty: 'asset.empty',
  missing: 'asset.failed',
  failed: 'asset.failed',
}

/**
 * SafeCodeBlock：修掉官方 codeBlock 的 markdown 读写缺陷（Tiptap 3.32 实测复现）——
 *  · #8460：`   \`\`\`\ncode\n\`\`\``（围栏前 ≤3 空格，CommonMark 合法）解析时被丢成空/普通文本。
 *    上游 `parseMarkdown` 只在 `token.raw` 以 ``` / ~~~ 开头（或缩进式）时才建节点，前导空格使判据落空。
 *  · #8341：内容里含三反引号时仍固定用三反引号做围栏 → 往返把代码块劈成两段（不稳定）。
 *    这里按「内容里最长连续反引号 + 1」选围栏长度。
 * 与 spec 冲突时以「不丢内容」为准：宁可围栏变长，不可吞掉用户代码。
 */
const SafeCodeBlock = CodeBlock.extend({
  parseMarkdown: (token, helpers) =>
    helpers.createNode(
      'codeBlock',
      { language: token.lang || null },
      token.text ? [helpers.createTextNode(token.text)] : [],
    ),
  renderMarkdown: (node, h) => {
    const language = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
    const body = node.content ? h.renderChildren(node.content) : ''
    const longestRun = Math.max(0, ...[...body.matchAll(/`+/g)].map((match) => match[0].length))
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    return `${fence}${language}\n${body}\n${fence}`
  },
})

/**
 * TaskListShortcut：`[] ` / `[ ] ` 行首快捷语法（spec 6.4 的快捷语法清单第 5 条）。
 * TaskItem 3.32 没有内置输入规则，故自补：命中即删掉标记文本并把当前段落转成任务列表。
 */
const TaskListShortcut = Extension.create({
  name: 'taskListShortcut',
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[( |x)?\]\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).toggleTaskList().run()
        },
      }),
    ]
  },
})

/**
 * NotePlaceholder：空文档时给首段挂一个装饰，CSS 用 `::before` 画出提示语。
 * 不装 @tiptap/extensions 的 Placeholder，是因为那要新增一条直接依赖（它现在只是传递依赖）；
 * 这里只需要「整篇为空」这一种形态，20 行足够，也不会在保存时写进任何内容。
 */
const NotePlaceholder = Extension.create<{ text: string }>({
  name: 'notePlaceholder',
  addOptions() {
    return { text: '' }
  },
  addProseMirrorPlugins() {
    const text = this.options.text
    return [
      new Plugin({
        key: new PluginKey('notePlaceholder'),
        props: {
          decorations: ({ doc }) => {
            const first = doc.firstChild
            if (doc.childCount !== 1 || first === null || first.content.size !== 0) return null
            return DecorationSet.create(doc, [
              Decoration.node(0, first.nodeSize, {
                class: 'oe-note-empty',
                'data-placeholder': text,
              }),
            ])
          },
        },
      }),
    ]
  },
})


/**
 * MermaidPreview：把 ```` ```mermaid ```` 代码块渲染成图，**画在代码块下方**。
 *
 * 为什么是装饰（Decoration.widget）而不是新建一个 atom 节点：
 *  · 存储口径不允许——图必须是普通围栏代码块，才能被 Obsidian / Typora / 导出原样读走；
 *  · 交互口径也不允许——代码块要照旧可编辑（光标能进去改一行再看效果），
 *    换成一个"双击进入源码"的自定义节点会把最常用的操作变远。
 * 所以：代码在编辑器里是代码，图是它下面的一块只读预览，两者永远同步（同一次事务）。
 *
 * 渲染失败不是异常：语法写错的围栏在写作过程中很常见，这里显示一行错误原因，
 * 代码块本身原样保留——绝不吞掉用户写的字。
 */
interface MermaidPreviewLabels {
  rendering: string
  error: string
  /** T63：把源码围栏收起来 / 再展开（同一个按钮的两种文案）。 */
  collapse: string
  expand: string
}

const FALLBACK_MERMAID_LABELS: MermaidPreviewLabels = {
  rendering: 'Rendering diagram…',
  error: 'Diagram error',
  collapse: 'Hide source',
  expand: 'Show source',
}

/** 稳定但短的指纹：只用于 DOM 标记与 id 作用域，不参与渲染结果。 */
function shortHash(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

function createMermaidPreviewDom(
  code: string,
  labels: MermaidPreviewLabels,
  collapsed: boolean,
  onToggle: () => void,
): HTMLElement {
  const hash = shortHash(code)
  const host = document.createElement('div')
  host.className = 'oe-mermaid-preview'
  host.setAttribute('data-testid', 'note-mermaid-preview')
  host.setAttribute('data-mermaid-hash', hash)
  host.setAttribute('data-mermaid-state', 'pending')
  host.contentEditable = 'false'

  // 标题行只有「mermaid」与一个收放按钮：源码收起来以后，这是唯一还告诉用户
  // 「上面那段代码去哪了」的线索，所以它必须留在图上，而不是跟着代码块一起消失。
  const head = document.createElement('div')
  head.className = 'oe-mermaid-preview-head'
  const title = document.createElement('span')
  title.className = 'oe-mermaid-preview-title'
  title.textContent = 'mermaid'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'oe-mermaid-preview-toggle'
  toggle.setAttribute('data-testid', 'note-mermaid-toggle')
  toggle.setAttribute('data-collapsed', collapsed ? 'true' : 'false')
  toggle.textContent = collapsed ? labels.expand : labels.collapse
  // 不拦 mousedown 的话，点按钮会先把选区挪到 widget 旁边（图会跳一下）
  toggle.addEventListener('mousedown', (event) => {
    event.preventDefault()
  })
  toggle.addEventListener('click', (event) => {
    event.preventDefault()
    onToggle()
  })
  head.append(title, toggle)
  host.appendChild(head)

  const body = document.createElement('div')
  body.className = 'oe-mermaid-preview-body'
  body.textContent = labels.rendering
  host.appendChild(body)

  void renderMermaidSvg(code).then((result) => {
    // widget 已被事务重建 / 文档已卸载：丢弃这次结果，不碰一个不在文档里的节点
    if (!host.isConnected) return
    if (result.ok) {
      body.innerHTML = scopeSvgIds(result.svg, hash)
      host.setAttribute('data-mermaid-state', 'ok')
      return
    }
    body.textContent = `${labels.error}: ${result.error}`
    host.setAttribute('data-mermaid-state', 'error')
  })
  return host
}

/** 「把这段源码收起来」的集合：键是源码指纹，不是位置（位置每次编辑都会变）。 */
const MERMAID_PREVIEW_KEY = new PluginKey<Set<string>>('mermaidPreview')
interface MermaidCollapseMeta {
  toggle: string
}
const NO_COLLAPSED: Set<string> = new Set()

/**
 * 光标是否**停在代码文本里**（= 收起状态该解除）。
 *
 * 只认 TextSelection：`Selection.near()` 落在块边界时会给出一个把整块框住的 NodeSelection
 * （点击「收起源码」后选区通常就变成这个样子），把那种也算「在里面」的话，
 * 收起会在下一个事务里被立刻撤销，按钮看起来完全没反应。
 */
function caretInsideBlock(selection: { from: number; to: number; empty: boolean }, pos: number, size: number): boolean {
  if (!selection.empty) return false
  const start = pos + 1
  const end = pos + size - 1
  return selection.from >= start && selection.from <= end
}

const MermaidPreview = Extension.create<{ labels: MermaidPreviewLabels }>({
  name: 'mermaidPreview',
  addOptions() {
    return { labels: FALLBACK_MERMAID_LABELS }
  },
  addProseMirrorPlugins() {
    const labels = this.options.labels
    const key = MERMAID_PREVIEW_KEY
    return [
      new Plugin<Set<string>>({
        key,
        state: {
          init: () => NO_COLLAPSED,
          apply: (tr, value, oldState, newState) => {
            const meta = tr.getMeta(key) as MermaidCollapseMeta | undefined
            let next = value
            if (meta !== undefined) {
              next = new Set(value)
              if (next.has(meta.toggle)) next.delete(meta.toggle)
              else next.add(meta.toggle)
              // 这一步是「用户自己点的」→ 不再按光标位置纠偏：点按钮时光标通常就停在
              // 那段代码里，若在同一事务里又把它展开，按钮会看起来完全没反应。
              // 收起时手柄已把选区挪到块外（见 widget 的 onToggle），不会留下隐形光标。
              return next
            }
            if (next.size === 0) return next
            // 收起只是**显示**状态：光标一进去就必须还原，否则用户能看见光标却看不见字，
            // 一敲键盘就在一段隐形文本里改内容——这是最不能接受的一种"顺手删代码"。
            // 而且只在**光标刚进入**时展开：如果只看「当前光标在不在块里」，那么
            // 「光标本来就在这段代码上、用户去点收起」这个最常见的操作会被下一个事务立刻撤销
            // （点完按钮浏览器还会补一个选区事务），按钮看起来完全没反应。
            const entered: string[] = []
            newState.doc.descendants((node, pos) => {
              if (node.type.name !== 'codeBlock') return true
              if (!isMermaidLanguage(node.attrs.language)) return true
              const hash = shortHash(normalizeMermaidCode(node.textContent))
              if (!next.has(hash)) return true
              const wasInside = caretInsideBlock(oldState.selection, pos, node.nodeSize)
              const isInside = caretInsideBlock(newState.selection, pos, node.nodeSize)
              // 只看「光标刚进入」：块在文档末尾时挪不出去，光标会留在块内，
              // 那种情况由**内容指纹**兜底——收起状态是按源码文本记录的，
              // 一旦在里面改动，指纹就变了，这段代码自动恢复显示（不需要额外判断）。
              if (isInside && !wasInside) entered.push(hash)
              return true
            })
            if (entered.length === 0) return next
            const pruned = new Set(next)
            for (const hash of entered) pruned.delete(hash)
            return pruned
          },
        },
        props: {
          decorations: (state) => {
            const refs = mermaidBlockRefs(state.doc)
            if (refs.length === 0) return null
            const collapsed = key.getState(state) ?? NO_COLLAPSED
            const decorations: Decoration[] = []
            for (const ref of refs) {
              const hash = shortHash(ref.code)
              const isCollapsed = collapsed.has(hash)
              if (isCollapsed) {
                // 节点级装饰：`display:none` 由 CSS 给（见 theme.css），
                // 这里只负责「这段源码现在不显示」这一个事实。
                decorations.push(
                  Decoration.node(ref.pos, ref.after, {
                    class: 'oe-mermaid-src-collapsed',
                    'data-mermaid-collapsed': 'true',
                  }),
                )
              }
              decorations.push(
                Decoration.widget(
                  ref.after,
                  (view) =>
                    createMermaidPreviewDom(ref.code, labels, isCollapsed, () => {
                      const tr = view.state.tr.setMeta(key, { toggle: hash } satisfies MermaidCollapseMeta)
                      // 收起时把光标挪到块外：否则它停在一段已经不显示的文本上，
                      // 一敲键盘就是在改看不见的内容。块后面没有内容时不硬挪——
                      // 硬挪只能落到块左侧或整块选中，两种都比"光标停在原地"更糟；
                      // 那种情况由「一敲键盘就展开」兜底（见 apply 里的 docChanged 判断）。
                      if (!isCollapsed && ref.after < view.state.doc.content.size) {
                        tr.setSelection(Selection.near(view.state.doc.resolve(ref.after), 1))
                      }
                      view.dispatch(tr)
                    }),
                  {
                    // 图的预览不该影响光标：点它不移动选区、方向键也不停在它上面
                    ignoreSelection: true,
                    // 收起态要换按钮文案 → key 里带上状态，事务重建时才真的换一副 DOM
                    key: `mermaid-${ref.after}-${hash}-${isCollapsed ? 'c' : 'o'}`,
                  },
                ),
              )
            }
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})

/**
 * T63 · 代码块着色：把 `highlightCode()` 切出来的区间挂成 inline decoration。
 *
 * 为什么不改 renderHTML：代码块的内容必须是**纯文本节点**，光标才能逐字移动、
 * markdown 才能原样写回。着色只能是「叠在文字上的样式」，一旦改成真 span，
 * 每次按键都要重建 DOM，选区与输入法都会跟着坏。
 *
 * 逐键重算的成本由 highlightCode 内部的一层缓存兜住（同一段代码不重复扫描）。
 */
const SyntaxHighlight = Extension.create({
  name: 'syntaxHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('syntaxHighlight'),
        props: {
          decorations: (state) => {
            const decorations: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'codeBlock') return true
              const language = typeof node.attrs.language === 'string' ? node.attrs.language : null
              const tokens = highlightCode(node.textContent, language)
              if (tokens.length === 0) return true
              const base = pos + 1
              for (const token of tokens) {
                decorations.push(
                  Decoration.inline(base + token.from, base + token.to, { class: tokenClassNames(token.cls) }),
                )
              }
              return true
            })
            return decorations.length === 0 ? null : DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})


/**
 * WikiLink：`[[标题]]` 双向链接的最小落地（spec 6.4）。
 * atom inline 节点，markdown 侧用 tokenizer / parseMarkdown / renderMarkdown 三件套保证
 * `[[标题]]` 原样往返；DOM 侧渲染成可点击的文字（点击经 onNavigate 外送，接线归集成窗口）。
 */
const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { target: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'span[data-wiki-target]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const target = typeof HTMLAttributes.target === 'string' ? HTMLAttributes.target : ''
    return [
      'span',
      mergeAttributes({
        'data-wiki-target': target,
        style: `color: ${INDIGO}; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;`,
      }),
      `[[${target}]]`,
    ]
  },
  markdownTokenName: 'wikilink',
  markdownTokenizer: {
    name: 'wikilink',
    level: 'inline',
    start: (src: string) => (src.startsWith('[[') ? 0 : -1),
    tokenize: (src: string) => {
      const matched = /^\[\[([^[\]\n]+?)\]\]/.exec(src)
      if (matched === null) return undefined
      return { type: 'wikilink', raw: matched[0], target: matched[1] }
    },
  },
  parseMarkdown: (token) => [
    { type: 'wikiLink', attrs: { target: typeof token.target === 'string' ? token.target : '' } },
  ],
  renderMarkdown: (node) =>
    `[[${typeof node.attrs?.target === 'string' ? node.attrs.target : ''}]]`,
})

/**
 * 图片节点与宿主之间的三条接缝（全部可选）。
 * 都不传时退回 T24 的形态：只渲染灰底 chip，`![](assets/<id>.<ext>)` 语法照旧往返。
 */
export interface NoteImagePort {
  /** `assets/<id>.<ext>` → 可显示的 URL（file:// 下只能是 blob URL）；未就绪返回 null。 */
  resolve?: (src: string) => string | null
  /** 点击图片 → 外层开灯箱。 */
  open?: (src: string, alt: string) => void
  /** 宿主缓存就绪的通知：图片是异步读出来的，读到了要能重画（可选，没有则只在挂载时取一次）。 */
  subscribe?: (listener: () => void) => () => void
}

/** 节点视图要用的文案（由视图注 t()，扩展本身不 import i18n）。 */
export interface NoteImageLabels {
  resize: string
  resetSize: string
  widthValue: string
  /** 「高 240px」——缩放的主线索是高度，光给百分比看不出实际占多高。 */
  heightValue: string
  /** 未手动缩放时的档位名（= 智能限高 + 撑满可用宽度）。 */
  autoSize: string
}

interface NoteImageStorage {
  port: NoteImagePort | null
  labels: NoteImageLabels
}

/** 像素位移 → 百分比：内容宽度未知（jsdom / 未布局）时退回 100%，绝不算出 NaN 写进文档。 */
export function widthPercentFromPixels(pixels: number, contentWidth: number): number {
  if (!(contentWidth > 0) || !Number.isFinite(pixels)) return NOTE_IMAGE_WIDTH_MAX
  return parseImageWidth((pixels / contentWidth) * 100) ?? NOTE_IMAGE_WIDTH_MAX
}

/**
 * NoteImageView：图片用 React 节点视图渲染，而不是 ProseMirror 的静态 renderHTML——
 * 因为 blob URL 是**异步**来的（getFile() → createObjectURL），静态 HTML 一旦画出来就没机会改 src；
 * 节点视图是 React 组件，能等通知重画。markdown 往返由扩展的 renderMarkdown 负责。
 *
 * T49 缩放交互（三种入口，全部落到同一个属性 `width`）：
 *  · 右下角把手拖拽：**以垂直方向为主**（往下拖变高、往上拖变矮，宽度等比跟随），
 *    水平拖动仍可用（横向位移更大时按宽度算）；拖动时只改本地预览，抬手才写一次属性
 *    （一次拖拽 = 一条撤销命令）；
 *  · 选中/悬停后的 25/50/75/100% 预设条：「自适应」清掉宽度，回到智能限高；
 *  · 把手聚焦后方向键 ±5%（左右、上下都认；role=slider，键盘用户不是二等公民）。
 */
function NoteImageView(props: NodeViewProps) {
  const { node, extension, editor, selected, updateAttributes } = props
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : ''
  const storage = extension.storage as NoteImageStorage
  const port = storage.port
  const labels = storage.labels
  const width = parseImageWidth(node.attrs.width)
  const [url, setUrl] = useState<string | null>(() => port?.resolve?.(src) ?? null)
  /** 拖拽中的预览值（null = 没在拖）。 */
  const [preview, setPreview] = useState<number | null>(null)
  /** 悬停：让缩放预设不依赖「先选中」——点击图片是开灯箱（T25 既有行为），不能拿它当选中。 */
  const [hovering, setHovering] = useState(false)
  /** 渲染后的实际像素高度：缩放的主线索，百分比看不出「占多高」。 */
  const [shownHeight, setShownHeight] = useState<number | null>(null)
  /** 原图像素尺寸：决定「限高之后还看不看得清」（见 NOTE_IMAGE_MIN_READABLE_WIDTH）。 */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    const read = (): void => setUrl(port?.resolve?.(src) ?? null)
    read()
    if (typeof port?.subscribe !== 'function') return
    return port.subscribe(read)
  }, [src, port])

  const label = alt !== '' ? alt : src
  const shown = preview ?? width

  // 量实际高度。jsdom 没有布局（一切为 0），那时保持 null，badge 退回显示百分比。
  useEffect(() => {
    const node = imageRef.current
    if (node === null) return
    const rect = node.getBoundingClientRect()
    setShownHeight(rect.height > 0 ? Math.round(rect.height) : null)
  }, [shown, url, natural])

  /**
   * 自适应档要不要真的限高。
   * 按 62vh 缩完还剩多宽？剩不到 `NOTE_IMAGE_MIN_READABLE_WIDTH` 就不限了——
   * 一张整页截图缩成 74px 宽的细条，用户只会觉得图坏了，不如让它高、点开灯箱看。
   * 原图尺寸还没读到（首帧）时先按限高渲染，读到后再决定（图片本来就是异步来的）。
   */
  const autoMaxHeight: string | undefined = (() => {
    if (natural === null || natural.h <= 0) return NOTE_IMAGE_AUTO_MAX_HEIGHT
    const viewport = typeof window === 'undefined' ? 0 : window.innerHeight
    const capPx = viewport * AUTO_MAX_HEIGHT_RATIO
    if (!(capPx > 0)) return NOTE_IMAGE_AUTO_MAX_HEIGHT
    const widthAfterCap = (capPx * natural.w) / natural.h
    return widthAfterCap >= NOTE_IMAGE_MIN_READABLE_WIDTH ? NOTE_IMAGE_AUTO_MAX_HEIGHT : undefined
  })()

  const commitWidth = useCallback(
    (next: number | null): void => {
      updateAttributes({ width: next === null ? null : formatImageWidth(next) })
    },
    [updateAttributes],
  )

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>): void => {
      if (url === null) return
      event.preventDefault()
      event.stopPropagation()
      // 百分比的基准是段落（= 编辑区内容宽度），不是图片自身
      const contentWidth = editor.view.dom.clientWidth
      const startX = event.clientX
      const startY = event.clientY
      const box = imageRef.current?.getBoundingClientRect()
      const startWidth = box !== undefined && box.width > 0 ? box.width : 0
      const startHeight = box !== undefined && box.height > 0 ? box.height : 0
      const startPercent =
        width ?? (contentWidth > 0 && startWidth > 0 ? widthPercentFromPixels(startWidth, contentWidth) : NOTE_IMAGE_WIDTH_MAX)
      const target = event.currentTarget
      try {
        target.setPointerCapture(event.pointerId)
      } catch {
        // jsdom / 老浏览器：没有指针捕获也能靠 window 监听完成拖拽
      }
      setPreview(startPercent)

      /**
       * 位移 → 目标宽度（px）。
       * 垂直占优时按**高度**算：等比缩放意味着「高度变化比例 = 宽度变化比例」，
       * 所以 newW = startW × (startH + dy) / startH。这正是用户「拖高度」的手感，
       * 而落点仍是宽度百分比（唯一能跨容器自适应的相对量）。
       */
      const widthPixelsFor = (clientX: number, clientY: number): number => {
        const dx = clientX - startX
        const dy = clientY - startY
        if (startWidth <= 0) return 0
        if (Math.abs(dy) >= Math.abs(dx) && startHeight > 0) {
          return startWidth * ((startHeight + dy) / startHeight)
        }
        return startWidth + dx
      }

      const onMove = (move: PointerEvent): void => {
        const pixels = widthPixelsFor(move.clientX, move.clientY)
        // 内容宽度为 0（未布局）时用起始百分比兜底，避免把 NaN 显示给用户
        setPreview(
          contentWidth > 0 && pixels > 0
            ? widthPercentFromPixels(pixels, contentWidth)
            : startPercent,
        )
      }
      const onUp = (up: PointerEvent): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        const pixels = widthPixelsFor(up.clientX, up.clientY)
        const next =
          contentWidth > 0 && pixels > 0
            ? widthPercentFromPixels(pixels, contentWidth)
            : startPercent
        setPreview(null)
        commitWidth(next)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [commitWidth, editor, url, width],
  )

  // 未就绪（刚打开弹窗、图片还在读）：渲染灰底 chip 而不是碎图——
  // 内容取 alt / 路径，都是数据不是文案，不涉 i18n。
  if (url === null) {
    return (
      <NodeViewWrapper as="span">
        <span data-note-image={src} data-testid="note-image-pending" style={IMAGE_CHIP}>
          {label}
        </span>
      </NodeViewWrapper>
    )
  }

  /**
   * 包装层拿宽度（其包含块是段落，所以百分比 = 编辑区宽度的一部分）；
   * 图片自身恒定 `width:100%` 填满包装层，高度按原始比例——两个方向都不会被拉伸。
   * 自适应档不加宽度：让 `max-width:100%` 与 `max-height` 共同决定，浏览器取更严格的那个，等比。
   */
  const wrapStyle: CSSProperties = {
    ...IMAGE_WRAP,
    ...(selected ? IMAGE_WRAP_SELECTED : null),
    ...(shown === null ? null : { width: `${shown}%` }),
  }
  const tagStyle: CSSProperties = {
    ...IMAGE_TAG,
    ...(shown === null
      ? autoMaxHeight === undefined
        ? null
        : { maxHeight: autoMaxHeight }
      : { width: '100%' }),
  }
  const badgeText =
    shownHeight === null
      ? shown === null
        ? labels.autoSize
        : labels.widthValue.replace('{n}', String(shown))
      : labels.heightValue.replace('{n}', String(shownHeight))

  return (
    <NodeViewWrapper as="span">
      <span
        data-note-image-wrap={src}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={wrapStyle}
      >
        <img
          ref={imageRef}
          data-note-image={src}
          data-testid="note-image"
          src={url}
          alt={alt}
          onClick={() => port?.open?.(src, alt)}
          onLoad={(event) => {
            const el = event.currentTarget
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              setNatural({ w: el.naturalWidth, h: el.naturalHeight })
            }
          }}
          style={tagStyle}
        />
        <span
          data-note-image-handle=""
          data-testid="note-image-resize"
          role="slider"
          tabIndex={0}
          aria-label={labels.resize}
          aria-valuemin={NOTE_IMAGE_WIDTH_MIN}
          aria-valuemax={NOTE_IMAGE_WIDTH_MAX}
          aria-valuenow={shown ?? NOTE_IMAGE_WIDTH_MAX}
          aria-valuetext={
            shown === null
              ? labels.autoSize
              : labels.widthValue.replace('{n}', String(shown))
          }
          title={labels.resize}
          contentEditable={false}
          onPointerDown={startResize}
          onKeyDown={(event) => {
            // 上下与左右都认：缩放是等比的，「往上拖变矮」在键盘上就是 ArrowUp
            const shrink = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            const grow = event.key === 'ArrowRight' || event.key === 'ArrowDown'
            if (!shrink && !grow) return
            event.preventDefault()
            event.stopPropagation()
            const base = shown ?? NOTE_IMAGE_WIDTH_MAX
            const next = Math.min(
              NOTE_IMAGE_WIDTH_MAX,
              Math.max(NOTE_IMAGE_WIDTH_MIN, base + (grow ? 5 : -5)),
            )
            commitWidth(next)
          }}
          style={IMAGE_HANDLE}
        />
        {preview === null && !(hovering || selected) ? null : (
          <span data-testid="note-image-width-badge" style={IMAGE_WIDTH_BADGE}>
            {preview === null ? badgeText : `${preview}%`}
          </span>
        )}
        {selected || hovering ? (
          <span data-testid="note-image-tools" contentEditable={false} style={IMAGE_TOOLS}>
            {NOTE_IMAGE_WIDTH_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                data-testid={`note-image-width-${preset}`}
                aria-pressed={width === preset}
                aria-label={labels.widthValue.replace('{n}', String(preset))}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commitWidth(preset)}
                style={{ ...IMAGE_TOOL_CHIP, ...(width === preset ? IMAGE_TOOL_CHIP_ACTIVE : null) }}
              >
                {preset}%
              </button>
            ))}
            <button
              type="button"
              data-testid="note-image-width-reset"
              aria-pressed={width === null}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commitWidth(null)}
              style={{ ...IMAGE_TOOL_CHIP, ...(width === null ? IMAGE_TOOL_CHIP_ACTIVE : null) }}
            >
              {labels.resetSize}
            </button>
          </span>
        ) : null}
      </span>
    </NodeViewWrapper>
  )
}

const IMAGE_CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(6),
  padding: px('2px 8px'),
  border: `1px dashed ${BORDER}`,
  borderRadius: RADIUS_CONTROL,
  background: FILL,
  color: MUTED,
  fontSize: fs(11),
}

const IMAGE_WRAP: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  maxWidth: '100%',
  lineHeight: 0,
  verticalAlign: 'middle',
}

const IMAGE_WRAP_SELECTED: CSSProperties = {
  outline: `2px solid var(--oe-accent)`,
  outlineOffset: sp(2),
  borderRadius: RADIUS_CONTROL,
}

const IMAGE_TAG: CSSProperties = {
  maxWidth: '100%',
  height: 'auto',
  borderRadius: RADIUS_CONTROL,
  cursor: 'zoom-in',
  verticalAlign: 'middle',
}

const IMAGE_HANDLE: CSSProperties = {
  position: 'absolute',
  right: sp(-4),
  bottom: sp(-4),
  width: sp(12),
  height: sp(12),
  borderRadius: '50%',
  background: 'var(--oe-accent)',
  border: `2px solid var(--oe-surface)`,
  boxShadow: 'var(--oe-shadow-card)',
  cursor: 'nwse-resize',
  outline: 'none',
}

const IMAGE_WIDTH_BADGE: CSSProperties = {
  position: 'absolute',
  left: sp(4),
  top: sp(4),
  padding: px('1px 6px'),
  fontSize: fs(10),
  lineHeight: 1.6,
  color: 'var(--oe-on-accent)',
  background: 'var(--oe-accent)',
  borderRadius: RADIUS_CONTROL,
  pointerEvents: 'none',
}

const IMAGE_TOOLS: CSSProperties = {
  position: 'absolute',
  // 贴着图片右上角内侧：放图片外面（尤其下方）时，图片正好在滚动区底部就会被裁掉，
  // 用户只看得见一个孤零零的把手。叠在图上反正是半透明浮层，代价最小。
  top: sp(6),
  right: sp(6),
  display: 'flex',
  alignItems: 'center',
  gap: sp(2),
  padding: px('3px 4px'),
  background: 'var(--oe-material-overlay)',
  border: `1px solid ${SEPARATOR}`,
  borderRadius: RADIUS_CONTROL,
  boxShadow: 'var(--oe-shadow-pop)',
  lineHeight: 1,
  whiteSpace: 'nowrap',
}

const IMAGE_TOOL_CHIP: CSSProperties = {
  padding: px('2px 6px'),
  fontSize: fs(10),
  lineHeight: 1.6,
  color: SECONDARY,
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const IMAGE_TOOL_CHIP_ACTIVE: CSSProperties = {
  color: 'var(--oe-on-accent)',
  background: INDIGO,
}

function createNoteImage(port: NoteImagePort | null, labels: NoteImageLabels) {
  return Image.extend<object, NoteImageStorage>({
    addStorage() {
      return { port, labels }
    },
    addNodeView() {
      return ReactNodeViewRenderer(NoteImageView)
    },
    // 与官方实现只差一点：有宽度时写成 HTML img（标准 Markdown 图片语法没有尺寸位）。
    renderMarkdown: (node) =>
      imageMarkdown({
        src: typeof node.attrs?.src === 'string' ? node.attrs.src : '',
        alt: typeof node.attrs?.alt === 'string' ? node.attrs.alt : '',
        width: node.attrs?.width,
      }),
  })
}

/** 未注入文案时的兜底（纯函数往返、独立挂载的组件测试都会走到）。 */
const FALLBACK_IMAGE_LABELS: NoteImageLabels = {
  resize: 'Resize image',
  resetSize: 'Auto',
  widthValue: '{n}%',
  heightValue: '{n}px',
  autoSize: 'Auto',
}

/**
 * 笔记编辑器的扩展集（导出供单测复用，保证测试与产品走同一套 schema）。
 * `labels` 只影响图片节点视图上的可访问名，不影响 markdown 往返。
 */
export function createNoteExtensions(
  port?: NoteImagePort,
  labels?: NoteImageLabels,
  placeholder = '',
  mermaidLabels?: MermaidPreviewLabels,
) {
  return [
    StarterKit.configure({
      // 换成自补的 SafeCodeBlock（见其注释）
      codeBlock: false,
      // StarterKit 3.32 已含 Link：只改默认行为，不再单独装 @tiptap/extension-link
      link: { openOnClick: false, autolink: false },
      // heading 保持默认 1–6 级：工具栏只暴露 H2/H3（spec 6.4），但 schema 必须容得下 H1——
      // 快捷语法 `# `（Obsidian 习惯）与既有笔记里的 `# 标题` 都要能原样往返，收窄 levels 会直接丢内容。
    }),
    SafeCodeBlock,
    SyntaxHighlight,
    Markdown,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit,
    createNoteImage(port ?? null, labels ?? FALLBACK_IMAGE_LABELS),
    WikiLink,
    TaskListShortcut,
    NotePlaceholder.configure({ text: placeholder }),
    // T50：mermaid 预览（装饰件，不影响 markdown 往返）
    MermaidPreview.configure({ labels: mermaidLabels ?? FALLBACK_MERMAID_LABELS }),
  ]
}

/**
 * 纯函数口径的往返：Markdown → 文档 → Markdown。
 * 「不丢内容」= 一遍往返后的文本再往返一次保持不变（幂等），且各样例的关键语法仍在。
 */
export function roundTripNoteMarkdown(markdown: string): string {
  const element = typeof document === 'undefined' ? undefined : document.createElement('div')
  const editor = new Editor({
    element,
    extensions: createNoteExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
  const output = editor.getMarkdown()
  editor.destroy()
  return output
}

/** 双链候选：任务、里程碑，或知识库文档（T49）。同名多任务时列表里会出现多条同 title 的候选。 */
export interface NoteLinkTarget {
  id: string
  kind: 'task' | 'milestone' | 'doc'
  title: string
}

/** `insert()` 的结果：ok=false 时 reason 直接对应一条提示文案（spec 6.4 的两条限制）。 */
export type NoteAssetInsert =
  | { ok: true; src: string; alt?: string }
  | { ok: false; reason: AssetRejectReason | 'failed' }

/** 附件端口：编辑器不碰文件系统，落盘与显示全由宿主注入。 */
export interface NoteAssetsPort {
  /** 落盘（AssetStore.put）+ 记元数据；返回 note 里要写的 src。 */
  insert: (file: File) => Promise<NoteAssetInsert>
  /** `assets/<id>.<ext>` → blob URL；未就绪 null。 */
  resolve: (src: string) => string | null
  /** 缓存就绪通知（可选）：宿主异步读出图片后通知重画。 */
  subscribe?: (listener: () => void) => () => void
}

export interface NoteEditorProps {
  /** 当前笔记（Markdown 纯文本）。 */
  value: string
  /** debounce 后提交；宿主经 patchTaskCommand 落库（进撤销栈）。 */
  onCommit: (markdown: string) => void
  /** 双链候选（任务 + 里程碑标题）；省略则 `[[` 弹层为空。 */
  linkTargets?: readonly NoteLinkTarget[]
  /** 点击已渲染的 `[[标题]]` 时外送（matches 为同名候选，空数组表示链接指向的标题已不存在）。 */
  onNavigate?: (title: string, matches: readonly NoteLinkTarget[]) => void
  /** 工具栏「图片」的落点；T25 接入。省略时按钮为无操作（形态保留）。 */
  onInsertImage?: () => void
  /** T25：附件端口。给了它，粘贴 / 拖入 / 工具栏三条路径才真的能插图。 */
  assets?: NoteAssetsPort
  /** 插入被拒（超限 / 格式不允许 / 落盘失败）时外送，用于提示。 */
  onAssetRejected?: (reason: AssetRejectReason | 'failed') => void
  /** 编辑器就绪句柄（宿主/测试用）；卸载时回送 null。 */
  onReady?: (editor: Editor | null) => void
  /** 覆盖 debounce 毫秒数（测试确定化用）。 */
  debounceMs?: number
  /** 空内容时的占位提示；省略用通用文案。 */
  placeholder?: string
  /** 正文区最小高度（设计稿 px，经界面尺度换算）；默认 200。 */
  minHeight?: number
  /**
   * true：正文区吃满父容器高度、内部滚动（知识库文档页）；
   * false/省略：随内容增长（任务详情弹窗，外层本来就滚）。
   */
  grow?: boolean
  /** 底部右侧的字数统计；默认显示。 */
  showStats?: boolean
  /**
   * T50 · 正文基准字号（设计稿 px，12–20）。省略 = 13（此前的写死值）。
   * 最终渲染成 `calc(Npx * var(--oe-ui-scale))` —— 界面尺度与正文字号是两个独立旋钮：
   * 高分屏自动放大整体界面，用户再按阅读习惯单独调正文。
   */
  fontSize?: number
  /** 点 A- / A+ 时外送目标字号；不传则不显示字号控件（纯展示场景）。 */
  onFontSizeChange?: (next: number) => void
  t?: (key: MsgKey, params?: TranslateParams) => string
  style?: CSSProperties
}

/** 兜底文案表：组件测试或未接线时也能独立挂载（与 GanttView 同手法）。 */
const fallbackI18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })

interface ToolSpec {
  id: string
  icon: IconName
  label: MsgKey
  isActive: (editor: Editor) => boolean
  run: (editor: Editor, t: (key: MsgKey, params?: TranslateParams) => string) => void
}

/** 工具栏一行（spec 6.4 的 15 个按钮）；顺序即视觉顺序。 */
const TOOLS: readonly ToolSpec[] = [
  { id: 'bold', icon: 'bold', label: 'noteEditor.bold', isActive: (e) => e.isActive('bold'), run: (e) => e.chain().focus().toggleBold().run() },
  { id: 'italic', icon: 'italic', label: 'noteEditor.italic', isActive: (e) => e.isActive('italic'), run: (e) => e.chain().focus().toggleItalic().run() },
  { id: 'strike', icon: 'strike', label: 'noteEditor.strike', isActive: (e) => e.isActive('strike'), run: (e) => e.chain().focus().toggleStrike().run() },
  { id: 'inline-code', icon: 'code', label: 'noteEditor.inlineCode', isActive: (e) => e.isActive('code'), run: (e) => e.chain().focus().toggleCode().run() },
  { id: 'code-block', icon: 'code-block', label: 'noteEditor.codeBlock', isActive: (e) => e.isActive('codeBlock'), run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { id: 'h2', icon: 'heading-2', label: 'noteEditor.heading2', isActive: (e) => e.isActive('heading', { level: 2 }), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'h3', icon: 'heading-3', label: 'noteEditor.heading3', isActive: (e) => e.isActive('heading', { level: 3 }), run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'bullet-list', icon: 'list-ul', label: 'noteEditor.bulletList', isActive: (e) => e.isActive('bulletList'), run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'ordered-list', icon: 'list-ol', label: 'noteEditor.orderedList', isActive: (e) => e.isActive('orderedList'), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: 'task-list', icon: 'list-task', label: 'noteEditor.taskList', isActive: (e) => e.isActive('taskList'), run: (e) => e.chain().focus().toggleTaskList().run() },
  { id: 'quote', icon: 'quote', label: 'noteEditor.quote', isActive: (e) => e.isActive('blockquote'), run: (e) => e.chain().focus().toggleBlockquote().run() },
  {
    id: 'link',
    icon: 'link',
    label: 'noteEditor.link',
    isActive: (e) => e.isActive('link'),
    run: (editor, t) => {
      if (editor.isActive('link')) {
        editor.chain().focus().unsetLink().run()
        return
      }
      const href = typeof window.prompt === 'function' ? window.prompt(t('noteEditor.linkPrompt')) : null
      if (href === null || href === '') return
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    },
  },
  { id: 'table', icon: 'table', label: 'noteEditor.table', isActive: (e) => e.isActive('table'), run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'image', icon: 'image', label: 'noteEditor.image', isActive: () => false, run: () => undefined },
  { id: 'divider', icon: 'divider', label: 'noteEditor.divider', isActive: () => false, run: (e) => e.chain().focus().setHorizontalRule().run() },
]

export function NoteEditor(props: NoteEditorProps): ReactElement {
  const t = props.t ?? fallbackI18n.t
  const debounceMs = props.debounceMs ?? DEFAULT_DEBOUNCE_MS

  const [linkQuery, setLinkQuery] = useState<string | null>(null)
  const [linkIndex, setLinkIndex] = useState(0)
  const [editorReady, setEditorReady] = useState(false)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [rejectReason, setRejectReason] = useState<AssetRejectReason | 'failed' | null>(null)
  /** 富文本 / Markdown 源码两种模式（T49）。源码模式是给「想直接改 md」的人开的后门。 */
  const [mode, setMode] = useState<'rich' | 'source'>('rich')
  const [sourceDraft, setSourceDraft] = useState(props.value)
  const [charCount, setCharCount] = useState(() => countNoteChars(props.value))

  const editorRef = useRef<Editor | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const anchorRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  /** 编辑器当前内容的权威快照（卸载补交时用，避免读到已销毁的编辑器）。 */
  const latestRef = useRef(props.value)
  /** 最近一次「与宿主同步过」的 markdown：它等于宿主里的值，故不可再回写（防回声成环）。 */
  const lastSyncedRef = useRef(props.value)
  /** 程序化 setContent 期间抑制 onUpdate 的自动提交（否则「打开即规范化」会污染撤销栈）。 */
  const suppressRef = useRef(false)
  /**
   * 源码 → 富文本切换后，props.value 还是上一帧的旧值（宿主下一次渲染才追平）。
   * 这一次外部同步必须跳过，否则刚载入的源码内容会被旧值覆盖回去。
   */
  const skipSyncRef = useRef(false)
  const commitRef = useRef(props.onCommit)
  commitRef.current = props.onCommit
  const assetsRef = useRef(props.assets)
  assetsRef.current = props.assets
  const rejectedRef = useRef(props.onAssetRejected)
  rejectedRef.current = props.onAssetRejected

  /**
   * 图片节点视图用的稳定接缝：扩展集只在首次渲染时建一次（useEditor deps=[]），
   * 所以这里给一个引用恒定的对象，内部再转发到最新的 props（否则闭包会锁住旧回调）。
   */
  const imagePortRef = useRef<NoteImagePort | null>(null)
  if (imagePortRef.current === null) {
    imagePortRef.current = {
      resolve: (src) => assetsRef.current?.resolve(src) ?? null,
      open: (src, alt) => setLightbox({ src, alt }),
      subscribe: (listener) => assetsRef.current?.subscribe?.(listener) ?? (() => undefined),
    }
  }
  const imagePort = imagePortRef.current

  /** 节点视图的可访问名同样只在首次挂载时取一次（扩展集只建一次）。 */
  const imageLabelsRef = useRef<NoteImageLabels | null>(null)
  if (imageLabelsRef.current === null) {
    imageLabelsRef.current = {
      resize: t('noteEditor.imageResize'),
      resetSize: t('noteEditor.imageResetSize'),
      widthValue: t('noteEditor.imageWidthValue'),
      heightValue: t('noteEditor.imageHeightValue'),
      autoSize: t('noteEditor.imageAutoSize'),
    }
  }
  const imageLabels = imageLabelsRef.current
  const placeholderRef = useRef(props.placeholder ?? t('noteEditor.placeholder'))
  /** mermaid 预览的两条文案同样只取一次（扩展集只建一次）。 */
  const mermaidLabelsRef = useRef<MermaidPreviewLabels | null>(null)
  if (mermaidLabelsRef.current === null) {
    mermaidLabelsRef.current = {
      rendering: t('noteEditor.mermaidRendering'),
      error: t('noteEditor.mermaidError'),
      collapse: t('noteEditor.mermaidCollapse'),
      expand: t('noteEditor.mermaidExpand'),
    }
  }
  const minHeight = props.minHeight ?? 200
  const grow = props.grow ?? false
  const fontSize = props.fontSize ?? NOTE_FONT_SIZE_DEFAULT
  const canShrink = fontSize > NOTE_FONT_SIZE_MIN
  const canGrow = fontSize < NOTE_FONT_SIZE_MAX

  /** 插入一张图：落盘（宿主）→ 拿到 src → 在光标处插图片节点（markdown 由编辑器生成）。 */
  const insertFiles = useCallback(async (files: readonly File[]) => {
    const assets = assetsRef.current
    if (assets === undefined) return
    for (const file of files) {
      const result = await assets.insert(file)
      if (!result.ok) {
        setRejectReason(result.reason)
        rejectedRef.current?.(result.reason)
        continue
      }
      const instance = editorRef.current
      if (instance === null) continue
      instance.chain().focus().setImage({ src: result.src, alt: result.alt ?? '' }).run()
    }
  }, [])

  const emit = useCallback(() => {
    const markdown = latestRef.current
    setCharCount(countNoteChars(markdown))
    if (markdown === lastSyncedRef.current) return
    lastSyncedRef.current = markdown
    commitRef.current(markdown)
  }, [])

  const scheduleCommit = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      emit()
    }, debounceMs)
  }, [debounceMs, emit])

  const detectLinkTrigger = useCallback((instance: Editor) => {
    const { from } = instance.state.selection
    const textBefore = instance.state.doc.textBetween(Math.max(0, from - 64), from, '\n', '\ufffc')
    const matched = /\[\[([^[\]\n]*)$/.exec(textBefore)
    if (matched === null) {
      anchorRef.current = null
      setLinkQuery(null)
      return
    }
    const query = matched[1] ?? ''
    anchorRef.current = from - query.length - 2
    setLinkQuery(query)
    setLinkIndex(0)
  }, [])

  const handleUpdate = useCallback(
    (instance: Editor) => {
      const markdown = instance.getMarkdown()
      latestRef.current = markdown
      setCharCount(countNoteChars(markdown))
      if (suppressRef.current) {
        // 程序化载入（打开/撤销/换任务）不算用户编辑
        lastSyncedRef.current = markdown
        return
      }
      detectLinkTrigger(instance)
      if (markdown === lastSyncedRef.current) return
      scheduleCommit()
    },
    [detectLinkTrigger, scheduleCommit],
  )
  const updateRef = useRef(handleUpdate)
  updateRef.current = handleUpdate

  const editor = useEditor({
    extensions: createNoteExtensions(
      imagePort,
      imageLabels,
      placeholderRef.current,
      mermaidLabelsRef.current ?? FALLBACK_MERMAID_LABELS,
    ),
    content: props.value,
    contentType: 'markdown',
    // TipTap v3 默认「事务后不重渲染」；工具栏的 aria-pressed / 高亮要跟着选区与标记即时刷新，
    // 这里显式打开（笔记编辑器体量小，重渲染代价可忽略）。
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        'data-testid': 'note-editor-content',
        'aria-label': t('noteEditor.content'),
        // 占位提示走装饰节点的 data-placeholder（见 NotePlaceholder），这里不再重复
      },
    },
    onUpdate: ({ editor: instance }) => updateRef.current(instance),
    onCreate: ({ editor: instance }) => {
      editorRef.current = instance
      setEditorReady(true)
      props.onReady?.(instance)
    },
    onDestroy: () => {
      editorRef.current = null
      props.onReady?.(null)
    },
  }, [])

  // 卸载补交：debounce 未到就切任务/关弹窗时，把最后一次编辑交给「发起它的那个任务」
  // （commitRef 的闭包在挂载时已绑定该任务的 onCommit）。
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
        emit()
      }
    },
    [emit],
  )

  // 插入失败的提示自动消失（不阻塞编辑，也不必用户去关）
  useEffect(() => {
    if (rejectReason === null) return
    const timer = window.setTimeout(() => setRejectReason(null), HINT_MS)
    return () => window.clearTimeout(timer)
  }, [rejectReason])

  // 外部值变化（撤销 / 重做 / 换任务）：非自身回声才写回编辑器。
  // 源码模式下不碰编辑器（它被 textarea 遮住了），只同步草稿——切回富文本时再整体载入。
  useEffect(() => {
    if (skipSyncRef.current) {
      skipSyncRef.current = false
      return
    }
    if (props.value === lastSyncedRef.current) return
    if (mode === 'source') {
      lastSyncedRef.current = props.value
      latestRef.current = props.value
      setSourceDraft(props.value)
      setCharCount(countNoteChars(props.value))
      return
    }
    const instance = editorRef.current
    if (instance === null) return
    suppressRef.current = true
    try {
      instance.commands.setContent(props.value, { contentType: 'markdown' })
      lastSyncedRef.current = instance.getMarkdown()
      latestRef.current = lastSyncedRef.current
      setCharCount(countNoteChars(lastSyncedRef.current))
    } finally {
      suppressRef.current = false
    }
    setLinkQuery(null)
    anchorRef.current = null
  }, [props.value, mode])

  const candidates = useMemo(() => {
    if (linkQuery === null) return []
    const query = linkQuery.trim().toLowerCase()
    const all = props.linkTargets ?? []
    const matched = query === '' ? all : all.filter((target) => target.title.toLowerCase().includes(query))
    return matched.slice(0, LINK_MENU_LIMIT)
  }, [linkQuery, props.linkTargets])

  const insertLink = useCallback((target: NoteLinkTarget) => {
    const instance = editorRef.current
    const anchor = anchorRef.current
    if (instance === null || anchor === null) return
    const to = instance.state.selection.from
    instance
      .chain()
      .focus()
      .deleteRange({ from: anchor, to })
      .insertContent({ type: 'wikiLink', attrs: { target: target.title } })
      .insertContent(' ')
      .run()
    anchorRef.current = null
    setLinkQuery(null)
  }, [])

  /**
   * 富文本 ↔ Markdown 源码。
   * 进源码：草稿取编辑器当前 markdown（已规范化）；
   * 回富文本：先把源码整体载入编辑器（程序化载入，不进撤销栈），再按差异提交一次。
   */
  const switchMode = useCallback(() => {
    if (mode === 'rich') {
      const current = latestRef.current
      setSourceDraft(current)
      setCharCount(countNoteChars(current))
      setMode('source')
      setLinkQuery(null)
      anchorRef.current = null
      return
    }
    const draft = sourceDraft
    const instance = editorRef.current
    let normalized = draft
    if (instance !== null) {
      suppressRef.current = true
      try {
        instance.commands.setContent(draft, { contentType: 'markdown' })
        normalized = instance.getMarkdown()
        latestRef.current = normalized
      } finally {
        suppressRef.current = false
      }
    }
    lastSyncedRef.current = normalized
    setCharCount(countNoteChars(normalized))
    if (normalized !== props.value) commitRef.current(normalized)
    skipSyncRef.current = true
    setMode('rich')
    setLinkQuery(null)
  }, [mode, sourceDraft, props.value])

  /** 源码模式的输入：照旧走 debounce，与富文本共用一条写路径。 */
  const changeSource = (value: string): void => {
    setSourceDraft(value)
    latestRef.current = value
    setCharCount(countNoteChars(value))
    if (value === lastSyncedRef.current) return
    scheduleCommit()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (linkQuery === null) return
    if (candidates.length === 0) {
      if (event.key === 'Escape') {
        // 菜单开着时 Esc 只关菜单：stopPropagation 截住原生事件，
        // 免得冒泡到弹窗在 window 上的监听、把弹窗一起关掉（T24 遗留，收尾修复）。
        event.stopPropagation()
        setLinkQuery(null)
        anchorRef.current = null
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setLinkIndex((index) => (index + 1) % candidates.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setLinkIndex((index) => (index - 1 + candidates.length) % candidates.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const picked = candidates[Math.min(linkIndex, candidates.length - 1)] ?? candidates[0]
      if (picked !== undefined) insertLink(picked)
      return
    }
    if (event.key === 'Escape') {
      // 同上：截住事件，菜单与弹窗不同时关。
      event.preventDefault()
      event.stopPropagation()
      setLinkQuery(null)
      anchorRef.current = null
    }
  }

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const element = target.closest('[data-wiki-target]')
    if (element === null) return
    const title = element.getAttribute('data-wiki-target') ?? ''
    const matches = (props.linkTargets ?? []).filter((candidate) => candidate.title === title)
    props.onNavigate?.(title, matches)
  }

  // ── 图片三条插入路径（spec 6.4）──────────────────────────────────────────
  // 粘贴与拖入都只从事件的 clipboardData / dataTransfer 取 File，
  // 不用 navigator.clipboard.read()——它额外要求文档持系统前台焦点 + clipboard-read 权限（T01 R4）。
  // 格式与体积的判定统一交给 AssetStore（唯一判定点），这里只做「是不是图片」的粗筛。

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>): void => {
    const files = imageFilesOf(event.clipboardData)
    if (files.length === 0) return // 文本粘贴交回浏览器默认：快捷语法、列表续行都靠它
    event.preventDefault()
    void insertFiles(files)
  }

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    // 不 preventDefault，浏览器不会把这次拖放交给我们（默认行为是打开文件）
    if (imageFilesOf(event.dataTransfer).length === 0) return
    event.preventDefault()
  }

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    const files = imageFilesOf(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    void insertFiles(files)
  }

  const handleFileInput = (event: ReactChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? [])
    // 清空 value：否则连续插同一张图时第二次不会触发 change
    event.target.value = ''
    if (files.length === 0) return
    void insertFiles(files)
  }

  const tools = TOOLS
  const activeIndex = candidates.length === 0 ? -1 : Math.min(linkIndex, candidates.length - 1)
  /** CSS 自定义属性不在 CSSProperties 里，单独断言一次（值本身就是一层 calc）。 */
  const noteFontVar = {
    '--oe-note-font-size': `calc(${fontSize}px * var(--oe-ui-scale, 1))`,
  } as CSSProperties

  return (
    <div
      data-testid="note-editor"
      data-mode={mode}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        // grow 模式下编辑器自己吃满父容器（正文内部滚动）；否则由内容撑高（任务弹窗）
        flex: grow ? '1 1 auto' : undefined,
        height: grow ? '100%' : undefined,
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_CARD,
        fontFamily: BODY_FONT,
        color: TEXT,
        // T50：正文字号只在这里注入一次，.oe-prose 与源码框都读它
        ...noteFontVar,
        ...props.style,
      }}
    >
      {editorReady && mode === 'rich' ? (
        <div data-testid="note-toolbar" role="toolbar" aria-label={t('noteEditor.toolbar')} style={TOOLBAR}>
          {tools.map((tool) => {
            const instance = editorRef.current
            const active = instance === null ? false : tool.isActive(instance)
            const pending = tool.id === 'image' && props.onInsertImage === undefined && props.assets === undefined
            return (
              <button
                key={tool.id}
                type="button"
                data-testid={`note-tool-${tool.id}`}
                data-pending={pending ? 't25' : undefined}
                aria-label={t(tool.label)}
                aria-pressed={active}
                title={t(tool.label)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const current = editorRef.current
                  if (current === null) return
                  if (tool.id === 'image') {
                    // 有附件端口就开文件选择器（三条路径里的「工具栏选文件」）；
                    // 没有则退回 T24 的 onInsertImage 接缝，按钮形态不变。
                    if (props.assets !== undefined) fileInputRef.current?.click()
                    else props.onInsertImage?.()
                    return
                  }
                  tool.run(current, t)
                }}
                style={{ ...TOOL_BUTTON, ...(active ? TOOL_BUTTON_ACTIVE : null) }}
              >
                <Icon name={tool.icon} size={15} />
              </button>
            )
          })}
        </div>
      ) : null}

      {/* 工具栏「图片」的落点：隐藏的原生文件选择器（零依赖，file:// 下同样可用） */}
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        data-testid="note-image-input"
        onChange={handleFileInput}
        style={{ display: 'none' }}
      />

      {mode === 'source' ? (
        <textarea
          data-testid="note-source"
          aria-label={t('noteEditor.markdownSource')}
          value={sourceDraft}
          spellCheck={false}
          onChange={(event) => {
            changeSource(event.target.value)
          }}
          onKeyDown={(event) => {
            event.stopPropagation() // 源码模式里的 Esc / Ctrl+Z 归浏览器（文本撤销），不关弹窗
            if (event.key === 'Tab') {
              // 纯文本域默认把 Tab 交给焦点链；这里给缩进——写 md 的列表/代码块需要它
              event.preventDefault()
              const area = event.currentTarget
              const { selectionStart, selectionEnd, value } = area
              const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
              changeSource(next)
              requestAnimationFrame(() => {
                area.selectionStart = selectionStart + 2
                area.selectionEnd = selectionStart + 2
              })
            }
          }}
          style={{
            ...SOURCE_AREA,
            flex: grow ? '1 1 auto' : undefined,
            minHeight: sp(minHeight),
            resize: grow ? 'none' : 'vertical',
          }}
        />
      ) : (
        <div
          className="oe-prose"
          data-testid="note-body"
          style={{
            ...NOTE_BODY,
            flex: grow ? '1 1 auto' : undefined,
            minHeight: sp(minHeight),
            overflowY: grow ? 'auto' : undefined,
          }}
        >
          <EditorContent editor={editor} />
        </div>
      )}

      <div data-testid="note-statusbar" style={STATUSBAR}>
        <span style={STATUS_LEFT}>
          <button
            type="button"
            data-testid="note-mode-toggle"
            aria-pressed={mode === 'source'}
            title={mode === 'rich' ? t('noteEditor.markdownModeHint') : t('noteEditor.richModeHint')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={switchMode}
            style={{ ...MODE_BUTTON, ...(mode === 'source' ? MODE_BUTTON_ACTIVE : null) }}
          >
            {mode === 'rich' ? t('noteEditor.markdownMode') : t('noteEditor.richMode')}
          </button>
          {/* T50：字号调节。放在编辑器自己的底栏，任务详情与知识库共用同一个控件、
              同一个设置值——用户不必记「这条笔记的字号要在哪个面板里改」。 */}
          <span role="group" aria-label={t('noteEditor.fontSize')} style={FONT_CONTROLS}>
            <button
              type="button"
              data-testid="note-font-smaller"
              aria-label={t('noteEditor.fontSmaller')}
              title={t('noteEditor.fontSmaller')}
              disabled={props.onFontSizeChange === undefined || !canShrink}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onFontSizeChange?.(fontSize - 1)}
              style={{ ...FONT_BUTTON, ...(canShrink ? null : FONT_BUTTON_OFF) }}
            >
              A-
            </button>
            <span data-testid="note-font-size" title={t('noteEditor.fontSize')} style={FONT_VALUE}>
              {fontSize}
            </span>
            <button
              type="button"
              data-testid="note-font-larger"
              aria-label={t('noteEditor.fontLarger')}
              title={t('noteEditor.fontLarger')}
              disabled={props.onFontSizeChange === undefined || !canGrow}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onFontSizeChange?.(fontSize + 1)}
              style={{ ...FONT_BUTTON, ...(canGrow ? null : FONT_BUTTON_OFF) }}
            >
              A+
            </button>
          </span>
        </span>
        {props.showStats === false ? null : (
          <span data-testid="note-char-count" style={STATS}>
            {t('noteEditor.charCount', { n: charCount })}
          </span>
        )}
      </div>

      {linkQuery !== null ? (
        <div data-testid="note-link-menu" role="listbox" aria-label={t('noteEditor.linkSearch')} style={LINK_MENU}>
          <div style={LINK_MENU_TITLE}>{t('noteEditor.linkSearch')}</div>
          {candidates.length === 0 ? (
            <div data-testid="note-link-empty" style={LINK_MENU_EMPTY}>
              {t('noteEditor.linkEmpty')}
            </div>
          ) : (
            candidates.map((candidate, index) => (
              <div
                key={`${candidate.kind}-${candidate.id}`}
                data-testid={`note-link-option-${index}`}
                data-link-id={candidate.id}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertLink(candidate)}
                style={{ ...LINK_MENU_ITEM, ...(index === activeIndex ? LINK_MENU_ITEM_ACTIVE : null) }}
              >
                <span style={{ ...LINK_MENU_KIND }}>
                  {t(
                    candidate.kind === 'task'
                      ? 'noteEditor.kindTask'
                      : candidate.kind === 'milestone'
                        ? 'noteEditor.kindMilestone'
                        : 'noteEditor.kindDoc',
                  )}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{candidate.title}</span>
              </div>
            ))
          )}
        </div>
      ) : null}

      {rejectReason !== null ? (
        <div data-testid="note-asset-hint" role="status" style={ASSET_HINT}>
          {t(REJECT_KEY[rejectReason])}
        </div>
      ) : null}

      {lightbox !== null ? (
        <Lightbox
          open
          src={assetsRef.current?.resolve(lightbox.src) ?? lightbox.src}
          alt={lightbox.alt}
          filename={filenameOf(lightbox.src)}
          onClose={() => setLightbox(null)}
          t={t}
        />
      ) : null}
    </div>
  )
}

function filenameOf(src: string): string {
  const tail = src.slice(src.lastIndexOf('/') + 1)
  return tail === '' ? src : tail
}

const TOOLBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(2),
  flexWrap: 'wrap',
  padding: px('4px 6px'),
  borderBottom: `1px solid ${SEPARATOR}`,
  // 任务弹窗的外层会整体滚动；工具栏吸顶，长笔记里随时能加粗 / 插图
  position: 'sticky',
  top: 0,
  zIndex: 4,
  background: SURFACE,
  borderTopLeftRadius: RADIUS_CARD,
  borderTopRightRadius: RADIUS_CARD,
}

/** 正文容器：排版交给 theme.css 的 `.oe-prose`，这里只管盒模型（内边距/滚动由 CSS 承担）。 */
const NOTE_BODY: CSSProperties = {
  minWidth: 0,
  background: SURFACE,
}

const SOURCE_AREA: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  margin: 0,
  padding: px('12px 16px'),
  border: 'none',
  outline: 'none',
  color: TEXT,
  background: SURFACE,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  // 源码模式与富文本同一字号：切过去不该"字突然变大/变小"
  fontSize: 'var(--oe-note-font-size, calc(12px * var(--oe-ui-scale, 1)))',
  lineHeight: 1.75,
  tabSize: 2,
}

const STATUSBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: sp(8),
  flex: '0 0 auto',
  padding: px('2px 8px 3px'),
  borderTop: `1px solid ${SEPARATOR}`,
}

const MODE_BUTTON: CSSProperties = {
  padding: px('1px 6px'),
  fontSize: fs(10),
  lineHeight: 1.7,
  color: MUTED,
  background: 'transparent',
  border: `1px solid ${BORDER}`,
  borderRadius: RADIUS_CONTROL,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const MODE_BUTTON_ACTIVE: CSSProperties = {
  color: 'var(--oe-on-accent)',
  background: INDIGO,
  border: `1px solid ${INDIGO}`,
}

const STATUS_LEFT: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(8),
  minWidth: 0,
}

const FONT_CONTROLS: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(1),
}

const FONT_BUTTON: CSSProperties = {
  padding: px('1px 4px'),
  fontSize: fs(10),
  lineHeight: 1.7,
  fontFamily: 'inherit',
  color: MUTED,
  background: 'transparent',
  border: `1px solid ${BORDER}`,
  borderRadius: RADIUS_CONTROL,
  cursor: 'pointer',
  minWidth: sp(20),
}

/** 到边界就置灰：12px 再往下、20px 再往上都不是"更小的字"，是排版事故。 */
const FONT_BUTTON_OFF: CSSProperties = {
  color: 'var(--oe-text-faint)',
  cursor: 'default',
  opacity: 0.6,
}

const FONT_VALUE: CSSProperties = {
  minWidth: sp(16),
  textAlign: 'center',
  fontSize: fs(10),
  lineHeight: 1.7,
  color: MUTED,
  fontVariantNumeric: 'tabular-nums',
}

const STATS: CSSProperties = {
  fontSize: fs(10),
  color: MUTED,
  fontVariantNumeric: 'tabular-nums',
}

const TOOL_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: sp(24),
  height: sp(24),
  padding: 0,
  color: MUTED,
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: RADIUS_CONTROL,
  cursor: 'pointer',
}

const TOOL_BUTTON_ACTIVE: CSSProperties = {
  color: 'var(--oe-on-accent)',
  background: INDIGO,
  border: `1px solid ${INDIGO}`,
}

const LINK_MENU: CSSProperties = {
  position: 'absolute',
  left: sp(8),
  right: sp(8),
  bottom: sp(8),
  zIndex: 6,
  maxHeight: sp(180),
  overflowY: 'auto',
  padding: sp(6),
  display: 'flex',
  flexDirection: 'column',
  gap: sp(2),
  background: SURFACE,
  border: `1px solid ${SEPARATOR}`,
  borderRadius: RADIUS_OVERLAY,
  boxShadow: 'var(--oe-shadow-pop)',
}

const LINK_MENU_TITLE: CSSProperties = {
  padding: px('2px 6px'),
  fontSize: fs(10),
  color: MUTED,
}

const LINK_MENU_EMPTY: CSSProperties = {
  padding: px('6px'),
  fontSize: fs(11),
  color: MUTED,
}

const LINK_MENU_ITEM: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(6),
  padding: px('4px 6px'),
  fontSize: fs(11),
  color: TEXT,
  borderRadius: RADIUS_CONTROL,
  cursor: 'pointer',
}

const LINK_MENU_ITEM_ACTIVE: CSSProperties = {
  background: FILL,
}

const ASSET_HINT: CSSProperties = {
  position: 'absolute',
  left: sp(8),
  right: sp(8),
  bottom: sp(8),
  zIndex: 7,
  padding: px('4px 8px'),
  fontSize: fs(11),
  color: 'var(--oe-overdue)',
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: RADIUS_CONTROL,
}

const LINK_MENU_KIND: CSSProperties = {
  flex: '0 0 auto',
  fontSize: fs(10),
  color: MUTED,
}

export default NoteEditor
