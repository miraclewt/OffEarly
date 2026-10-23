// T49 · NotebookView：知识库（笔记本 / 文档树 / 编辑区）。
//
// 形态对齐语雀「知识库」那一栏：左列是笔记本（一个库里可以有多本），中间是当前笔记本的
// 文档树（支持子文档），右侧是正文编辑区。三块之间没有隐藏状态——选中的笔记本 / 文档
// 全部是本地 UI state，数据一律来自 vault（唯一事实源），写入一律经 CommandBus。
//
// 三条与项目既有约定对齐的地方：
//  1) 正文复用 NoteEditor：Markdown 存储、图片三条插入路径、图片缩放、MD 源码模式全部
//     与任务笔记同一套实现（同一份往返口径，不在知识库里另造一个编辑器）。
//  2) `[[双链]]` 的候选池 = 文档 + 任务 + 里程碑：知识库里可以链任务，点开即任务弹窗；
//     文档之间互链则切换当前文档（App 只负责把任务 / 里程碑点击接出去）。
//  3) 删除是破坏性操作，走「两段确认」：第一次点变红并问一句，第二次才真删，3 秒后复位；
//     删除本身是一条命令，Ctrl+Z 能把整篇 / 整个笔记本连文档一起恢复。
//
// 边界：不改 App 以外的文件系统接线；不碰 topic/task 的写命令；文档正文不经本组件落盘，
// 由 NoteEditor 的 onCommit 调 applySaveDocContent（debounce 在编辑器里）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import dayjs from 'dayjs'

import {
  applyCreateDoc,
  applyCreateNotebook,
  applyDeleteDoc,
  applyDeleteNotebook,
  applyRenameDoc,
  applyMoveDoc,
  applyRenameNotebook,
  applySaveDocContent,
} from '../controllers/notebookActions'
import type { NotebookActionDeps } from '../controllers/notebookActions'
import { patchNoteFontSize } from '../controllers/settingsActions'
import type { CommandBus } from '../domain/commandBus'
import {
  buildDocTree,
  docPath,
  flattenDocTree,
  matchesDocQuery,
} from '../domain/notebookTree'
import { extractOutline, findBacklinks } from '../domain/noteOutline'
import type { DocNode } from '../domain/notebookTree'
import type { NoteDoc, Vault } from '../domain/types'
import { createI18n } from '../locales/i18n'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { Icon } from './IconSprite'
import { NoteEditor } from './NoteEditor'
import type { NoteAssetsPort, NoteLinkTarget } from './NoteEditor'
import {
  buildExportHtml,
  createAssetResolver,
  exportNotebookHtml,
  printHtmlDocument,
  sanitizeExportFilename,
} from './notebookExport'
import { triggerDownload } from './GanttExporter'
import type { ExportDocInput } from './notebookExport'
import { fs, px, sp } from '../styles/scale'

type Translate = (key: MsgKey, params?: TranslateParams) => string

const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const FAINT = 'var(--oe-text-faint)'
const SURFACE = 'var(--oe-surface)'
const SEPARATOR = 'var(--oe-separator)'
const INDIGO = 'var(--oe-accent)'
const ROW_SELECTED = 'var(--oe-row-selected)'
const ROW_HOVER = 'var(--oe-row-hover)'
const DANGER = 'var(--oe-overdue)'

/** 两段确认的复位时长：够第二下点，也够意识到「点错了」。 */
const ARM_MS = 3000
const NOTEBOOK_PANE_WIDTH = 176
const TREE_PANE_WIDTH = 248

const fallbackI18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })

export interface NotebookViewProps {
  vault: Vault
  bus: CommandBus
  t?: Translate
  assets?: NoteAssetsPort
  /** 注入 id / 时钟（测试确定化）。 */
  deps?: NotebookActionDeps
  /** 文档里的 `[[任务标题]]` 被点击。 */
  onOpenTask?: (taskId: string) => void
  /** 文档里的 `[[里程碑标题]]` 被点击。 */
  onOpenMilestone?: (milestoneId: string) => void
  /** 当前界面语言（导出文件的 `<html lang>` 与页脚文案）。 */
  locale?: 'zh' | 'en'
  /**
   * T59 · 外部指定要打开的文档（全局搜索命中后跳过来用）。
   * `nonce` 每次都变：同一篇文档连点两次也要重新定位并展开父级。
   */
  focusDoc?: { notebookId: string; docId: string; nonce: number } | null
}

/** 导出菜单的落点（T60 追加 markdown：交接与迁移要能拿到原文）。 */
type ExportKind = 'doc' | 'notebook' | 'print' | 'markdown'

type Editing =
  | { kind: 'notebook'; id: string }
  | { kind: 'notebook-create' }
  | { kind: 'doc'; id: string }

/** 行内输入：Enter 提交、Esc 取消、blur 提交（三路收尾，与 TaskDrawer 的 CommitInput 同款语义）。 */
function InlineInput(props: {
  testId: string
  ariaLabel: string
  initial: string
  placeholder?: string
  onCommit: (value: string) => void
  onCancel: () => void
  style?: CSSProperties
}): ReactElement {
  const [draft, setDraft] = useState(props.initial)
  const closedRef = useRef(false)

  const finish = (commit: boolean): void => {
    if (closedRef.current) return
    closedRef.current = true
    if (commit) props.onCommit(draft)
    else props.onCancel()
  }

  return (
    <input
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      autoFocus
      value={draft}
      placeholder={props.placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(false)
        }
      }}
      style={{ ...INLINE_INPUT, ...props.style }}
    />
  )
}

