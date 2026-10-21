// T24 · NoteEditor：任务笔记的富文本编辑器（spec 6.4）。
//
// 存储口径：`Task.note` 永远存 Markdown 纯文本（可读、可迁移、能被 Obsidian 直读）。
// 编辑器内部是 ProseMirror 文档，进出都经官方 @tiptap/markdown（MarkedJS）转换；
// 往返不丢内容的口径由 `roundTripNoteMarkdown()` 固化（导出供单测直接断言）。
//
// 三处刻意取舍（都是为了「不丢内容」或不越 T25 的界）：
//  1) 自补 SafeCodeBlock —— 官方 codeBlock 的 markdown 读写有两个已知缺陷（见其定义处注释），
//     会把嵌套围栏 / 前导空格的围栏代码块写坏或吞掉；这里覆写两个 handler 修掉。
//  2) 自补任务列表快捷语法 `[] ` —— StarterKit / TaskItem 3.32 未内置该输入规则（实测无 addInputRules）。
//  3) 图片只做「形态与接缝」—— assetStore.ts 是 T25 的产出，此处不 import 尚不存在的模块；
//     图片节点渲染成灰底 chip 而不是碎图，但 `![](assets/<id>.<ext>)` 语法原样往返。
//
// 写路径：编辑 debounce 后 onCommit（宿主用 patchTaskCommand 落库 → 进 CommandBus 撤销栈）；
// 组件自己不碰 store、不碰文件系统。撤销粒度 = 一个 debounce 窗口一条命令。
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangeEvent as ReactChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from 'react'

import { createI18n } from '../locales/i18n'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import type { AssetRejectReason } from '../persistence/assetStore'
import { Icon } from './IconSprite'
import type { IconName } from './IconSprite'
import { Lightbox } from './Lightbox'
import { fs, sp, px } from '../styles/scale'

const BORDER = 'var(--oe-border)'
const SEPARATOR = 'var(--oe-separator)'
const TEXT = 'var(--oe-text)'
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

interface NoteImageStorage {
  port: NoteImagePort | null
}

/**
 * NoteImageView：图片用 React 节点视图渲染，而不是 ProseMirror 的静态 renderHTML——
 * 因为 blob URL 是**异步**来的（getFile() → createObjectURL），静态 HTML 一旦画出来就没机会改 src；
 * 节点视图是 React 组件，能等通知重画。markdown 读写一字未动（节点视图只影响 DOM）。
 */
function NoteImageView({ node, extension }: NodeViewProps) {
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : ''
  const port = (extension.storage as NoteImageStorage).port
  const [url, setUrl] = useState<string | null>(() => port?.resolve?.(src) ?? null)

  useEffect(() => {
    const read = (): void => setUrl(port?.resolve?.(src) ?? null)
    read()
    if (typeof port?.subscribe !== 'function') return
    return port.subscribe(read)
  }, [src, port])

  const label = alt !== '' ? alt : src

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

  return (
    <NodeViewWrapper as="span">
      <img
        data-note-image={src}
        data-testid="note-image"
        src={url}
        alt={alt}
        onClick={() => port?.open?.(src, alt)}
        style={IMAGE_TAG}
      />
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

const IMAGE_TAG: CSSProperties = {
  maxWidth: '100%',
  height: 'auto',
  borderRadius: RADIUS_CONTROL,
  cursor: 'zoom-in',
  verticalAlign: 'middle',
}

function createNoteImage(port: NoteImagePort | null) {
  return Image.extend<object, NoteImageStorage>({
    addStorage() {
      return { port }
    },
    addNodeView() {
      return ReactNodeViewRenderer(NoteImageView)
    },
  })
}

/** 笔记编辑器的扩展集（导出供单测复用，保证测试与产品走同一套 schema）。 */
export function createNoteExtensions(port?: NoteImagePort) {
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
    Markdown,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit,
    createNoteImage(port ?? null),
    WikiLink,
    TaskListShortcut,
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

/** 双链候选：任务或里程碑。同名多任务时列表里会出现多条同 title 的候选。 */
export interface NoteLinkTarget {
  id: string
  kind: 'task' | 'milestone'
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
    extensions: createNoteExtensions(imagePort),
    content: props.value,
    contentType: 'markdown',
    // TipTap v3 默认「事务后不重渲染」；工具栏的 aria-pressed / 高亮要跟着选区与标记即时刷新，
    // 这里显式打开（笔记编辑器体量小，重渲染代价可忽略）。
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        'data-testid': 'note-editor-content',
        'aria-label': t('noteEditor.content'),
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

  // 外部值变化（撤销 / 重做 / 换任务）：非自身回声才写回编辑器
  useEffect(() => {
    const instance = editorRef.current
    if (instance === null) return
    if (props.value === lastSyncedRef.current) return
    suppressRef.current = true
    try {
      instance.commands.setContent(props.value, { contentType: 'markdown' })
      lastSyncedRef.current = instance.getMarkdown()
      latestRef.current = lastSyncedRef.current
    } finally {
      suppressRef.current = false
    }
    setLinkQuery(null)
    anchorRef.current = null
  }, [props.value])

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

  return (
    <div
      data-testid="note-editor"
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
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS_CARD,
        fontFamily: BODY_FONT,
        color: TEXT,
        ...props.style,
      }}
    >
      {editorReady ? (
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

      <EditorContent editor={editor} />

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
                <span style={{ ...LINK_MENU_KIND }}>{t(candidate.kind === 'task' ? 'noteEditor.kindTask' : 'noteEditor.kindMilestone')}</span>
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
