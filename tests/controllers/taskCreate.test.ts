// T34 · taskCreate：新建任务的判定（纯函数）+ 与 CommandBus 的接线。

import { describe, expect, it, vi } from 'vitest'

import {
  applyCreateTask,
  buildNewTask,
  nextOrderFor,
  pickDefaultTopicId,
  planCreateTask,
} from '../../src/controllers/taskCreate'
import { sortByOrder } from '../../src/controllers/boardDnd'
import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import { createEmptyFilter } from '../../src/domain/queryEngine'
import type { Status, Task, Topic, Vault } from '../../src/domain/types'

const NOW = '2026-10-17T08:30:00.000Z'

function topic(id: string, name: string, order: string, extra: Partial<Topic> = {}): Topic {
  return { id, name, color: '#4F46E5', parentId: null, order, archived: false, ...extra }
}

function task(id: string, status: Status, order: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    topicId: 't1',
    title: `任务-${id}`,
    status,
    kind: 'feature',
    priority: 'P2',
    progress: 0,
    tags: [],
    note: '',
    order,
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
    ...extra,
  }
}

function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: 'OffEarly 0.1.0',
    revision: 1,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
    },
    topics: [topic('t1', '支付', 'a'), topic('t2', '风控', 'b')],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    ...overrides,
  }
}

describe('taskCreate · 归属话题', () => {
  it('显式指定且可用时用指定的', () => {
    expect(pickDefaultTopicId(vault(), 't2')).toBe('t2')
  })

  it('未指定时取当前筛选里的第一个可用话题（筛选生效时新任务才看得见）', () => {
    const base = vault()
    const filtered: Vault = {
      ...base,
      settings: { ...base.settings, lastFilter: { ...createEmptyFilter(), topicIds: ['t2', 't1'] } },
    }
    expect(pickDefaultTopicId(filtered)).toBe('t2')
  })

  it('筛选里的话题已不存在 / 已归档时回落到第一个未归档话题', () => {
    const base = vault({
      topics: [topic('t1', '支付', 'a', { archived: true }), topic('t2', '风控', 'b')],
    })
    const filtered: Vault = {
      ...base,
      settings: { ...base.settings, lastFilter: { ...createEmptyFilter(), topicIds: ['t1', 'ghost'] } },
    }
    expect(pickDefaultTopicId(filtered)).toBe('t2')
    expect(pickDefaultTopicId(base, 't1')).toBe('t2')
  })

  it('话题顺序按 LexoRank 键，不是数组顺序', () => {
    const base = vault({ topics: [topic('t2', '风控', 'z'), topic('t1', '支付', 'a')] })
    expect(pickDefaultTopicId(base)).toBe('t1')
  })

  it('一个未归档话题都没有时返回 null', () => {
    expect(pickDefaultTopicId(vault({ topics: [] }))).toBeNull()
    expect(pickDefaultTopicId(vault({ topics: [topic('t1', '支付', 'a', { archived: true })] }))).toBeNull()
  })
})

describe('taskCreate · 排序键', () => {
  it('追加到目标列尾部（严格大于列内最后一个键）', () => {
    const base = vault({ tasks: [task('k1', 'todo', 'a'), task('k2', 'todo', 'm')] })
    const order = nextOrderFor(base, 'todo')
    expect(order > 'm').toBe(true)
    expect(order > 'a').toBe(true)
  })

  it('空列取 LexoRank 的中点初值', () => {
    expect(nextOrderFor(vault(), 'todo')).toBe(nextOrderFor(vault(), 'review'))
  })

  it('只看未归档任务：归档任务不能成为列尾邻居', () => {
    const base = vault({ tasks: [task('k1', 'todo', 'a'), task('k9', 'todo', 'zz', { archived: true })] })
    // 把归档的 'zz' 算成邻居的话，新键会是 mid('a','zz') = 'm'；正确结果是紧跟可见列尾的 'b'。
    expect(nextOrderFor(base, 'todo')).toBe('b')
  })

  it('别的列的任务不参与', () => {
    const base = vault({ tasks: [task('k1', 'doing', 'zz')] })
    // 空列 → LexoRank 的中点初值（ALPHABET[31] = 'V'，与 example.vault 的首键同一口径）
    expect(nextOrderFor(base, 'todo')).toBe('V')
  })
})