export function NotebookView(props: NotebookViewProps): ReactElement {
  const t = props.t ?? fallbackI18n.t
  const { vault, bus } = props
  const deps = props.deps ?? {}

  const [notebookId, setNotebookId] = useState<string | null>(null)
  const [docId, setDocId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  /**
   * T51 · 左两栏的折叠态（笔记本栏 / 文档树）：纯 UI 态，不进 vault、不进撤销栈——
   * 它描述的是「界面现在怎么摆」，不是「库里有什么」。与甘特左侧任务表（T39）同一口径：
   * 收起后只留一条 30px 竖轨，**展开入口就在竖轨上**（面板头部的按钮跟着面板一起消失，
   * 所以竖轨自身必须是可点的按钮，否则收起就成了单向操作）。
   */
  const [booksOpen, setBooksOpen] = useState(true)
  const [treeOpen, setTreeOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  /** T56 · 拖拽改父 / 换序：源行与落点提示（notebook 内一次性状态，不写库）。 */
  const [dragDocId, setDragDocId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; zone: 'before' | 'inside' | 'after' } | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  /** T50 · 导出菜单与进度（导出是异步的：读图 → 转 base64 → 渲染图 → 下载）。 */
  const [exportMenu, setExportMenu] = useState(false)
  /** T58 · 右侧阅读辅助栏（大纲 + 反向链接）。纯视图态，不落盘。 */
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [exporting, setExporting] = useState<ExportKind | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * 当前编辑器的实例：导出要取「用户刚打完、还在 400ms debounce 里」的内容。
   * 只读 vault.noteDocs 会导出上一版——这正是过去所有"导出的和屏幕上不一样"的根因。
   */
  const editorRef = useRef<Editor | null>(null)

  const notebooks = useMemo(
    () => [...vault.notebooks].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0)),
    [vault.notebooks],
  )

  /** 选中的笔记本：悬空（被删 / 撤销）时回退第一本，绝不出现「选中态空着、右边全空」。 */
  const activeNotebook = notebooks.find((notebook) => notebook.id === notebookId) ?? notebooks[0]
  const activeNotebookId = activeNotebook?.id ?? null

  const tree = useMemo(
    () => (activeNotebookId === null ? [] : buildDocTree(vault.noteDocs, activeNotebookId)),
    [vault.noteDocs, activeNotebookId],
  )
  const visibleRows = useMemo(() => flattenDocTree(tree, collapsed), [tree, collapsed])
  const notebookDocs = useMemo(
    () => (activeNotebookId === null ? [] : vault.noteDocs.filter((doc) => doc.notebookId === activeNotebookId)),
    [vault.noteDocs, activeNotebookId],
  )

  /** 选中的文档：悬空时回退当前笔记本第一篇。 */
  const activeDoc =
    vault.noteDocs.find((doc) => doc.id === docId && doc.notebookId === activeNotebookId) ?? notebookDocs[0]

  // T58：大纲与反向链接都从 Markdown 派生（正文的唯一事实源），不进 vault。
  const outline = useMemo(
    () => (activeDoc === undefined ? [] : extractOutline(activeDoc.content)),
    [activeDoc],
  )
  const backlinks = useMemo(
    () =>
      activeDoc === undefined ? [] : findBacklinks(vault.noteDocs, activeDoc.title, activeDoc.id),
    [activeDoc, vault.noteDocs],
  )

  /** 点大纲跳到编辑器里第 index 个标题；找不到就静默不动（正文可能刚被改短）。 */
  function jumpToHeading(index: number): void {
    const root = document.querySelector('[data-testid="note-editor-content"]')
    if (root === null) return
    const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6')
    headings[index]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const doc of vault.noteDocs) map.set(doc.notebookId, (map.get(doc.notebookId) ?? 0) + 1)
    return map
  }, [vault.noteDocs])

  const searching = query.trim() !== ''
  const results = useMemo(
    () => (searching ? vault.noteDocs.filter((doc) => matchesDocQuery(doc, query)).slice(0, 60) : []),
    [searching, vault.noteDocs, query],
  )

  /** 双链候选池：文档 + 任务 + 里程碑（文档之间可互链，任务 / 里程碑点开交给 App）。 */
  const linkTargets = useMemo<NoteLinkTarget[]>(
    () => [
      ...vault.noteDocs.map((doc) => ({ id: doc.id, kind: 'doc' as const, title: doc.title })),
      ...vault.tasks.map((task) => ({ id: task.id, kind: 'task' as const, title: task.title })),
      ...vault.milestones.map((item) => ({ id: item.id, kind: 'milestone' as const, title: item.title })),
    ],
    [vault.noteDocs, vault.tasks, vault.milestones],
  )

  // 选中变化即复位两段确认与标题草稿——避免「确认态」落到另一个对象上（误删）
  useEffect(() => {
    setArmed(null)
    setTitleDraft(null)
  }, [activeDoc?.id, activeNotebookId])

  useEffect(() => {
    if (armed === null) return
    const timer = window.setTimeout(() => setArmed(null), ARM_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

  // 导出结果提示自动消失（与图片插入失败的提示同一节奏）
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), ARM_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  /**
   * 导出用的 Markdown：优先取编辑器**当前**内容（含尚未 debounce 落盘的最后几个字），
   * 拿不到编辑器（还没挂载 / 已销毁）时退回库里的值。
   */
  function liveMarkdown(doc: NoteDoc): string {
    const instance = editorRef.current
    if (instance === null || doc.id !== activeDoc?.id) return doc.content
    try {
      return instance.getMarkdown()
    } catch {
      return doc.content
    }
  }

  /** 单篇 = 只有当前文档；整本 = 文档树的前序遍历（与左侧树看到的顺序一致）。 */
  function collectExportDocs(kind: ExportKind): ExportDocInput[] {
    if (activeDoc === undefined) return []
    if (kind !== 'notebook') {
      return [{ title: activeDoc.title, content: liveMarkdown(activeDoc), depth: 0 }]
    }
    return flattenDocTree(tree, new Set()).map((node) => ({
      title: node.doc.title,
      content: liveMarkdown(node.doc),
      depth: node.depth,
    }))
  }

  async function runExport(kind: ExportKind): Promise<void> {
    if (activeDoc === undefined || exporting !== null) return
    setExportMenu(false)
    // T60：Markdown 就是正文本身——不过 HTML 管线、不等图片解析，直接落一个 .md
    if (kind === 'markdown') {
      const content = liveMarkdown(activeDoc)
      const filename = `${sanitizeExportFilename(activeDoc.title, 'note')}.md`
      triggerDownload(new Blob([content], { type: 'text/markdown;charset=utf-8' }), filename)
      setNotice(t('notebook.exportDone', { name: filename }))
      return
    }
    setExporting(kind)
    const docs = collectExportDocs(kind)
    try {
      const request = {
        docs,
        meta: {
          appName: 'OffEarly',
          exportedAt: dayjs().format('YYYY-MM-DD HH:mm'),
          kind: kind === 'notebook' ? ('notebook' as const) : ('doc' as const),
          notebookName: activeNotebook?.name,
          locale: props.locale ?? 'zh',
        },
        resolveAsset: createAssetResolver(props.assets),
      }
      if (kind === 'print') {
        const { html } = await buildExportHtml(request)
        if (!printHtmlDocument(html)) setNotice(t('notebook.exportFailed'))
      } else {
        const result = await exportNotebookHtml(request)
        setNotice(t('notebook.exportDone', { name: result.filename }))
      }
    } catch {
      setNotice(t('notebook.exportFailed'))
    } finally {
      setExporting(null)
    }
  }

  const isArmed = (key: string): boolean => armed === key

  /** 第一次点变红确认，第二次点才真的删。 */
  function armOrRun(key: string, run: () => void): void {
    if (armed === key) {
      setArmed(null)
      run()
      return
    }
    setArmed(key)
  }

  const focusDoc = useCallback((nextNotebookId: string, nextDocId: string): void => {
    setNotebookId(nextNotebookId)
    setDocId(nextDocId)
    setQuery('')
    // 新建的文档可能在折叠的子树里 / 列表视口外：先展开父级，再滚进视野
    setCollapsed((prev) => {
      const next = new Set(prev)
      let cursor = nextDocId
      for (let guard = 0; guard < 64; guard += 1) {
        const doc = vault.noteDocs.find((candidate) => candidate.id === cursor)
        if (doc === undefined || doc.parentId === null) break
        next.delete(doc.parentId)
        cursor = doc.parentId
      }
      return next
    })
    window.requestAnimationFrame(() => {
      const row = document.querySelector(`[data-doc-id="${nextDocId}"]`)
      // jsdom 没有实现 scrollIntoView：别让「新建后滚进视野」变成测试里的未捕获异常
      if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'nearest' })
      }
    })
  }, [vault.noteDocs])

  // T59 · 全局搜索命中文档后跳过来：视图是被重新挂载的，所以这里既处理挂载首帧，
  // 也处理「已经在本视图里再搜一次」——靠 nonce 而不是 id 触发。
  const focusNonce = props.focusDoc?.nonce
  useEffect(() => {
    const target = props.focusDoc
    if (target === undefined || target === null) return
    focusDoc(target.notebookId, target.docId)
    // focusDoc 由 vault.noteDocs 派生；nonce 是「这一次」的唯一标识
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce])

  function createNotebook(name: string): void {
    const id = applyCreateNotebook(bus, vault, name, t('notebook.untitled'), deps)
    setNotebookId(id)
    setDocId(null)
    setEditing(null)
  }

  function createDoc(parentId: string | null): void {
    if (activeNotebookId === null) return
    const id = applyCreateDoc(
      bus,
      vault,
      { notebookId: activeNotebookId, parentId, fallbackTitle: t('notebook.untitledDoc') },
      deps,
    )
    setEditing(null)
    if (id !== null) focusDoc(activeNotebookId, id)
  }

  function renameDoc(doc: NoteDoc, title: string): void {
    setEditing(null)
    const trimmed = title.trim()
    if (trimmed === '') return
    applyRenameDoc(bus, vault, doc.id, trimmed, deps)
  }

  function deleteDoc(doc: NoteDoc): void {
    applyDeleteDoc(bus, vault, doc.id)
    if (docId === doc.id || activeDoc?.id === doc.id) setDocId(null)
  }

  function deleteNotebook(id: string): void {
    applyDeleteNotebook(bus, vault, id)
    setNotebookId(null)
    setDocId(null)
  }

  function handleLinkNavigate(_title: string, matches: readonly NoteLinkTarget[]): void {
    const doc = matches.find((match) => match.kind === 'doc')
    if (doc !== undefined) {
      const target = vault.noteDocs.find((candidate) => candidate.id === doc.id)
      if (target !== undefined) {
        focusDoc(target.notebookId, target.id)
        return
      }
    }
    const task = matches.find((match) => match.kind === 'task')
    if (task !== undefined) {
      props.onOpenTask?.(task.id)
      return
    }
    const milestone = matches.find((match) => match.kind === 'milestone')
    if (milestone !== undefined) props.onOpenMilestone?.(milestone.id)
  }

  // ── 没有笔记本：整页空态（唯一的写入口） ─────────────────────────────────
  if (notebooks.length === 0) {
    return (
      <div data-testid="notebook-empty" style={EMPTY_PAGE}>
        <div style={{ maxWidth: sp(380), textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', color: MUTED }}>
            <Icon name="notebook" size={28} />
          </div>
          <div style={{ marginTop: sp(12), fontSize: fs(14), fontWeight: 600, color: TEXT }}>
            {t('notebook.emptyTitle')}
          </div>
          <p style={{ margin: px('8px 0 16px'), fontSize: fs(12), lineHeight: 1.7, color: MUTED }}>
            {t('notebook.emptyHint')}
          </p>
          {editing !== null && editing.kind === 'notebook-create' ? (
            <InlineInput
              testId="notebook-name-input"
              ariaLabel={t('notebook.namePlaceholder')}
              initial=""
              placeholder={t('notebook.namePlaceholder')}
              onCommit={createNotebook}
              onCancel={() => setEditing(null)}
              style={{ textAlign: 'center' }}
            />
          ) : (
            <button
              type="button"
              data-testid="notebook-create-empty"
              onClick={() => setEditing({ kind: 'notebook-create' })}
              style={PRIMARY_BUTTON}
            >
              {t('notebook.create')}
            </button>
          )}
        </div>
      </div>
    )
  }

  const editingDocId = editing !== null && editing.kind === 'doc' ? editing.id : null

  return (
    <div data-testid="notebook" style={ROOT}>
      {/* ① 笔记本：可收起（T51）——收起后留竖轨，正文能多吃 176px 宽 */}
      {booksOpen ? (
        <aside data-testid="notebook-books-pane" style={PANE_NOTEBOOKS}>
          <div style={PANE_HEAD}>
            <span style={PANE_TITLE}>{t('notebook.title')}</span>
            <button
              type="button"
              data-testid="notebook-add"
              aria-label={t('notebook.create')}
              title={t('notebook.create')}
              onClick={() => setEditing({ kind: 'notebook-create' })}
              style={ICON_BUTTON}
            >
              <Icon name="plus" size={13} />
            </button>
            <PaneToggle
              testId="notebook-books-collapse"
              label={t('notebook.collapseBooks')}
              onCollapse={() => setBooksOpen(false)}
            />
          </div>

          <div role="list" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: px('0 6px 8px') }}>
            {notebooks.map((notebook) => {
              const active = notebook.id === activeNotebook?.id
              const rowId = `nb:${notebook.id}`
              return (
                <div key={notebook.id}>
                  {editing !== null && editing.kind === 'notebook' && editing.id === notebook.id ? (
                    <InlineInput
                      testId="notebook-name-input"
                      ariaLabel={t('notebook.rename')}
                      initial={notebook.name}
                      onCommit={(value) => {
                        setEditing(null)
                        if (value.trim() !== '') applyRenameNotebook(bus, vault, notebook.id, value, deps)
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <div
                      role="button"
                      tabIndex={0}
                      data-testid={`notebook-row-${notebook.id}`}
                      aria-current={active ? 'true' : undefined}
                      onMouseEnter={() => setHover(rowId)}
                      onMouseLeave={() => setHover((current) => (current === rowId ? null : current))}
                      onClick={() => {
                        setNotebookId(notebook.id)
                        setDocId(null)
                      }}
                      onDoubleClick={() => setEditing({ kind: 'notebook', id: notebook.id })}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        setNotebookId(notebook.id)
                        setDocId(null)
                      }}
                      style={{ ...NB_ROW, ...(hover === rowId && !active ? { background: ROW_HOVER } : null), ...(active ? NB_ROW_ACTIVE : null) }}
                    >
                      <span style={{ display: 'flex', flex: '0 0 auto', color: active ? INDIGO : FAINT }}>
                        <Icon name="notebook" size={14} />
                      </span>
                      <span style={ELLIPSIS}>{notebook.name}</span>
                      {hover === rowId || active ? (
                        <span style={{ display: 'flex', gap: sp(2), flex: '0 0 auto' }}>
                          <button
                            type="button"
                            data-testid={`notebook-rename-${notebook.id}`}
                            aria-label={t('notebook.rename')}
                            title={t('notebook.rename')}
                            onClick={(event) => {
                              event.stopPropagation()
                              setEditing({ kind: 'notebook', id: notebook.id })
                            }}
                            style={ROW_ACTION}
                          >
                            <Icon name="pencil" size={11} />
                          </button>
                          <button
                            type="button"
                            data-testid={`notebook-delete-${notebook.id}`}
                            aria-label={isArmed(rowId) ? t('notebook.confirmDelete') : t('notebook.delete')}
                            title={isArmed(rowId) ? t('notebook.confirmDelete') : t('notebook.delete')}
                            onClick={(event) => {
                              event.stopPropagation()
                              armOrRun(rowId, () => deleteNotebook(notebook.id))
                            }}
                            style={{ ...ROW_ACTION, ...(isArmed(rowId) ? { color: DANGER } : null) }}
                          >
                            <Icon name={isArmed(rowId) ? 'close' : 'trash'} size={11} />
                          </button>
                        </span>
                      ) : (
                        <span style={{ ...COUNT, flex: '0 0 auto' }}>{counts.get(notebook.id) ?? 0}</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {editing !== null && editing.kind === 'notebook-create' ? (
              <InlineInput
                testId="notebook-name-input"
                ariaLabel={t('notebook.namePlaceholder')}
                initial=""
                placeholder={t('notebook.namePlaceholder')}
                onCommit={createNotebook}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </div>
        </aside>
      ) : (
        <PaneRail
          testId="notebook-books-rail"
          label={t('notebook.title')}
          hint={t('notebook.expandBooks')}
          background="var(--oe-material-sidebar)"
          onExpand={() => setBooksOpen(true)}
        />
      )}

      {/* ② 文档树：同样可收起 */}
      {treeOpen ? (
        <aside data-testid="notebook-tree-pane" style={PANE_TREE}>
          <div style={PANE_HEAD}>
            <span style={{ ...PANE_TITLE, ...ELLIPSIS }}>{activeNotebook?.name ?? ''}</span>
            <span style={COUNT}>{notebookDocs.length}</span>
            <button
              type="button"
              data-testid="notebook-new-doc"
              aria-label={t('notebook.newDoc')}
              title={t('notebook.newDoc')}
              onClick={() => createDoc(null)}
              style={ICON_BUTTON}
            >
              <Icon name="plus" size={13} />
            </button>
            <PaneToggle
              testId="notebook-tree-collapse"
              label={t('notebook.collapseTree')}
              onCollapse={() => setTreeOpen(false)}
            />
          </div>

          <div style={{ padding: px('0 8px 6px') }}>
            <div style={SEARCH_BOX}>
              <span style={{ display: 'flex', flex: '0 0 auto', color: FAINT }}>
                <Icon name="search" size={12} />
              </span>
              <input
                data-testid="notebook-search"
                type="search"
                value={query}
                placeholder={t('notebook.searchPlaceholder')}
                aria-label={t('notebook.search')}
                onChange={(event) => setQuery(event.target.value)}
                style={SEARCH_INPUT}
              />
            </div>
          </div>

          <div role="tree" data-testid="notebook-tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: px('0 6px 10px') }}>
            {searching ? (
              results.length === 0 ? (
                <div data-testid="notebook-search-empty" style={HINT}>
                  {t('notebook.searchEmpty')}
                </div>
              ) : (
                results.map((doc) => {
                  const notebookName = vault.notebooks.find((item) => item.id === doc.notebookId)?.name ?? ''
                  return (
                    <div
                      key={doc.id}
                      role="treeitem"
                      tabIndex={0}
                      data-testid={`notebook-search-result-${doc.id}`}
                      onClick={() => focusDoc(doc.notebookId, doc.id)}
                      style={{ ...DOC_ROW, paddingLeft: sp(8) }}
                    >
                      <span style={{ display: 'flex', flex: '0 0 auto', color: FAINT }}>
                        <Icon name="doc" size={13} />
                      </span>
                      <span style={{ ...ELLIPSIS, flex: 1 }}>{doc.title}</span>
                      <span style={{ ...COUNT, maxWidth: sp(72), ...ELLIPSIS }}>{notebookName}</span>
                    </div>
                  )
                })
              )
            ) : (
              <>
                {visibleRows.map((node) => renderDocRow(node, {
                  active: node.doc.id === activeDoc?.id,
                  isEditing: editingDocId === node.doc.id,
                  collapsed: collapsed.has(node.doc.id),
                }))}
                {visibleRows.length === 0 ? (
                  <div data-testid="notebook-tree-empty" style={HINT}>
                    {t('notebook.noDocs')}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>
      ) : (
        <PaneRail
          testId="notebook-tree-rail"
          label={t('notebook.railTree')}
          hint={t('notebook.expandTree')}
          background={SURFACE}
          onExpand={() => setTreeOpen(true)}
        />
      )}

      {/* ③ 编辑区 */}
      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--oe-bg)' }}>
        {activeDoc === undefined ? (
          <div data-testid="notebook-editor-empty" style={EMPTY_PAGE}>
            <div style={{ textAlign: 'center', maxWidth: sp(360) }}>
              <div style={{ display: 'flex', justifyContent: 'center', color: MUTED }}>
                <Icon name="doc" size={26} />
              </div>
              <div style={{ marginTop: sp(10), fontSize: fs(14), fontWeight: 600, color: TEXT }}>{t('notebook.emptyDocTitle')}</div>
              <p style={{ margin: px('6px 0 14px'), fontSize: fs(12), lineHeight: 1.7, color: MUTED }}>{t('notebook.emptyDocHint')}</p>
              <button type="button" data-testid="notebook-empty-new-doc" onClick={() => createDoc(null)} style={PRIMARY_BUTTON}>
                {t('notebook.newDoc')}
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              padding: px('10px 16px 14px'),
              // T57 · 阅读宽度上限：宽屏下正文不再一路铺到 1900px。
              // 整列（面包屑 / 标题 / 正文 / 工具栏）一起收，这样标题左缘与正文左缘仍然对齐；
              // 用 margin auto 居中，而不是靠左留一条空右边。
              maxWidth: sp(NOTE_READING_WIDTH),
              width: '100%',
              margin: '0 auto',
            }}
          >
            <div data-testid="notebook-breadcrumb" style={BREADCRUMB}>
              <span style={{ ...ELLIPSIS, color: MUTED }}>{activeNotebook?.name ?? ''}</span>
              {docPath(vault.noteDocs, activeDoc.id).slice(0, -1).map((doc) => (
                <span key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: sp(4), minWidth: 0 }}>
                  <span style={{ color: FAINT }}>/</span>
                  <button
                    type="button"
                    onClick={() => focusDoc(activeDoc.notebookId, doc.id)}
                    style={BREADCRUMB_LINK}
                  >
                    {doc.title}
                  </button>
                </span>
              ))}
              {/* 当前文档标题就在下面一行的标题输入框里，面包屑不再重复一遍 */}
              <span style={{ flex: 1 }} />
              <span data-testid="notebook-doc-meta" style={COUNT}>
                {t('notebook.updatedAt', { date: activeDoc.updatedAt.slice(0, 10) })}
              </span>
              {/* T50：导出入库。菜单挂在按钮下方，backdrop 负责「点外面就关」。 */}
              {/* T58：大纲 + 反向链接是一个可选右栏，默认收起——阅读时它不该占宽 */}
              <button
                type="button"
                data-testid="notebook-outline-toggle"
                aria-pressed={outlineOpen}
                aria-label={t('notebook.outline')}
                title={t('notebook.outline')}
                onClick={() => setOutlineOpen((open) => !open)}
                style={
                  outlineOpen
                    ? { ...EXPORT_BUTTON, color: INDIGO, background: 'var(--oe-accent-tint)' }
                    : EXPORT_BUTTON
                }
              >
                <Icon name="outline" size={12} />
              </button>
              <span style={{ position: 'relative', display: 'flex', flex: '0 0 auto' }}>
                <button
                  type="button"
                  data-testid="notebook-export"
                  aria-haspopup="menu"
                  aria-expanded={exportMenu}
                  title={t('notebook.export')}
                  disabled={exporting !== null}
                  onClick={() => setExportMenu((open) => !open)}
                  style={EXPORT_BUTTON}
                >
                  <Icon name="export" size={12} />
                  <span>{exporting === null ? t('notebook.export') : t('notebook.exporting')}</span>
                </button>
                {exportMenu ? (
                  <>
                    <div
                      data-testid="notebook-export-backdrop"
                      onMouseDown={() => setExportMenu(false)}
                      style={MENU_BACKDROP}
                    />
                    <div role="menu" data-testid="notebook-export-menu" style={EXPORT_MENU}>
                      <div style={EXPORT_MENU_HINT}>{t('notebook.exportHint')}</div>
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="notebook-export-doc"
                        onClick={() => void runExport('doc')}
                        style={EXPORT_MENU_ITEM}
                      >
                        {t('notebook.exportDoc')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="notebook-export-notebook"
                        onClick={() => void runExport('notebook')}
                        style={EXPORT_MENU_ITEM}
                      >
                        {t('notebook.exportNotebook')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="notebook-export-markdown"
                        onClick={() => void runExport('markdown')}
                        style={EXPORT_MENU_ITEM}
                      >
                        {t('notebook.exportMarkdown')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="notebook-export-print"
                        onClick={() => void runExport('print')}
                        style={EXPORT_MENU_ITEM}
                      >
                        {t('notebook.exportPrint')}
                      </button>
                    </div>
                  </>
                ) : null}
              </span>
            </div>

            <input
              data-testid="notebook-title-input"
              aria-label={t('notebook.docTitle')}
              value={titleDraft ?? activeDoc.title}
              placeholder={t('notebook.untitledDoc')}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => {
                if (titleDraft !== null) renameDoc(activeDoc, titleDraft)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  renameDoc(activeDoc, titleDraft ?? activeDoc.title)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setTitleDraft(null)
                }
              }}
              style={TITLE_INPUT}
            />

            <div style={{ flex: 1, minHeight: 0, display: 'flex', marginTop: sp(8) }}>
              <NoteEditor
                key={activeDoc.id}
                value={activeDoc.content}
                onCommit={(markdown) => {
                  applySaveDocContent(bus, vault, activeDoc.id, markdown, deps)
                }}
                linkTargets={linkTargets}
                onNavigate={handleLinkNavigate}
                assets={props.assets}
                t={t}
                placeholder={t('notebook.docPlaceholder')}
                minHeight={220}
                grow
                // T50：字号与任务笔记共用同一个设置值；调完立刻写回 settings（可撤销）
                fontSize={vault.settings.noteFontSize}
                onFontSizeChange={(size) => patchNoteFontSize(bus, vault, size)}
                // 导出要取"屏幕上这一刻"的内容，而不是上一次落盘的内容
                onReady={(instance) => {
                  if (instance !== null) editorRef.current = instance
                }}
                style={{ flex: 1, minHeight: 0 }}
              />
            </div>
          </div>
        )}
      </main>

      {outlineOpen && activeDoc !== undefined ? (
        <aside data-testid="notebook-outline-panel" style={RAIL_PANEL}>
          <div>
            <div style={RAIL_TITLE}>{t('notebook.outline')}</div>
            {outline.length === 0 ? (
              <p style={RAIL_EMPTY}>{t('notebook.outlineEmpty')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: sp(1), marginTop: sp(4) }}>
                {outline.map((item) => (
                  <button
                    key={item.index}
                    type="button"
                    data-testid={`notebook-outline-item-${item.index}`}
                    title={item.text}
                    onClick={() => jumpToHeading(item.index)}
                    style={{
                      ...RAIL_ITEM,
                      paddingLeft: sp(6 + (item.level - 1) * 10),
                      fontWeight: item.level <= 2 ? 550 : 400,
                      color: item.level <= 2 ? TEXT : SECONDARY,
                    }}
                  >
                    {item.text}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ borderTop: '1px solid var(--oe-separator)', paddingTop: sp(8) }}>
            <div style={RAIL_TITLE}>{t('notebook.backlinks')}</div>
            {backlinks.length === 0 ? (
              <p style={RAIL_EMPTY}>{t('notebook.backlinksEmpty')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: sp(1), marginTop: sp(4) }}>
                {backlinks.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`notebook-backlink-${item.id}`}
                    title={item.title}
                    onClick={() => {
                      const target = vault.noteDocs.find((doc) => doc.id === item.id)
                      if (target !== undefined) focusDoc(target.notebookId, target.id)
                    }}
                    style={RAIL_ITEM}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
      ) : null}

      {notice === null ? null : (
        <div data-testid="notebook-export-notice" role="status" style={TOAST}>
          {notice}
        </div>
      )}
    </div>
  )

  /** 文档树的一行：折叠箭头 / 图标 / 标题 / 行内动作（加子文档、改名、删除）。 */
  function renderDocRow(
    node: DocNode,
    state: { active: boolean; isEditing: boolean; collapsed: boolean },
  ): ReactNode {
    const doc = node.doc
    const rowKey = `doc:${doc.id}`
    const hasChildren = node.children.length > 0
    const armedNow = isArmed(rowKey)
    // T56：同级序列（含自己）。折叠子树不在 visibleRows 里，这不影响「同级」的判定——
    // 同级兄弟无论展开与否都是 depth === node.depth 的那几行。
    const siblingIds = ((): string[] => {
      const start = visibleRows.findIndex((row) => row.doc.id === doc.id)
      if (start < 0) return []
      const out: string[] = []
      for (let i = start - 1; i >= 0; i -= 1) {
        const row = visibleRows[i]!
        if (row.depth < node.depth) break
        if (row.depth === node.depth) out.unshift(row.doc.id)
      }
      out.push(doc.id)
      for (let i = start + 1; i < visibleRows.length; i += 1) {
        const row = visibleRows[i]!
        if (row.depth < node.depth) break
        if (row.depth === node.depth) out.push(row.doc.id)
      }
      return out
    })()
    const selfAt = siblingIds.indexOf(doc.id)
    const nextSiblingId = selfAt >= 0 ? (siblingIds[selfAt + 1] ?? null) : null
    const hint = dropHint?.id === doc.id ? dropHint.zone : null
    if (state.isEditing) {
      return (
        <div key={doc.id} style={{ paddingLeft: sp(node.depth * 12) }}>
          <InlineInput
            testId="doc-name-input"
            ariaLabel={t('notebook.renameDoc')}
            initial={doc.title}
            onCommit={(value) => renameDoc(doc, value)}
            onCancel={() => setEditing(null)}
          />
        </div>
      )
    }
    return (
      <div
        key={doc.id}
        role="treeitem"
        aria-level={node.depth + 1}
        aria-selected={state.active}
        aria-expanded={hasChildren ? !state.collapsed : undefined}
        tabIndex={0}
        draggable
        data-testid={`doc-row-${doc.id}`}
        data-doc-id={doc.id}
        data-drop-hint={hint ?? undefined}
        onMouseEnter={() => setHover(rowKey)}
        onMouseLeave={() => setHover((current) => (current === rowKey ? null : current))}
        onClick={() => {
          setDocId(doc.id)
          setTitleDraft(null)
        }}
        onDoubleClick={() => setEditing({ kind: 'doc', id: doc.id })}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', doc.id)
          event.dataTransfer.effectAllowed = 'move'
          setDragDocId(doc.id)
        }}
        onDragEnd={() => {
          setDragDocId(null)
          setDropHint(null)
        }}
        onDragOver={(event) => {
          if (dragDocId === null || dragDocId === doc.id) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          // 上/下 28% 是「插到它前面/后面」，中间是「成为它的子文档」——和文件管理器的三段落点同口径
          const rect = event.currentTarget.getBoundingClientRect()
          const ratio = rect.height === 0 ? 0.5 : (event.clientY - rect.top) / rect.height
          const zone = ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'inside'
          setDropHint((current) =>
            current?.id === doc.id && current.zone === zone ? current : { id: doc.id, zone },
          )
        }}
        onDragLeave={() => setDropHint((current) => (current?.id === doc.id ? null : current))}
        onDrop={(event) => {
          event.preventDefault()
          const source = dragDocId ?? event.dataTransfer.getData('text/plain')
          const zone = hint ?? 'inside'
          setDragDocId(null)
          setDropHint(null)
          if (source === '' || source === doc.id) return
          if (zone === 'inside') {
            applyMoveDoc(bus, vault, source, { parentId: doc.id, beforeId: null })
            return
          }
          applyMoveDoc(bus, vault, source, {
            parentId: doc.parentId,
            beforeId: zone === 'before' ? doc.id : nextSiblingId,
          })
        }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            setDocId(doc.id)
          } else if (event.key === 'F2') {
            event.preventDefault()
            setEditing({ kind: 'doc', id: doc.id })
          } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            // 键盘换序：Alt+↑/↓ 与鼠标拖拽是同一个落点模型（beforeId 而不是「交换」），
            // 因为 order 是连续键，交换会破坏 LexoRank 的局部性。
            event.preventDefault()
            if (selfAt < 0) return
            if (event.key === 'ArrowUp' && selfAt > 0) {
              applyMoveDoc(bus, vault, doc.id, {
                parentId: doc.parentId,
                beforeId: siblingIds[selfAt - 2] ?? null,
              })
            } else if (event.key === 'ArrowDown' && selfAt < siblingIds.length - 1) {
              applyMoveDoc(bus, vault, doc.id, {
                parentId: doc.parentId,
                beforeId: siblingIds[selfAt + 2] ?? null,
              })
            }
          }
        }}
        style={{
          ...DOC_ROW,
          paddingLeft: sp(4 + node.depth * 12),
          ...(dragDocId === doc.id ? { opacity: 0.45 } : null),
          ...(hint === 'before' ? { boxShadow: 'inset 0 2px 0 0 var(--oe-accent)' } : null),
          ...(hint === 'after' ? { boxShadow: 'inset 0 -2px 0 0 var(--oe-accent)' } : null),
          ...(hint === 'inside' ? { background: 'var(--oe-accent-tint)' } : null),
          ...(hover === rowKey && !state.active && hint === null ? { background: ROW_HOVER } : null),
          ...(state.active && hint === null ? DOC_ROW_ACTIVE : null),
        }}
      >
        <button
          type="button"
          data-testid={`doc-toggle-${doc.id}`}
          aria-label={state.collapsed ? t('notebook.expand') : t('notebook.collapse')}
          onClick={(event) => {
            event.stopPropagation()
            setCollapsed((prev) => {
              const next = new Set(prev)
              if (next.has(doc.id)) next.delete(doc.id)
              else next.add(doc.id)
              return next
            })
          }}
          style={{ ...ROW_ACTION, visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          <Icon name={state.collapsed ? 'chevron-right' : 'chevron'} size={11} />
        </button>
        <span style={{ display: 'flex', flex: '0 0 auto', color: state.active ? INDIGO : FAINT }}>
          <Icon name={hasChildren ? 'folder' : 'doc'} size={13} />
        </span>
        <span style={{ ...ELLIPSIS, flex: 1 }}>{doc.title}</span>
        {hover === rowKey || state.active ? (
          <span style={{ display: 'flex', gap: sp(1), flex: '0 0 auto' }}>
            <button
              type="button"
              data-testid={`doc-add-child-${doc.id}`}
              aria-label={t('notebook.newChildDoc')}
              title={t('notebook.newChildDoc')}
              onClick={(event) => {
                event.stopPropagation()
                createDoc(doc.id)
              }}
              style={ROW_ACTION}
            >
              <Icon name="plus" size={11} />
            </button>
            <button
              type="button"
              data-testid={`doc-rename-${doc.id}`}
              aria-label={t('notebook.renameDoc')}
              title={t('notebook.renameDoc')}
              onClick={(event) => {
                event.stopPropagation()
                setEditing({ kind: 'doc', id: doc.id })
              }}
              style={ROW_ACTION}
            >
              <Icon name="pencil" size={11} />
            </button>
            <button
              type="button"
              data-testid={`doc-delete-${doc.id}`}
              aria-label={armedNow ? t('notebook.confirmDelete') : t('notebook.deleteDoc')}
              title={armedNow ? t('notebook.confirmDelete') : t('notebook.deleteDoc')}
              onClick={(event) => {
                event.stopPropagation()
                armOrRun(rowKey, () => deleteDoc(doc))
              }}
              style={{ ...ROW_ACTION, ...(armedNow ? { color: DANGER } : null) }}
            >
              <Icon name={armedNow ? 'close' : 'trash'} size={11} />
            </button>
          </span>
        ) : null}
      </div>
    )
  }


}

/**
 * T51 · 面板头部的折叠按钮：常驻但不抢戏——平时静音，悬停才给底色与正文色。
 * 用一个极小的本地 hover state 而不是 CSS `:hover`，与侧栏 / 文档行（同一文件的 `hover`）保持一套写法。
 */
function PaneToggle(props: { testId: string; label: string; onCollapse: () => void }): ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-expanded={true}
      aria-label={props.label}
      title={props.label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={props.onCollapse}
      style={{
        ...COLLAPSE_BUTTON,
        color: hover ? TEXT : MUTED,
        background: hover ? ROW_HOVER : 'transparent',
      }}
    >
      <span aria-hidden="true" style={CHEVRON_LEFT}>
        <Icon name="chevron-right" size={12} />
      </span>
    </button>
  )
}

/**
 * T51 · 面板收起后的竖轨（30px）：一个朝右的箭头 + 竖排标签，整条轨道本身就是一个按钮。
 *
 * 只做「点一下把那一栏换回来」这一件事：收起时面板头部的折叠按钮跟着面板一起消失了，
 * 所以展开入口必须落在这里，否则收起就是单向的。键盘可达性天然由 `<button>` 提供。
 */
function PaneRail(props: {
  testId: string
  label: string
  hint: string
  background: string
  onExpand: () => void
}): ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-expanded={false}
      aria-label={props.hint}
      title={props.hint}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={props.onExpand}
      style={{ ...RAIL, background: hover ? ROW_HOVER : props.background }}
    >
      <span aria-hidden="true" style={{ display: 'inline-flex', color: INDIGO }}>
        <Icon name="chevron-right" size={12} />
      </span>
      <span
        aria-hidden="true"
        style={{
          writingMode: 'vertical-rl',
          fontSize: fs(11),
          letterSpacing: sp(2),
          color: hover ? TEXT : MUTED,
        }}
      >
        {props.label}
      </span>
    </button>
  )
}

// ── 样式 ────────────────────────────────────────────────────────────────

const ROOT: CSSProperties = {
  display: 'flex',
  height: '100%',
  minHeight: 0,
  position: 'relative',
  fontFamily: 'var(--oe-font)',
  color: TEXT,
}

const PANE_NOTEBOOKS: CSSProperties = {
  width: sp(NOTEBOOK_PANE_WIDTH),
  flex: `0 0 ${sp(NOTEBOOK_PANE_WIDTH)}`,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  borderRight: `1px solid ${SEPARATOR}`,
  background: 'var(--oe-material-sidebar)',
}

const PANE_TREE: CSSProperties = {
  width: sp(TREE_PANE_WIDTH),
  flex: `0 0 ${sp(TREE_PANE_WIDTH)}`,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  borderRight: `1px solid ${SEPARATOR}`,
  background: SURFACE,
}

/** T51 · 收起后的竖轨宽度：与甘特任务表（T39）的 30px 竖轨同宽，两处收起看起来是一套语言。 */
const RAIL_WIDTH = 30

/** 收起后的竖轨：整条轨道是一个按钮（展开入口），因此要抹掉 button 的默认外观。 */
const RAIL: CSSProperties = {
  width: sp(RAIL_WIDTH),
  flex: `0 0 ${sp(RAIL_WIDTH)}`,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: sp(10),
  padding: px('10px 0'),
  boxSizing: 'border-box',
  border: 'none',
  borderRight: `1px solid ${SEPARATOR}`,
  background: SURFACE,
  color: MUTED,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

/** 面板头部的折叠按钮：压到 18px，紧跟在右侧的 + 号后面，不抢标题的位置。 */
const COLLAPSE_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: sp(18),
  height: sp(18),
  padding: 0,
  color: MUTED,
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  flex: '0 0 auto',
}

/** 「收起」= 朝左的箭头：把同一份 chevron-right 几何转 180°，不另造图标。 */
const CHEVRON_LEFT: CSSProperties = {
  display: 'inline-flex',
  transform: 'rotate(180deg)',
  transition: 'transform 120ms ease',
}

const PANE_HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(6),
  flex: '0 0 auto',
  padding: px('10px 8px 6px 10px'),
}

const PANE_TITLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: fs(11),
  fontWeight: 650,
  letterSpacing: '0.02em',
  color: FAINT,
}

const NB_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(6),
  padding: px('5px 6px'),
  borderRadius: 'var(--oe-radius-control)',
  fontSize: fs(12),
  color: SECONDARY,
  cursor: 'pointer',
  minWidth: 0,
}

const NB_ROW_ACTIVE: CSSProperties = {
  background: ROW_SELECTED,
  color: TEXT,
  fontWeight: 550,
}

const DOC_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(4),
  minHeight: sp(24),
  padding: px('2px 4px'),
  borderRadius: 'var(--oe-radius-control)',
  fontSize: fs(12),
  color: SECONDARY,
  cursor: 'pointer',
  minWidth: 0,
}

const DOC_ROW_ACTIVE: CSSProperties = {
  background: ROW_SELECTED,
  color: TEXT,
  fontWeight: 550,
}

const ROW_ACTION: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: sp(18),
  height: sp(18),
  padding: 0,
  color: MUTED,
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  flex: '0 0 auto',
}

const ICON_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: sp(20),
  height: sp(20),
  padding: 0,
  color: INDIGO,
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  flex: '0 0 auto',
}

