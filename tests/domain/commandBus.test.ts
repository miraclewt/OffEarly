import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addNodeCommand,
  createCommandBus,
  createMapCommand,
  createTaskCommand,
  deleteMapCommand,
  deleteNodeCommand,
  deleteTaskCommand,
  moveNodeCommand,
  moveTaskCommand,
  patchMapCommand,
  patchNodeCommand,
  patchSettingsCommand,
  patchTaskCommand,
} from '../../src/domain/commandBus'
import type { CommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { VaultStore } from '../../src/domain/store'
import type { MindMap, MindNode, Task, Vault } from '../../src/domain/types'
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

// ── T41 · 思维导图命令（图与节点树写入口；task.* / settings.patch 行为不变） ──────

describe('思维导图命令', () => {
  /** 种子图：root r，子 ['a'（有子 a1）, 'b']。直接换 vault 不走 bus，undo 栈保持 0。 */
  function seedMap(overrides: Partial<MindMap> = {}): MindMap {
    const map: MindMap = {
      id: 'map-1',
      name: '图 1',
      order: 'm',
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
      root: {
        id: 'r',
        text: 'R',
        order: 'm',
        folded: false,
        children: [
          {
            id: 'a',
            text: 'A',
            order: 'a',
            folded: false,
            children: [{ id: 'a1', text: 'A1', order: 'a1', folded: false, children: [] }],
          },
          { id: 'b', text: 'B', order: 'b', folded: false, children: [] },
        ],
      },
      ...overrides,
    }
    store.setVault({ ...store.getVault(), mindmaps: [map] })
    return map
  }

  function mapRoot(s: VaultStore, id = 'map-1'): MindNode {
    const map = s.getVault().mindmaps.find((candidate) => candidate.id === id)
    if (map === undefined) throw new Error('夹具：图不存在')
    return map.root
  }

  // ── T48 终审修复轮（Important 4）：既有 7 个导图 case 只断言了 undo 对称，
  //    这里逐一补 bus.redo() → 必须回到 apply 之后的状态（undo/redo 往返闭合）。
  it('addNodeCommand + undo 还原树 + redo 回到加子之后', () => {
    const map = seedMap() // root 'r'，子 ['a','b']
    const before = structuredClone(store.getVault())
    const node: MindNode = { id: 'c', text: 'C', order: 'w', folded: false, children: [] }

    bus.apply(addNodeCommand(map.id, 'r', node, null))
    const after = structuredClone(store.getVault())
    expect(mapRoot(store).children.map((n) => n.id)).toEqual(['a', 'b', 'c'])

    bus.undo()
    expect(mapRoot(store).children.map((n) => n.id)).toEqual(['a', 'b'])
    expect(store.getVault()).toEqual(before)

    expect(bus.redo()).toBe(true)
    expect(store.getVault()).toEqual(after)
    expect(mapRoot(store).children.map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('deleteNodeCommand 逆元携完整子树复原位置；redo 再删一次', () => {
    seedMap()
    const before = structuredClone(store.getVault())

    bus.apply(deleteNodeCommand(store.getVault(), 'map-1', 'a')) // 删 a（有子 a1）
    const after = structuredClone(store.getVault())
    expect(mapRoot(store).children.map((n) => n.id)).toEqual(['b'])

    bus.undo()
    expect(mapRoot(store).children.map((n) => n.id)).toEqual(['a', 'b'])
    expect(mapRoot(store).children[0]!.children.map((n) => n.id)).toEqual(['a1']) // a 回 index 0 且 a1 仍在
    expect(store.getVault()).toEqual(before)

    expect(bus.redo()).toBe(true)
    expect(store.getVault()).toEqual(after)
    expect(mapRoot(store).children.map((n) => n.id)).toEqual(['b'])
  })

  it('deleteNodeCommand 删根抛错、不压 undo 栈', () => {
    seedMap()
    expect(() => deleteNodeCommand(store.getVault(), 'map-1', 'r')).toThrow()
    expect(bus.undoDepth()).toBe(0)
  })

  it('patchNodeCommand 字段级逆（text/folded）；redo 重放同一 patch', () => {
    seedMap()
    const before = structuredClone(store.getVault())

    bus.apply(patchNodeCommand(store.getVault(), 'map-1', 'a', { text: '改过', folded: true }))
    const after = structuredClone(store.getVault())
    const patched = mapRoot(store).children[0]!
    expect({ text: patched.text, folded: patched.folded }).toEqual({ text: '改过', folded: true })

    bus.undo()
    const restored = mapRoot(store).children[0]!
    expect({ text: restored.text, folded: restored.folded }).toEqual({ text: 'A', folded: false })
    expect(store.getVault()).toEqual(before)

    expect(bus.redo()).toBe(true)
    expect(store.getVault()).toEqual(after)
    expect(() => patchNodeCommand(store.getVault(), 'map-1', 'a', {})).toThrow(/空 patch/)
  })

  it('moveNodeCommand 跨父移动 + 逆元回原父原下标；redo 按记录的下标再移一次', () => {
    seedMap()
    const before = structuredClone(store.getVault())

    bus.apply(moveNodeCommand(store.getVault(), 'map-1', 'a1', 'b', 0)) // a1: a→b index0
    const after = structuredClone(store.getVault())
    expect(mapRoot(store).children.map((n) => n.id)).toEqual(['a', 'b'])
    expect(mapRoot(store).children[0]!.children).toEqual([])
    expect(mapRoot(store).children[1]!.children.map((n) => n.id)).toEqual(['a1'])

    bus.undo()
    expect(store.getVault()).toEqual(before)

    // redo = 重新执行 forward（payload 里的 index 是「remove 之后」的下标）→ 与 apply 后逐字节相同
    expect(bus.redo()).toBe(true)
    expect(store.getVault()).toEqual(after)
    expect(mapRoot(store).children[1]!.children.map((n) => n.id)).toEqual(['a1'])
  })

  it('moveNodeCommand 移入自身子树抛错、不压 undo 栈', () => {
    seedMap()
    const before = structuredClone(store.getVault())
    expect(() => moveNodeCommand(store.getVault(), 'map-1', 'a', 'a1', 0)).toThrow()
    expect(bus.undoDepth()).toBe(0)
    // 同一构造期拦截：移根、移入自身同样抛错
    expect(() => moveNodeCommand(store.getVault(), 'map-1', 'r', 'a', 0)).toThrow()
    expect(() => moveNodeCommand(store.getVault(), 'map-1', 'a', 'a', 0)).toThrow()
    expect(bus.undoDepth()).toBe(0)
    expect(store.getVault()).toEqual(before)
  })

  it('createMapCommand / patchMapCommand 往返，空 patch 抛错；redo 逐级重放', () => {
    const initial = structuredClone(store.getVault())
    const created: MindMap = {
      id: 'map-new',
      name: '新图',
      order: 'z',
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
      root: { id: 'nr', text: '根', order: 'm', folded: false, children: [] },
    }
    bus.apply(createMapCommand(created))
    const afterCreate = structuredClone(store.getVault())
    expect(store.getVault().mindmaps.map((m) => m.id)).toEqual(['map-new'])

    bus.apply(patchMapCommand(store.getVault(), 'map-new', { name: '改名', updatedAt: T1.toISOString() }))
    const afterPatch = structuredClone(store.getVault())
    expect(store.getVault().mindmaps[0]!.name).toBe('改名')

    bus.undo()
    expect(store.getVault().mindmaps[0]!.name).toBe('新图')
    expect(store.getVault()).toEqual(afterCreate)
    expect(() => patchMapCommand(store.getVault(), 'map-new', {})).toThrow(/空 patch/)
    bus.undo()
    expect(store.getVault().mindmaps).toEqual([])
    expect(store.getVault()).toEqual(initial)

    // redo 栈序回放：先重建图、再重放 patch
    expect(bus.redo()).toBe(true)
    expect(store.getVault()).toEqual(afterCreate)
    expect(bus.redo()).toBe(true)
    expect(store.getVault()).toEqual(afterPatch)
    expect(store.getVault().mindmaps[0]!.name).toBe('改名')
    expect(bus.canRedo()).toBe(false)
  })

  it('deleteMapCommand undo 后图与原下标复原；redo 再删同一张', () => {
    const first = seedMap()
    const second: MindMap = { ...first, id: 'map-2', name: '图 2' }
    store.setVault({ ...store.getVault(), mindmaps: [first, second] })
    const before = structuredClone(store.getVault())

    bus.apply(deleteMapCommand(store.getVault(), 'map-1')) // 删第一张
    const after = structuredClone(store.getVault())
    expect(store.getVault().mindmaps.map((m) => m.id)).toEqual(['map-2'])

    bus.undo()
    expect(store.getVault()).toEqual(before)
    expect(store.getVault().mindmaps.map((m) => m.id)).toEqual(['map-1', 'map-2'])

    expect(bus.redo()).toBe(true)
    expect(store.getVault()).toEqual(after)
    expect(store.getVault().mindmaps.map((m) => m.id)).toEqual(['map-2'])
  })
})
