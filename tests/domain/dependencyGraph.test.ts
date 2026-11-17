import { describe, expect, it } from 'vitest'

import { createDependencyGraph } from '../../src/domain/dependencyGraph'
import type { Dependency, Status, Task } from '../../src/domain/types'

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    topicId: 'topic-1',
    title: `任务 ${id}`,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note: '',
    order: 'a0',
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    archived: false,
    ...overrides,
  }
}

function link(from: string, to: string, overrides: Partial<Dependency> = {}): Dependency {
  return { id: `${from}->${to}`, from, to, type: 'FS', lagDays: 0, ...overrides }
}

/** 以「任务 id → 工期」映射作为可注入的权重函数（工期默认自然日跨度，见默认实现用例）。 */
function weightOf(map: Record<string, number>): (task: Task) => number {
  return (task) => map[task.id] ?? 1
}

function sorted(list: readonly string[]): string[] {
  return [...list].sort()
}

function sortComponents(comps: readonly string[][]): string[][] {
  return comps.map((c) => sorted(c)).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))
}

const statusOf = (statuses: Record<string, Status>): Task[] =>
  Object.entries(statuses).map(([id, status]) => makeTask(id, { status }))

describe('DependencyGraph · 邻接派生（验收 1）', () => {
  it('从 links 派生 from→to 与 to→from 双向 Map；blocks/blockedBy 正确', () => {
    const links = [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')]
    const g = createDependencyGraph(links, ['a', 'b', 'c', 'd'].map((id) => makeTask(id)))

    expect(sorted(g.blocks('a'))).toEqual(['b', 'c'])
    expect(sorted(g.blocks('d'))).toEqual([])
    expect(sorted(g.blockedBy('d'))).toEqual(['b', 'c'])
    expect(sorted(g.blockedBy('a'))).toEqual([])

    expect(sorted(g.successors.get('a') ?? [])).toEqual(['b', 'c'])
    expect(sorted(g.predecessors.get('d') ?? [])).toEqual(['b', 'c'])
    expect(g.successors.get('d')).toBeUndefined()
    expect(g.predecessors.get('a')).toBeUndefined()
  })

  it('重复链接去重；未知 id（不在 tasks 中）不报错', () => {
    const g = createDependencyGraph([link('a', 'b'), link('a', 'b', { id: 'dup', type: 'SS' })], [makeTask('a'), makeTask('b')])
    expect(g.blocks('a')).toEqual(['b'])
  })

  it('跨 topic 依赖与同 topic 依赖一视同仁（links 只认 id）', () => {
    const tasks = [
      makeTask('a', { topicId: 'tA' }),
      makeTask('b', { topicId: 'tB' }),
      makeTask('c', { topicId: 'tA' }),
    ]
    const g = createDependencyGraph([link('a', 'b'), link('a', 'c')], tasks)
    expect(sorted(g.blocks('a'))).toEqual(['b', 'c'])
    expect(sorted(g.blockedBy('b'))).toEqual(['a'])
  })
})

describe('DependencyGraph · isBlocked（验收 2，FS 语义）', () => {
  it('存在 status≠done 的直接前置即被阻塞；前置全 done 则不阻塞', () => {
    const tasks = statusOf({ a: 'done', b: 'doing', c: 'todo', d: 'done' })
    const g = createDependencyGraph([link('a', 'c'), link('b', 'c')], tasks)
    expect(g.isBlocked('c')).toBe(true)

    const g2 = createDependencyGraph([link('a', 'd')], tasks)
    expect(g2.isBlocked('d')).toBe(false)
  })

  it('无前置的任务不被阻塞', () => {
    const g = createDependencyGraph([link('a', 'b')], statusOf({ a: 'todo', b: 'todo' }))
    expect(g.isBlocked('a')).toBe(false)
  })

  it('前置引用缺失任务 id 时保守判为被阻塞', () => {
    const g = createDependencyGraph([link('ghost', 'b')], [makeTask('b', { status: 'todo' })])
    expect(g.isBlocked('b')).toBe(true)
  })
})

describe('DependencyGraph · cycles（验收 3，Tarjan）', () => {
  it('无环返回空', () => {
    const g = createDependencyGraph([link('a', 'b'), link('b', 'c')], ['a', 'b', 'c'].map((id) => makeTask(id)))
    expect(g.cycles()).toEqual([])
    expect(g.hasCycle()).toBe(false)
  })

  it('单环返回该强连通分量', () => {
    const g = createDependencyGraph([link('a', 'b'), link('b', 'c'), link('c', 'a')], ['a', 'b', 'c'].map((id) => makeTask(id)))
    expect(sortComponents(g.cycles())).toEqual([['a', 'b', 'c']])
    expect(g.hasCycle()).toBe(true)
  })

  it('双环返回两个互不相交的强连通分量', () => {
    const links = [link('a', 'b'), link('b', 'a'), link('c', 'd'), link('d', 'c')]
    const g = createDependencyGraph(links, ['a', 'b', 'c', 'd'].map((id) => makeTask(id)))
    expect(sortComponents(g.cycles())).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('自环（A→A）也计为环，以单元素分量返回', () => {
    const g = createDependencyGraph([link('a', 'a')], [makeTask('a')])
    expect(g.cycles()).toEqual([['a']])
    expect(g.hasCycle()).toBe(true)
  })

  it('环与树混合时只报真正的环', () => {
    const links = [link('x', 'a'), link('a', 'b'), link('b', 'a'), link('b', 'y')]
    const g = createDependencyGraph(links, ['x', 'a', 'b', 'y'].map((id) => makeTask(id)))
    expect(sortComponents(g.cycles())).toEqual([['a', 'b']])
  })
})

describe('DependencyGraph · criticalPath（验收 4，拓扑排序 + 最长路径）', () => {
  it('线性链全部落在关键路径上', () => {
    const links = [link('a', 'b'), link('b', 'c')]
    const g = createDependencyGraph(links, ['a', 'b', 'c'].map((id) => makeTask(id)), {
      duration: weightOf({ a: 1, b: 2, c: 3 }),
    })
    expect(g.criticalPath()).toEqual(new Set(['a', 'b', 'c']))
  })

  it('菱形取工期更长的那条分支（不为最长路径补零浮动）', () => {
    // a→b→d 工期 1+5+1=7；a→c→d 工期 1+2+1=4；关键集应为 {a,b,d}
    const links = [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')]
    const g = createDependencyGraph(links, ['a', 'b', 'c', 'd'].map((id) => makeTask(id)), {
      duration: weightOf({ a: 1, b: 5, c: 2, d: 1 }),
    })
    expect(g.criticalPath()).toEqual(new Set(['a', 'b', 'd']))
  })

  it('工期并列的两条最长路径：两条都算关键（零总浮动集）', () => {
    const links = [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')]
    const g = createDependencyGraph(links, ['a', 'b', 'c', 'd'].map((id) => makeTask(id)), {
      duration: weightOf({ a: 1, b: 3, c: 3, d: 1 }),
    })
    expect(g.criticalPath()).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('默认工期取含端点的自然日跨度（start→due）', () => {
    // 分支一：x 2026-10-01→2026-10-05 = 5 天；分支二：y 2026-10-01→2026-10-02 = 2 天
    const links = [link('s', 'x'), link('s', 'y'), link('x', 'e'), link('y', 'e')]
    const tasks = [
      makeTask('s', { start: '2026-10-01', due: '2026-10-01' }),
      makeTask('x', { start: '2026-10-01', due: '2026-10-05' }),
      makeTask('y', { start: '2026-10-01', due: '2026-10-02' }),
      makeTask('e', { start: '2026-10-06', due: '2026-10-06' }),
    ]
    // s=1, x=5, y=2, e=1 → 关键路径 s→x→e
    const g = createDependencyGraph(links, tasks)
    expect(g.criticalPath()).toEqual(new Set(['s', 'x', 'e']))
  })

  it('含环时返回 null（spec 5.3 降级：先解环）', () => {
    const links = [link('a', 'b'), link('b', 'c'), link('c', 'a')]
    const g = createDependencyGraph(links, ['a', 'b', 'c'].map((id) => makeTask(id)))
    expect(g.criticalPath()).toBeNull()
  })

  it('自环同样使 criticalPath 降级为 null', () => {
    const g = createDependencyGraph([link('a', 'a')], [makeTask('a')])
    expect(g.criticalPath()).toBeNull()
  })

  it('空图返回空集合而非 null', () => {
    const g = createDependencyGraph([], [])
    expect(g.criticalPath()).toEqual(new Set())
  })
})

describe('DependencyGraph · upstream/downstream（验收 5，N 跳遍历）', () => {
  const links = [link('a', 'b'), link('b', 'c'), link('c', 'd')]
  const graph = () => createDependencyGraph(links, ['a', 'b', 'c', 'd'].map((id) => makeTask(id)))

  it('n=0 仅自身', () => {
    const g = graph()
    expect(g.downstream('b', 0)).toEqual(new Set(['b']))
    expect(g.upstream('b', 0)).toEqual(new Set(['b']))
  })

  it('按跳数逐层扩展，含起点', () => {
    const g = graph()
    expect(g.downstream('a', 1)).toEqual(new Set(['a', 'b']))
    expect(g.downstream('a', 2)).toEqual(new Set(['a', 'b', 'c']))
    expect(g.upstream('d', 2)).toEqual(new Set(['d', 'c', 'b']))
  })

  it('跳数超过深度时返回全部可达节点，不越界', () => {
    const g = graph()
    expect(g.downstream('a', 99)).toEqual(new Set(['a', 'b', 'c', 'd']))
    expect(g.upstream('a', 99)).toEqual(new Set(['a']))
  })

  it('菱形汇合处不重复访问（visited 保证）', () => {
    const g = createDependencyGraph([link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')], ['a', 'b', 'c', 'd'].map((id) => makeTask(id)))
    expect(g.downstream('a', 2)).toEqual(new Set(['a', 'b', 'c', 'd']))
    expect(g.upstream('d', 2)).toEqual(new Set(['d', 'b', 'c', 'a']))
  })

  it('负跳数按 0 处理', () => {
    const g = graph()
    expect(g.downstream('b', -3)).toEqual(new Set(['b']))
  })

  it('环上遍历不无限循环', () => {
    const g = createDependencyGraph([link('a', 'b'), link('b', 'a')], ['a', 'b'].map((id) => makeTask(id)))
    expect(g.downstream('a', 10)).toEqual(new Set(['a', 'b']))
  })
})