/**
 * T57 · 正文阅读宽度上限（逻辑像素，随 uiScale 缩放）。
 * 760 是「13px 字号下约 55 个汉字 + 表格/代码不吃紧」的折中：比 700 宽一点，
 * 长表格不至于横向挤；再宽就回到「一行读不完」的老问题。
 */
const NOTE_READING_WIDTH = 760

/** T58 · 右侧阅读辅助栏：默认不占宽，展开后固定 196px，两个分区共用一套行样式。 */
const RAIL_PANEL: CSSProperties = {
  width: sp(196),
  flex: '0 0 auto',
  borderLeft: '1px solid var(--oe-separator)',
  padding: px('10px 10px 14px'),
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: sp(10),
  background: SURFACE,
}

const RAIL_TITLE: CSSProperties = {
  fontSize: fs(11),
  fontWeight: 650,
  color: MUTED,
}

const RAIL_ITEM: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 'none',
  background: 'transparent',
  padding: px('3px 6px'),
  borderRadius: 'var(--oe-radius-control)',
  fontSize: fs(12),
  color: SECONDARY,
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const RAIL_EMPTY: CSSProperties = {
  margin: px('4px 0 0'),
  fontSize: fs(11),
  color: FAINT,
  lineHeight: 1.6,
}

const ELLIPSIS: CSSProperties = {  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
}

