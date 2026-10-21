// T18 · MilestonePanel：里程碑列表面板 + 新建 / 编辑 / 删除（spec 6.5 第一条款）。
//
// 入口与联动：
// - 侧栏「里程碑」入口（T14 TopicSidebar 的 onOpenMilestones）把本面板拉起；
// - 甘特图点击菱形（GanttCanvas 的 MilestoneDiamond）经**选中契约**打开同一个面板：
//   外部把里程碑 id 传进 props.selectedId，面板即打开并把编辑器定位到该条。
//   菱形 onClick 的实际连线由集成窗口在 T21 合入后接线——本任务不碰 GanttCanvas
//   （甘特车道正在改它），这里只保证「契约就绪、任何入口都能打开同一面板」。
//
// 写入口：现有 MutationType 只有 task.* 与 settings.patch，没有 milestone.* 命令，
// 而 commandBus.ts 属 T10 文件域（已合入主干）不得改动——沿用 T14 话题写入的先例，
// 里程碑写操作收敛在本文件、经 VaultStore 既有的 store.update 入口完成
// （纯函数 helper 一并导出，组件自身不私藏任何领域状态）。将来补齐 milestone.*
// 命令后只需把 store.update 换成 bus.apply，视图无感（props.bus 已为此预留）。
//
// 分层：纯视图 + store 读写，零文件系统调用（spec 3 硬规则 1）；
// 不 import 任何尚未实现的面板（FilterBar / TaskDrawer / BackupPanel）。
// 视觉：颜色一律取 --oe-* token，圆角两档、无渐变、无 emoji（spec 第 7 节）。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useStore } from 'zustand'
import { nanoid } from 'nanoid'

import { TOPIC_PALETTE, isPaletteColor, paletteColorAt } from '../controllers/topicActions'
import type { CommandBus } from '../domain/commandBus'
import type { VaultStore } from '../domain/store'
import { createTopicTree } from '../domain/topicTree'
import type { Milestone, Topic, Vault } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { Icon } from './IconSprite'
import { fs, sp, px } from '../styles/scale'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const INDIGO = 'var(--oe-accent)'
const DONE_GREEN = 'var(--oe-done)'
const OVERDUE_RED = 'var(--oe-overdue)'
const SURFACE = 'var(--oe-surface)'
const ROW_SELECTED = 'var(--oe-row-selected)'

/** 面板宽度：右侧抽屉，列表 + 编辑器同屏。 */
const PANEL_WIDTH = 340

// ── 纯函数（导出供单测直接断言；组件只负责把结果写进 Store） ──────────────

/** 表单草稿；id === null 表示新建中的里程碑。 */
export interface MilestoneDraft {
  id: string | null
  title: string
  date: string
  /** null = 跨 topic 里程碑（甘特图顶部独立轨道，不受话题筛选影响）。 */
  topicId: string | null
  done: boolean
  color: string
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/** 合法日期键：格式对、且是真实存在的一天（2026-02-30 这类伪日期拒绝）。 */
export function isValidDateKey(value: string): boolean {
  if (!DATE_KEY.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** 里程碑未配颜色时的兜底：与 GanttCanvas 的 topicBarFill(null) 默认值一致。 */
export function fallbackMilestoneColor(): string {
  return paletteColorAt(0)
}

export function draftFromMilestone(milestone: Milestone): MilestoneDraft {
  return {
    id: milestone.id,
    title: milestone.title,
    date: milestone.date,
    topicId: milestone.topicId,
    done: milestone.done,
    color: milestone.color ?? fallbackMilestoneColor(),
  }
}

/** 新建草稿：默认话题取入口传入值（不存在则回落跨话题），颜色按现有数量轮转。 */
export function newMilestoneDraft(vault: Vault, defaultTopicId: string | null): MilestoneDraft {
  const known = defaultTopicId !== null && vault.topics.some((topic) => topic.id === defaultTopicId)
  return {
    id: null,
    title: '',
    date: '',
    topicId: known ? defaultTopicId : null,
    done: false,
    color: paletteColorAt(vault.milestones.length),
  }
}

/** 插入或替换（按 id）；纯函数，不改入参。 */
export function upsertMilestone(vault: Vault, milestone: Milestone): Vault {
  const index = vault.milestones.findIndex((candidate) => candidate.id === milestone.id)
  if (index === -1) return { ...vault, milestones: [...vault.milestones, milestone] }
  const milestones = [...vault.milestones]
  milestones[index] = milestone
  return { ...vault, milestones }
}

/** 只动 milestones 一个数组——任务与依赖天然不受影响（验收 4 的结构性保证）。 */
export function removeMilestone(vault: Vault, id: string): Vault {
  if (!vault.milestones.some((candidate) => candidate.id === id)) {
    throw new Error(`milestonePanel: 里程碑不存在（${id}）`)
  }
  return { ...vault, milestones: vault.milestones.filter((candidate) => candidate.id !== id) }
}

/** 组内排序：日期升序，同日期按标题。 */
export function sortMilestones(milestones: readonly Milestone[]): Milestone[] {
  return [...milestones].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.title !== b.title) return a.title < b.title ? -1 : 1
    return 0
  })
}

