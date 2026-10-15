// T13 · QueryEngine：组合筛选 + 全文搜索（spec 6.2）。
// 零 React / 零 DOM / 零 I/O；输入 topics + tasks + links，输出命中的 Task[]。
// 依赖 TopicTree（话题归属）与 DependencyGraph（依赖跳数），不反向依赖上层。
//
// 约定：
// - 数组型维度为空数组 = 不施加该维度约束（看板默认无筛选）。
// - 归档任务默认排除，includeArchived=true 时纳入。
// - 结果保持入参 tasks 的顺序，便于看板列内沿用 order。

import { createDependencyGraph } from './dependencyGraph'
import { createTopicTree } from './topicTree'
import type { Dependency, Filter, FilterDateRange, Task, Topic } from './types'

export interface QueryEngineOptions {
  /** 判定「逾期」的今天（YYYY-MM-DD）。默认取本地当天；注入以便测试确定化。 */
  today?: string
  /** 关键路径工期权重，透传给 DependencyGraph（T19 可换成 ScheduleEngine 的工作日工期）。 */
  duration?: (task: Task) => number
}

export interface QueryEngine {
  query(filter: Filter): Task[]
}

/** 与 spec 6.2 的 Filter 对齐的「空筛选」：所有维度不设限。 */
export function createEmptyFilter(): Filter {
  return {
    topicIds: [],
    includeDescendants: true,
    statuses: [],
    kinds: [],
    priorities: [],
    tags: [],
    tagMode: 'any',
    assignees: [],
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 本地时区的 YYYY-MM-DD。刻意不用 UTC——否则东八区凌晨会把「今天」算成昨天。 */
export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 把 note 降为可搜索纯文本。
 * 图片整体丢弃（否则 `assets/<id>.png` 会被当成正文命中）；链接保留文字丢弃 URL；
 * 剥掉强调 / 行内码 / 标题 / 引用 / 删除线 / 围栏标记。
 */
export function noteToSearchText(note: string): string {
  if (!note) return ''
  return note
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/```+/g, ' ')
    .replace(/[*`#>~]/g, ' ')
    .toLowerCase()
}

/** 区间语义：任务 [start, due] 与筛选区间 [from, to] 有交集即命中；两端开区间可缺省。 */
function inDateRange(task: Task, range: FilterDateRange): boolean {
  const { from, to } = range
  const start = task.start ?? task.due
  const due = task.due ?? task.start
  if (!start || !due) return false
  if (to && start > to) return false
  if (from && due < from) return false
  return true
}

/** 逾期：有到期日、尚未 done、且到期日早于今天。无 due 的任务不算逾期。 */
function isOverdue(task: Task, today: string): boolean {
  if (!task.due) return false
  if (task.status === 'done') return false
  return task.due < today
}

export function createQueryEngine(
  topics: readonly Topic[],
  tasks: readonly Task[],
  links: readonly Dependency[],
  options: QueryEngineOptions = {},
): QueryEngine {
  const tree = createTopicTree(topics)
  const graph = createDependencyGraph(links, tasks, options.duration ? { duration: options.duration } : {})

  /** 话题作用域；topicIds 为空表示不限定话题，返回 null。 */
  const topicScope = (filter: Filter): Set<string> | null => {
    if (filter.topicIds.length === 0) return null
    const scope = new Set<string>()
    for (const id of filter.topicIds) {
      if (filter.includeDescendants) {
        for (const topicId of tree.subtreeIds(id)) scope.add(topicId)
      } else {
        scope.add(id)
      }
    }
    return scope
  }

  const matches = (task: Task, filter: Filter, scope: Set<string> | null, today: string): boolean => {
    if (!filter.includeArchived && task.archived) return false
    if (scope && !scope.has(task.topicId)) return false

    if (filter.statuses.length > 0 && !filter.statuses.includes(task.status)) return false
    if (filter.kinds.length > 0 && !filter.kinds.includes(task.kind)) return false
    if (filter.priorities.length > 0 && !filter.priorities.includes(task.priority)) return false

    if (filter.tags.length > 0) {
      const owned = new Set(task.tags)
      const hit =
        filter.tagMode === 'all'
          ? filter.tags.every((tag) => owned.has(tag))
          : filter.tags.some((tag) => owned.has(tag))
      if (!hit) return false
    }

    if (filter.assignees.length > 0) {
      if (task.assignee === undefined || !filter.assignees.includes(task.assignee)) return false
    }

    if (filter.dateRange && !inDateRange(task, filter.dateRange)) return false
    if (filter.overdueOnly && !isOverdue(task, today)) return false
    if (filter.blockedOnly && !graph.isBlocked(task.id)) return false
    if (filter.withNotesOnly && task.note.trim() === '') return false

    const query = filter.text?.trim().toLowerCase()
    if (query) {
      const haystack = `${task.title}\n${noteToSearchText(task.note)}`.toLowerCase()
      if (!haystack.includes(query)) return false
    }

    return true
  }

  const query = (filter: Filter): Task[] => {
    const today = options.today ?? localDateKey(new Date())
    const scope = topicScope(filter)
    const base = tasks.filter((task) => matches(task, filter, scope, today))

    const up = filter.upstreamDepth ?? 0
    const down = filter.downstreamDepth ?? 0
    if (up <= 0 && down <= 0) return [...base]

    // 跳数扩展：把命中集合沿依赖方向拉开 N 跳，用于回答「这个延期会波及谁」。
    // 扩展开来的邻居不再受其余维度约束——否则状态/类别一限定，扩展就失去意义；
    // 仅归档规则仍然生效，避免把已归档任务带回来。
    const included = new Set<string>(base.map((task) => task.id))
    for (const task of base) {
      if (up > 0) for (const id of graph.upstream(task.id, up)) included.add(id)
      if (down > 0) for (const id of graph.downstream(task.id, down)) included.add(id)
    }

    return tasks.filter((task) => included.has(task.id) && (filter.includeArchived || !task.archived))
  }

  return { query }
}
