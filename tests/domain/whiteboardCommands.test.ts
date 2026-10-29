// T69 · 白板领域：命令逆元 + 构造层。
//
// 锁住四条承诺：
//   ① 一次动作一条撤销项（贴模板 = 十几个框加线，按一次 Ctrl+Z 整件事回去）；
//   ② 删框连带它的线，undo 之后**线也回到原位**（不是只在屏幕上消失）；
//   ③ 批量 patch 的逆元只还原这次真的改过的键（不把没动的坐标写回去）；
//   ④ 端点不存在的连线宁可不画，也不能进数据（否则导出时才暴露）。

import { describe, expect, it } from 'vitest'

import {
  applyAddDrafts,
  applyAddGraphic,
  applyAddTemplate,
  applyCreateWhiteboard,
  applyDeleteWhiteboard,
  applyDeleteGraphic,
  applyPatchNodes,
  applyRenameWhiteboard,
  buildEdge,
  buildNode,
} from '../../src/controllers/whiteboardActions'
import {
  addGraphicCommand,
  createCommandBus,
  deleteGraphicCommand,
  patchWhiteboardNodesCommand,
} from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Whiteboard, WhiteboardEdge, WhiteboardNode, Vault } from '../../src/domain/types'

const NOW = '2026-10-29T10:00:00.000Z'

function baseVault(): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: 'OffEarly 0.5.0',
    revision: 1,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
      noteFontSize: 13,
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    trash: [],
    whiteboards: [],
  }
}

function node(id: string, over: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return {
    id,
    shape: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    text: id,
    tone: 'plain',
    ...over,
  }
}

function edge(id: string, from: string, to: string): WhiteboardEdge {
  return {
    id,
    from,
    to,
    fromAnchor: 'auto',
    toAnchor: 'auto',
    route: 'ortho',
    arrow: 'end',
    dashed: false,
    label: '',
  }
}

function whiteboard(id: string, nodes: WhiteboardNode[] = [], edges: WhiteboardEdge[] = []): Whiteboard {
  return { id, name: id, order: 'U', nodes, edges, createdAt: NOW, updatedAt: NOW }
}

/** 每次调用递增的假 id，让「一批里每个图元各拿一个 id」可预测。 */
function seqIds(prefix = 'id'): () => string {
  let count = 0
  return () => {
    count += 1
    return `${prefix}${count}`
  }
}

function mount(vault: Vault) {
  const store = createVaultStore(vault)
  const bus = createCommandBus(store)
  return { store, bus }
}

describe('白板增删改', () => {
  it('新建后落在列表尾部，删除后 undo 回到原位', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1')] })
    const created = applyCreateWhiteboard(bus, store.getVault(), { fallbackName: '未命名白板' }, { newId: seqIds('new'), now: () => new Date(NOW) })
    expect(store.getVault().whiteboards.map((item) => item.id)).toEqual(['b1', created.id])

    expect(applyDeleteWhiteboard(bus, store.getVault(), created.id)).toBe(true)
    expect(store.getVault().whiteboards).toHaveLength(1)
    bus.undo()
    expect(store.getVault().whiteboards.map((item) => item.id)).toEqual(['b1', created.id])
  })

  it('改名：空名走兜底文案，同名不写库（不进撤销栈）', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1')] })
    expect(applyRenameWhiteboard(bus, store.getVault(), 'b1', '   ', '未命名', { now: () => new Date(NOW) })).toBe(true)
    expect(store.getVault().whiteboards[0]!.name).toBe('未命名')

    const depth = bus.undoDepth()
    expect(applyRenameWhiteboard(bus, store.getVault(), 'b1', '未命名', '未命名')).toBe(false)
    expect(bus.undoDepth()).toBe(depth)
  })

  it('改不存在的板返回 false，且不压栈', () => {
    const { store, bus } = mount(baseVault())
    expect(applyDeleteWhiteboard(bus, store.getVault(), 'nope')).toBe(false)
    expect(applyRenameWhiteboard(bus, store.getVault(), 'nope', 'x', 'y')).toBe(false)
    expect(bus.undoDepth()).toBe(0)
  })
})