/**
 * 分组口径（验收 2）：跨 topic（topicId === null）**置顶**成组，与日期无关；
 * 其余归「话题里程碑」组。甘特图上跨 topic 里程碑同样在顶部独立轨道（T20 既定）。
 */
export function splitMilestoneGroups(milestones: readonly Milestone[]): {
  cross: Milestone[]
  byTopic: Milestone[]
} {
  const sorted = sortMilestones(milestones)
  return {
    cross: sorted.filter((milestone) => milestone.topicId === null),
    byTopic: sorted.filter((milestone) => milestone.topicId !== null),
  }
}

// ── 组件 ────────────────────────────────────────────────────────────────

export interface MilestonePanelProps {
  store: VaultStore
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 受控打开态；省略时面板自管开合（可独立挂载）。 */
  open?: boolean
  /** 开合请求外送（受控时由接线方决定，非受控时仅作通知）。 */
  onOpenChange?: (open: boolean) => void
  /**
   * 外部选中契约（甘特图菱形点击的落点）：传入里程碑 id，面板打开并定位到该条。
   * 用户在列表里选中某条时经 onSelect 外送，便于外部（如甘特图）同步。
   */
  selectedId?: string | null
  onSelect?: (milestone: Milestone | null) => void
  /** 新建时的默认归属话题（侧栏入口可传当前筛选话题）。 */
  defaultTopicId?: string | null
  /** 注入 id 生成，便于测试确定化。 */
  newId?: () => string
  /**
   * 预留：milestone.* 命令补齐后切换写入口用。当前里程碑写走 store.update
   * （T14 话题写入的同一先例），故本 prop 可选且暂不参与逻辑。
   */
  bus?: CommandBus
  style?: CSSProperties
}

const INPUT: CSSProperties = {
  padding: px('4px 6px'),
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
  gap: sp(3),
  fontSize: fs(11),
  color: MUTED,
}

