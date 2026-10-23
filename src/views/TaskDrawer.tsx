// T17 · TaskDrawer：任务详情**弹窗**（T36 起由 spec 6.3 的右侧抽屉改为居中弹窗）——
// 甘特图只读后，这里是唯一的排期修改入口。
//
// 受控契约（对照 T18 MilestonePanel 的既定手法，接线归集成窗口）：
// - `open` / `onOpenChange`：受控开合，省略时自管（可独立挂载）；
// - `taskId` / `onSelect`：**外部选中契约**——卡片点击（BoardView.onOpenTask）与
//   甘特条点击（data-gantt-bar）都由集成窗口把任务 id 传进来，本组件只负责
//   「打开并定位」；这两处点击的实际接线本任务不碰（BoardView / GanttCanvas 均不改）。
// 组件测试用 rerender 驱动 props 验证该契约。
//
// **呈现层（T36 起）**：居中弹窗（modal），不再是 spec 6.3 的「右侧滑出 400px」。
// 依据是产品方的明确要求——任务编辑要一个聚焦的弹窗，而不是一条从侧边挤进来的窄栏。
// 弹窗语义的落法：
// - 遮罩 `--oe-scrim` + `role="dialog"` + `aria-modal`，z-25（高于里程碑面板 z-20，
//   低于灯箱 z-60）；点遮罩空白处、Esc、右上角 × 三条出路都关得掉；
// - **遮罩关闭要按「按下与抬起都在遮罩上」判定**：本弹窗里有富文本编辑器，
//   从面板内拖选到面板外时 click 的 target 会落到遮罩（浏览器取共同祖先），
//   只看 click 会把正在选字的弹窗误关掉——所以 onMouseDown 记一次落点，onClick 复核；
// - 打开时把焦点移进面板、关闭时还给打开它的那个元素（这里是看板卡片 / 甘特条）；
// - **不做 Tab 焦点陷阱**：笔记里的任务列表用 Tab/Shift-Tab 缩进（TipTap 既有行为），
//   全局 trap 会把这个键吃掉——可访问性收益抵不过功能损失，故明确不实现；
// - 组件名与 `task-drawer` / `drawer-*` 测试 id 沿用 T17 历史命名（改名会波及 6 个测试
//   文件约 200 条断言，且 task.md 的 T17/T24 记录都以此称呼它），语义以本注释与
//   `data-presentation="modal"` 为准。
//
// 五个分区（spec 第 7 节信息密度上限：详情弹窗 5 分区）：
//   ① 标题（inline 编辑） ② 属性行 ③ 日期与进度 ④ 依赖关系 ⑤ 笔记
// 每一条写操作都构造 Command 经 CommandBus.apply 落地（spec 3 硬规则 2）：
// 改标题/属性/日期/进度走 patchTaskCommand；依赖增删改走 T17 新增的 link.* 命令。
// 因此顶部保存指示（T08 SaveIndicator）与 Ctrl+Z 撤销天然联动——没有野写路径。
//
// 边界：不改 App.tsx / BoardView / Gantt*；除 link 命令外不碰 src/domain/*；
// 工期只读展示取自 T11 ScheduleEngine.duration，不在弹窗里重算；
// 颜色一律取 --oe-* token，无 hex、无 emoji。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useStore } from 'zustand'

import { deleteTaskCommand, patchTaskCommand } from '../domain/commandBus'
import type { CommandBus, TaskPatch } from '../domain/commandBus'
import { patchNoteFontSize } from '../controllers/settingsActions'
import { duration } from '../domain/scheduleEngine'
import type { VaultStore } from '../domain/store'
import { createTopicTree } from '../domain/topicTree'
import type { Kind, Priority, Status, Task, Topic, WorkCalendar } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { DependencyEditor } from './DependencyEditor'
import { DateField } from './DateField'
import { Icon } from './IconSprite'
import { isValidDateKey } from './MilestonePanel'
import { NoteEditor } from './NoteEditor'
import type { NoteAssetsPort, NoteLinkTarget } from './NoteEditor'
import { SaveIndicator } from './SaveIndicator'
import type { SaveIndicatorSource } from './SaveIndicator'
import { fs, sp, px } from '../styles/scale'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const FAINT = 'var(--oe-text-faint)'
const SURFACE = 'var(--oe-surface)'
const INDIGO = 'var(--oe-accent)'
const DANGER = 'var(--oe-overdue)'

