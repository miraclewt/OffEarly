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
} from './notebookExport'
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
}

/** 导出菜单的三条落点。 */
type ExportKind = 'doc' | 'notebook' | 'print'

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
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  /** T50 · 导出菜单与进度（导出是异步的：读图 → 转 base64 → 渲染图 → 下载）。 */
  const [exportMenu, setExportMenu] = useState(false)
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
      {/* ① 笔记本 */}
      <aside style={PANE_NOTEBOOKS}>
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

      {/* ② 文档树 */}
      <aside style={PANE_TREE}>
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
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: px('10px 16px 14px') }}>
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
        data-testid={`doc-row-${doc.id}`}
        data-doc-id={doc.id}
        onMouseEnter={() => setHover(rowKey)}
        onMouseLeave={() => setHover((current) => (current === rowKey ? null : current))}
        onClick={() => {
          setDocId(doc.id)
          setTitleDraft(null)
        }}
        onDoubleClick={() => setEditing({ kind: 'doc', id: doc.id })}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            setDocId(doc.id)
          } else if (event.key === 'F2') {
            event.preventDefault()
            setEditing({ kind: 'doc', id: doc.id })
          }
        }}
        style={{
          ...DOC_ROW,
          paddingLeft: sp(4 + node.depth * 12),
          ...(hover === rowKey && !state.active ? { background: ROW_HOVER } : null),
          ...(state.active ? DOC_ROW_ACTIVE : null),
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

const ELLIPSIS: CSSProperties = {
  overflow: 'hidden',
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
