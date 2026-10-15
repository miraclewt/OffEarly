import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createCommandBus,
  createTaskCommand,
  deleteTaskCommand,
  moveTaskCommand,
  patchSettingsCommand,
  patchTaskCommand,
} from '../../src/domain/commandBus'
import type { CommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { VaultStore } from '../../src/domain/store'
import type { Task, Vault } from '../../src/domain/types'
import { createAutosave } from '../../src/persistence/autosave'
import { createNewVault } from '../../src/persistence/vaultRepository'

const T0 = new Date('2026-10-15T08:00:00.000Z')
const T1 = new Date('2026-10-15T09:30:00.000Z')

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
    order: 'm',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    archived: false,
    ...overrides,
  }
}

function seeded(): Vault {
  const vault = createNewVault(T0)
  return { ...vault, tasks: [makeTask('a'), makeTask('b'), makeTask('c')] }
}

let store: VaultStore
let bus: CommandBus

beforeEach(() => {
  store = createVaultStore(seeded())
  bus = createCommandBus(store)
})

describe('apply', () => {
  it('更新 Store 且不改动旧 vault 对象', () => {
    const before = store.getVault()

    bus.apply(patchTaskCommand(before, 'b', { title: '改过的标题' }))

    expect(store.getVault()).not.toBe(before)
    expect(store.getVault().tasks.find((t) => t.id === 'b')?.title).toBe('改过的标题')
    expect(before.tasks.find((t) => t.id === 'b')?.title).toBe('任务 b')
  })

  it('推入 undo 栈并通知订阅者', () => {
    let notified = 0
    bus.subscribe(() => {
      notified += 1
    })

    bus.apply(patchTaskCommand(store.getVault(), 'a', { title: 'x' }))

    expect(bus.canUndo()).toBe(true)
    expect(bus.undoDepth()).toBe(1)
    expect(bus.canRedo()).toBe(false)
    expect(notified).toBe(1)
  })

  it('端到端标记 dirty：Store 一变，T08 的 autosave 就进 dirty 态', () => {
    const autosave = createAutosave({
      store,
      sink: { save: async () => {} },
      now: () => T1,
    })
    autosave.start()
    expect(autosave.getState()).toBe('saved')

    bus.apply(patchTaskCommand(store.getVault(), 'a', { title: 'x' }))

    expect(autosave.isDirty()).toBe(true)
    expect(autosave.getState()).toBe('dirty')
    autosave.stop()
  })

  it('未知 id 直接抛错，不静默写坏数据', () => {
    expect(() => patchTaskCommand(store.getVault(), 'nope', { title: 'x' })).toThrow(/不存在/)
    expect(() => deleteTaskCommand(store.getVault(), 'nope')).toThrow(/不存在/)
  })
})