/** 弹窗面板的最大宽度；高度用 `maxHeight: sp(100)%` 顶住视口（遮罩留 24px 内边距）。 */
const MODAL_MAX_WIDTH = 760

const STATUSES: readonly Status[] = ['todo', 'doing', 'review', 'done']
const KINDS: readonly Kind[] = ['feature', 'bug', 'chore', 'research', 'doc']
const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3']

// ── 纯函数（导出供单测直接断言） ─────────────────────────────────────────

/** 标签输入解析：中英文逗号都能分隔，去空白、去重、丢空项。 */
export function parseTags(input: string): string[] {
  return [...new Set(input.split(/[,，]/).map((piece) => piece.trim()).filter((piece) => piece !== ''))]
}

/** 标签输入的规范化串（用于判断「真的变了没」，避免空提交进撤销栈）。 */
export function tagsToInput(tags: readonly string[]): string {
  return tags.join(', ')
}

/** 两个标签数组是否等价（顺序敏感，因为输入顺序由用户决定）。 */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * 日期区间校验：单值非法（2026-02-30 这类伪日期）或区间颠倒时返回错误文案键；
 * 合法返回 null。空串表示「清空该日期」，永远合法。
 */
export function dateRangeErrorKey(
  field: 'start' | 'due',
  value: string,
  task: Pick<Task, 'start' | 'due'>,
): 'drawer.invalidDate' | 'drawer.dateRangeError' | null {
  if (value !== '' && !isValidDateKey(value)) return 'drawer.invalidDate'
  const start = field === 'start' ? value : task.start ?? ''
  const due = field === 'due' ? value : task.due ?? ''
  if (start !== '' && due !== '' && due < start) return 'drawer.dateRangeError'
  return null
}

/** 工期只读文案：口径来自 T11 ScheduleEngine（`workdaysBetween + 1`），此处不重算。 */
export function durationLabel(
  task: Pick<Task, 'start' | 'due'>,
  calendar: WorkCalendar,
  t: (key: MsgKey, params?: TranslateParams) => string,
): string {
  try {
    const workdays = duration({ start: task.start, due: task.due }, calendar)
    return workdays === null ? t('drawer.durationEmpty') : t('drawer.durationValue', { n: workdays })
  } catch {
    // 日期串非法时 ScheduleEngine 显式抛错——只读展示退化为占位符，不把错误带进视图
    return t('drawer.durationEmpty')
  }
}

// ── 组件 ────────────────────────────────────────────────────────────────

export interface TaskDrawerProps {
  store: VaultStore
  bus: CommandBus
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 受控打开态；省略时弹窗自管开合（可独立挂载）。 */
  open?: boolean
  /** 开合请求外送（受控时由接线方决定，非受控时仅作通知）。 */
  onOpenChange?: (open: boolean) => void
  /**
   * 外部选中契约：传入任务 id → 弹窗打开并定位到该任务。
   * 看板卡片与甘特条的点击都经此入口（实际接线归集成窗口）。
   */
  taskId?: string | null
  /** 选中任务外送；关闭时回送 null，便于外部同步高亮 / 清空选中。 */
  onSelect?: (task: Task | null) => void
  /** 顶部保存指示的数据源（T08 Autosave 的三态面）；省略则不渲染指示器。 */
  autosave?: SaveIndicatorSource
  /** 注入 id 生成（依赖新建用），便于测试确定化。 */
  newId?: () => string
  /** 笔记里 `[[标题]]` 的点击跳转（T24）；matches 为同名候选，接线归集成窗口。 */
  onNavigateNoteLink?: (title: string, matches: readonly NoteLinkTarget[]) => void
  /** T25 附件端口：图片的插入 / 显示都经它（编辑器本身不碰文件系统）。 */
  assets?: NoteAssetsPort
  style?: CSSProperties
}

const INPUT: CSSProperties = {
  padding: px('6px 10px'),
  fontSize: fs(12),
  color: TEXT,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

const FIELD_LABEL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: sp(4),
  fontSize: fs(11),
  fontWeight: 550,
  color: MUTED,
  minWidth: 0,
}

