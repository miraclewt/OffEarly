// T12 · DependencyGraph：依赖图纯函数模块。
// 零 React / 零 DOM / 零 I/O；输入 links + tasks，输出派生结果（不落盘，spec 4.3 决定 3）。
// 语义（spec 4.2）：Dependency.from = 前置任务，Dependency.to = 后置任务（FS：from 完成后 to 才能开始）。
// 只依赖 T03 的类型定义，不引用 VaultStore / ScheduleEngine。

import type { Dependency, Status, Task } from './types'

/** 关键路径的工期权重端口。默认实现为「含端点的自然日跨度」；T19 可注入 ScheduleEngine 的工作日工期。 */
export interface DependencyGraphOptions {
  duration?: (task: Task) => number
}

export interface DependencyGraph {
  /** from → to[]（正向邻接） */
  readonly successors: ReadonlyMap<string, readonly string[]>
  /** to → from[]（反向邻接） */
  readonly predecessors: ReadonlyMap<string, readonly string[]>
  /** 被 id 阻塞的直接后置任务 id（from=id 的 to） */
  blocks(id: string): readonly string[]
  /** 直接阻塞 id 的前置任务 id（to=id 的 from） */
  blockedBy(id: string): readonly string[]
  /** 存在 status≠done 的直接前置即视为被阻塞（spec 5.3） */
  isBlocked(id: string): boolean
  /** Tarjan 求强连通分量，返回 size>1 的环；自环以单元素分量返回。无环返回空数组 */
  cycles(): string[][]
  hasCycle(): boolean
  /** DAG 拓扑排序 + 最长路径（工期为权）返回关键任务 id 集合；含环返回 null（spec 5.3 降级） */
  criticalPath(): Set<string> | null
  /** 上游（前置方向）N 跳，含自身；n=0 仅自身 */
  upstream(id: string, n: number): Set<string>
  /** 下游（后置方向）N 跳，含自身；n=0 仅自身 */
  downstream(id: string, n: number): Set<string>
}

const MS_PER_DAY = 86_400_000

