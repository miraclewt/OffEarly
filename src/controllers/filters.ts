// T16 · filters：FilterBar 的筛选计算（纯函数）+ lastFilter 落盘入口（spec 6.2）。
//
// 分层边界（spec 3）：
// - 本文件是**编排层**：把 UI 事件（一次 chip 切换 / 一次输入）翻译成「新 Filter」，
//   再经 T10 CommandBus 的 settings.patch 写进唯一状态源。筛选语义本身不在这里——
//   Filter 全字段的匹配规则在 T13 的 QueryEngine，本文件只管「状态怎么变」。
// - 全部函数纯化：给定 Filter + 一次交互 → 新 Filter（不改入参、不读全局、不碰 DOM），
//   因此可脱离 React 单测；组件只负责渲染与调用 commitFilter。
// - lastFilter 落盘 = 写进 vault.settings（spec 6.2「筛选状态写进 settings.lastFilter
//   落盘，重开恢复」）。persistence 层负责把 settings 序列化进 vault.json，
//   恢复的落点就是 settings.lastFilter，无需本任务额外造机制。
//
// 撤销栈卫生（沿用 T14 topicActions 的先例）：无变化的交互不产生命令——
// 点一个已选中的 chip、把跳数改成当前值，都不该在撤销栈里留下空操作。

import { patchSettingsCommand } from '../domain/commandBus'
import type { CommandBus } from '../domain/commandBus'
import { createEmptyFilter } from '../domain/queryEngine'
import type { Filter, FilterDateRange, Kind, Priority, Status, Vault } from '../domain/types'

/** 依赖跳数上限（T16 验收 2 / spec 6.2：0–3）。 */
export const MAX_HOP_DEPTH = 3

/** 合法枚举值（与 domain/types.ts 一致；normalizeFilter 靠它们清洗磁盘上的脏数据）。 */
export const STATUS_VALUES: readonly Status[] = ['todo', 'doing', 'review', 'done']
export const KIND_VALUES: readonly Kind[] = ['feature', 'bug', 'chore', 'research', 'doc']
export const PRIORITY_VALUES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3']

/** Filter 上的四个布尔开关维度。 */
export type FilterFlag = 'overdueOnly' | 'blockedOnly' | 'withNotesOnly' | 'includeArchived'

/** 跳数方向。 */
export type HopSide = 'upstream' | 'downstream'

function dedupe(values: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** 数组型维度的通用切换：已在其中则移除，否则追加到末尾。 */
function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((current) => current !== value) : [...values, value]
}

// ── 空筛选 / 清空 / 判空计数 ─────────────────────────────────────────────

/**
 * 空筛选（所有维度不设限）。直接复用 T13 的 createEmptyFilter——筛选的形状只有一份定义，
 * 这里不做等价重写，避免两处口径漂移。
 */
export function clearFilter(): Filter {
  return createEmptyFilter()
}

export function isFilterEmpty(filter: Filter): boolean {
  const canonical = normalizeFilter(filter)
  return (
    canonical.topicIds.length === 0 &&
    canonical.statuses.length === 0 &&
    canonical.kinds.length === 0 &&
    canonical.priorities.length === 0 &&
    canonical.tags.length === 0 &&
    canonical.assignees.length === 0 &&
    canonical.dateRange === undefined &&
    canonical.overdueOnly !== true &&
    canonical.blockedOnly !== true &&
    canonical.withNotesOnly !== true &&
    canonical.includeArchived !== true &&
    canonical.text === undefined &&
    (canonical.upstreamDepth ?? 0) === 0 &&
    (canonical.downstreamDepth ?? 0) === 0
  )
}

/**
 * 生效的筛选维度数（面板标题上的角标）。
 * includeDescendants / tagMode 是「某维度的修饰符」而非独立维度，故不计入。
 */
