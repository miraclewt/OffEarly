// T59 · 全局搜索（Ctrl/Cmd + K）。
//
// 为什么要它：任务搜索在 QueryEngine 里、文档搜索在 NotebookView 里，两套入口、
// 两套命中规则，用户想找「上周那条关于对账的笔记」时不知道该去哪个视图。
// 这里把三类结果（任务 / 文档 / 命令）汇到一个键盘可达的浮层里。
//
// 三条约束：
//   ① 浮层必须 createPortal 到 body：外壳的 backdrop-filter 会给 position:fixed
//      造一个包含块，留在原地的话 left/top 会按面板而不是视口解析（DateField 踩过同一条）；
//   ② 只读派生：搜索不写 store，也不触发 QueryEngine 的筛选状态——它不该改变你看板上的筛选；
//   ③ 命中规则与各视图对齐：任务匹配标题/备注/标签，文档匹配标题/正文，命令匹配标签文字。

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { NoteDoc, Task, Vault } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { fs, px, sp } from '../styles/scale'

export type PaletteView = 'board' | 'gantt' | 'mindmap' | 'notebook'

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  vault: Vault
  t: (key: MsgKey, params?: TranslateParams) => string
  onOpenTask: (id: string) => void
  onOpenDoc: (notebookId: string, docId: string) => void
  onSelectView: (view: PaletteView) => void
  onOpenSettings: () => void
  onOpenBackup: () => void
}

type ItemKind = 'task' | 'doc' | 'command'

interface PaletteItem {
  key: string
  kind: ItemKind
  label: string
  meta: string
  run: () => void
}

/** 单类结果的条数上限：搜索面板是「快速跳转」，不是结果页。 */
export const PALETTE_LIMIT = 6

function hit(haystacks: readonly (string | undefined)[], needle: string): boolean {
  if (needle === '') return true
  return haystacks.some((text) => (text ?? '').toLowerCase().includes(needle))
}

export function matchTasks(tasks: readonly Task[], query: string): Task[] {
  const needle = query.trim().toLowerCase()
  return tasks
    .filter((task) => !task.archived)
    .filter((task) => hit([task.title, task.note, task.tags.join(' ')], needle))
    .slice(0, PALETTE_LIMIT)
}

export function matchDocs(docs: readonly NoteDoc[], query: string): NoteDoc[] {
  const needle = query.trim().toLowerCase()
  return docs.filter((doc) => hit([doc.title, doc.content], needle)).slice(0, PALETTE_LIMIT)
}