/** 含端点的自然日跨度（start→due）；缺日期或日期非法时记 1 天。 */
function defaultDuration(task: Task): number {
  const { start, due } = task
  if (!start || !due) return 1
  const a = Date.parse(`${start}T00:00:00Z`)
  const b = Date.parse(`${due}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 1
  return Math.round((b - a) / MS_PER_DAY) + 1
}

interface Adjacency {
  successors: Map<string, string[]>
  predecessors: Map<string, string[]>
}

/** 从 links 派生 from→to 与 to→from 双向邻接，同向重复边去重。 */
function buildAdjacency(links: readonly Dependency[]): Adjacency {
  const successors = new Map<string, string[]>()
  const predecessors = new Map<string, string[]>()
  const seen = new Set<string>()

  for (const l of links) {
    const key = `${l.from}\u0000${l.to}`
    if (seen.has(key)) continue
    seen.add(key)
    const out = successors.get(l.from)
    if (out) out.push(l.to)
    else successors.set(l.from, [l.to])
    const inc = predecessors.get(l.to)
    if (inc) inc.push(l.from)
    else predecessors.set(l.to, [l.from])
  }
  return { successors, predecessors }
}

function neighbours(map: ReadonlyMap<string, readonly string[]>, id: string): readonly string[] {
  return map.get(id) ?? []
}

/**
 * 迭代式 Tarjan（显式栈，避免大库递归爆栈）。
 * 按 nodes 给定顺序返回强连通分量；执行顺序为 Tarjan 的逆拓扑序。
 */
function strongComponents(nodes: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  interface Frame {
    node: string
    neighbours: readonly string[]
    cursor: number
  }
  const work: Frame[] = []

  const open = (node: string): void => {
    index.set(node, counter)
    low.set(node, counter)
    counter += 1
    stack.push(node)
    onStack.add(node)
    work.push({ node, neighbours: neighbours(adjacency, node), cursor: 0 })
  }

  for (const root of nodes) {
    if (index.has(root)) continue
    open(root)
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      if (frame.cursor < frame.neighbours.length) {
        const next = frame.neighbours[frame.cursor]!
        frame.cursor += 1
        if (!index.has(next)) {
          open(next)
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const popped = stack.pop()!
          onStack.delete(popped)
          component.push(popped)
          if (popped === frame.node) break
        }
        components.push(component)
      }
    }
  }
  return components
}

/** Kahn 拓扑排序；存在环时返回 null。 */
function topologicalOrder(
  nodes: readonly string[],
  successors: ReadonlyMap<string, readonly string[]>,
  predecessors: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const indegree = new Map<string, number>()
  for (const node of nodes) indegree.set(node, neighbours(predecessors, node).length)

  const queue: string[] = nodes.filter((node) => indegree.get(node) === 0)
  const order: string[] = []
  let head = 0
  while (head < queue.length) {
    const node = queue[head]!
    head += 1
    order.push(node)
    for (const next of neighbours(successors, node)) {
      const remaining = indegree.get(next)
      if (remaining === undefined) continue
      const decremented = remaining - 1
      indegree.set(next, decremented)
      if (decremented === 0) queue.push(next)
    }
  }
  return order.length === nodes.length ? order : null
}

export function createDependencyGraph(
  links: readonly Dependency[],
  tasks: readonly Task[],
  options: DependencyGraphOptions = {},
): DependencyGraph {
  const { successors, predecessors } = buildAdjacency(links)

  const taskById = new Map<string, Task>()
  for (const task of tasks) taskById.set(task.id, task)

  const statusById = new Map<string, Status>()
  for (const task of tasks) statusById.set(task.id, task.status)

  // 节点集合 = 任务 id ∪ 链接端点，稳定排序便于复现
  const nodeSet = new Set<string>(taskById.keys())
  for (const l of links) {
    nodeSet.add(l.from)
    nodeSet.add(l.to)
  }
  const nodes = [...nodeSet].sort()

  const duration = options.duration ?? defaultDuration
  const weightOf = (id: string): number => {
    const task = taskById.get(id)
    const weight = task ? duration(task) : 1
    return Number.isFinite(weight) && weight >= 0 ? weight : 1
  }

  let cyclesCache: string[][] | null = null
  const cycles = (): string[][] => {
    if (cyclesCache) return cyclesCache
    const result: string[][] = []
    for (const component of strongComponents(nodes, successors)) {
      if (component.length > 1) result.push(component)
      else {
        const only = component[0]!
        // 自环：size=1 但存在指向自身的边，同样使 DAG 前提失效
        if (neighbours(successors, only).includes(only)) result.push([only])
      }
    }
    cyclesCache = result
    return result
  }

  const blocks = (id: string): readonly string[] => successors.get(id) ?? []
  const blockedBy = (id: string): readonly string[] => predecessors.get(id) ?? []

  const isBlocked = (id: string): boolean => {
    for (const predecessor of blockedBy(id)) {
      // 缺状态（引用了不存在的任务）保守判为未完成
      if (statusById.get(predecessor) !== 'done') return true
    }
    return false
  }

  const walk = (id: string, hops: number, adjacency: ReadonlyMap<string, readonly string[]>): Set<string> => {
    const visited = new Set<string>([id])
    let frontier: string[] = [id]
    const depth = Number.isFinite(hops) ? Math.max(0, Math.floor(hops)) : 0
    for (let step = 0; step < depth && frontier.length > 0; step += 1) {
      const next: string[] = []
      for (const node of frontier) {
        for (const neighbour of neighbours(adjacency, node)) {
          if (visited.has(neighbour)) continue
          visited.add(neighbour)
          next.push(neighbour)
        }
      }
      frontier = next
    }
    return visited
  }

  const criticalPath = (): Set<string> | null => {
    if (cycles().length > 0) return null

    const order = topologicalOrder(nodes, successors, predecessors)
    if (!order) return null

    // 前向：最早开始 ES（节点权 = 工期）
    const earliest = new Map<string, number>()
    for (const node of order) {
      let start = 0
      for (const predecessor of neighbours(predecessors, node)) {
        const finish = (earliest.get(predecessor) ?? 0) + weightOf(predecessor)
        if (finish > start) start = finish
      }
      earliest.set(node, start)
    }

    let total = 0
    for (const node of nodes) {
      const finish = (earliest.get(node) ?? 0) + weightOf(node)
      if (finish > total) total = finish
    }

    // 反向：最晚完成 LF / 最晚开始 LS
    // 节点权的口径下 LF(v) = min{ LS(s) : v→s } = min{ LF(s) − w(s) }；无后置时收束到总工期。
    const latestFinish = new Map<string, number>()
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const node = order[i]!
      let finish = total
      for (const successor of neighbours(successors, node)) {
        const successorLatestStart = (latestFinish.get(successor) ?? total) - weightOf(successor)
        if (successorLatestStart < finish) finish = successorLatestStart
      }
      latestFinish.set(node, finish)
    }

    // 关键 = 总浮动为 0（ES === LS）的节点，即落在至少一条最长路径上的全部任务
    const critical = new Set<string>()
    for (const node of nodes) {
      const start = earliest.get(node) ?? 0
      const latestStart = (latestFinish.get(node) ?? total) - weightOf(node)
      if (latestStart === start) critical.add(node)
    }
    return critical
  }

  return {
    successors,
    predecessors,
    blocks,
    blockedBy,
    isBlocked,
    cycles,
    hasCycle: () => cycles().length > 0,
    criticalPath,
    upstream: (id, n) => walk(id, n, predecessors),
    downstream: (id, n) => walk(id, n, successors),
  }
}
