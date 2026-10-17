// T39 · 甘特任务名标签的两个纯计算件（估算宽度 + 截断、进度覆盖判定）。
//
// 口径：DOM 里没有 canvas 度量可用（导出物要在 file:// 单文件里跑，且 SVG <text> 的
// 排版宽度无法在测试环境测），所以标签宽度一律按「CJK 1em / 拉丁数字标点 0.55em」估。
// 这里的断言全部用整数 em，避免浮点边界把测试变成对实现细节的描摹。

import { describe, expect, it } from 'vitest'

import {
  estimateGanttLabelWidth,
  labelOverProgress,
  truncateGanttLabel,
} from '../../src/controllers/ganttViewport'

describe('estimateGanttLabelWidth', () => {
  it('中日韩按 1em、拉丁与数字按 0.55em 估宽', () => {
    expect(estimateGanttLabelWidth('任务', 10)).toBe(20)
    expect(estimateGanttLabelWidth('ab1', 10)).toBeCloseTo(16.5, 6)
    expect(estimateGanttLabelWidth('任务ab', 10)).toBeCloseTo(31, 6)
  })

  it('空串估宽为 0', () => {
    expect(estimateGanttLabelWidth('', 12)).toBe(0)
  })
})

describe('truncateGanttLabel', () => {
  it('放得下时原样返回，不加省略号', () => {
    expect(truncateGanttLabel('任务一', 200, 12)).toBe('任务一')
  })

  it('放不下时截断并补省略号，省略号本身按 1em 计宽', () => {
    // 每字 12px，省略号 12px：4 字 + 省略号 = 60px，5 字 + 省略号 = 72px 超预算
    expect(truncateGanttLabel('任务任务任务', 60, 12)).toBe('任务任务…')
    expect(estimateGanttLabelWidth('任务任务…', 12)).toBeLessThanOrEqual(60)
  })

  it('预算连一个字都放不下时返回空串，而不是孤零零一个省略号', () => {
    expect(truncateGanttLabel('任务', 20, 12)).toBe('')
  })

  it('宽度刚好等于全文时不截断（边界取「放得下」）', () => {
    expect(truncateGanttLabel('任务', 20, 10)).toBe('任务')
  })

  it('预算连省略号都放不下时返回空串', () => {
    expect(truncateGanttLabel('任务', 10, 12)).toBe('')
    expect(truncateGanttLabel('任务', 0, 12)).toBe('')
    expect(truncateGanttLabel('任务', -5, 12)).toBe('')
  })
})

describe('labelOverProgress', () => {
  it('进度盖过标签宽的一半时用浅色字', () => {
    expect(labelOverProgress(60, 100)).toBe(true)
  })

  it('恰好一半与更少时用深色字', () => {
    expect(labelOverProgress(50, 100)).toBe(false)
    expect(labelOverProgress(10, 100)).toBe(false)
  })

  it('标签宽度为 0 时无所谓覆盖', () => {
    expect(labelOverProgress(40, 0)).toBe(false)
  })
})
