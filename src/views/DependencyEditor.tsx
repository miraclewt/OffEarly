// T17 · DependencyEditor：TaskDrawer 的「依赖关系」分区（spec 6.3 第四款）。
//
// 能力（验收 3/4）：
// - 添加：全库标题**模糊搜索**下拉（跨 topic 天然支持——候选不按话题过滤），
//   选中即在「选中任务 → 本任务」方向建一条 FS 依赖（本任务被它阻塞）；
// - 修改：每条依赖的类型 FS/SS/FF/SF 与 lagDays 可改（经 patchLinkCommand）；
// - 删除：逐条可删（经 deleteLinkCommand）；
// - 成环：参与环的依赖行**标红 + 徽标**，分区级给提示，但**不阻止保存**
//   （spec 5.3：个人工具应宽容，只标红警示；关键路径此时降级为不算）。
//
// 成环判定复用 T12 的 createDependencyGraph（Tarjan 强连通分量），不另写环检测。
// 写入口全部走 T10 CommandBus 的 link.* 命令（T17 授权扩展），undo/redo 与
// 任务编辑共用同一条撤销栈。颜色一律取 --oe-* token（语义红借 --oe-overdue，
// 与 MilestonePanel 的危险操作同源），无 hex、无 emoji。

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useStore } from 'zustand'

import { createDependencyGraph } from '../domain/dependencyGraph'
import type { CommandBus } from '../domain/commandBus'
import { createLinkCommand, deleteLinkCommand, patchLinkCommand } from '../domain/commandBus'
import type { VaultStore } from '../domain/store'
import type { Dependency, DependencyType, Task } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { Icon } from './IconSprite'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const FAINT = 'var(--oe-text-faint)'
const SURFACE = 'var(--oe-surface)'
const FILL = 'var(--oe-fill)'
const DANGER = 'var(--oe-overdue)'

/** 依赖类型四枚举（spec 4.2 DependencyType）。缩写是项目管理通用语，不翻译。 */
export const DEPENDENCY_TYPES: readonly DependencyType[] = ['FS', 'SS', 'FF', 'SF']

/** 搜索下拉最多展示的候选数（个人库量级下够用，避免一次渲染几百行）。 */
export const DEPENDENCY_SEARCH_LIMIT = 8

// ── 纯函数（导出供单测直接断言；组件只负责把结果写进 Store） ──────────────

/**
 * 标题模糊匹配：query 的每个字符按顺序出现在 text 里即命中（大小写不敏感），
 * 返回得分（越小越好）或 null（不命中）。连续命中与靠前出现都降分，
 * 因此「登录」对「登录页」的得分优于「登-录- elsewhere」的散点匹配。
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (query === '') return 0
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  let score = 0
  let cursor = 0
  let previous = -2
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor)
    if (found === -1) return null
    score += found - cursor
    // 与上一个命中相邻时奖励 1 分：连续子串理应排在跳字匹配前面
    if (found === previous + 1) score -= 1
    cursor = found + 1
    previous = found
  }
  return score
}

export interface DependencyCandidateOptions {
  /** 正在编辑的任务 id：自依赖无意义，从候选里剔除。 */
  taskId: string
  /** 已是本任务前置的任务 id：同方向重复建链会造出平行边，剔除。 */
  existingPredecessorIds: ReadonlySet<string>
  /** 省略即取默认上限。 */
  limit?: number
}

/**
 * 全库标题模糊搜索：候选**不按话题过滤**（「天然支持跨 topic」），
 * 但剔除自身（自环）与已有同方向链接的任务（平行边）。
 * query 为空返回空数组——先输入关键词再选，避免下拉一开就刷全库。
 */
export function searchDependencyCandidates(
  tasks: readonly Task[],
  query: string,
  options: DependencyCandidateOptions,
): Task[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const limit = options.limit ?? DEPENDENCY_SEARCH_LIMIT
  const scored: { task: Task; score: number }[] = []
  for (const task of tasks) {
    if (task.id === options.taskId) continue
    if (options.existingPredecessorIds.has(task.id)) continue
    const score = fuzzyScore(task.title, trimmed)
    if (score === null) continue
    scored.push({ task, score })
  }
  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.task.title.localeCompare(b.task.title)))
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.task)
}

export interface TaskLinks {
  /** from → 本任务：这些任务在阻塞本任务（spec 4.2 语义）。 */
  predecessors: Dependency[]
  /** 本任务 → to：本任务在阻塞它们。 */
  successors: Dependency[]
}

