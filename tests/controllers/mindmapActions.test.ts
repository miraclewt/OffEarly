// T42 · mindmapActions：控制器构造层（plan→apply）+ 与 CommandBus 的接线。
// store/bus 的搭法与 tests/controllers/taskCreate.test.ts 同款：真实 store + 真实 bus，
// 只注入 newId / now 让 id 与时间戳确定化。

import { describe, expect, it } from 'vitest'

import {
  applyAddNode,
  applyCreateMap,
  applyDeleteMap,
  applyDeleteNode,
  applyMoveNode,
  applyRenameMap,
  applyRenameNode,
  applyToggleFold,
  buildNewMap,
  planCreateMap,
} from '../../src/controllers/mindmapActions'
import { createCommandBus } from '../../src/domain/commandBus'
import type { CommandBus } from '../../src/domain/commandBus'
import { mid } from '../../src/domain/lexorank'
import { findNode } from '../../src/domain/mindmapTree'
import { createVaultStore } from '../../src/domain/store'
import type { VaultStore } from '../../src/domain/store'
import type { MindMap, MindNode, Vault } from '../../src/domain/types'

const NOW = '2026-10-17T08:00:00.000Z'

/** 依次吐出给定 id 的 id 生成器（applyCreateMap 先取 map id、再取 root id）。 */
function seq(...ids: string[]): () => string {
  let i = 0
  return () => {
    const id = ids[i++]
    if (id === undefined) throw new Error('seq: id 用尽')
    return id
  }
}

function node(id: string, text: string, extra: Partial<MindNode> = {}): MindNode {
  return { id, text, order: mid(undefined, undefined), folded: false, children: [], ...extra }
}

/** 固定树：root1 → [ a(→ a1), b ]。 */
function fixtureMap(extra: Partial<MindMap> = {}): MindMap {
  return {
    id: 'm1',
    name: '计划',
    root: node('root1', '中心主题', {
      children: [node('a', '分支A', { children: [node('a1', '子A1')] }), node('b', '分支B')],
    }),
    order: mid(undefined, undefined),
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  }
}

function vault(mindmaps: MindMap[] = []): Vault {
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
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps,
  }
}

function world(mindmaps: MindMap[] = []): { store: VaultStore; bus: CommandBus } {
  const store = createVaultStore(vault(mindmaps))
  return { store, bus: createCommandBus(store) }
}

const deps = { newId: () => 'n1', now: () => new Date(NOW) }

describe('mindmapActions · applyCreateMap', () => {
  it('plan 是只算不写；apply 后才进库、才进撤销栈', () => {
    const { store, bus } = world()
    const plan = planCreateMap(store.getVault(), { name: '计划', fallbackName: '未命名导图', rootText: '中心主题' }, { newId: seq('m1', 'root1'), now: () => new Date(NOW) })
    expect(plan.command.type).toBe('mindmap.create')
    expect(plan.command.inverse.type).toBe('mindmap.delete')
    expect(store.getVault().mindmaps).toHaveLength(0)
    expect(bus.undoDepth()).toBe(0)

    bus.apply(plan.command)
    expect(store.getVault().mindmaps).toHaveLength(1)
  })

  it('applyCreateMap：根节点带注入文案、map/root 的 order 取 LexoRank 中点、时间注入确定化、入参快照不被改写', () => {
    const { store, bus } = world()
    const snapshot = store.getVault()
    const plan = applyCreateMap(bus, snapshot, { name: '  计划  ', fallbackName: '未命名导图', rootText: '中心主题' }, { newId: seq('m1', 'root1'), now: () => new Date(NOW) })

    expect(snapshot.mindmaps).toHaveLength(0) // 不改入参
    expect(plan.map.id).toBe('m1')
    const created = store.getVault().mindmaps[0]!
    expect(created.name).toBe('计划') // 只 trim 首尾
    expect(created.order).toBe(mid(undefined, undefined))
    expect(created.createdAt).toBe(NOW)
    expect(created.updatedAt).toBe(NOW)
    expect(created.root).toEqual({ id: 'root1', text: '中心主题', order: mid(undefined, undefined), folded: false, children: [] })
    expect(bus.undoDepth()).toBe(1)
  })

  it('name 缺省 / 纯空白 → fallbackName（视图注入译文，控制器不 import i18n）', () => {
    const { store, bus } = world()
    applyCreateMap(bus, store.getVault(), { fallbackName: '未命名导图', rootText: '中心主题' }, { newId: seq('m1', 'r1'), now: () => new Date(NOW) })
    applyCreateMap(bus, store.getVault(), { name: '   ', fallbackName: '未命名导图', rootText: '中心主题' }, { newId: seq('m2', 'r2'), now: () => new Date(NOW) })
    expect(store.getVault().mindmaps.map((m) => m.name)).toEqual(['未命名导图', '未命名导图'])
  })

  it('第二张图 order 追加列表尾部；undo 一步还原', () => {
    const { store, bus } = world([fixtureMap()])
    const plan = applyCreateMap(bus, store.getVault(), { name: '新图', fallbackName: '未命名导图', rootText: '中心主题' }, { newId: seq('m2', 'root2'), now: () => new Date(NOW) })
    expect(plan.map.order > 'V').toBe(true)
    expect(store.getVault().mindmaps.map((m) => m.id)).toEqual(['m1', 'm2'])

    bus.undo()
    expect(store.getVault().mindmaps.map((m) => m.id)).toEqual(['m1'])
  })

  it('buildNewMap 一次消耗两个 id：先 map 后 root', () => {
    const map = buildNewMap(vault(), { name: 'x', fallbackName: 'fb', rootText: 'rt' }, { newId: seq('map-1', 'root-1'), now: () => new Date(NOW) })
    expect(map.id).toBe('map-1')
    expect(map.root.id).toBe('root-1')
  })
})