describe('图元批量进出', () => {
  it('一批图元只进一条撤销项，undo 后全部消失', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1')] })
    applyAddGraphic(bus, store.getVault(), 'b1', [node('n1'), node('n2')], [edge('e1', 'n1', 'n2')])
    expect(bus.undoDepth()).toBe(1)
    expect(store.getVault().whiteboards[0]!.nodes).toHaveLength(2)

    bus.undo()
    expect(store.getVault().whiteboards[0]!.nodes).toHaveLength(0)
    expect(store.getVault().whiteboards[0]!.edges).toHaveLength(0)
  })

  it('端点不存在的连线被拒绝，宁可画不出来也不进数据', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1')] })
    expect(applyAddGraphic(bus, store.getVault(), 'b1', [node('n1')], [edge('e1', 'n1', 'ghost')])).toBe(false)
    expect(applyAddGraphic(bus, store.getVault(), 'b1', [node('n1')], [edge('e1', 'n1', 'n1')])).toBe(false)
    expect(store.getVault().whiteboards[0]!.nodes).toHaveLength(0)
    expect(bus.undoDepth()).toBe(0)
  })

  it('往下标引用两端的草案一次成型', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1')] })
    applyAddDrafts(
      bus,
      store.getVault(),
      'b1',
      [
        { shape: 'rect', x: 0, y: 0, text: 'A' },
        { shape: 'diamond', x: 200, y: 0, text: 'B' },
      ],
      [{ from: 0, to: 1, label: '是' }],
      { newId: seqIds('x') },
    )
    const current = store.getVault().whiteboards[0]!
    expect(current.nodes.map((item) => item.id)).toEqual(['x1', 'x2'])
    expect(current.edges[0]).toMatchObject({ from: 'x1', to: 'x2', label: '是' })
  })

  it('删框连带挂在它身上的线，undo 后线回到原下标', () => {
    const { store, bus } = mount({
      ...baseVault(),
      whiteboards: [whiteboard('b1', [node('n1'), node('n2'), node('n3')], [edge('e1', 'n1', 'n2'), edge('e2', 'n2', 'n3')])],
    })
    applyDeleteGraphic(bus, store.getVault(), 'b1', ['n2'])
    const after = store.getVault().whiteboards[0]!
    expect(after.nodes.map((item) => item.id)).toEqual(['n1', 'n3'])
    expect(after.edges).toHaveLength(0)

    bus.undo()
    const restored = store.getVault().whiteboards[0]!
    expect(restored.nodes.map((item) => item.id)).toEqual(['n1', 'n2', 'n3'])
    // 两条线按原下标升序插回，顺序与删除前一致
    expect(restored.edges.map((item) => item.id)).toEqual(['e1', 'e2'])
  })

  it('删除不存在的图元直接抛错，且 vault 原样不动', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1', [node('n1')])] })
    expect(() => bus.apply(deleteGraphicCommand(store.getVault(), 'b1', ['ghost']))).toThrow()
    expect(store.getVault().whiteboards[0]!.nodes).toHaveLength(1)
    expect(bus.undoDepth()).toBe(0)
  })
})

describe('批量 patch', () => {
  it('拖动一批节点只进一条，逆元只还原这次改过的键', () => {
    const { store, bus } = mount({
      ...baseVault(),
      whiteboards: [whiteboard('b1', [node('n1'), node('n2')])],
    })
    applyPatchNodes(bus, store.getVault(), 'b1', [
      { id: 'n1', patch: { x: 40 } },
      { id: 'n2', patch: { x: 40 } },
    ])
    expect(bus.undoDepth()).toBe(1)
    expect(store.getVault().whiteboards[0]!.nodes.map((item) => item.x)).toEqual([40, 40])

    bus.undo()
    expect(store.getVault().whiteboards[0]!.nodes.map((item) => item.x)).toEqual([0, 0])
  })

  it('空 patch 不构成变更（不进栈）', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1', [node('n1')])] })
    expect(applyPatchNodes(bus, store.getVault(), 'b1', [{ id: 'n1', patch: {} }])).toBe(false)
    expect(bus.undoDepth()).toBe(0)
  })

  it('逆元不碰这次没改的字段', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1', [node('n1', { text: '原文' })])] })
    bus.apply(patchWhiteboardNodesCommand(store.getVault(), 'b1', [{ id: 'n1', patch: { text: '新文' } }]))
    bus.undo()
    expect(store.getVault().whiteboards[0]!.nodes[0]).toMatchObject({ text: '原文', x: 0, y: 0 })
  })
})

describe('模板', () => {
  it('贴模板：相对坐标偏移到落点，连线按下标接上真 id', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1')] })
    expect(applyAddTemplate(bus, store.getVault(), 'b1', 'architecture', { x: 100, y: 50 }, {}, { newId: seqIds('t') })).toBe(true)
    const current = store.getVault().whiteboards[0]!
    expect(current.nodes.length).toBe(11)
    expect(current.edges.length).toBe(6)
    // 第一个节点是接入层 frame，落在落点上
    expect(current.nodes[0]).toMatchObject({ shape: 'frame', x: 100, y: 50 })
    // 六条线的两端都必须真实存在
    const ids = new Set(current.nodes.map((item) => item.id))
    for (const link of current.edges) {
      expect(ids.has(link.from)).toBe(true)
      expect(ids.has(link.to)).toBe(true)
    }
    expect(bus.undoDepth()).toBe(1)
  })

  it('四个模板都能落地且都有内容', () => {
    for (const templateId of ['architecture', 'flow', 'quadrant', 'radial'] as const) {
      const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1')] })
      expect(applyAddTemplate(bus, store.getVault(), 'b1', templateId, { x: 0, y: 0 }, {}, { newId: seqIds() })).toBe(true)
      expect(store.getVault().whiteboards[0]!.nodes.length).toBeGreaterThan(2)
    }
  })
})

describe('buildNode / buildEdge 默认值', () => {
  it('缺省尺寸按形状给，tone 默认 plain', () => {
    const built = buildNode({ shape: 'note', x: 1, y: 2 }, { newId: () => 'n' })
    expect(built).toMatchObject({ id: 'n', width: 180, height: 120, tone: 'plain', text: '' })
  })

  it('连线默认正交、单向箭头、实线', () => {
    const built = buildEdge({ from: 'a', to: 'b' }, { newId: () => 'e' })
    expect(built).toMatchObject({ route: 'ortho', arrow: 'end', dashed: false, fromAnchor: 'auto' })
  })
})

describe('撤销栈与重新加回来', () => {
  it('redo 把整批图元加回去（逆元的逆元）', () => {
    const { store, bus } = mount({ ...baseVault(), whiteboards: [whiteboard('b1')] })
    bus.apply(addGraphicCommand('b1', [{ node: node('n1'), index: 0 }], []))
    bus.undo()
    expect(store.getVault().whiteboards[0]!.nodes).toHaveLength(0)
    bus.redo()
    expect(store.getVault().whiteboards[0]!.nodes.map((item) => item.id)).toEqual(['n1'])
  })
})