export function CommandPalette(props: CommandPaletteProps): ReactElement | null {
  const { open, onOpenChange, vault, t } = props
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 每次打开都回到空查询：上次的关键词留在这儿会让人以为搜过了
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    setActive(0)
  }, [query])

  if (!open) return null

  const notebookName = new Map(vault.notebooks.map((notebook) => [notebook.id, notebook.name]))
  const commands: { key: string; label: string; run: () => void }[] = [
    { key: 'board', label: t('palette.cmdBoard'), run: () => props.onSelectView('board') },
    { key: 'gantt', label: t('palette.cmdGantt'), run: () => props.onSelectView('gantt') },
    { key: 'mindmap', label: t('palette.cmdMindmap'), run: () => props.onSelectView('mindmap') },
    { key: 'notebook', label: t('palette.cmdNotebook'), run: () => props.onSelectView('notebook') },
    { key: 'settings', label: t('palette.cmdSettings'), run: props.onOpenSettings },
    { key: 'backup', label: t('palette.cmdBackup'), run: props.onOpenBackup },
  ]

  const needle = query.trim().toLowerCase()
  const taskHits = matchTasks(vault.tasks, query)
  const docHits = matchDocs(vault.noteDocs, query)
  const commandHits = commands.filter((command) => command.label.toLowerCase().includes(needle))

  const items: PaletteItem[] = [
    ...taskHits.map((task) => ({
      key: `task:${task.id}`,
      kind: 'task' as const,
      label: task.title,
      meta: t('palette.taskMeta'),
      run: () => props.onOpenTask(task.id),
    })),
    ...docHits.map((doc) => ({
      key: `doc:${doc.id}`,
      kind: 'doc' as const,
      label: doc.title,
      meta: notebookName.get(doc.notebookId) ?? t('palette.docMeta'),
      run: () => props.onOpenDoc(doc.notebookId, doc.id),
    })),
    ...commandHits.map((command) => ({
      key: `cmd:${command.key}`,
      kind: 'command' as const,
      label: command.label,
      meta: t('palette.commandMeta'),
      run: command.run,
    })),
  ]

  function runAt(index: number): void {
    const item = items[index]
    if (item === undefined) return
    onOpenChange(false)
    item.run()
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (items.length === 0 ? 0 : (index + 1) % items.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (items.length === 0 ? 0 : (index - 1 + items.length) % items.length))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      runAt(active)
    }
  }

  const groupHeader = (kind: ItemKind): string | null => {
    if (kind === 'task' && taskHits.length > 0) return t('palette.tasks')
    if (kind === 'doc' && docHits.length > 0) return t('palette.docs')
    if (kind === 'command' && commandHits.length > 0) return t('palette.commands')
    return null
  }

  return createPortal(
    <div data-testid="command-palette" style={BACKDROP} onMouseDown={() => onOpenChange(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        style={PANEL}
      >
        <div style={SEARCH_ROW}>
          <input
            ref={inputRef}
            data-testid="palette-input"
            type="text"
            value={query}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.title')}
            onChange={(event) => setQuery(event.target.value)}
            style={INPUT}
          />
          <span style={HINT}>{t('palette.hint')}</span>
        </div>
        <div data-testid="palette-results" role="listbox" style={LIST}>
          {items.length === 0 ? (
            <div data-testid="palette-empty" style={EMPTY}>
              {t('palette.empty')}
            </div>
          ) : (
            items.map((item, index) => {
              const header = index === 0 || items[index - 1]?.kind !== item.kind ? groupHeader(item.kind) : null
              return (
                <div key={item.key}>
                  {header === null ? null : <div style={GROUP}>{header}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    data-testid={`palette-item-${item.key}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => runAt(index)}
                    style={index === active ? { ...ROW, background: 'var(--oe-accent-tint)' } : ROW}
                  >
                    <span style={{ ...ROW_LABEL, fontWeight: index === active ? 550 : 400 }}>{item.label}</span>
                    <span style={ROW_META}>{item.meta}</span>
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const BACKDROP: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 80,
  background: 'rgba(20, 20, 22, 0.22)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  paddingTop: '14vh',
}

const PANEL: CSSProperties = {
  width: sp(560),
  maxWidth: '92vw',
  maxHeight: '70vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--oe-material-overlay)',
  backdropFilter: 'blur(20px) saturate(180%)',
  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
  border: '1px solid var(--oe-border)',
  borderRadius: 'var(--oe-radius-overlay)',
  boxShadow: 'var(--oe-shadow-pop)',
  overflow: 'hidden',
}

const SEARCH_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(10),
  padding: px('10px 12px'),
  borderBottom: '1px solid var(--oe-separator)',
}

const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: fs(14),
  color: 'var(--oe-text)',
}

const HINT: CSSProperties = {
  flex: '0 0 auto',
  fontSize: fs(11),
  color: 'var(--oe-text-faint)',
}

const LIST: CSSProperties = {
  overflowY: 'auto',
  padding: px('6px'),
}

const GROUP: CSSProperties = {
  padding: px('6px 8px 2px'),
  fontSize: fs(11),
  fontWeight: 650,
  color: 'var(--oe-text-muted)',
}

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: sp(8),
  width: '100%',
  padding: px('7px 8px'),
  border: 'none',
  background: 'transparent',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  textAlign: 'left',
}

const ROW_LABEL: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: fs(13),
  color: 'var(--oe-text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const ROW_META: CSSProperties = {
  flex: '0 0 auto',
  maxWidth: sp(140),
  fontSize: fs(11),
  color: 'var(--oe-text-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const EMPTY: CSSProperties = {
  padding: px('18px 10px'),
  textAlign: 'center',
  fontSize: fs(12),
  color: 'var(--oe-text-muted)',
}