const SECTION: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: sp(8),
  padding: px('12px 0'),
  borderTop: '1px solid var(--oe-separator)',
}

const SECTION_TITLE: CSSProperties = {
  fontSize: fs(12),
  fontWeight: 650,
  color: TEXT,
}

/** 收尾动作按钮：低噪常态，危险动作靠文字与确认态（而不是常驻红色）表达。 */
const DANGER_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(5),
  padding: px('5px 10px'),
  fontSize: fs(12),
  color: SECONDARY,
  background: 'var(--oe-fill)',
  border: '1px solid var(--oe-border)',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

/** 弹窗遮罩：铺满视口、居中承载面板；`--oe-scrim` 是主题里唯一的模态遮罩色。 */
const BACKDROP: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 25,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: sp(24),
  background: 'var(--oe-scrim)',
  backdropFilter: 'blur(8px) saturate(140%)',
  WebkitBackdropFilter: 'blur(8px) saturate(140%)',
  fontFamily: 'var(--oe-font)',
}

/**
 * 弹窗面板：宽不超过 760（遮罩内边距再兜一层小屏），高度顶住遮罩的内容盒，
 * 内部滚动交给 `<div>` 自适应区——顶栏常驻，五个分区在框内滚。
 */
const PANEL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  maxWidth: MODAL_MAX_WIDTH,
  maxHeight: '100%',
  background: SURFACE,
  border: '1px solid var(--oe-separator)',
  borderRadius: 'var(--oe-radius-overlay)',
  boxShadow: 'var(--oe-shadow-pop)',
  overflow: 'hidden',
  boxSizing: 'border-box',
}

function SectionHeader(props: { icon: ReactNode; title: string; trailing?: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: sp(6) }}>
      <span style={{ display: 'flex', flex: '0 0 auto', color: MUTED }}>{props.icon}</span>
      <span style={{ flex: 1, ...SECTION_TITLE }}>{props.title}</span>
      {props.trailing}
    </div>
  )
}

/** 回车提交 / Esc 撤销的单行文本输入（标题、负责人、标签共用同一交互）。 */
function CommitInput(props: {
  testId: string
  value: string
  placeholder?: string
  ariaLabel: string
  autoFocus?: boolean
  onCommit: (next: string) => void
  onCancel?: () => void
  style?: CSSProperties
}): ReactNode {
  const [draft, setDraft] = useState(props.value)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(props.value)
  }, [props.value, editing])

  function commit(): void {
    setEditing(false)
    if (draft !== props.value) props.onCommit(draft)
  }

  return (
    <input
      data-testid={props.testId}
      aria-label={props.ariaLabel}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      value={editing ? draft : props.value}
      style={{ ...INPUT, ...props.style }}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        setEditing(true)
        setDraft(event.target.value)
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(props.value)
          setEditing(false)
          props.onCancel?.()
        }
      }}
    />
  )
}

