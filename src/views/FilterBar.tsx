// T16 · FilterBar：组合筛选面板（spec 6.2 筛选 / 第 7 节视觉规范）。
//
// 职责边界（spec 3 三条硬规则 / 本任务验收）：
// - 面板**只产出 Filter**：不建 QueryEngine、不接触任务列表。看板与甘特各自拿
//   同一份 `settings.lastFilter` 去跑自己的 QueryEngine（spec 6.2「共用同一份筛选结果」），
//   所以切换视图不会丢条件——条件本来就存在库里，不存在任何一个视图的局部状态里。
// - 所有筛选计算在 controllers/filters.ts 的纯函数里，组件只做两件事：
//   渲染 + 把「新 Filter」交给 commitFilter（内部走 T10 CommandBus 的 settings.patch）。
// - 落盘由既有链路负责：settings 变 → Store 变 → T08 autosave 写 vault.json；
//   重开时 vault.json 里的 settings.lastFilter 就是恢复源（本组件不做任何持久化）。
//
// 可挂载性（分支约定第 4 条）：导出默认组件 + 显式 props（store / bus / t / open）
// 由外部传入，不读 App 级单例、不改 src/App.tsx；侧栏「筛选器」入口的接线由集成窗口完成。
// 未 import 任何尚不存在的组件（TaskDrawer T17 / NoteEditor T24 / BackupPanel T28）。
//
// 视觉（spec 第 7 节）：颜色一律取 --oe-* token（不写死 hex）、圆角两档、无阴影堆叠、
// 无 emoji；选中态只用强调色描边 + 次级填充，不加装饰性元素。

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useStore } from 'zustand'

import {
  MAX_HOP_DEPTH,
  KIND_VALUES,
  PRIORITY_VALUES,
  STATUS_VALUES,
  clearFilter,
  commitFilter,
  countActiveFilters,
  normalizeFilter,
  setDateRange,
  setHopDepth,
  setTagMode,
  setText,
  toggleAssignee,
  toggleFlag,
  toggleKind,
  togglePriority,
  toggleStatus,
  toggleTag,
  toggleTopicId,
} from '../controllers/filters'
import type { CommandBus } from '../domain/commandBus'
import type { VaultStore } from '../domain/store'
import type { Filter } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { Icon } from './IconSprite'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const ACCENT = 'var(--oe-accent)'
const SURFACE = 'var(--oe-surface)'

const PANEL_WIDTH = 300

const INPUT: CSSProperties = {
  padding: '4px 6px',
  fontSize: 12,
  color: TEXT,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  outline: 'none',
  boxSizing: 'border-box',
}

const SECTION_LABEL: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  fontWeight: 600,
  color: MUTED,
  marginBottom: 4,
}

const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }

export interface FilterBarProps {
  store: VaultStore
  bus: CommandBus
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 受控开合；省略时面板自管（侧栏「筛选器」入口由集成窗口拉起）。 */
  open?: boolean
  /** 开合请求外送（受控时由接线方决定，非受控时仅作通知）。 */
  onOpenChange?: (open: boolean) => void
  /**
   * 命中条数。由外部（集成窗口）拿同一份 Filter 跑 QueryEngine 后传入——
   * 面板自己不查询：它只产出 Filter，结果属于两个视图各自的 QueryEngine。
   */
  matchCount?: number
  style?: CSSProperties
}

/** 一个可切换的 chip：选中态 = 强调色描边 + 次级填充 + aria-pressed。 */
function Chip(props: {
  testId: string
  label: string
  active: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      data-active={props.active ? 'true' : 'false'}
      aria-pressed={props.active}
      {...(props.title === undefined ? {} : { title: props.title })}
      onClick={props.onClick}
      style={{
        padding: '3px 8px',
        fontSize: 12,
        lineHeight: 1.5,
        color: props.active ? ACCENT : SECONDARY,
        background: props.active ? 'var(--oe-fill)' : 'transparent',
        border: `1px solid ${props.active ? ACCENT : BORDER}`,
        borderRadius: 'var(--oe-radius-control)',
        cursor: 'pointer',
      }}
    >
      {props.label}
    </button>
  )
}

