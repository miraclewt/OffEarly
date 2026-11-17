import { describe, expect, it } from 'vitest'

import { createEmptyFilter, createQueryEngine, noteToSearchText } from '../../src/domain/queryEngine'
import { createTopicTree } from '../../src/domain/topicTree'
import type { Dependency, Filter, Task, Topic } from '../../src/domain/types'

function makeTopic(id: string, overrides: Partial<Topic> = {}): Topic {
  return {
    id,
    name: `话题 ${id}`,
    color: '#4F46E5',
    parentId: null,
    order: 'a0',
    archived: false,
    ...overrides,
  }
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    topicId: 'a',
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

function link(from: string, to: string): Dependency {
  return { id: `${from}->${to}`, from, to, type: 'FS', lagDays: 0 }
}

function filter(overrides: Partial<Filter> = {}): Filter {
  return { ...createEmptyFilter(), ...overrides }
}

const ids = (list: readonly Task[]): string[] => list.map((task) => task.id)
const topicIds = (list: readonly Topic[]): string[] => list.map((topic) => topic.id)

// root ─┬─ a ─── a1
//       └─ b
// other（独立一级话题）
const topics: Topic[] = [
  makeTopic('root', { order: 'a0' }),
  makeTopic('a', { parentId: 'root', order: 'a0' }),
  makeTopic('a1', { parentId: 'a', order: 'a0' }),
  makeTopic('b', { parentId: 'root', order: 'b0' }),
  makeTopic('other', { order: 'b0' }),
]

const links: Dependency[] = [link('t1', 't2'), link('t2', 't3')]

const tasks: Task[] = [
  makeTask('t1', {
    topicId: 'a',
    status: 'todo',
    priority: 'P0',
    tags: ['ui', 'urgent'],
    assignee: 'amy',
    due: '2026-10-10',
    note: '# 说明\n见 ![](assets/x1.png)',
  }),
  makeTask('t2', {
    topicId: 'a1',
    status: 'doing',
    kind: 'bug',
    assignee: 'bob',
    start: '2026-10-20',
    due: '2026-10-25',
  }),
  makeTask('t3', { topicId: 'b', status: 'done', kind: 'chore', priority: 'P2', tags: ['ui'], due: '2026-10-01', note: '收尾' }),
  makeTask('t4', { topicId: 'other', status: 'review', kind: 'doc', priority: 'P3', archived: true, note: '归档件' }),
  makeTask('t5', { topicId: 'other', tags: ['ui', 'urgent'], due: '2026-11-30', note: '关联 assets 说明' }),
  makeTask('t6', { topicId: 'a', kind: 'research', priority: 'P2', note: '无日期任务' }),
]

const engine = createQueryEngine(topics, tasks, links, { today: '2026-10-15' })
const tree = createTopicTree(topics)

describe('TopicTree · 树形派生', () => {
  it('roots / childrenOf 按 (order, id) 升序', () => {
    expect(topicIds(tree.roots())).toEqual(['root', 'other'])
    expect(topicIds(tree.childrenOf('root'))).toEqual(['a', 'b'])
    expect(topicIds(tree.childrenOf(null))).toEqual(['root', 'other'])
  })

  it('descendants 含全部子孙且不含自身；subtreeIds 含自身', () => {
    expect(tree.descendants('root')).toEqual(['a', 'a1', 'b'])
    expect(tree.descendants('a')).toEqual(['a1'])
    expect(tree.descendants('a1')).toEqual([])
    expect(tree.subtreeIds('root')).toEqual(['root', 'a', 'a1', 'b'])
  })

  it('pathOf / ancestors / depth 反映层级', () => {
    expect(topicIds(tree.pathOf('a1'))).toEqual(['root', 'a', 'a1'])
    expect(topicIds(tree.ancestors('a1'))).toEqual(['root', 'a'])
    expect(tree.depth('root')).toBe(0)
    expect(tree.depth('a1')).toBe(2)
  })

  it('isDescendantOf 严格排除自身与反向', () => {
    expect(tree.isDescendantOf('a1', 'root')).toBe(true)
    expect(tree.isDescendantOf('a1', 'a')).toBe(true)
    expect(tree.isDescendantOf('root', 'a1')).toBe(false)
    expect(tree.isDescendantOf('a1', 'a1')).toBe(false)
  })

  it('未知 id 一律安全返回空 / -1', () => {
    expect(tree.descendants('nope')).toEqual([])
    expect(tree.subtreeIds('nope')).toEqual([])
    expect(tree.pathOf('nope')).toEqual([])
    expect(tree.depth('nope')).toBe(-1)
  })

  it('父节点缺失时按根处理，断链不丢枝', () => {
    const broken = createTopicTree([...topics, makeTopic('orphan', { parentId: 'missing', order: 'c0' })])
    expect(topicIds(broken.roots())).toEqual(['root', 'other', 'orphan'])
    expect(topicIds(broken.pathOf('orphan'))).toEqual(['orphan'])
  })
})

describe('QueryEngine · 空筛选与归档（验收 5）', () => {
  it('空筛选返回全部未归档任务，且保持入参顺序', () => {
    expect(ids(engine.query(filter()))).toEqual(['t1', 't2', 't3', 't5', 't6'])
  })

  it('includeArchived=true 时纳入归档任务', () => {
    expect(ids(engine.query(filter({ includeArchived: true })))).toEqual(['t1', 't2', 't3', 't4', 't5', 't6'])
  })
})

describe('QueryEngine · 话题维度（验收 1）', () => {
  it('includeDescendants=true 命中子孙话题', () => {
    expect(ids(engine.query(filter({ topicIds: ['a'] })))).toEqual(['t1', 't2', 't6'])
    expect(ids(engine.query(filter({ topicIds: ['root'] })))).toEqual(['t1', 't2', 't3', 't6'])
  })

  it('includeDescendants=false 时仅本话题', () => {
    expect(ids(engine.query(filter({ topicIds: ['a'], includeDescendants: false })))).toEqual(['t1', 't6'])
    expect(ids(engine.query(filter({ topicIds: ['root'], includeDescendants: false })))).toEqual([])
  })

  it('多话题取并集', () => {
    expect(ids(engine.query(filter({ topicIds: ['b', 'other'] })))).toEqual(['t3', 't5'])
  })
})

describe('QueryEngine · 枚举维度（验收 2）', () => {
  it('statuses / kinds / priorities 组合生效', () => {
    expect(ids(engine.query(filter({ statuses: ['todo'] })))).toEqual(['t1', 't5', 't6'])
    expect(ids(engine.query(filter({ kinds: ['feature'], priorities: ['P1'] })))).toEqual(['t5'])
    expect(ids(engine.query(filter({ statuses: ['done'], priorities: ['P2'] })))).toEqual(['t3'])
    expect(ids(engine.query(filter({ statuses: ['todo'], kinds: ['chore'] })))).toEqual([])
  })

  it('tags 支持 any / all 两种模式', () => {
    expect(ids(engine.query(filter({ tags: ['ui'] })))).toEqual(['t1', 't3', 't5'])
    expect(ids(engine.query(filter({ tags: ['ui', 'urgent'], tagMode: 'all' })))).toEqual(['t1', 't5'])
    expect(ids(engine.query(filter({ tags: ['ui', 'urgent'], tagMode: 'any' })))).toEqual(['t1', 't3', 't5'])
  })

  it('assignees 精确匹配，未指派任务不被命中', () => {
    expect(ids(engine.query(filter({ assignees: ['bob'] })))).toEqual(['t2'])
    expect(ids(engine.query(filter({ assignees: ['amy', 'bob'] })))).toEqual(['t1', 't2'])
  })
})

describe('QueryEngine · 日期与状态派生（验收 2）', () => {
  it('dateRange 按 [start, due] 与筛选区间求交集，未排期任务排除', () => {
    expect(ids(engine.query(filter({ dateRange: { from: '2026-10-20', to: '2026-10-31' } })))).toEqual(['t2'])
    expect(ids(engine.query(filter({ dateRange: { from: '2026-10-10' } })))).toEqual(['t1', 't2', 't5'])
    expect(ids(engine.query(filter({ dateRange: { to: '2026-10-05' } })))).toEqual(['t3'])
  })

  it('overdueOnly 只认「有到期日 + 未完成 + 早于今天」', () => {
    expect(ids(engine.query(filter({ overdueOnly: true })))).toEqual(['t1'])
  })

  it('blockedOnly 复用 DependencyGraph 的 FS 语义', () => {
    expect(ids(engine.query(filter({ blockedOnly: true })))).toEqual(['t2', 't3'])
  })

  it('withNotesOnly 排除空笔记', () => {
    expect(ids(engine.query(filter({ withNotesOnly: true })))).toEqual(['t1', 't3', 't5', 't6'])
  })
})

describe('QueryEngine · 全文搜索（验收 3）', () => {
  it('text 匹配标题与 note 正文，大小写不敏感', () => {
    expect(ids(engine.query(filter({ text: '任务 t2' })))).toEqual(['t2'])
    expect(ids(engine.query(filter({ text: 'ASSETS' })))).toEqual(['t5'])
  })

  it('图片语法与路径不参与匹配，markdown 标记不误命中', () => {
    // t1 的 note 只含 ![](assets/x1.png)：搜 png / x1 不应命中
    expect(ids(engine.query(filter({ text: 'png' })))).toEqual([])
    expect(ids(engine.query(filter({ text: 'x1' })))).toEqual([])
    expect(ids(engine.query(filter({ text: '###' })))).toEqual([])
    // 但 note 的真实正文仍可命中
    expect(ids(engine.query(filter({ text: '说明' })))).toEqual(['t1', 't5'])
  })

  it('noteToSearchText 丢弃图片、保留链接文字', () => {
    expect(noteToSearchText('见 ![](assets/a.png) 与 [文档](https://x.test/a)')).toBe('见   与 文档')
  })
})

describe('QueryEngine · 依赖跳数（验收 4）', () => {
  it('downstreamDepth 沿后置方向扩展 N 跳', () => {
    const result = engine.query(filter({ text: '任务 t1', downstreamDepth: 2 }))
    expect(ids(result)).toEqual(['t1', 't2', 't3'])
  })

  it('upstreamDepth 沿前置方向扩展 N 跳', () => {
    const result = engine.query(filter({ text: '收尾', upstreamDepth: 2 }))
    expect(ids(result)).toEqual(['t1', 't2', 't3'])
  })

  it('n=0 或未设置时不扩展', () => {
    expect(ids(engine.query(filter({ text: '收尾' })))).toEqual(['t3'])
    expect(ids(engine.query(filter({ text: '收尾', downstreamDepth: 0 })))).toEqual(['t3'])
  })

  it('扩展开来的邻居不受其余维度约束，但仍排除归档', () => {
    const result = engine.query(filter({ text: '收尾', upstreamDepth: 9, includeArchived: false }))
    expect(ids(result)).toEqual(['t1', 't2', 't3'])
  })
})