describe('taskCreate · 任务构造', () => {
  it('默认属性齐备：类别 / 优先级 / 进度 / 标签 / 笔记 / 未归档', () => {
    const created = buildNewTask(vault(), { title: '新任务', status: 'doing' }, { newId: () => 'id-1', now: () => new Date(NOW) })
    expect(created).toEqual({
      id: 'id-1',
      topicId: 't1',
      title: '新任务',
      status: 'doing',
      kind: 'feature',
      priority: 'P2',
      progress: 0,
      tags: [],
      note: '',
      order: 'V',
      createdAt: NOW,
      updatedAt: NOW,
      archived: false,
    })
  })

  it('标题只 trim 首尾，内部空白与大小写原样保留', () => {
    const created = buildNewTask(vault(), { title: '  Fix  Login Flow  ', status: 'todo' })
    expect(created?.title).toBe('Fix  Login Flow')
  })

  it('空白标题抛错（视图已拦，这里不静默兜底）', () => {
    expect(() => buildNewTask(vault(), { title: '   ', status: 'todo' })).toThrow(/标题不能为空/)
  })

  it('status=done 时进度摆到 100（task.create 的 reducer 不做归一）', () => {
    expect(buildNewTask(vault(), { title: 'x', status: 'done' })?.progress).toBe(100)
    expect(buildNewTask(vault(), { title: 'x', status: 'review' })?.progress).toBe(0)
  })

  it('没有可用话题时返回 null', () => {
    expect(buildNewTask(vault({ topics: [] }), { title: 'x', status: 'todo' })).toBeNull()
  })
})

describe('taskCreate · 计划与落库', () => {
  it('有话题即产出 create 计划：命令是 task.create、逆元是 task.delete', () => {
    const plan = planCreateTask(vault(), { title: 'x', status: 'todo' }, { newId: () => 'id-1' })
    expect(plan.kind).toBe('create')
    if (plan.kind !== 'create') return
    expect(plan.command.type).toBe('task.create')
    expect(plan.command.inverse.type).toBe('task.delete')
  })

  it('无话题产出 no-topic：不 apply、不进撤销栈', () => {
    const store = createVaultStore(vault({ topics: [] }))
    const bus = createCommandBus(store)
    const apply = vi.spyOn(bus, 'apply')
    const plan = applyCreateTask(bus, store.getVault(), { title: 'x', status: 'todo' })
    expect(plan.kind).toBe('no-topic')
    expect(apply).not.toHaveBeenCalled()
    expect(bus.undoDepth()).toBe(0)
  })

  it('apply 后任务进库、进撤销栈，undo 一步还原', () => {
    const store = createVaultStore(vault({ tasks: [task('k1', 'todo', 'a')] }))
    const bus = createCommandBus(store)

    const plan = applyCreateTask(bus, store.getVault(), { title: '新任务', status: 'todo' }, { newId: () => 'id-9' })
    expect(plan.kind).toBe('create')

    const after = store.getVault()
    expect(after.tasks.map((t) => t.id)).toEqual(['k1', 'id-9'])
    expect(bus.undoDepth()).toBe(1)

    bus.undo()
    expect(store.getVault().tasks.map((t) => t.id)).toEqual(['k1'])
  })

  it('连续创建的任务按 order 排在列尾（不重复键、顺序稳定）', () => {
    const store = createVaultStore(vault({ tasks: [task('k1', 'todo', 'a')] }))
    const bus = createCommandBus(store)
    for (const id of ['n1', 'n2', 'n3']) {
      applyCreateTask(bus, store.getVault(), { title: id, status: 'todo' }, { newId: () => id })
    }
    const column = sortByOrder(store.getVault().tasks.filter((t) => t.status === 'todo'))
    expect(column.map((t) => t.id)).toEqual(['k1', 'n1', 'n2', 'n3'])
    expect(new Set(column.map((t) => t.order)).size).toBe(4)
  })
})
