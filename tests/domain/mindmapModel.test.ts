import { describe, expect, it } from 'vitest'

import {
  buildMindMapModel,
  MINDMAP_FONT_SIZE,
  MINDMAP_H_GAP,
  MINDMAP_MAX_TEXT_WIDTH,
  MINDMAP_MIN_NODE_WIDTH,
  MINDMAP_NODE_HEIGHT,
  MINDMAP_V_GAP,
} from '../../src/domain/mindmapModel'
import type { MindMapModel, MindMapNodeView } from '../../src/domain/mindmapModel'
import type { MindMap, MindNode } from '../../src/domain/types'

const node = (id: string, text: string, children: MindNode[] = [], folded = false): MindNode =>
  ({ id, text, order: 'V', folded, children })

const map = (root: MindNode): MindMap => ({
  id: 'm1',
  name: 'M',
  root,
  order: 'V',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

// noUncheckedIndexedAccess 下数组解构会带 undefined，用显式取点保持断言原样
const pick = (model: MindMapModel, id: string): MindMapNodeView =>
  model.nodes.find((n) => n.id === id)!

describe('buildMindMapModel：xmind 逻辑图·向右布局（纯函数）', () => {
  it('常量：与 spec 锁定值逐一对齐', () => {
    expect([
      MINDMAP_NODE_HEIGHT,
      MINDMAP_H_GAP,
      MINDMAP_V_GAP,
      MINDMAP_MIN_NODE_WIDTH,
      MINDMAP_MAX_TEXT_WIDTH,
      MINDMAP_FONT_SIZE,
    ]).toEqual([32, 48, 14, 56, 320, 13])
  })

  it('根居左垂直居中于子树，子节点自上而下堆叠', () => {
    const m = buildMindMapModel(map(node('r', '中心', [node('a', '甲'), node('b', '乙')])))
    const [r, a, b] = [pick(m, 'r'), pick(m, 'a'), pick(m, 'b')]
    expect(r.x).toBe(0)
    expect(a.x).toBe(r.x + r.width + MINDMAP_H_GAP)
    expect(b.y - a.y).toBe(MINDMAP_NODE_HEIGHT + MINDMAP_V_GAP)
    expect(r.y + r.height / 2).toBeCloseTo((a.y + b.y + MINDMAP_NODE_HEIGHT) / 2, 5)
  })

  it('折叠节点按叶子布局并带 hiddenCount；子树与入边不进模型', () => {
    const m = buildMindMapModel(map(node('r', 'R', [node('a', 'A', [node('a1', 'A1')], true)])))
    expect(m.nodes.map((n) => n.id)).toEqual(['r', 'a'])
    expect(m.edges).toHaveLength(1)
    expect(m.nodes.find((n) => n.id === 'a')!.hiddenCount).toBe(1)
  })

  it('单子链逐级右推；bounds 覆盖全部可见节点', () => {
    const m = buildMindMapModel(map(node('r', 'R', [node('a', 'A', [node('b', 'B')])])))
    const b = m.nodes.find((n) => n.id === 'b')!
    expect(m.bounds.maxX).toBeCloseTo(b.x + b.width, 5)
    // 单子链只有一行高：bounds 上下即一行，左即根 x
    expect(m.bounds).toEqual({ minX: 0, minY: 0, maxX: b.x + b.width, maxY: MINDMAP_NODE_HEIGHT })
  })

  it('边是父右缘中点到子左缘中点的三次贝塞尔', () => {
    const m = buildMindMapModel(map(node('r', 'R', [node('a', '甲甲')])))
    const [r, a] = [m.nodes[0]!, m.nodes[1]!]
    expect(m.edges[0]!.path).toBe(
      `M ${r.x + r.width} ${r.y + r.height / 2} C ${(r.x + r.width + a.x) / 2} ${r.y + r.height / 2}, ${(r.x + r.width + a.x) / 2} ${a.y + a.height / 2}, ${a.x} ${a.y + a.height / 2}`,
    )
  })

  it('节点宽 = clamp(截断文本估算宽 + 24, MIN, MAX)；text 即截断后的文本', () => {
    const short = buildMindMapModel(map(node('r', 'AB'))).nodes[0]!
    expect(short.text).toBe('AB')
    expect(short.width).toBe(MINDMAP_MIN_NODE_WIDTH) // 2×0.55×13 + 24 = 38.3 → 抬到 56

    const longText = '标'.repeat(60) // 60×13 = 780 > 320 - 24
    const long = buildMindMapModel(map(node('r', longText))).nodes[0]!
    expect(long.text).toBe(`${'标'.repeat(21)}…`) // 预算 283 只放得下 21 字，补省略号
    expect(long.width).toBe(310) // (21 + 1)×13 + 24
    expect(long.width).toBeLessThanOrEqual(MINDMAP_MAX_TEXT_WIDTH)
  })

  it('opts.foldAll：有子节点一律按折叠渲染（含根），数据原样不动', () => {
    const source = map(node('r', 'R', [node('a', 'A', [node('a1', 'A1')]), node('b', 'B')]))
    const folded = buildMindMapModel(source, { foldAll: true })
    // 根也被 foldAll 命中 → 整图收成中心主题，hiddenCount 计全部后代
    expect(folded.nodes.map((n) => n.id)).toEqual(['r'])
    expect(folded.edges).toHaveLength(0)
    expect(folded.nodes[0]!.folded).toBe(true)
    expect(folded.nodes[0]!.hiddenCount).toBe(3)
    expect(folded.bounds).toEqual({
      minX: folded.nodes[0]!.x,
      minY: folded.nodes[0]!.y,
      maxX: folded.nodes[0]!.x + folded.nodes[0]!.width,
      maxY: folded.nodes[0]!.y + MINDMAP_NODE_HEIGHT,
    })
    // 数据未改动：子树仍在；不带 opts 时按 node.folded 布局
    expect(source.root.children[0]!.children).toHaveLength(1)
    expect(buildMindMapModel(source).nodes.map((n) => n.id)).toEqual(['r', 'a', 'a1', 'b'])
    expect(buildMindMapModel(source, { foldAll: false }).nodes.map((n) => n.id)).toEqual([
      'r',
      'a',
      'a1',
      'b',
    ])
  })

  it('兄弟顺序 = children 数组顺序（不按 order 排序）；前序产出、colorTier = depth % 4', () => {
    const deep = node('z', 'Z', [
      node('y', 'Y', [node('x', 'X', [node('w', 'W', [node('v', 'V')])])]),
    ])
    const structure = map(node('r', 'R', [node('b', 'B'), node('a', 'A', [deep])]))
    const m = buildMindMapModel(structure)
    expect(m.nodes.map((n) => n.id)).toEqual(['r', 'b', 'a', 'z', 'y', 'x', 'w', 'v'])
    expect(m.nodes.map((n) => n.colorTier)).toEqual([0, 1, 1, 2, 3, 0, 1, 2])
    expect(m.nodes.map((n) => n.parentId)).toEqual([null, 'r', 'r', 'a', 'z', 'y', 'x', 'w'])
    // bounds 取可见节点矩形的 min/max（不含贝塞尔控制点）：单字宽节点恒为 MIN，逐层右推 104
    const v = pick(m, 'v')
    expect(v.x).toBe(624)
    expect(v.depth).toBe(6)
    expect(m.bounds).toEqual({ minX: 0, minY: 0, maxX: 680, maxY: 78 })
    // 纯函数：同一份数据两次布局逐字段相同（导出器 / 视图复算依赖这点）
    expect(buildMindMapModel(structure)).toEqual(m)
  })
})

describe('T40 · 界面尺度：布局等比放大', () => {
  it('行高 / 节点宽 / 父子间距与兄弟间距一起放大', () => {
    const m = map(node('r', '根', [node('c1', '子一'), node('c2', '子二')]))
    const base = buildMindMapModel(m)
    const big = buildMindMapModel(m, { uiScale: 2 })

    expect(pick(big, 'r').height).toBe(pick(base, 'r').height * 2)
    expect(pick(big, 'r').width).toBe(pick(base, 'r').width * 2)
    // 子节点 x = 父宽 + H_GAP，y 由行高与 V_GAP 递推 —— 两者都该翻倍
    expect(pick(big, 'c1').x).toBe(pick(base, 'c1').x * 2)
    expect(pick(big, 'c2').y).toBe(pick(base, 'c2').y * 2)
  })

  it('非法尺度回落到 1（视图/导出在不调 installUiScale 时保持设计稿）', () => {
    const m = map(node('r', '根'))
    expect(buildMindMapModel(m, { uiScale: 0 }).nodes[0]!.height).toBe(MINDMAP_NODE_HEIGHT)
  })
})