describe('mindmapActions · applyAddNode', () => {
  it('追加尾部：order = mid(最后兄弟, undefined)，text 空白走 fallbackText，返回新节点', () => {
    const { store, bus } = world([fixtureMap()])
    const created = applyAddNode(bus, store.getVault(), 'm1', 'root1', { text: '  ', fallbackText: '分支' }, { newId: () => 'n1' })!
    expect(created.id).toBe('n1')
    expect(created.text).toBe('分支')
    expect(created.folded).toBe(false)
    expect(created.children).toEqual([])

    const root = store.getVault().mindmaps[0]!.root
    expect(root.children.map((c) => c.id)).toEqual(['a', 'b', 'n1'])
    expect(created.order > 'V').toBe(true) // mid(最后兄弟 order, undefined)
    expect(bus.undoDepth()).toBe(1)
  })

  it('text 只 trim 首尾，内部空白原样保留', () => {
    const { store, bus } = world([fixtureMap()])
    const created = applyAddNode(bus, store.getVault(), 'm1', 'a', { text: '  Fix  Login  ', fallbackText: '分支' }, deps)!
    expect(created.text).toBe('Fix  Login')
  })

  it('父折叠 → 展开并入两条命令（两条 undo 记录）：先撤加子、再撤展开', () => {
    const folded = fixtureMap({ root: node('root1', '中心主题', { folded: true, children: [node('a', '分支A'), node('b', '分支B')] }) })
    const { store, bus } = world([folded])
    const before = bus.undoDepth()
    const created = applyAddNode(bus, store.getVault(), 'm1', 'root1', { text: '新分支', fallbackText: '分支' }, { newId: () => 'n1' })!
    expect(created).not.toBeNull()
    expect(bus.undoDepth()).toBe(before + 2) // 裁决：展开与加子是两条命令
    expect(findNode(store.getVault().mindmaps[0]!.root, 'root1')!.folded).toBe(false)

    bus.undo() // 撤加子 → 父保持展开
    expect(store.getVault().mindmaps[0]!.root.children.map((c) => c.id)).toEqual(['a', 'b'])
    expect(findNode(store.getVault().mindmaps[0]!.root, 'root1')!.folded).toBe(false)
    bus.undo() // 撤展开 → 回到折叠
    expect(findNode(store.getVault().mindmaps[0]!.root, 'root1')!.folded).toBe(true)
  })

  it('父 / 图不存在 → null 且零写入（不碰撤销栈）', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyAddNode(bus, store.getVault(), 'm1', 'ghost', { text: 'x', fallbackText: 'fb' }, deps)).toBeNull()
    expect(applyAddNode(bus, store.getVault(), 'ghost', 'root1', { text: 'x', fallbackText: 'fb' }, deps)).toBeNull()
    expect(bus.undoDepth()).toBe(0)
    expect(store.getVault().mindmaps[0]!.root.children).toHaveLength(2)
  })
})