const COUNT: CSSProperties = {
  fontSize: fs(10),
  color: FAINT,
  fontVariantNumeric: 'tabular-nums',
}

const INLINE_INPUT: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: px('3px 6px'),
  fontSize: fs(12),
  color: TEXT,
  background: SURFACE,
  border: `1px solid ${INDIGO}`,
  borderRadius: 'var(--oe-radius-control)',
  outline: 'none',
  fontFamily: 'inherit',
}

const SEARCH_BOX: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(5),
  padding: px('0 8px'),
  height: sp(24),
  background: 'var(--oe-fill)',
  borderRadius: 'var(--oe-radius-control)',
}

const SEARCH_INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: 0,
  fontSize: fs(11),
  color: TEXT,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  fontFamily: 'inherit',
}

const HINT: CSSProperties = {
  padding: px('10px 8px'),
  fontSize: fs(11),
  lineHeight: 1.7,
  color: MUTED,
}

const BREADCRUMB: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(4),
  flex: '0 0 auto',
  fontSize: fs(11),
  color: MUTED,
  minHeight: sp(20),
}

const BREADCRUMB_LINK: CSSProperties = {
  padding: 0,
  maxWidth: sp(140),
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: fs(11),
  color: MUTED,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const TITLE_INPUT: CSSProperties = {
  flex: '0 0 auto',
  width: '100%',
  boxSizing: 'border-box',
  marginTop: sp(2),
  padding: px('2px 0'),
  fontSize: fs(20),
  fontWeight: 650,
  letterSpacing: '-0.01em',
  lineHeight: 1.35,
  color: TEXT,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  fontFamily: 'inherit',
}

const EMPTY_PAGE: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  flex: 1,
  minHeight: 0,
  padding: sp(24),
  color: TEXT,
}

