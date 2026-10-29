import { describe, expect, it } from 'vitest'

import {
  BOOKS_PANE_WIDTH,
  PANE_GROWTH_BANDS,
  TREE_PANE_WIDTH,
  paneGrowth,
  resolveNotebookPaneWidths,
} from '../../src/views/notebookLayout'

describe('notebookLayout · 知识库两栏宽度', () => {
  it('scale = 1 时就是设计稿基线，与 T51 的窄屏表现一致', () => {
    expect(paneGrowth(1)).toBe(1)
    expect(resolveNotebookPaneWidths(1)).toEqual({ books: BOOKS_PANE_WIDTH, tree: TREE_PANE_WIDTH })
  })

  it('0.95 档（窄屏）不做任何加宽，反而按比例收一点', () => {
    expect(resolveNotebookPaneWidths(0.95)).toEqual({ books: 167, tree: 236 })
  })

  it('1.05 档（1920）开始吃富余空间', () => {
    expect(resolveNotebookPaneWidths(1.05)).toEqual({ books: 222, tree: 312 })
  })

  it('1.3 档（27" 2K）两栏比原来宽三成——这是「27 寸上太窄」的正解', () => {
    const panes = resolveNotebookPaneWidths(1.3)
    expect(panes).toEqual({ books: 309, tree: 435 })
    // 原来的算法只有 scale 一层：176×1.3 = 229 / 248×1.3 = 322
    expect(panes.books).toBeGreaterThan(Math.round(BOOKS_PANE_WIDTH * 1.3))
    expect(panes.tree).toBeGreaterThan(Math.round(TREE_PANE_WIDTH * 1.3))
  })

  it('4K / 5K 档继续变宽，但两栏合计不超过 5K 视口的 30%', () => {
    const uhd = resolveNotebookPaneWidths(1.65)
    expect(uhd).toEqual({ books: 407, tree: 573 })
    const fiveK = resolveNotebookPaneWidths(2.2)
    expect(fiveK).toEqual({ books: 542, tree: 764 })
    expect(fiveK.books + fiveK.tree).toBeLessThan(5120 * 0.3)
  })

  it('宽度随尺度单调不减：放大字号却把栏改窄会挤出省略号', () => {
    const scales = [0.95, 1, 1.05, 1.15, 1.3, 1.65, 2.2]
    for (let i = 1; i < scales.length; i += 1) {
      const prev = resolveNotebookPaneWidths(scales[i - 1] ?? 1)
      const next = resolveNotebookPaneWidths(scales[i] ?? 1)
      expect(next.books).toBeGreaterThanOrEqual(prev.books)
      expect(next.tree).toBeGreaterThanOrEqual(prev.tree)
    }
  })

  it('结果是整数像素：1px 描边要落在设备像素上，不要 0.5px 的半透明分隔线', () => {
    for (const scale of [0.95, 1, 1.05, 1.15, 1.3, 1.65, 2.2]) {
      const panes = resolveNotebookPaneWidths(scale)
      expect(Number.isInteger(panes.books)).toBe(true)
      expect(Number.isInteger(panes.tree)).toBe(true)
    }
  })

  it('档表本身从宽到窄排列，首档为界', () => {
    const mins = PANE_GROWTH_BANDS.map((band) => band.minScale)
    expect(mins).toEqual([...mins].sort((a, b) => b - a))
    expect(PANE_GROWTH_BANDS[0]?.minScale).toBeGreaterThan(1.5)
  })
})