describe('mindmapActions · applyRenameNode', () => {
  it('走 node.patch { text }，空白文本走 fallbackText；undo 还原旧文案', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyRenameNode(bus, store.getVault(), 'm1', 'a', '   ', '分支')).toBe(true)
    expect(findNode(store.getVault().mindmaps[0]!.root, 'a')!.text).toBe('分支')
    bus.undo()
    expect(findNode(store.getVault().mindmaps[0]!.root, 'a')!.text).toBe('分支A')
  })

  it('节点 / 图不存在 → false 且零写入', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyRenameNode(bus, store.getVault(), 'm1', 'ghost', 'x', 'fb')).toBe(false)
    expect(applyRenameNode(bus, store.getVault(), 'ghost', 'a', 'x', 'fb')).toBe(false)
    expect(bus.undoDepth()).toBe(0)
  })

  it('节点级编辑不刷新图级 updatedAt（T41 handoff 纪律）', () => {
    const { store, bus } = world([fixtureMap()])
    applyRenameNode(bus, store.getVault(), 'm1', 'a', '改名', 'fb')
    applyAddNode(bus, store.getVault(), 'm1', 'a', { text: '子', fallbackText: 'fb' }, deps)
    applyToggleFold(bus, store.getVault(), 'm1', 'a')
    expect(store.getVault().mindmaps[0]!.updatedAt).toBe(NOW)
    expect(bus.undoDepth()).toBe(3)
  })
})

describe('mindmapActions · applyToggleFold', () => {
  it('翻转 folded；根也可折叠；undo 还原', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyToggleFold(bus, store.getVault(), 'm1', 'a')).toBe(true)
    expect(findNode(store.getVault().mindmaps[0]!.root, 'a')!.folded).toBe(true)
    bus.undo()
    expect(findNode(store.getVault().mindmaps[0]!.root, 'a')!.folded).toBe(false)

    expect(applyToggleFold(bus, store.getVault(), 'm1', 'root1')).toBe(true)
    expect(store.getVault().mindmaps[0]!.root.folded).toBe(true)
  })

  it('节点 / 图不存在 → false 且零写入', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyToggleFold(bus, store.getVault(), 'm1', 'ghost')).toBe(false)
    expect(applyToggleFold(bus, store.getVault(), 'ghost', 'a')).toBe(false)
    expect(bus.undoDepth()).toBe(0)
  })
})

describe('mindmapActions · applyDeleteNode', () => {
  it('根节点 → false 且 bus 零写入（不抛错不压栈）', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyDeleteNode(bus, store.getVault(), 'm1', 'root1')).toBe(false)
    expect(bus.undoDepth()).toBe(0)
    expect(store.getVault().mindmaps[0]!.root.id).toBe('root1')
  })

  it('删普通节点连子树；undo 携完整子树回原父原下标', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyDeleteNode(bus, store.getVault(), 'm1', 'a')).toBe(true)
    expect(store.getVault().mindmaps[0]!.root.children.map((c) => c.id)).toEqual(['b'])
    bus.undo()
    const a = findNode(store.getVault().mindmaps[0]!.root, 'a')!
    expect(a.children.map((c) => c.id)).toEqual(['a1'])
    expect(store.getVault().mindmaps[0]!.root.children.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('节点 / 图不存在 → false 且零写入', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyDeleteNode(bus, store.getVault(), 'm1', 'ghost')).toBe(false)
    expect(applyDeleteNode(bus, store.getVault(), 'ghost', 'a')).toBe(false)
    expect(bus.undoDepth()).toBe(0)
  })
})