export function TaskDrawer(props: TaskDrawerProps) {
  const { store, bus, t } = props
  const vault = useStore(store, (state) => state.vault)

  const [selfOpen, setSelfOpen] = useState(false)
  const [selfTaskId, setSelfTaskId] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [dateError, setDateError] = useState<MsgKey | null>(null)
  /** T55：删除的两段确认。换任务必须复位，否则「确认」态会跨任务带着走。 */
  const [armedDelete, setArmedDelete] = useState(false)

  const open = props.open ?? selfOpen
  const taskId = props.taskId !== undefined ? props.taskId : selfTaskId
  const task = taskId === null || taskId === undefined ? undefined : vault.tasks.find((item) => item.id === taskId)

  const calendar = vault.settings.calendar
  const tree = useMemo(() => createTopicTree(vault.topics), [vault.topics])

  // 换任务时复位删除确认态：否则在 A 上点了「删除」，切到 B 时按钮还带着红色确认态。
  useEffect(() => {
    setArmedDelete(false)
  }, [taskId])

  /** 话题下拉：树序展平带缩进；已归档话题仍列出（其任务要能落脚）。 */
  const topicOptions = useMemo(() => {
    const out: { id: string; label: string; indent: string; archived: boolean }[] = []
    const walk = (topics: readonly Topic[], depth: number): void => {
      for (const topic of topics) {
        out.push({
          id: topic.id,
          label: topic.name,
          indent: '\u00A0\u00A0'.repeat(depth),
          archived: topic.archived,
        })
        walk(tree.childrenOf(topic.id), depth + 1)
      }
    }
    walk(tree.roots(), 0)
    return out
  }, [tree])

  /**
   * T24：笔记 `[[双链]]` 的候选池 = 全库任务标题 + 里程碑标题（同名多任务会有多条同 title 候选）。
   * 只读派生，不落盘。
   */
  const noteLinkTargets = useMemo<NoteLinkTarget[]>(
    () => [
      ...vault.tasks.map((item) => ({ id: item.id, kind: 'task' as const, title: item.title })),
      ...vault.milestones.map((item) => ({ id: item.id, kind: 'milestone' as const, title: item.title })),
    ],
    [vault.tasks, vault.milestones],
  )

  /**
   * 键盘处理读最新值的 ref：effect 只在 open 变化时重挂监听，
   * 不必因为「用户敲了一个字」就重新绑定 window 事件。
   */
  const latest = useRef({ taskId, titleDraft })
  latest.current = { taskId, titleDraft }

  /** 弹窗面板（焦点落点）与遮罩按下落点（判定「点的是不是外部」）。 */
  const panelRef = useRef<HTMLDivElement | null>(null)
  const backdropPressed = useRef(false)

  function requestClose(): void {
    if (props.open === undefined) setSelfOpen(false)
    if (props.taskId === undefined) setSelfTaskId(null)
    props.onOpenChange?.(false)
    props.onSelect?.(null)
    setTitleDraft(null)
    setDateError(null)
  }

  /**
   * 弹窗开合时的焦点交接：打开 → 焦点进面板（键盘用户下一格 Tab 就在弹窗里）；
   * 关闭 → 还给打开它的那个元素（看板卡片 / 甘特条），不把焦点丢到 body。
   * `preventScroll`：面板是 fixed 居中的，聚焦不该带动背景滚动位置。
   */
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    panelRef.current?.focus({ preventScroll: true })
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])

  /** 遮罩空白处按下：记为「点外部」的起点（抬起时还要复核，见 BACKDROP 注释）。 */
  function onBackdropMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    backdropPressed.current = event.target === event.currentTarget
  }

  function onBackdropClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const pressedOutside = backdropPressed.current
    backdropPressed.current = false
    if (!pressedOutside) return
    if (event.target !== event.currentTarget) return
    requestClose()
  }

  // 外部选中契约：taskId 变化 → 打开弹窗并定位到该任务。
  // 依赖只取 [props.taskId, store]，同一 id 重复传入不会重复应用。
  useEffect(() => {
    const selected = props.taskId
    if (selected === null || selected === undefined) return
    if (props.open === undefined) setSelfOpen(true)
    props.onOpenChange?.(true)
    props.onSelect?.(store.getVault().tasks.find((item) => item.id === selected) ?? null)
    setTitleDraft(null)
    setDateError(null)
  }, [props.taskId, store])

  // Esc 关闭 + Ctrl/Cmd+Z 撤销（走 CommandBus 的撤销栈；Shift 为重做）。
  // 撤销前先把正在编辑的输入提交（blur 触发 commit），避免「草稿还在、撤销的是更早的命令」。
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        requestClose()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        const { taskId: currentId, titleDraft: draft } = latest.current
        if (draft !== null && currentId !== null && currentId !== undefined) commitTitle(currentId, draft)
        const active = document.activeElement
        if (active instanceof HTMLElement) active.blur()
        if (event.shiftKey) bus.redo()
        else bus.undo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, bus])

  function patchTask(patch: TaskPatch): void {
    if (task === undefined) return
    bus.apply(patchTaskCommand(store.getVault(), task.id, patch))
  }

  function commitTitle(id: string, draft: string): void {
    const current = store.getVault().tasks.find((item) => item.id === id)
    if (current === undefined) {
      setTitleDraft(null)
      return
    }
    const trimmed = draft.trim()
    const next = trimmed === '' ? t('drawer.untitled') : trimmed
    if (next !== current.title) bus.apply(patchTaskCommand(store.getVault(), id, { title: next }))
    setTitleDraft(null)
  }

  function changeDate(field: 'start' | 'due', value: string): void {
    if (task === undefined) return
    const errorKey = dateRangeErrorKey(field, value, task)
    if (errorKey !== null) {
      setDateError(errorKey)
      return
    }
    setDateError(null)
    const normalized = value === '' ? undefined : value
    patchTask(field === 'start' ? { start: normalized } : { due: normalized })
  }

  function changeTags(next: string): void {
    if (task === undefined) return
    const parsed = parseTags(next)
    if (sameTags(parsed, task.tags)) return
    patchTask({ tags: parsed })
  }

  function changeAssignee(next: string): void {
    if (task === undefined) return
    const trimmed = next.trim()
    const normalized = trimmed === '' ? undefined : trimmed
    if (normalized === (task.assignee ?? undefined)) return
    patchTask({ assignee: normalized })
  }

  function renderEditor(task: Task): ReactNode {
    const done = task.status === 'done'
    const progress = done ? 100 : task.progress

    return (
      <div style={{ display: 'flex', flexDirection: 'column', padding: px('0 18px 20px') }}>
        {/* ① 标题（inline 编辑） */}
        <section data-testid="drawer-title-section" style={{ ...SECTION, borderTop: 'none', paddingTop: sp(4) }}>
          {titleDraft === null ? (
            <button
              type="button"
              data-testid="drawer-title-display"
              title={t('drawer.fieldTitle')}
              onClick={() => {
                setTitleDraft(task.title)
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: px('2px 0'),
                fontSize: fs(15),
                fontWeight: 600,
                lineHeight: 1.4,
                color: TEXT,
                background: 'transparent',
                border: 'none',
                cursor: 'text',
                textAlign: 'left',
                wordBreak: 'break-word',
              }}
            >
              {task.title}
            </button>
          ) : (
            <input
              data-testid="drawer-title-input"
              aria-label={t('drawer.fieldTitle')}
              value={titleDraft}
              autoFocus
              placeholder={t('drawer.untitled')}
              style={{ ...INPUT, fontSize: fs(15), fontWeight: 600 }}
              onChange={(event) => {
                setTitleDraft(event.target.value)
              }}
              onBlur={() => {
                commitTitle(task.id, titleDraft)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitTitle(task.id, titleDraft)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setTitleDraft(null)
                }
              }}
            />
          )}
        </section>

        {/* ② 属性行：状态 / 类别 / 优先级 / 话题 / 负责人 / 标签 */}
        <section data-testid="drawer-props-section" style={SECTION}>
          <div style={SECTION_TITLE}>{t('drawer.sectionProps')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: sp(8) }}>
            <label style={FIELD_LABEL}>
              {t('drawer.fieldStatus')}
              <select
                data-testid="drawer-status-select"
                value={task.status}
                style={INPUT}
                onChange={(event) => {
                  patchTask({ status: event.target.value as Status })
                }}
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {t(`status.${status}`)}
                  </option>
                ))}
              </select>
            </label>
            <label style={FIELD_LABEL}>
              {t('drawer.fieldKind')}
              <select
                data-testid="drawer-kind-select"
                value={task.kind}
                style={INPUT}
                onChange={(event) => {
                  patchTask({ kind: event.target.value as Kind })
                }}
              >
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`card.kind.${kind}` as MsgKey)}
                  </option>
                ))}
              </select>
            </label>
            <label style={FIELD_LABEL}>
              {t('drawer.fieldPriority')}
              <select
                data-testid="drawer-priority-select"
                value={task.priority}
                style={INPUT}
                onChange={(event) => {
                  patchTask({ priority: event.target.value as Priority })
                }}
              >
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>
            <label style={FIELD_LABEL}>
              {t('drawer.fieldAssignee')}
              <CommitInput
                testId="drawer-assignee-input"
                ariaLabel={t('drawer.fieldAssignee')}
                placeholder={t('drawer.assigneePlaceholder')}
                value={task.assignee ?? ''}
                onCommit={changeAssignee}
              />
            </label>
            <label style={{ ...FIELD_LABEL, gridColumn: '1 / -1' }}>
              {t('drawer.fieldTopic')}
              <select
                data-testid="drawer-topic-select"
                value={task.topicId}
                style={INPUT}
                onChange={(event) => {
                  patchTask({ topicId: event.target.value })
                }}
              >
                {topicOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.indent}
                    {option.label}
                    {option.archived ? `（${t('sidebar.archive')}）` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ ...FIELD_LABEL, gridColumn: '1 / -1' }}>
              {t('drawer.fieldTags')}
              <CommitInput
                testId="drawer-tags-input"
                ariaLabel={t('drawer.fieldTags')}
                placeholder={t('drawer.tagsPlaceholder')}
                value={tagsToInput(task.tags)}
                onCommit={changeTags}
              />
            </label>
          </div>
        </section>

        {/* ③ 日期与进度：起止可填、工期只读、进度滑块（done 强压 100） */}
        <section data-testid="drawer-dates-section" style={SECTION}>
          <div style={SECTION_TITLE}>{t('drawer.sectionDates')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: sp(8) }}>
            <label style={FIELD_LABEL}>
              {t('drawer.fieldStart')}
              <DateField
                testId="drawer-start-input"
                ariaLabel={t('drawer.fieldStart')}
                t={t}
                value={task.start ?? ''}
                onCommit={(next) => {
                  changeDate('start', next)
                }}
                inputStyle={INPUT}
              />
            </label>
            <label style={FIELD_LABEL}>
              {t('drawer.fieldDue')}
              <DateField
                testId="drawer-due-input"
                ariaLabel={t('drawer.fieldDue')}
                t={t}
                value={task.due ?? ''}
                onCommit={(next) => {
                  changeDate('due', next)
                }}
                inputStyle={INPUT}
              />
            </label>
          </div>

          {dateError === null ? null : (
            <div data-testid="drawer-date-error" style={{ fontSize: fs(11), color: DANGER }}>
              {t(dateError)}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: sp(6) }}>
            <span style={{ display: 'flex', color: FAINT }}>
              <Icon name="clock" size={13} />
            </span>
            <span style={{ fontSize: fs(11), color: MUTED }}>{t('drawer.fieldDuration')}</span>
            <span data-testid="drawer-duration" style={{ fontSize: fs(12), color: SECONDARY }}>
              {durationLabel(task, calendar, t)}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: sp(4) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: sp(6) }}>
              <span style={{ fontSize: fs(11), color: MUTED }}>{t('drawer.fieldProgress')}</span>
              <span data-testid="drawer-progress-value" style={{ fontSize: fs(12), color: SECONDARY }}>
                {progress}%
              </span>
            </div>
            <input
              data-testid="drawer-progress-input"
              type="range"
              min={0}
              max={100}
              step={1}
              aria-label={t('drawer.fieldProgress')}
              value={progress}
              disabled={done}
              style={{ width: '100%', accentColor: INDIGO, cursor: done ? 'not-allowed' : 'pointer' }}
              onChange={(event) => {
                patchTask({ progress: Number(event.target.value) })
              }}
            />
            {done ? (
              <div data-testid="drawer-progress-locked" style={{ fontSize: fs(11), color: MUTED }}>
                {t('drawer.doneProgressLocked')}
              </div>
            ) : null}
          </div>
        </section>

        {/* ④ 依赖关系（DependencyEditor：模糊搜索建链 / 类型与 lag / 删除 / 成环标红） */}
        <section data-testid="drawer-deps-section" style={SECTION}>
          <DependencyEditor store={store} bus={bus} taskId={task.id} t={t} newId={props.newId} />
        </section>

        {/* ⑤ 笔记（T24 NoteEditor）：编辑 debounce 后经 patchTaskCommand 落库 → 进撤销栈；
            key=task.id 让换任务即重挂，避免 debounce 把 A 的内容写进 B。 */}
        <section data-testid="drawer-notes-section" style={SECTION}>
          <SectionHeader icon={<Icon name="note" size={14} />} title={t('drawer.sectionNotes')} />
          <NoteEditor
            key={task.id}
            value={task.note}
            linkTargets={noteLinkTargets}
            onCommit={(markdown) => patchTask({ note: markdown })}
            onNavigate={props.onNavigateNoteLink}
            assets={props.assets}
            t={t}
            // T50：与知识库共用同一个字号设置（同一个编辑器，不该有两套字号）
            fontSize={vault.settings.noteFontSize}
            onFontSizeChange={(size) => patchNoteFontSize(bus, store.getVault(), size)}
          />
        </section>

        {/* ⑥ T55 · 收尾动作。此前任务只有「改状态」一条出路——误建的任务永远赖在板上，
            归档唯一路径是归档整个话题（级联），代价太大。删除走两段确认，并把
            「会连带摘掉依赖」这句后果写在按钮下面，不藏在 tooltip 里。 */}
        <section
          data-testid="drawer-actions"
          style={{ ...SECTION, paddingBottom: 0, gap: sp(6) }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: sp(8), flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="drawer-archive"
              onClick={() => {
                patchTask({ archived: true })
                requestClose()
              }}
              style={DANGER_BUTTON}
            >
              <Icon name="archive" size={13} />
              <span>{t('drawer.archive')}</span>
            </button>
            <button
              type="button"
              data-testid="drawer-delete"
              aria-label={armedDelete ? t('drawer.deleteConfirm') : t('drawer.delete')}
              onClick={() => {
                if (!armedDelete) {
                  setArmedDelete(true)
                  return
                }
                if (task === undefined) return
                bus.apply(deleteTaskCommand(store.getVault(), task.id))
                requestClose()
              }}
              style={
                armedDelete
                  ? { ...DANGER_BUTTON, color: 'var(--oe-on-accent)', background: DANGER, borderColor: DANGER }
                  : DANGER_BUTTON
              }
            >
              <Icon name="trash" size={13} />
              <span>{armedDelete ? t('drawer.deleteConfirm') : t('drawer.delete')}</span>
            </button>
          </div>
          <p style={{ margin: 0, fontSize: fs(11), color: FAINT, lineHeight: 1.5 }}>
            {armedDelete ? t('drawer.deleteHint') : t('drawer.archiveHint')}
          </p>
        </section>
      </div>
    )
  }

  if (!open) return null
  if (taskId === null || taskId === undefined) return null

  return (
    <div
      data-testid="task-modal"
      // 遮罩本身不是对话框，语义元素是里面的面板（与 Lightbox 把 role 挂在外层不同：
      // 灯箱的「内容」就是整个铺满的视口，这里只有中间那一块是）
      onMouseDown={onBackdropMouseDown}
      onClick={onBackdropClick}
      style={BACKDROP}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('drawer.title')}
        data-testid="task-drawer"
        data-presentation="modal"
        style={{ ...PANEL, outline: 'none', ...props.style }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: sp(8),
            flex: '0 0 auto',
            padding: px('10px 14px'),
            background: 'var(--oe-material-overlay)',
            backdropFilter: 'blur(16px) saturate(180%)',
            WebkitBackdropFilter: 'blur(16px) saturate(180%)',
            borderBottom: '1px solid var(--oe-separator)',
          }}
        >
          <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: sp(8) }}>
            {props.autosave === undefined ? null : (
              <SaveIndicator autosave={props.autosave} t={t} testId="drawer-save-indicator" live={false} />
            )}
          </span>
          <span style={{ fontSize: fs(13), fontWeight: 650, color: TEXT }}>{t('drawer.title')}</span>
          <span style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              data-testid="drawer-close"
              aria-label={t('drawer.close')}
              title={t('drawer.close')}
              onClick={requestClose}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: sp(22),
                height: sp(22),
                padding: 0,
                color: MUTED,
                background: 'var(--oe-fill)',
                border: 'none',
                borderRadius: '50%',
                cursor: 'pointer',
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        </div>

        {task === undefined ? (
          <div
            data-testid="drawer-missing-task"
            style={{ padding: px('24px 16px'), fontSize: fs(12), color: MUTED, textAlign: 'center', lineHeight: 1.7 }}
          >
            {t('drawer.missingTask')}
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{renderEditor(task)}</div>
        )}
      </div>
    </div>
  )
}

export default TaskDrawer