/** 按方向拆开与本任务相关的全部链接；自环归到前置组展示（它同时是二者）。 */
export function splitTaskLinks(links: readonly Dependency[], taskId: string): TaskLinks {
  const predecessors: Dependency[] = []
  const successors: Dependency[] = []
  for (const link of links) {
    const outgoing = link.from === taskId
    const incoming = link.to === taskId
    if (incoming) predecessors.push(link)
    else if (outgoing) successors.push(link)
  }
  return { predecessors, successors }
}

/**
 * 参与成环的链接 id 集合：两端点落在同一个强连通分量里（自环同样计入）。
 * 判定复用 T12 的 DependencyGraph.cycles()，不另写环检测算法。
 */
export function cycleLinkIds(links: readonly Dependency[], tasks: readonly Task[]): Set<string> {
  const graph = createDependencyGraph(links, tasks)
  const cycles = graph.cycles()
  const ids = new Set<string>()
  if (cycles.length === 0) return ids
  for (const link of links) {
    if (link.from === link.to) {
      ids.add(link.id)
      continue
    }
    for (const cycle of cycles) {
      if (cycle.includes(link.from) && cycle.includes(link.to)) {
        ids.add(link.id)
        break
      }
    }
  }
  return ids
}

/** 本任务是否落在某个环里（分区级提示的触发条件）。 */
export function taskInCycle(taskId: string, links: readonly Dependency[], tasks: readonly Task[]): boolean {
  return createDependencyGraph(links, tasks)
    .cycles()
    .some((cycle) => cycle.includes(taskId))
}

// ── 组件 ────────────────────────────────────────────────────────────────

export interface DependencyEditorProps {
  store: VaultStore
  bus: CommandBus
  /** 正在编辑的任务 id（依赖行的「本任务」一侧）。 */
  taskId: string
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 注入 id 生成，便于测试确定化。 */
  newId?: () => string
  style?: CSSProperties
}

const INPUT: CSSProperties = {
  padding: '3px 6px',
  fontSize: 12,
  color: TEXT,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  outline: 'none',
  boxSizing: 'border-box',
}

const SMALL_GHOST: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 3,
  padding: '2px 6px',
  fontSize: 11,
  color: SECONDARY,
  background: 'transparent',
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

/** 单行 lag 输入：本地草稿 + 失焦/回车提交，避免逐字符写 Store 刷爆撤销栈。 */
function LagInput(props: { link: Dependency; commit: (lagDays: number) => void; t: DependencyEditorProps['t'] }) {
  const { link, commit, t } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(link.lagDays))

  // 外部（撤销 / 重做 / 别处编辑）改了 lagDays 时同步草稿；编辑中不打断用户输入
  useEffect(() => {
    if (!editing) setDraft(String(link.lagDays))
  }, [link.lagDays, editing])

  function tryCommit(): void {
    const parsed = Number(draft.trim())
    if (draft.trim() !== '' && Number.isInteger(parsed) && Math.abs(parsed) <= 999) {
      if (parsed !== link.lagDays) commit(parsed)
    } else {
      setDraft(String(link.lagDays))
    }
    setEditing(false)
  }

  return (
    <input
      data-testid={`dep-row-${link.id}-lag`}
      type="number"
      step={1}
      aria-label={t('drawer.depLag')}
      value={editing ? draft : String(link.lagDays)}
      style={{ ...INPUT, width: 52 }}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        setEditing(true)
        setDraft(event.target.value)
      }}
      onBlur={tryCommit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          tryCommit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(String(link.lagDays))
          setEditing(false)
        }
      }}
    />
  )
}