describe('mindmapActions · applyMoveNode', () => {
  it('负 index → TypeError，零写入', () => {
    const { store, bus } = world([fixtureMap()])
    expect(() => applyMoveNode(bus, store.getVault(), 'm1', 'b', 'a', -1)).toThrow(TypeError)
    expect(bus.undoDepth()).toBe(0)
  })

  it('非法结构（移根 / 移入自身子树）透传命令层抛错，且不落 undo 栈', () => {
    const { store, bus } = world([fixtureMap()])
    expect(() => applyMoveNode(bus, store.getVault(), 'm1', 'root1', 'a', 0)).toThrow(/根节点不可移动/)
    expect(() => applyMoveNode(bus, store.getVault(), 'm1', 'a', 'a1', 0)).toThrow(/子树/)
    expect(bus.undoDepth()).toBe(0)
    expect(store.getVault()).toEqual(vault([fixtureMap()]))
  })

  it('合法移动 → true；index 按「remove 之后」的兄弟序列解释；undo 回原父原下标', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyMoveNode(bus, store.getVault(), 'm1', 'a1', 'b', 0)).toBe(true)
    expect(findNode(store.getVault().mindmaps[0]!.root, 'b')!.children.map((c) => c.id)).toEqual(['a1'])
    expect(findNode(store.getVault().mindmaps[0]!.root, 'a')!.children).toHaveLength(0)
    bus.undo()
    expect(findNode(store.getVault().mindmaps[0]!.root, 'a')!.children.map((c) => c.id)).toEqual(['a1'])
  })

  it('T47 拖拽落点口径：index = 目标 children.length 尾插；同父落到尾部、其余兄弟保持原序', () => {
    const source: MindMap = {
      id: 'm1',
      name: '计划',
      root: node('root1', '中心主题', {
        children: [
          node('a', '分支A', { children: [node('a1', '子A1'), node('a2', '子A2'), node('a3', '子A3')] }),
          node('b', '分支B', { children: [node('b1', '子B1')] }),
        ],
      }),
      order: mid(undefined, undefined),
      createdAt: NOW,
      updatedAt: NOW,
    }
    const { store, bus } = world([source])
    const rootNow = () => store.getVault().mindmaps[0]!.root

    // 跨父尾插：UI 传 index = b.children.length（remove 前取值，=1）→ 落 b 尾
    expect(applyMoveNode(bus, store.getVault(), 'm1', 'a1', 'b', findNode(rootNow(), 'b')!.children.length)).toBe(true)
    expect(findNode(rootNow(), 'b')!.children.map((c) => c.id)).toEqual(['b1', 'a1'])
    bus.undo()
    expect(findNode(rootNow(), 'a')!.children.map((c) => c.id)).toEqual(['a1', 'a2', 'a3'])

    // 同父尾插：index = a.children.length（=3，remove 后仅 2 位，splice 越界即尾插）
    // → a1 移到尾部，其余兄弟相对序不动（工厂内不做原下标补偿——此测试锁定该语义）
    expect(applyMoveNode(bus, store.getVault(), 'm1', 'a1', 'a', findNode(rootNow(), 'a')!.children.length)).toBe(true)
    expect(findNode(rootNow(), 'a')!.children.map((c) => c.id)).toEqual(['a2', 'a3', 'a1'])
  })
})

describe('mindmapActions · applyRenameMap', () => {
  it('trim 后落 name 并经 payload 刷新 updatedAt = deps.now；undo 两个字段一起还原', () => {
    const { store, bus } = world([fixtureMap()])
    const later = '2026-10-18T00:00:00.000Z'
    expect(applyRenameMap(bus, store.getVault(), 'm1', '  新名  ', { now: () => new Date(later) })).toBe(true)
    expect(store.getVault().mindmaps[0]!.name).toBe('新名')
    expect(store.getVault().mindmaps[0]!.updatedAt).toBe(later)
    bus.undo()
    expect(store.getVault().mindmaps[0]!.name).toBe('计划')
    expect(store.getVault().mindmaps[0]!.updatedAt).toBe(NOW)
  })

  it('trim 后为空 → false 且零写入；图不存在 → false', () => {
    const { store, bus } = world([fixtureMap()])
    expect(applyRenameMap(bus, store.getVault(), 'm1', '   ')).toBe(false)
    expect(applyRenameMap(bus, store.getVault(), 'ghost', 'x')).toBe(false)
    expect(bus.undoDepth()).toBe(0)
  })
})

describe('mindmapActions · applyDeleteMap', () => {
  it('唯一一张图也允许删（空库态由 T45 引导卡承接）；undo 还原列表位置', () => {
    const { store, bus } = world([fixtureMap({ order: 'b' })])
    expect(applyDeleteMap(bus, store.getVault(), 'm1')).toBe(true)
    expect(store.getVault().mindmaps).toHaveLength(0)
    bus.undo()
    expect(store.getVault().mindmaps.map((m) => ({ id: m.id, order: m.order }))).toEqual([{ id: 'm1', order: 'b' }])
  })

  it('图不存在 → false 且零写入', () => {
    const { store, bus } = world()
    expect(applyDeleteMap(bus, store.getVault(), 'ghost')).toBe(false)
    expect(bus.undoDepth()).toBe(0)
  })
})