const PRIMARY_BUTTON: CSSProperties = {
  padding: px('5px 12px'),
  fontSize: fs(12),
  fontWeight: 600,
  color: 'var(--oe-on-accent)',
  background: INDIGO,
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

const GHOST_BUTTON: CSSProperties = {
  padding: px('5px 10px'),
  fontSize: fs(12),
  color: SECONDARY,
  background: 'transparent',
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

const DANGER_BUTTON: CSSProperties = {
  ...GHOST_BUTTON,
  color: OVERDUE_RED,
  borderColor: OVERDUE_RED,
}

export function MilestonePanel(props: MilestonePanelProps) {
  const { store, t } = props
  const vault = useStore(store, (state) => state.vault)

  const [selfOpen, setSelfOpen] = useState(false)
  const [draft, setDraft] = useState<MilestoneDraft | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [dateError, setDateError] = useState(false)
  /**
   * 刚建好的里程碑：列表按日期排序，新条可能落在滚动区之外——不把它带进视野，
   * 用户点完「保存」看到的是编辑器关闭、列表纹丝不动（线上反馈的「创建后不显示」）。
   */
  const [revealId, setRevealId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (revealId === null) return
    const row = listRef.current?.querySelector(`[data-testid="milestone-row-${revealId}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
    setRevealId(null)
  }, [revealId, vault.milestones])

  const open = props.open ?? selfOpen
  const newId = props.newId ?? (() => nanoid())

  const tree = useMemo(() => createTopicTree(vault.topics), [vault.topics])
  const groups = useMemo(() => splitMilestoneGroups(vault.milestones), [vault.milestones])

  /** 话题下拉项：按树序展平，保留层级缩进；已归档话题仍列出（其里程碑要能落脚）。 */
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

  function requestOpen(): void {
    if (props.open === undefined) setSelfOpen(true)
    props.onOpenChange?.(true)
  }

  function requestClose(): void {
    if (props.open === undefined) setSelfOpen(false)
    props.onOpenChange?.(false)
    setDraft(null)
    setConfirmingDelete(false)
    setDateError(false)
  }

  // 外部选中契约：selectedId 变化 → 打开面板并把编辑器定位到该条。
  // 依赖只取 [props.selectedId, store]：同一 id 重复传入不会重复应用，
  // 用户在面板内的未保存编辑不会被自己触发的回写冲掉。
  useEffect(() => {
    const selectedId = props.selectedId
    if (selectedId === null || selectedId === undefined) return
    const found = store.getVault().milestones.find((candidate) => candidate.id === selectedId)
    if (found === undefined) return
    setDraft(draftFromMilestone(found))
    setConfirmingDelete(false)
    setDateError(false)
    requestOpen()
  }, [props.selectedId, store])

  // Esc 关闭：面板是非模态抽屉（甘特图保持可见可点），Esc 是最自然的退出。
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function startNew(): void {
    setDraft(newMilestoneDraft(vault, props.defaultTopicId ?? null))
    setConfirmingDelete(false)
    setDateError(false)
    requestOpen()
  }

  function selectMilestone(milestone: Milestone): void {
    setDraft(draftFromMilestone(milestone))
    setConfirmingDelete(false)
    setDateError(false)
    props.onSelect?.(milestone)
  }

  function saveDraft(): void {
    if (draft === null) return
    if (!isValidDateKey(draft.date)) {
      setDateError(true)
      return
    }
    const trimmed = draft.title.trim()
    const title = trimmed === '' ? t('milestonePanel.untitled') : trimmed
    const color = isPaletteColor(draft.color) ? draft.color : fallbackMilestoneColor()
    const topicId = draft.topicId
    const done = draft.done
    const date = draft.date
    const id = draft.id
    // 新建时的实体先算好（recipe 保持纯函数：不在 store.update 里塞副作用）
    const created: Milestone | null = id === null ? { id: newId(), topicId, title, date, done, color } : null
    store.update((current) => {
      if (created !== null) return upsertMilestone(current, created)
      const existing = current.milestones.find((candidate) => candidate.id === id)
      // 面板打开期间该条被外部删掉的罕见情况：不新建、不报错，静默跳过
      if (existing === undefined) return current
      return upsertMilestone(current, { ...existing, topicId, title, date, done, color })
    })
    setRevealId(created?.id ?? null)
    setDraft(null)
    setConfirmingDelete(false)
    setDateError(false)
  }

  function deleteDraft(): void {
    if (draft === null || draft.id === null) return
    const id = draft.id
    store.update((current) => removeMilestone(current, id))
    setDraft(null)
    setConfirmingDelete(false)
    setDateError(false)
    props.onSelect?.(null)
  }

  /** 行内完成态芯片：不必打开编辑器即可勾掉 / 取消勾掉。 */
  function toggleDone(milestone: Milestone): void {
    const done = !milestone.done
    store.update((current) => upsertMilestone(current, { ...milestone, done }))
    if (draft !== null && draft.id === milestone.id) setDraft({ ...draft, done })
  }

  function renderEditor(): ReactNode {
    if (draft === null) return null
    const editing = draft.id !== null
    return (
      <section
        data-testid="milestone-editor"
        data-mode={editing ? 'edit' : 'new'}
        data-editing-id={draft.id ?? ''}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: sp(8),
          padding: px('10px 10px 12px'),
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <div style={{ fontSize: fs(12), fontWeight: 600, color: TEXT }}>
          {editing ? t('milestonePanel.edit') : t('milestonePanel.new')}
        </div>

        <label style={FIELD_LABEL}>
          {t('milestonePanel.fieldTitle')}
          <input
            data-testid="milestone-title-input"
            value={draft.title}
            placeholder={t('milestonePanel.untitled')}
            autoFocus
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value })
            }}
            style={INPUT}
          />
        </label>

        <label style={FIELD_LABEL}>
          {t('milestonePanel.fieldDate')}
          <input
            data-testid="milestone-date-input"
            type="date"
            value={draft.date}
            onChange={(event) => {
              setDraft({ ...draft, date: event.target.value })
              setDateError(false)
            }}
            style={INPUT}
          />
        </label>
        {dateError ? (
          <div data-testid="milestone-error" style={{ fontSize: fs(11), color: OVERDUE_RED }}>
            {t('milestonePanel.invalidDate')}
          </div>
        ) : null}

        <label style={FIELD_LABEL}>
          {t('milestonePanel.fieldTopic')}
          <select
            data-testid="milestone-topic-select"
            value={draft.topicId ?? ''}
            onChange={(event) => {
              setDraft({ ...draft, topicId: event.target.value === '' ? null : event.target.value })
            }}
            style={INPUT}
          >
            <option value="">{t('milestonePanel.fieldCrossTopic')}</option>
            {topicOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.indent}
                {option.label}
                {option.archived ? `（${t('sidebar.archive')}）` : ''}
              </option>
            ))}
          </select>
        </label>
        {draft.topicId === null ? (
          <div data-testid="milestone-cross-hint" style={{ fontSize: fs(11), color: MUTED, lineHeight: 1.6 }}>
            {t('milestonePanel.crossTopicHint')}
          </div>
        ) : null}

        <label style={{ ...FIELD_LABEL, flexDirection: 'row', alignItems: 'center', gap: sp(6) }}>
          <input
            data-testid="milestone-done-toggle"
            type="checkbox"
            checked={draft.done}
            onChange={(event) => {
              setDraft({ ...draft, done: event.target.checked })
            }}
          />
          <span style={{ fontSize: fs(12), color: SECONDARY }}>{t('milestonePanel.fieldDone')}</span>
        </label>

        <div>
          <div style={{ fontSize: fs(11), color: MUTED, marginBottom: sp(4) }}>{t('milestonePanel.fieldColor')}</div>
          <div
            data-testid="milestone-color-palette"
            role="group"
            aria-label={t('milestonePanel.fieldColor')}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: sp(4) }}
          >
            {TOPIC_PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                data-color={color}
                data-current={color === draft.color ? 'true' : 'false'}
                aria-label={color}
                onClick={() => {
                  setDraft({ ...draft, color })
                }}
                style={{
                  width: sp(16),
                  height: sp(16),
                  padding: 0,
                  background: color,
                  border: color === draft.color ? `1px solid ${TEXT}` : '1px solid transparent',
                  borderRadius: 'var(--oe-radius-control)',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: sp(6), marginTop: sp(2) }}>
          <button type="button" data-testid="milestone-save" onClick={saveDraft} style={PRIMARY_BUTTON}>
            {t('milestonePanel.save')}
          </button>
          <button
            type="button"
            data-testid="milestone-cancel"
            onClick={() => {
              setDraft(null)
              setConfirmingDelete(false)
              setDateError(false)
            }}
            style={GHOST_BUTTON}
          >
            {t('milestonePanel.cancel')}
          </button>
        </div>

        {editing ? (
          confirmingDelete ? (
            <div
              data-testid="milestone-delete-confirm-bar"
              style={{ display: 'flex', alignItems: 'center', gap: sp(6), marginTop: sp(2) }}
            >
              <span style={{ flex: 1, fontSize: fs(11), color: MUTED, lineHeight: 1.5 }}>
                {t('milestonePanel.deleteHint')}
              </span>
              <button type="button" data-testid="milestone-delete-confirm" onClick={deleteDraft} style={DANGER_BUTTON}>
                {t('milestonePanel.deleteConfirm')}
              </button>
              <button
                type="button"
                data-testid="milestone-delete-cancel"
                onClick={() => {
                  setConfirmingDelete(false)
                }}
                style={GHOST_BUTTON}
              >
                {t('milestonePanel.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="milestone-delete"
              onClick={() => {
                setConfirmingDelete(true)
              }}
              style={{ ...GHOST_BUTTON, marginTop: sp(2), alignSelf: 'flex-start' }}
            >
              {t('milestonePanel.delete')}
            </button>
          )
        ) : null}
      </section>
    )
  }

  function renderRow(milestone: Milestone): ReactNode {
    const topic = milestone.topicId === null ? null : tree.byId.get(milestone.topicId)
    const cross = milestone.topicId === null || topic === undefined
    const selected = draft !== null && draft.id === milestone.id
    const color = milestone.color ?? fallbackMilestoneColor()
    return (
      <div
        key={milestone.id}
        data-testid={`milestone-row-${milestone.id}`}
        data-selected={selected ? 'true' : 'false'}
        data-done={milestone.done ? 'true' : 'false'}
        data-cross-topic={cross ? 'true' : 'false'}
        className="oe-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: sp(6),
          padding: px('0 10px'),
          background: selected ? ROW_SELECTED : 'transparent',
        }}
      >
        <button
          type="button"
          data-testid={`milestone-open-${milestone.id}`}
          onClick={() => {
            selectMilestone(milestone)
          }}
          style={{
            display: 'flex',
            flex: 1,
            minWidth: 0,
            alignItems: 'center',
            gap: sp(8),
            padding: px('5px 0'),
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {/* 菱形：与甘特图 MilestoneDiamond 同一形状语言；完成 = 实心，未完成 = 空心 */}
          <span
            aria-hidden="true"
            style={{
              width: sp(9),
              height: sp(9),
              flex: px('0 0 9px'),
              transform: 'rotate(45deg)',
              background: milestone.done ? color : 'transparent',
              border: `1px solid ${color}`,
              borderRadius: sp(1),
            }}
          />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: fs(12),
              color: milestone.done ? MUTED : TEXT,
              textDecoration: milestone.done ? 'line-through' : 'none',
            }}
          >
            {milestone.title}
          </span>
          <span style={{ fontSize: fs(11), color: MUTED, flex: '0 0 auto' }}>{milestone.date}</span>
          {cross ? (
            <span
              data-testid={`milestone-badge-${milestone.id}`}
              style={{
                flex: '0 0 auto',
                padding: px('0 5px'),
                fontSize: fs(10),
                color: SECONDARY,
                background: 'var(--oe-fill)',
                borderRadius: 'var(--oe-radius-control)',
              }}
            >
              {t('milestonePanel.crossTopicBadge')}
            </span>
          ) : (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: sp(4),
                flex: '0 0 auto',
                maxWidth: sp(84),
                fontSize: fs(11),
                color: SECONDARY,
              }}
            >
              <span
                style={{
                  width: sp(8),
                  height: sp(8),
                  flex: px('0 0 8px'),
                  borderRadius: 'var(--oe-radius-control)',
                  background: topic?.color ?? color,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {topic?.name ?? ''}
              </span>
            </span>
          )}
        </button>
        <button
          type="button"
          data-testid={`milestone-done-chip-${milestone.id}`}
          aria-pressed={milestone.done}
          onClick={() => {
            toggleDone(milestone)
          }}
          style={{
            flex: '0 0 auto',
            padding: px('1px 6px'),
            fontSize: fs(11),
            color: milestone.done ? DONE_GREEN : MUTED,
            background: 'transparent',
            border: `1px solid ${milestone.done ? DONE_GREEN : BORDER}`,
            borderRadius: 'var(--oe-radius-control)',
            cursor: 'pointer',
          }}
        >
          {milestone.done ? t('milestonePanel.doneLabel') : t('milestonePanel.undoneLabel')}
        </button>
      </div>
    )
  }

  function renderGroup(key: 'cross' | 'topic', title: string, items: readonly Milestone[]): ReactNode {
    if (items.length === 0) return null
    return (
      <div key={key} data-testid={`milestone-group-${key}`}>
        <div style={{ padding: px('6px 10px 2px'), fontSize: fs(11), fontWeight: 600, color: MUTED }}>{title}</div>
        {items.map((milestone) => renderRow(milestone))}
      </div>
    )
  }

  if (!open) return null

  const empty = groups.cross.length === 0 && groups.byTopic.length === 0

  return (
    <aside
      data-testid="milestone-panel"
      aria-label={t('milestonePanel.title')}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: PANEL_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--oe-material-sidebar)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderLeft: '1px solid var(--oe-separator)',
        boxSizing: 'border-box',
        fontFamily: 'var(--oe-font)',
        zIndex: 20,
        ...props.style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: sp(6), padding: px('10px 10px 8px') }}>
        <Icon name="milestone" size={15} />
        <span style={{ flex: 1, fontSize: fs(13), fontWeight: 600, color: TEXT }}>{t('milestonePanel.title')}</span>
        <span data-testid="milestone-count" style={{ fontSize: fs(11), color: MUTED }}>
          {t('milestonePanel.count', { n: vault.milestones.length })}
        </span>
        <button
          type="button"
          data-testid="milestone-panel-close"
          aria-label={t('milestonePanel.close')}
          title={t('milestonePanel.close')}
          onClick={requestClose}
          style={{
            display: 'flex',
            padding: sp(2),
            color: MUTED,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div style={{ padding: px('0 10px 8px') }}>
        <button
          type="button"
          data-testid="milestone-new"
          onClick={startNew}
          style={{
            ...GHOST_BUTTON,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: sp(5),
            width: '100%',
            color: INDIGO,
            borderColor: INDIGO,
          }}
        >
          <Icon name="plus" size={13} />
          {t('milestonePanel.new')}
        </button>
      </div>

      {renderEditor()}

      <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', borderTop: `1px solid ${BORDER}` }}>
        {empty ? (
          <div
            data-testid="milestone-empty"
            style={{ padding: px('24px 16px'), fontSize: fs(12), color: MUTED, textAlign: 'center', lineHeight: 1.7 }}
          >
            {t('milestonePanel.empty')}
          </div>
        ) : (
          <>
            {renderGroup('cross', t('milestonePanel.crossTopicGroup'), groups.cross)}
            {renderGroup('topic', t('milestonePanel.topicGroup'), groups.byTopic)}
          </>
        )}
      </div>
    </aside>
  )
}

export default MilestonePanel