const PRIMARY_BUTTON: CSSProperties = {
  padding: px('5px 14px'),
  fontSize: fs(12),
  color: 'var(--oe-on-accent)',
  background: INDIGO,
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

// ── T50 · 导出（按钮 / 菜单 / 结果提示） ─────────────────────────────────

const EXPORT_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(4),
  padding: px('2px 8px'),
  fontSize: fs(11),
  lineHeight: 1.7,
  color: SECONDARY,
  background: 'transparent',
  border: `1px solid ${SEPARATOR}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  flex: '0 0 auto',
}

/** 点菜单外面就关：透明铺满，压在所有内容之上、菜单之下。 */
const MENU_BACKDROP: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 20,
  background: 'transparent',
}

const EXPORT_MENU: CSSProperties = {
  position: 'absolute',
  top: `calc(100% + ${sp(4)})`,
  right: 0,
  zIndex: 21,
  width: sp(238),
  display: 'flex',
  flexDirection: 'column',
  gap: sp(1),
  padding: sp(5),
  background: SURFACE,
  border: `1px solid ${SEPARATOR}`,
  borderRadius: 'var(--oe-radius-overlay)',
  boxShadow: 'var(--oe-shadow-pop)',
}

const EXPORT_MENU_HINT: CSSProperties = {
  padding: px('2px 6px 4px'),
  fontSize: fs(10),
  lineHeight: 1.6,
  color: FAINT,
}

const EXPORT_MENU_ITEM: CSSProperties = {
  padding: px('5px 8px'),
  fontSize: fs(11),
  textAlign: 'left',
  color: TEXT,
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const TOAST: CSSProperties = {
  position: 'absolute',
  right: sp(18),
  bottom: sp(18),
  zIndex: 22,
  maxWidth: sp(360),
  padding: px('6px 12px'),
  fontSize: fs(11),
  color: 'var(--oe-on-accent)',
  background: INDIGO,
  borderRadius: 'var(--oe-radius-control)',
  boxShadow: 'var(--oe-shadow-pop)',
  pointerEvents: 'none',
}

export default NotebookView