export function countActiveFilters(filter: Filter): number {
  const canonical = normalizeFilter(filter)
  let count = 0
  if (canonical.topicIds.length > 0) count += 1
  if (canonical.statuses.length > 0) count += 1
  if (canonical.kinds.length > 0) count += 1
  if (canonical.priorities.length > 0) count += 1
  if (canonical.tags.length > 0) count += 1
  if (canonical.assignees.length > 0) count += 1
  if (canonical.dateRange !== undefined) count += 1
  if (canonical.overdueOnly) count += 1
  if (canonical.blockedOnly) count += 1
  if (canonical.withNotesOnly) count += 1
  if (canonical.includeArchived) count += 1
  if (canonical.text !== undefined) count += 1
  if ((canonical.upstreamDepth ?? 0) > 0) count += 1
  if ((canonical.downstreamDepth ?? 0) > 0) count += 1
  return count
}

// ── chip 切换（每次交互一个纯函数） ──────────────────────────────────────

export function toggleStatus(filter: Filter, status: Status): Filter {
  return { ...filter, statuses: toggleValue(filter.statuses, status) as Status[] }
}

export function toggleKind(filter: Filter, kind: Kind): Filter {
  return { ...filter, kinds: toggleValue(filter.kinds, kind) as Kind[] }
}

export function togglePriority(filter: Filter, priority: Priority): Filter {
  return { ...filter, priorities: toggleValue(filter.priorities, priority) as Priority[] }
}

export function toggleTopicId(filter: Filter, topicId: string): Filter {
  return { ...filter, topicIds: toggleValue(filter.topicIds, topicId) }
}

export function toggleTag(filter: Filter, tag: string): Filter {
  const trimmed = tag.trim()
  if (trimmed === '') return filter
  return { ...filter, tags: toggleValue(filter.tags, trimmed) }
}

export function toggleAssignee(filter: Filter, assignee: string): Filter {
  const trimmed = assignee.trim()
  if (trimmed === '') return filter
  return { ...filter, assignees: toggleValue(filter.assignees, trimmed) }
}

export function setTagMode(filter: Filter, mode: Filter['tagMode']): Filter {
  if (filter.tagMode === mode) return filter
  return { ...filter, tagMode: mode }
}

export function toggleFlag(filter: Filter, flag: FilterFlag): Filter {
  return { ...filter, [flag]: filter[flag] !== true }
}

/** 区间两端都可缺省；两端都空则把整个 dateRange 摘掉（等价于没设该维度）。 */
export function setDateRange(filter: Filter, range: FilterDateRange): Filter {
  const from = (range.from ?? '').trim()
  const to = (range.to ?? '').trim()
  if (from === '' && to === '') {
    if (filter.dateRange === undefined) return filter
    const next = { ...filter }
    delete next.dateRange
    return next
  }
  return { ...filter, dateRange: from === '' ? { to } : to === '' ? { from } : { from, to } }
}

/** 空白搜索词等于没有全文条件（QueryEngine 里空串本来也不施加约束）。 */
export function setText(filter: Filter, text: string): Filter {
  if (text.trim() === '') {
    if (filter.text === undefined) return filter
    const next = { ...filter }
    delete next.text
    return next
  }
  if (filter.text === text) return filter
  return { ...filter, text }
}

/** 跳数归一到 0–MAX_HOP_DEPTH：NaN / 负数 / 越界 / 小数都落回合法值。 */
export function clampHopDepth(value: number): number {
  if (!Number.isFinite(value)) return 0
  const floored = Math.floor(value)
  if (floored < 0) return 0
  if (floored > MAX_HOP_DEPTH) return MAX_HOP_DEPTH
  return floored
}

export function setHopDepth(filter: Filter, side: HopSide, depth: number): Filter {
  const clamped = clampHopDepth(depth)
  const key = side === 'upstream' ? 'upstreamDepth' : 'downstreamDepth'
  if ((filter[key] ?? 0) === clamped) return filter
  return { ...filter, [key]: clamped }
}

// ── 归一化与比较（用于落盘清洗 + no-op 判定） ─────────────────────────────

/**
 * 把任意来源的筛选值归一成规范形态：
 * - null / 非对象 / 字段缺失 → 空筛选；
 * - 数组去重、剔除非字符串与空串、枚举外的值丢弃；
 * - tagMode 非法回落 'any'；includeDescendants 缺失视为 true；
 * - 跳数夹到 0–3；空 dateRange / 空 text 视为未设置（不落这两个可选字段）。
 * 磁盘上的旧库或手改过的 vault.json 由此清洗后再进 UI，避免脏值直接进渲染。
 */