export function DependencyEditor(props: DependencyEditorProps) {
  const { store, bus, taskId, t } = props
  const vault = useStore(store, (state) => state.vault)

  const [query, setQuery] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)

  const taskById = useMemo(() => new Map(vault.tasks.map((task) => [task.id, task])), [vault.tasks])
  const topicById = useMemo(() => new Map(vault.topics.map((topic) => [topic.id, topic])), [vault.topics])

  const groups = useMemo(() => splitTaskLinks(vault.links, taskId), [vault.links, taskId])
  const cycleIds = useMemo(() => cycleLinkIds(vault.links, vault.tasks), [vault.links, vault.tasks])
  const inCycle = useMemo(() => taskInCycle(taskId, vault.links, vault.tasks), [vault.links, vault.tasks, taskId])

  const existingPredecessorIds = useMemo(
    () => new Set(groups.predecessors.map((link) => link.from)),
    [groups.predecessors],
  )
  const candidates = useMemo(
    () => searchDependencyCandidates(vault.tasks, query, { taskId, existingPredecessorIds }),
    [vault.tasks, query, taskId, existingPredecessorIds],
  )

  const total = groups.predecessors.length + groups.successors.length

  /** 组内按对端任务标题排序，读起来像一份清单而不是录入顺序。 */
  const sortByOtherTitle = (links: readonly Dependency[], pick: (link: Dependency) => string): Dependency[] =>
    [...links].sort((a, b) => {
      const titleA = taskById.get(pick(a))?.title ?? ''
      const titleB = taskById.get(pick(b))?.title ?? ''
      return titleA.localeCompare(titleB)
    })

  function addDependency(otherId: string): void {
    const link: Dependency = { id: (props.newId ?? defaultNewId)(), from: otherId, to: taskId, type: 'FS', lagDays: 0 }
    bus.apply(createLinkCommand(link))
    setQuery('')
    setDropdownOpen(false)
    setHighlight(0)
  }

  function deleteDependency(id: string): void {
    bus.apply(deleteLinkCommand(store.getVault(), id))
  }

  function patchDependency(id: string, patch: { type?: DependencyType; lagDays?: number }): void {
    bus.apply(patchLinkCommand(store.getVault(), id, patch))
  }

  function renderRow(link: Dependency, direction: 'predecessor' | 'successor'): ReactNode {
    const otherId = direction === 'predecessor' ? link.from : link.to
    const other = taskById.get(otherId)
    const topic = other === undefined ? undefined : topicById.get(other.topicId)
    const cyclic = cycleIds.has(link.id)
    return (
      <div
        key={link.id}
        data-testid={`dep-row-${link.id}`}
        data-direction={direction}
        data-cyclic={cyclic ? 'true' : 'false'}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '6px 8px',
          border: `1px solid ${cyclic ? DANGER : BORDER}`,
          borderRadius: 'var(--oe-radius-card)',
          background: SURFACE,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              flex: '0 0 auto',
              padding: '0 5px',
              fontSize: 10,
              lineHeight: '15px',
              color: SECONDARY,
              background: FILL,
              borderRadius: 'var(--oe-radius-control)',
            }}
          >
            {direction === 'predecessor' ? t('drawer.depPredecessor') : t('drawer.depSuccessor')}
          </span>

          <span
            data-testid={`dep-row-${link.id}-other`}
            style={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: 5, flex: 1 }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                flex: '0 0 7px',
                borderRadius: '50%',
                background: topic?.color ?? FAINT,
              }}
            />
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: 12,
                color: other === undefined ? MUTED : TEXT,
              }}
              title={other?.title}
            >
              {other?.title ?? t('drawer.depMissingTask')}
            </span>
          </span>

          {cyclic ? (
            <span
              data-testid={`dep-row-${link.id}-cycle`}
              style={{
                flex: '0 0 auto',
                padding: '0 5px',
                fontSize: 10,
                lineHeight: '15px',
                color: DANGER,
                border: `1px solid ${DANGER}`,
                borderRadius: 'var(--oe-radius-control)',
              }}
            >
              {t('drawer.depCycleBadge')}
            </span>
          ) : null}

          <button
            type="button"
            data-testid={`dep-row-${link.id}-delete`}
            aria-label={t('drawer.depDelete')}
            title={t('drawer.depDelete')}
            onClick={() => {
              deleteDependency(link.id)
            }}
            style={{ ...SMALL_GHOST, flex: '0 0 auto', padding: '0 4px', color: MUTED }}
          >
            <Icon name="close" size={12} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: MUTED }}>
          <span>{t('drawer.depType')}</span>
          <select
            data-testid={`dep-row-${link.id}-type`}
            aria-label={t('drawer.depType')}
            title={t('drawer.depTypeTitle')}
            value={link.type}
            onChange={(event) => {
              patchDependency(link.id, { type: event.target.value as DependencyType })
            }}
            style={{ ...INPUT, width: 62 }}
          >
            {DEPENDENCY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <span>{t('drawer.depLag')}</span>
          <LagInput link={link} commit={(lagDays) => patchDependency(link.id, { lagDays })} t={t} />
          <span>{t('drawer.depLagUnit')}</span>
        </div>
      </div>
    )
  }

  return (
    <section
      data-testid="drawer-dependencies"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, ...props.style }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="dependency" size={14} />
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: TEXT }}>{t('drawer.sectionDeps')}</span>
        <span data-testid="dep-count" style={{ fontSize: 11, color: MUTED }}>
          {t('drawer.depCount', { n: total })}
        </span>
      </div>

      {inCycle ? (
        <div
          data-testid="dep-cycle-hint"
          style={{
            padding: '5px 8px',
            fontSize: 11,
            lineHeight: 1.6,
            color: DANGER,
            border: `1px solid ${DANGER}`,
            borderRadius: 'var(--oe-radius-control)',
          }}
        >
          {t('drawer.depCycleHint')}
        </div>
      ) : null}

      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'flex', flex: '0 0 auto', color: FAINT }}>
            <Icon name="search" size={14} />
          </span>
          <input
            data-testid="dep-search-input"
            role="combobox"
            aria-expanded={dropdownOpen}
            aria-controls="dep-search-listbox"
            placeholder={t('drawer.depAddPlaceholder')}
            value={query}
            style={{ ...INPUT, flex: 1 }}
            onFocus={() => setDropdownOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value)
              setDropdownOpen(true)
              setHighlight(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setDropdownOpen(false)
                return
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setDropdownOpen(true)
                setHighlight((current) => Math.min(current + 1, Math.max(0, candidates.length - 1)))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlight((current) => Math.max(current - 1, 0))
                return
              }
              if (event.key === 'Enter') {
                const picked = candidates[highlight]
                if (picked !== undefined) {
                  event.preventDefault()
                  addDependency(picked.id)
                }
              }
            }}
          />
        </div>

        {dropdownOpen && query.trim() !== '' ? (
          <div
            id="dep-search-listbox"
            role="listbox"
            data-testid="dep-search-dropdown"
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              zIndex: 30,
              marginTop: 2,
              maxHeight: 180,
              overflowY: 'auto',
              background: SURFACE,
              border: `1px solid ${BORDER}`,
              borderRadius: 'var(--oe-radius-card)',
              boxShadow: 'var(--oe-shadow-hover)',
            }}
          >
            {candidates.length === 0 ? (
              <div data-testid="dep-search-empty" style={{ padding: '6px 8px', fontSize: 11, color: MUTED }}>
                {t('drawer.depSearchEmpty')}
              </div>
            ) : (
              candidates.map((task, index) => {
                const topic = topicById.get(task.topicId)
                return (
                  <button
                    key={task.id}
                    type="button"
                    role="option"
                    aria-selected={index === highlight}
                    data-testid={`dep-search-option-${task.id}`}
                    data-highlighted={index === highlight ? 'true' : 'false'}
                    // 用 mousedown 阻止默认：否则 input 先失焦、下拉先卸载，click 落空
                    onMouseDown={(event) => {
                      event.preventDefault()
                    }}
                    onClick={() => {
                      addDependency(task.id)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      padding: '5px 8px',
                      background: index === highlight ? FILL : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 7,
                        height: 7,
                        flex: '0 0 7px',
                        borderRadius: '50%',
                        background: topic?.color ?? FAINT,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 12,
                        color: TEXT,
                      }}
                    >
                      {task.title}
                    </span>
                    <span style={{ flex: '0 0 auto', fontSize: 11, color: MUTED }}>{topic?.name ?? ''}</span>
                  </button>
                )
              })
            )}
          </div>
        ) : null}
      </div>

      {total === 0 ? (
        <div data-testid="dep-empty" style={{ fontSize: 11, color: MUTED, lineHeight: 1.7 }}>
          {t('drawer.depEmpty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sortByOtherTitle(groups.predecessors, (link) => link.from).map((link) =>
            renderRow(link, 'predecessor'),
          )}
          {sortByOtherTitle(groups.successors, (link) => link.to).map((link) => renderRow(link, 'successor'))}
        </div>
      )}
    </section>
  )
}

/** 与 MilestonePanel 等视图一致：优先用 crypto.randomUUID，缺失时退回时间戳 + 随机串。 */
function defaultNewId(): string {
  const globalCrypto = globalThis.crypto
  if (globalCrypto !== undefined && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }
  return `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export default DependencyEditor
