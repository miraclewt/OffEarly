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
import { applyDeleteTag, applyRenameTag, listTags } from '../controllers/tagActions'
import { Icon } from './IconSprite'
import { DateField } from './DateField'
import { fs, sp, px } from '../styles/scale'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const ACCENT = 'var(--oe-accent)'
const SURFACE = 'var(--oe-surface)'

const PANEL_WIDTH = 300

const INPUT: CSSProperties = {
  padding: px('4px 6px'),
  fontSize: fs(12),
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
  gap: sp(6),
  fontSize: fs(11),
  fontWeight: 600,
  color: MUTED,
  marginBottom: sp(4),
}

const ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: sp(4) }

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
        padding: px('3px 8px'),
        fontSize: fs(12),
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
        gap: sp(4),
        padding: px('3px 6px 3px 8px'),
        fontSize: fs(12),
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
  // T62 · 标签管理：面板内展开的标签清单 + 改名草稿 + 待确认删除的标签
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [renamingTag, setRenamingTag] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [armedTag, setArmedTag] = useState<string | null>(null)

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

  /** T62 · 全库标签清单（含使用次数）：标签管理的行源，与输入框候选共用同一份派生数据。 */
  const allTags = useMemo(() => listTags(vault), [vault])

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

  /**
   * 标签改名：目标名已存在时后端就是「合并」，这里不二次询问（行内已写明）。
   * 返回是否落库——空名字 / 同名都是 no-op，编辑态直接退出，不把用户困在输入框里。
   */
  function commitRename(from: string): boolean {
    const ok = applyRenameTag(bus, store.getVault(), from, renameDraft)
    setRenamingTag(null)
    setRenameDraft('')
    return ok
  }

  function commitDelete(tag: string): void {
    applyDeleteTag(bus, store.getVault(), tag)
    setArmedTag(null)
    if (renamingTag === tag) setRenamingTag(null)
  }

  /** 行内小按钮：改名 / 删除共用一套形状，删除确认态换危险色。 */
  function rowAction(testId: string, label: string, danger: boolean, onClick: () => void) {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        style={{
          padding: px('0 4px'),
          fontSize: fs(11),
          color: danger ? 'var(--oe-overdue)' : MUTED,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </button>
    )
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
          left: sp(8),
          bottom: sp(52),
          width: PANEL_WIDTH,
          maxHeight: px('min(640px, 72vh)'),
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
        <div style={{ display: 'flex', alignItems: 'center', gap: sp(6), padding: px('9px 10px 8px') }}>
          <Icon name="filter" size={15} />
          <span style={{ fontSize: fs(13), fontWeight: 600, color: TEXT }}>{t('filterBar.title')}</span>
          {activeCount > 0 ? (
            <span data-testid="filter-active-count" style={{ fontSize: fs(11), color: MUTED }}>
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

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: px('0 10px 10px'),
            display: 'flex',
            flexDirection: 'column',
            gap: sp(10),
          }}
        >
          {/* 全文搜索：草稿态 + Enter/blur 提交（逐字写库会把撤销栈刷满） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: sp(5), color: MUTED }}>
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

          {/* T61：「逾期 / 被阻塞 / 有笔记 / 含归档」四个开关置顶。
              它们原本排在面板最底部，在 900 高的窗口里正好落在视口之外——
              而「只看逾期」恰恰是打开筛选面板最常见的动机。 */}
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
              <div style={{ fontSize: fs(11), color: MUTED }}>{t('filterBar.topicHint')}</div>
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
              <span style={{ display: 'flex', gap: sp(3), marginLeft: 'auto' }}>
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
                      padding: px('0 6px'),
                      fontSize: fs(11),
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
                {/* T62：标签管理的入口。放在这个 Section 里而不是另开浮层——
                    标签的「筛选」与「改名/删除」是同一件事的两个动作，分开做会让
                    用户在两处之间来回看同一个清单。 */}
                <button
                  type="button"
                  data-testid="filter-tag-manage"
                  aria-pressed={tagManagerOpen}
                  title={t('filterBar.tagManage')}
                  onClick={() => {
                    setTagManagerOpen(!tagManagerOpen)
                    setRenamingTag(null)
                    setArmedTag(null)
                  }}
                  style={{
                    padding: px('0 6px'),
                    fontSize: fs(11),
                    color: tagManagerOpen ? ACCENT : MUTED,
                    background: tagManagerOpen ? 'var(--oe-fill)' : 'transparent',
                    border: `1px solid ${tagManagerOpen ? ACCENT : BORDER}`,
                    borderRadius: 'var(--oe-radius-control)',
                    cursor: 'pointer',
                  }}
                >
                  {tagManagerOpen ? t('filterBar.tagManageDone') : t('filterBar.tagManage')}
                </button>
              </span>
            }
          >
            {filter.tags.length > 0 ? (
              <div style={{ ...ROW, marginBottom: sp(4) }}>
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
              <div style={{ ...ROW, marginTop: sp(4) }}>
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
            {tagManagerOpen ? (
              <div
                data-testid="filter-tag-manager"
                style={{
                  marginTop: sp(6),
                  paddingTop: sp(6),
                  borderTop: `1px solid ${BORDER}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: sp(2),
                }}
              >
                {allTags.length === 0 ? (
                  <div data-testid="filter-tag-empty" style={{ fontSize: fs(11), color: MUTED }}>
                    {t('filterBar.tagEmpty')}
                  </div>
                ) : (
                  allTags.map((row) => (
                    <div
                      key={row.tag}
                      data-testid="filter-tag-row"
                      data-tag={row.tag}
                      style={{ display: 'flex', alignItems: 'center', gap: sp(4), minHeight: sp(22) }}
                    >
                      {renamingTag === row.tag ? (
                        <input
                          data-testid="filter-tag-rename-input"
                          aria-label={t('filterBar.tagRename')}
                          placeholder={t('filterBar.tagRenamePlaceholder')}
                          autoFocus
                          value={renameDraft}
                          onChange={(event) => {
                            setRenameDraft(event.target.value)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitRename(row.tag)
                            if (event.key === 'Escape') {
                              setRenamingTag(null)
                              setRenameDraft('')
                            }
                          }}
                          onBlur={() => {
                            commitRename(row.tag)
                          }}
                          style={{ ...INPUT, flex: 1, minWidth: 0, padding: px('2px 5px') }}
                        />
                      ) : (
                        <>
                          {/* 点标签名 = 按它筛选：与上方候选 chip 同一动作，顺手 */}
                          <button
                            type="button"
                            data-testid="filter-tag-apply"
                            title={t('filterBar.tagApply')}
                            onClick={() => {
                              addTag(row.tag)
                            }}
                            style={{
                              minWidth: 0,
                              padding: 0,
                              fontSize: fs(12),
                              color: filter.tags.includes(row.tag) ? ACCENT : TEXT,
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {row.tag}
                          </button>
                          <span style={{ fontSize: fs(11), color: MUTED }}>{row.count}</span>
                          <span style={{ flex: 1 }} />
                          {rowAction('filter-tag-rename', t('filterBar.tagRename'), false, () => {
                            setRenamingTag(row.tag)
                            setRenameDraft(row.tag)
                            setArmedTag(null)
                          })}
                          {rowAction(
                            'filter-tag-delete',
                            armedTag === row.tag ? t('filterBar.tagDeleteConfirm') : t('filterBar.tagDelete'),
                            armedTag === row.tag,
                            () => {
                              // 两段式：删除会从 N 个任务上抹掉标签，误点代价大（可撤销但不明显）
                              if (armedTag === row.tag) commitDelete(row.tag)
                              else {
                                setArmedTag(row.tag)
                                setRenamingTag(null)
                              }
                            },
                          )}
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </Section>

          <Section label={t('filterBar.assignees')}>
            {filter.assignees.length > 0 ? (
              <div style={{ ...ROW, marginBottom: sp(4) }}>
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
              <div style={{ ...ROW, marginTop: sp(4) }}>
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
                    fontSize: fs(11),
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
            <div style={{ display: 'flex', alignItems: 'center', gap: sp(4) }}>
              <DateField
                testId="filter-date-from"
                ariaLabel={t('filterBar.dateFrom')}
                t={t}
                value={filter.dateRange?.from ?? ''}
                onCommit={(from) => {
                  apply((current) => setDateRange(current, { from, to: current.dateRange?.to }))
                }}
                style={{ flex: 1, minWidth: 0 }}
                inputStyle={{ ...INPUT, width: '100%' }}
              />
              <span style={{ color: MUTED, fontSize: fs(11) }}>–</span>
              <DateField
                testId="filter-date-to"
                ariaLabel={t('filterBar.dateTo')}
                t={t}
                value={filter.dateRange?.to ?? ''}
                onCommit={(to) => {
                  apply((current) => setDateRange(current, { from: current.dateRange?.from, to }))
                }}
                style={{ flex: 1, minWidth: 0 }}
                inputStyle={{ ...INPUT, width: '100%' }}
              />
            </div>
          </Section>


          <Section label={t('filterBar.hops')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: sp(6) }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: sp(4), fontSize: fs(11), color: SECONDARY }}>
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
                  style={{ ...INPUT, width: sp(52) }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: sp(4), fontSize: fs(11), color: SECONDARY }}>
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
                  style={{ ...INPUT, width: sp(52) }}
                />
              </label>
            </div>
            <div style={{ marginTop: sp(4), fontSize: fs(11), color: MUTED, lineHeight: 1.6 }}>
              {t('filterBar.hopsHint')}
            </div>
          </Section>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: sp(6),
            padding: px('8px 10px'),
            borderTop: `1px solid ${BORDER}`,
          }}
        >
          {props.matchCount === undefined ? (
            <span style={{ flex: 1 }} />
          ) : (
            <span data-testid="filter-match-count" style={{ flex: 1, fontSize: fs(11), color: MUTED }}>
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
              padding: px('4px 10px'),
              fontSize: fs(12),
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