export function normalizeFilter(raw: unknown): Filter {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? dedupe(value.filter((item): item is string => typeof item === 'string' && item !== '')) : []

  const enums = <T extends string>(value: unknown, allowed: readonly T[]): T[] =>
    strings(value).filter((item): item is T => (allowed as readonly string[]).includes(item))

  const filter: Filter = {
    topicIds: strings(source.topicIds),
    includeDescendants: source.includeDescendants !== false,
    statuses: enums(source.statuses, STATUS_VALUES),
    kinds: enums(source.kinds, KIND_VALUES),
    priorities: enums(source.priorities, PRIORITY_VALUES),
    tags: strings(source.tags),
    tagMode: source.tagMode === 'all' ? 'all' : 'any',
    assignees: strings(source.assignees),
  }

  if (source.overdueOnly === true) filter.overdueOnly = true
  if (source.blockedOnly === true) filter.blockedOnly = true
  if (source.withNotesOnly === true) filter.withNotesOnly = true
  if (source.includeArchived === true) filter.includeArchived = true

  if (typeof source.text === 'string' && source.text.trim() !== '') filter.text = source.text

  const rawRange = source.dateRange
  if (typeof rawRange === 'object' && rawRange !== null) {
    const from = typeof (rawRange as FilterDateRange).from === 'string' ? (rawRange as FilterDateRange).from!.trim() : ''
    const to = typeof (rawRange as FilterDateRange).to === 'string' ? (rawRange as FilterDateRange).to!.trim() : ''
    if (from !== '' || to !== '') filter.dateRange = from === '' ? { to } : to === '' ? { from } : { from, to }
  }

  const upstream = clampHopDepth(typeof source.upstreamDepth === 'number' ? source.upstreamDepth : 0)
  const downstream = clampHopDepth(typeof source.downstreamDepth === 'number' ? source.downstreamDepth : 0)
  if (upstream > 0) filter.upstreamDepth = upstream
  if (downstream > 0) filter.downstreamDepth = downstream

  return filter
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((value) => set.has(value))
}

function sameRange(a: FilterDateRange | undefined, b: FilterDateRange | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return (a.from ?? '') === (b.from ?? '') && (a.to ?? '') === (b.to ?? '')
}

/** 语义相等（数组按集合比较，可选字段缺失即默认）。null / undefined 等价于空筛选。 */
export function isSameFilter(a: Filter | null | undefined, b: Filter | null | undefined): boolean {
  const left = normalizeFilter(a)
  const right = normalizeFilter(b)
  return (
    sameSet(left.topicIds, right.topicIds) &&
    left.includeDescendants === right.includeDescendants &&
    sameSet(left.statuses, right.statuses) &&
    sameSet(left.kinds, right.kinds) &&
    sameSet(left.priorities, right.priorities) &&
    sameSet(left.tags, right.tags) &&
    left.tagMode === right.tagMode &&
    sameSet(left.assignees, right.assignees) &&
    sameRange(left.dateRange, right.dateRange) &&
    left.overdueOnly === right.overdueOnly &&
    left.blockedOnly === right.blockedOnly &&
    left.withNotesOnly === right.withNotesOnly &&
    left.includeArchived === right.includeArchived &&
    left.text === right.text &&
    (left.upstreamDepth ?? 0) === (right.upstreamDepth ?? 0) &&
    (left.downstreamDepth ?? 0) === (right.downstreamDepth ?? 0)
  )
}

// ── 落盘入口 ─────────────────────────────────────────────────────────────

/**
 * 把新 Filter 写进 `settings.lastFilter`，走 T10 CommandBus 的 settings.patch
 * （唯一写入口、可撤销、触发 dirty → T08 autosave 落盘）。
 *
 * 与当前值语义相同则完全不产生命令：筛选是高频交互，空操作不该污染撤销栈
 * （也因此「点清空」在已经空筛选时不进栈）。
 */
export function commitFilter(vault: Vault, bus: CommandBus, next: Filter): void {
  const canonical = normalizeFilter(next)
  if (isSameFilter(vault.settings.lastFilter, canonical)) return
  bus.apply(patchSettingsCommand(vault, { lastFilter: canonical }))
}