describe('undo / redo', () => {
  it('MoveTask 往返一致：undo 后与 apply 前深度相等', () => {
    const before = store.getVault()
    const snapshot = structuredClone(before)

    bus.apply(moveTaskCommand(before, 'a', { status: 'doing', order: 'z' }))
    expect(store.getVault()).not.toEqual(before)

    expect(bus.undo()).toBe(true)

    expect(store.getVault()).toEqual(snapshot)
    expect(bus.canUndo()).toBe(false)
    expect(bus.canRedo()).toBe(true)
  })

  it('redo 回到 apply 之后的状态', () => {
    bus.apply(moveTaskCommand(store.getVault(), 'a', { status: 'review', order: 'q' }))
    const afterApply = structuredClone(store.getVault())

    bus.undo()
    bus.redo()

    expect(store.getVault()).toEqual(afterApply)
    expect(bus.canRedo()).toBe(false)
  })

  it('多步 undo / redo 严格按栈序回放', () => {
    const initial = structuredClone(store.getVault())
    bus.apply(patchTaskCommand(store.getVault(), 'a', { title: 'A1' }))
    const afterA = structuredClone(store.getVault())
    bus.apply(patchTaskCommand(store.getVault(), 'b', { title: 'B1' }))
    const afterB = structuredClone(store.getVault())
    bus.apply(moveTaskCommand(store.getVault(), 'c', { status: 'done', order: 'zz' }))
    const afterC = structuredClone(store.getVault())

    expect(bus.undoDepth()).toBe(3)
    bus.undo()
    expect(store.getVault()).toEqual(afterB)
    bus.undo()
    expect(store.getVault()).toEqual(afterA)
    bus.undo()
    expect(store.getVault()).toEqual(initial)
    expect(bus.canUndo()).toBe(false)

    bus.redo()
    bus.redo()
    bus.redo()
    expect(store.getVault()).toEqual(afterC)
    expect(bus.redoDepth()).toBe(0)
  })

  it('apply 新命令会清空 redo 栈', () => {
    bus.apply(patchTaskCommand(store.getVault(), 'a', { title: 'A1' }))
    bus.undo()
    expect(bus.canRedo()).toBe(true)

    bus.apply(patchTaskCommand(store.getVault(), 'b', { title: 'B1' }))

    expect(bus.canRedo()).toBe(false)
    expect(bus.redoDepth()).toBe(0)
  })

  it('空栈时 undo/redo 返回 false 且不动数据', () => {
    const before = structuredClone(store.getVault())

    expect(bus.undo()).toBe(false)
    expect(bus.redo()).toBe(false)
    expect(store.getVault()).toEqual(before)
  })

  it('create / delete 往返保留任务在数组中的原位置', () => {
    const before = structuredClone(store.getVault())
    expect(before.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c'])

    bus.apply(deleteTaskCommand(before, 'b'))
    expect(store.getVault().tasks.map((t) => t.id)).toEqual(['a', 'c'])

    bus.undo()
    expect(store.getVault()).toEqual(before)
    expect(store.getVault().tasks.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('新建任务后 undo 会把它移除', () => {
    const created = makeTask('d')
    bus.apply(createTaskCommand(created))
    expect(store.getVault().tasks.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])

    bus.undo()

    expect(store.getVault().tasks.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('命令契约', () => {
  it('每个命令都带 inverse，且 inverse 不嵌套下一层', () => {
    const vault = store.getVault()
    const commands = [
      createTaskCommand(makeTask('d')),
      deleteTaskCommand(vault, 'a'),
      patchTaskCommand(vault, 'a', { title: 'x', priority: 'P0' }),
      moveTaskCommand(vault, 'a', { status: 'doing', order: 'z' }),
      patchSettingsCommand(vault, { ganttScale: 'week' }),
    ]

    for (const command of commands) {
      expect(command.inverse).toBeDefined()
      expect(typeof command.inverse.type).toBe('string')
      expect(command.inverse).toHaveProperty('payload')
      // 逆元不再嵌套下一层，否则 undo 语义会分叉
      expect(command.inverse).not.toHaveProperty('inverse')
    }
  })

  it('每个命令的 inverse 都能把 vault 还原（逐命令往返）', () => {
    const vault = store.getVault()
    const commands = [
      createTaskCommand(makeTask('d')),
      deleteTaskCommand(vault, 'b'),
      patchTaskCommand(vault, 'a', { title: 'x', tags: ['ui'], priority: 'P0' }),
      moveTaskCommand(vault, 'c', { status: 'done', order: 'zz' }),
      patchSettingsCommand(vault, { ganttScale: 'week', locale: 'en' }),
    ]

    for (const command of commands) {
      const local = createVaultStore(seeded())
      const localBus = createCommandBus(local)
      const snapshot = structuredClone(local.getVault())
      localBus.apply(command)
      localBus.undo()
      expect(local.getVault()).toEqual(snapshot)
    }
  })
})

describe('领域规则：done 强制进度 100', () => {
  it('patch 到 done 时进度被抬到 100', () => {
    bus.apply(patchTaskCommand(store.getVault(), 'a', { status: 'done' }))

    expect(store.getVault().tasks.find((t) => t.id === 'a')?.progress).toBe(100)
  })

  it('undo 会把状态与进度一起还原（不是只还原状态）', () => {
    const before = store.getVault()
    bus.apply(patchTaskCommand(before, 'a', { status: 'done', progress: 40 }))

    expect(store.getVault().tasks.find((t) => t.id === 'a')?.progress).toBe(100)

    bus.undo()

    expect(store.getVault().tasks.find((t) => t.id === 'a')?.progress).toBe(0)
    expect(store.getVault()).toEqual(before)
  })

  it('move 到 done 同样强制 100，且 undo 后可逆', () => {
    const before = store.getVault()
    bus.apply(moveTaskCommand(before, 'a', { status: 'done', order: 'z' }))
    expect(store.getVault().tasks.find((t) => t.id === 'a')?.progress).toBe(100)

    bus.undo()
    expect(store.getVault()).toEqual(before)
  })

  it('非 done 状态不触碰进度', () => {
    bus.apply(patchTaskCommand(store.getVault(), 'a', { status: 'doing', progress: 40 }))

    expect(store.getVault().tasks.find((t) => t.id === 'a')?.progress).toBe(40)
  })
})

describe('settings', () => {
  it('settings.patch 改配置并可撤销', () => {
    const before = store.getVault()

    bus.apply(patchSettingsCommand(before, { locale: 'en', ganttScale: 'week' }))

    expect(store.getVault().settings.locale).toBe('en')
    expect(store.getVault().settings.ganttScale).toBe('week')
    expect(store.getVault().settings.boardColumns).toEqual(['todo', 'doing', 'review', 'done'])

    bus.undo()
    expect(store.getVault()).toEqual(before)
  })
})

describe('外部注入的订阅面', () => {
  it('订阅者可读到栈深变化，退订后不再收到', () => {
    const seen: number[] = []
    const off = bus.subscribe(() => seen.push(bus.undoDepth()))

    bus.apply(patchTaskCommand(store.getVault(), 'a', { title: 'x' }))
    bus.undo()
    off()
    bus.apply(patchTaskCommand(store.getVault(), 'a', { title: 'y' }))

    expect(seen).toEqual([1, 0])
  })

  it('apply 不吞异常：reducer 抛错时 Store 保持原样', () => {
    const spy = vi.spyOn(store, 'setVault')
    const before = structuredClone(store.getVault())

    expect(() =>
      bus.apply({ type: 'task.patch', payload: { id: 'nope', patch: {} }, inverse: { type: 'task.patch', payload: { id: 'nope', patch: {} } } }),
    ).toThrow(/不存在/)

    expect(store.getVault()).toEqual(before)
    expect(spy).not.toHaveBeenCalled()
  })
})