/** 已选值 chip：右侧带移除叉（标签 / 负责人 / 话题共用一套形状）。 */
function RemoveChip(props: { testId: string; label: string; onClick: () => void; data?: Record<string, string> }) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      {...(props.data ?? {})}
      onClick={props.onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 6px 3px 8px',
        fontSize: 12,
        color: ACCENT,
        background: 'var(--oe-fill)',
        border: `1px solid ${ACCENT}`,
        borderRadius: 'var(--oe-radius-control)',
        cursor: 'pointer',
      }}
    >
      <span>{props.label}</span>
      <Icon name="close" size={10} />
    </button>
  )
}

function Section(props: { label: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div style={SECTION_LABEL}>
        <span>{props.label}</span>
        {props.extra}
      </div>
      {props.children}
    </section>
  )
}

export function FilterBar(props: FilterBarProps) {
  const { store, bus, t } = props
  const vault = useStore(store, (state) => state.vault)

  const [selfOpen, setSelfOpen] = useState(false)
  const [textDraft, setTextDraft] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [assigneeDraft, setAssigneeDraft] = useState('')

  const open = props.open ?? selfOpen
  // 库里为 null / 手改过的脏值时都先归一（跳数夹到 0–3、枚举外的值丢弃、重复项去重），
  // 保证 UI 展示的永远是合法形态；useMemo 让引用稳定，避免每次渲染重建
  const filter = useMemo<Filter>(() => normalizeFilter(vault.settings.lastFilter), [vault.settings.lastFilter])

  // 草稿随库里已提交的值同步（外部清空 / 恢复库时输入框要跟着回去）
  const committedText = filter.text ?? ''
  useEffect(() => {
    setTextDraft(committedText)
  }, [committedText])

  /**
   * 所有写入的唯一通道：以**当前**库内筛选为基底算新 Filter，再交给 commitFilter。
   * 读 store.getVault() 而不是渲染期捕获的 vault，避免同一 tick 内连续两次交互
   * 用旧基底互相覆盖；基底同样先归一，脏值不会把非法项带进新结果。
   */
  function apply(recipe: (current: Filter) => Filter): void {
    const live = store.getVault()
    commitFilter(live, bus, recipe(normalizeFilter(live.settings.lastFilter)))
  }

  function requestClose(): void {
    if (props.open === undefined) setSelfOpen(false)
    props.onOpenChange?.(false)
  }

  // Esc 关闭：面板贴着侧栏浮起，Esc 是最自然的退出
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

  /** 候选值：从库里现有任务派生（派生数据不落盘），排除已选中的。 */
  const tagSuggestions = useMemo(() => {
    const owned = new Set<string>()
    for (const task of vault.tasks) for (const tag of task.tags) owned.add(tag)
    return [...owned].filter((tag) => !filter.tags.includes(tag)).sort()
  }, [vault.tasks, filter.tags])

  const assigneeSuggestions = useMemo(() => {
    const owned = new Set<string>()
    for (const task of vault.tasks) if (task.assignee !== undefined && task.assignee !== '') owned.add(task.assignee)
    return [...owned].filter((name) => !filter.assignees.includes(name)).sort()
  }, [vault.tasks, filter.assignees])

  const topicsById = useMemo(() => new Map(vault.topics.map((topic) => [topic.id, topic])), [vault.topics])

  if (!open) return null

  const activeCount = countActiveFilters(filter)
  const upstream = filter.upstreamDepth ?? 0
  const downstream = filter.downstreamDepth ?? 0

  function addTag(raw: string): void {
    const value = raw.trim()
    if (value === '') return
    apply((current) => toggleTag(current, value))
    setTagDraft('')
  }

  function addAssignee(raw: string): void {
    const value = raw.trim()
    if (value === '') return
    apply((current) => toggleAssignee(current, value))
    setAssigneeDraft('')
  }

  return (
    <>
      <div
        data-testid="filter-backdrop"
        onClick={requestClose}
        style={{ position: 'fixed', inset: 0, zIndex: 19 }}
      />
      <aside
        data-testid="filter-bar"
        aria-label={t('filterBar.title')}
        style={{
          position: 'fixed',
          left: 8,
          bottom: 52,
          width: PANEL_WIDTH,
          maxHeight: 'min(640px, 72vh)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--oe-material-overlay)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          border: '1px solid var(--oe-separator)',
          borderRadius: 'var(--oe-radius-overlay)',
          boxShadow: 'var(--oe-shadow-pop)',
          boxSizing: 'border-box',
          fontFamily: 'var(--oe-font)',
          zIndex: 20,
          ...props.style,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 10px 8px' }}>
          <Icon name="filter" size={15} />
          <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>{t('filterBar.title')}</span>
          {activeCount > 0 ? (
            <span data-testid="filter-active-count" style={{ fontSize: 11, color: MUTED }}>
              {t('filterBar.activeCount', { n: activeCount })}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="filter-close"
            aria-label={t('filterBar.close')}
            title={t('filterBar.close')}
            onClick={requestClose}
            style={{
              display: 'flex',
              padding: 2,
              color: MUTED,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '0 10px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {/* 全文搜索：草稿态 + Enter/blur 提交（逐字写库会把撤销栈刷满） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: MUTED }}>
            <Icon name="search" size={13} />
            <input
              data-testid="filter-text-input"
              aria-label={t('filterBar.search')}
              placeholder={t('filterBar.searchPlaceholder')}
              value={textDraft}
              onChange={(event) => {
                setTextDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') apply((current) => setText(current, textDraft))
                if (event.key === 'Escape') setTextDraft(committedText)
              }}
              onBlur={() => {
                if (textDraft !== committedText) apply((current) => setText(current, textDraft))
              }}
              style={{ ...INPUT, flex: 1, minWidth: 0 }}
            />
          </div>

          <Section label={t('filterBar.status')}>
            <div style={ROW}>
              {STATUS_VALUES.map((status) => (
                <Chip
                  key={status}
                  testId={`filter-chip-status-${status}`}
                  label={t(`status.${status}`)}
                  active={filter.statuses.includes(status)}
                  onClick={() => {
                    apply((current) => toggleStatus(current, status))
                  }}
                />
              ))}
            </div>
          </Section>

          <Section label={t('filterBar.kind')}>
            <div style={ROW}>
              {KIND_VALUES.map((kind) => (
                <Chip
                  key={kind}
                  testId={`filter-chip-kind-${kind}`}
                  // 类别译名复用 T15 的 card.kind.*（同一套术语，不重复维护）
                  label={t(`card.kind.${kind}`)}
                  active={filter.kinds.includes(kind)}
                  onClick={() => {
                    apply((current) => toggleKind(current, kind))
                  }}
                />
              ))}
            </div>
          </Section>

          <Section label={t('filterBar.priority')}>
            <div style={ROW}>
              {PRIORITY_VALUES.map((priority) => (
                <Chip
                  key={priority}
                  testId={`filter-chip-priority-${priority}`}
                  label={priority}
                  active={filter.priorities.includes(priority)}
                  onClick={() => {
                    apply((current) => togglePriority(current, priority))
                  }}
                />
              ))}
            </div>
          </Section>

          <Section label={t('filterBar.topics')}>
            {filter.topicIds.length === 0 ? (
              <div style={{ fontSize: 11, color: MUTED }}>{t('filterBar.topicHint')}</div>
            ) : (
              <div style={ROW}>
                {filter.topicIds.map((topicId) => {
                  const topic = topicsById.get(topicId)
                  if (topic === undefined) return null
                  return (
                    <RemoveChip
                      key={topicId}
                      testId={`filter-topic-chip-${topicId}`}
                      label={topic.name}
                      onClick={() => {
                        apply((current) => toggleTopicId(current, topicId))
                      }}
                    />
                  )
                })}
              </div>
            )}
          </Section>

          <Section
            label={t('filterBar.tags')}
            extra={
              <span style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
                {(['any', 'all'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`filter-tagmode-${mode}`}
                    aria-pressed={filter.tagMode === mode}
                    onClick={() => {
                      apply((current) => setTagMode(current, mode))
                    }}
                    style={{
                      padding: '0 6px',
                      fontSize: 11,
                      color: filter.tagMode === mode ? ACCENT : MUTED,
                      background: filter.tagMode === mode ? 'var(--oe-fill)' : 'transparent',
                      border: `1px solid ${filter.tagMode === mode ? ACCENT : BORDER}`,
                      borderRadius: 'var(--oe-radius-control)',
                      cursor: 'pointer',
                    }}
                  >
                    {mode === 'any' ? t('filterBar.tagModeAny') : t('filterBar.tagModeAll')}
                  </button>
                ))}
              </span>
            }
          >
            {filter.tags.length > 0 ? (
              <div style={{ ...ROW, marginBottom: 4 }}>
                {filter.tags.map((tag, index) => (
                  <RemoveChip
                    key={tag}
                    testId={`filter-tag-chip-${index}`}
                    data={{ 'data-tag': tag }}
                    label={tag}
                    onClick={() => {
                      apply((current) => toggleTag(current, tag))
                    }}
                  />
                ))}
              </div>
            ) : null}
            <input
              data-testid="filter-tag-input"
              aria-label={t('filterBar.tags')}
              placeholder={t('filterBar.tagInputPlaceholder')}
              value={tagDraft}
              onChange={(event) => {
                setTagDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ',') addTag(tagDraft)
              }}
              style={{ ...INPUT, width: '100%' }}
            />
            {tagSuggestions.length > 0 ? (
              <div style={{ ...ROW, marginTop: 4 }}>
                {tagSuggestions.map((tag, index) => (
                  <Chip
                    key={tag}
                    testId={`filter-tag-suggest-${index}`}
                    label={tag}
                    active={false}
                    onClick={() => {
                      addTag(tag)
                    }}
                  />
                ))}
              </div>
            ) : null}
          </Section>

          <Section label={t('filterBar.assignees')}>
            {filter.assignees.length > 0 ? (
              <div style={{ ...ROW, marginBottom: 4 }}>
                {filter.assignees.map((name, index) => (
                  <RemoveChip
                    key={name}
                    testId={`filter-assignee-chip-${index}`}
                    data={{ 'data-assignee': name }}
                    label={name}
                    onClick={() => {
                      apply((current) => toggleAssignee(current, name))
                    }}
                  />
                ))}
              </div>
            ) : null}
            <input
              data-testid="filter-assignee-input"
              aria-label={t('filterBar.assignees')}
              placeholder={t('filterBar.assigneeInputPlaceholder')}
              value={assigneeDraft}
              onChange={(event) => {
                setAssigneeDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ',') addAssignee(assigneeDraft)
              }}
              style={{ ...INPUT, width: '100%' }}
            />
            {assigneeSuggestions.length > 0 ? (
              <div style={{ ...ROW, marginTop: 4 }}>
                {assigneeSuggestions.map((name, index) => (
                  <Chip
                    key={name}
                    testId={`filter-assignee-suggest-${index}`}
                    label={name}
                    active={false}
                    onClick={() => {
                      addAssignee(name)
                    }}
                  />
                ))}
              </div>
            ) : null}
          </Section>

          <Section
            label={t('filterBar.dateRange')}
            extra={
              filter.dateRange === undefined ? null : (
                <button
                  type="button"
                  data-testid="filter-date-clear"
                  title={t('filterBar.dateClear')}
                  onClick={() => {
                    apply((current) => setDateRange(current, {}))
                  }}
                  style={{
                    marginLeft: 'auto',
                    padding: 0,
                    fontSize: 11,
                    color: MUTED,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {t('filterBar.dateClear')}
                </button>
              )
            }
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                data-testid="filter-date-from"
                type="date"
                aria-label={t('filterBar.dateFrom')}
                value={filter.dateRange?.from ?? ''}
                onChange={(event) => {
                  const from = event.target.value
                  apply((current) => setDateRange(current, { from, to: current.dateRange?.to }))
                }}
                style={{ ...INPUT, flex: 1, minWidth: 0 }}
              />
              <span style={{ color: MUTED, fontSize: 11 }}>–</span>
              <input
                data-testid="filter-date-to"
                type="date"
                aria-label={t('filterBar.dateTo')}
                value={filter.dateRange?.to ?? ''}
                onChange={(event) => {
                  const to = event.target.value
                  apply((current) => setDateRange(current, { from: current.dateRange?.from, to }))
                }}
                style={{ ...INPUT, flex: 1, minWidth: 0 }}
              />
            </div>
          </Section>

          <Section label={t('filterBar.flags')}>
            <div style={ROW}>
              <Chip
                testId="filter-chip-overdue"
                label={t('filterBar.overdue')}
                active={filter.overdueOnly === true}
                onClick={() => {
                  apply((current) => toggleFlag(current, 'overdueOnly'))
                }}
              />
              <Chip
                testId="filter-chip-blocked"
                label={t('filterBar.blocked')}
                active={filter.blockedOnly === true}
                onClick={() => {
                  apply((current) => toggleFlag(current, 'blockedOnly'))
                }}
              />
              <Chip
                testId="filter-chip-with-notes"
                label={t('filterBar.withNotes')}
                active={filter.withNotesOnly === true}
                onClick={() => {
                  apply((current) => toggleFlag(current, 'withNotesOnly'))
                }}
              />
              <Chip
                testId="filter-chip-include-archived"
                label={t('filterBar.includeArchived')}
                active={filter.includeArchived === true}
                onClick={() => {
                  apply((current) => toggleFlag(current, 'includeArchived'))
                }}
              />
            </div>
          </Section>

          <Section label={t('filterBar.hops')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: SECONDARY }}>
                {t('filterBar.upstream')}
                <input
                  data-testid="filter-upstream-input"
                  type="number"
                  min={0}
                  max={MAX_HOP_DEPTH}
                  value={upstream}
                  onChange={(event) => {
                    const value = Number.parseInt(event.target.value, 10)
                    apply((current) => setHopDepth(current, 'upstream', value))
                  }}
                  style={{ ...INPUT, width: 52 }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: SECONDARY }}>
                {t('filterBar.downstream')}
                <input
                  data-testid="filter-downstream-input"
                  type="number"
                  min={0}
                  max={MAX_HOP_DEPTH}
                  value={downstream}
                  onChange={(event) => {
                    const value = Number.parseInt(event.target.value, 10)
                    apply((current) => setHopDepth(current, 'downstream', value))
                  }}
                  style={{ ...INPUT, width: 52 }}
                />
              </label>
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: MUTED, lineHeight: 1.6 }}>
              {t('filterBar.hopsHint')}
            </div>
          </Section>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 10px',
            borderTop: `1px solid ${BORDER}`,
          }}
        >
          {props.matchCount === undefined ? (
            <span style={{ flex: 1 }} />
          ) : (
            <span data-testid="filter-match-count" style={{ flex: 1, fontSize: 11, color: MUTED }}>
              {t('filterBar.matchCount', { n: props.matchCount })}
            </span>
          )}
          <button
            type="button"
            data-testid="filter-clear"
            onClick={() => {
              apply(() => clearFilter())
            }}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              color: ACCENT,
              background: 'transparent',
              border: `1px solid ${ACCENT}`,
              borderRadius: 'var(--oe-radius-control)',
              cursor: 'pointer',
            }}
          >
            {t('filterBar.clear')}
          </button>
        </div>
      </aside>
    </>
  )
}

export default FilterBar
