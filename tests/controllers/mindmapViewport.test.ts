// T44 · mindmapViewport：pan/zoom/fit 视口控制器，骨架逐条对照 tests/controllers 里
// ganttViewport 的用法（稳定 getState、整体 patch、无变化不 emit）。
// 屏幕投影口径（T45 视图按此实现）：screen = content * zoom + pan。

import { describe, expect, it, vi } from 'vitest'

import {
  createMindmapViewport,
  clampMindmapZoomIndex,
  mindmapZoomFactorAt,
  MINDMAP_DEFAULT_ZOOM_INDEX,
  MINDMAP_ZOOM_STEPS,
} from '../../src/controllers/mindmapViewport'

describe('mindmapZoomFactorAt / clampMindmapZoomIndex', () => {
  it('档表与默认档位按规格', () => {
    expect(MINDMAP_ZOOM_STEPS).toEqual([0.5, 0.6, 0.75, 0.9, 1, 1.2, 1.5, 2, 3])
    expect(MINDMAP_DEFAULT_ZOOM_INDEX).toBe(4)
    expect(mindmapZoomFactorAt(MINDMAP_DEFAULT_ZOOM_INDEX)).toBe(1)
  })
  it('越界与非法输入折回合法档位下标', () => {
    expect(clampMindmapZoomIndex(-3)).toBe(0)
    expect(clampMindmapZoomIndex(99)).toBe(MINDMAP_ZOOM_STEPS.length - 1)
    expect(clampMindmapZoomIndex(Number.NaN)).toBe(MINDMAP_DEFAULT_ZOOM_INDEX)
    expect(clampMindmapZoomIndex(2.4)).toBe(2)
  })
})

describe('createMindmapViewport 缩放数学', () => {
  it('zoomAt 以视口锚点缩放：锚点内容坐标不变', () => {
    const vp = createMindmapViewport({ width: 800, height: 600 }) // zoom=1, pan=(0,0)
    vp.zoomAt(400, 300, 1) // → 1.2
    // 内容点 (400,300) 缩放前屏幕=400,300；缩放后仍应 400,300
    const s = vp.getState()
    expect(mindmapZoomFactorAt(s.zoomIndex)).toBe(1.2)
    expect(400 * mindmapZoomFactorAt(s.zoomIndex) + s.panX).toBeCloseTo(400, 5)
    expect(300 * mindmapZoomFactorAt(s.zoomIndex) + s.panY).toBeCloseTo(300, 5)
    // 锚点数学的等价形态：pan' = anchor - content * z1
    expect(s.panX).toBeCloseTo(400 - 400 * 1.2, 5)
    expect(s.panY).toBeCloseTo(300 - 300 * 1.2, 5)
  })

  it('zoomAt 顶格时平移量也保持不变（无变化不 emit）', () => {
    const vp = createMindmapViewport({ width: 800, height: 600 })
    vp.setZoomIndex(MINDMAP_ZOOM_STEPS.length - 1) // zoom = 3
    const before = vp.getState()
    const listener = vi.fn()
    vp.subscribe(listener)
    vp.zoomAt(123, 456, 1)
    expect(vp.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('createMindmapViewport fitToContent', () => {
  it('fitToContent 选最大可容纳档位并居中', () => {
    const vp = createMindmapViewport({ width: 800, height: 600 })
    vp.fitToContent({ minX: 0, minY: 0, maxX: 1600, maxY: 300 })
    const s = vp.getState()
    // 1600 宽放不进 800-2*40 的任何一档 → 落最小档 0.5
    expect(mindmapZoomFactorAt(s.zoomIndex)).toBeLessThanOrEqual(800 / 1600 + 1e-9)
    expect(mindmapZoomFactorAt(s.zoomIndex)).toBe(MINDMAP_ZOOM_STEPS[0])
    // 居中：内容中心 800*zoom + panX ≈ 400
    expect(800 * mindmapZoomFactorAt(s.zoomIndex) + s.panX).toBeCloseTo(400, 5)
    // 纵向同样居中：内容中心 y=150 → 150*zoom + panY ≈ 300
    expect(150 * mindmapZoomFactorAt(s.zoomIndex) + s.panY).toBeCloseTo(300, 5)
  })

  it('fitToContent 放得下时取最大可容纳档（非最小档）', () => {
    const vp = createMindmapViewport({ width: 800, height: 600 })
    vp.fitToContent({ minX: -100, minY: 0, maxX: 100, maxY: 100 }) // 200x100
    // avail = 720x520：200*3=600 ≤ 720 且 100*3=300 ≤ 520 → 顶格 3
    expect(mindmapZoomFactorAt(vp.getState().zoomIndex)).toBe(3)
  })

  it('fitToContent 零尺寸 bounds（单节点）不产生 Infinity/NaN，pan 居中该点', () => {
    const vp = createMindmapViewport({ width: 800, height: 600 })
    vp.fitToContent({ minX: 50, minY: 70, maxX: 50, maxY: 70 })
    const s = vp.getState()
    expect(Number.isFinite(s.panX)).toBe(true)
    expect(Number.isFinite(s.panY)).toBe(true)
    expect(Number.isFinite(vp.getZoom())).toBe(true)
    // 零宽高时最大档也「放得下」→ 3，且点 (50,70) 被摆到视口中心
    expect(vp.getZoom()).toBe(3)
    expect(50 * 3 + s.panX).toBeCloseTo(400, 5)
    expect(70 * 3 + s.panY).toBeCloseTo(300, 5)
  })
})

describe('createMindmapViewport applyWheel', () => {
  it('applyWheel：Ctrl 缩放、普通滚轮平移，返回是否消费', () => {
    const vp = createMindmapViewport({ width: 800, height: 600 })

    // ctrl 分支：以视口中心 (400,300) 为锚缩放一档
    expect(vp.applyWheel({ ctrlKey: true, deltaX: 0, deltaY: -100 })).toBe(true)
    let s = vp.getState()
    expect(s.zoomIndex).toBe(MINDMAP_DEFAULT_ZOOM_INDEX + 1)
    expect(400 * mindmapZoomFactorAt(s.zoomIndex) + s.panX).toBeCloseTo(400, 5)
    expect(300 * mindmapZoomFactorAt(s.zoomIndex) + s.panY).toBeCloseTo(300, 5)

    // 普通滚轮分支：panBy(-deltaX, -deltaY)，不动缩放
    vp.resetView()
    expect(vp.applyWheel({ ctrlKey: false, deltaX: 10, deltaY: 25 })).toBe(true)
    s = vp.getState()
    expect(s.panX).toBe(-10)
    expect(s.panY).toBe(-25)
    expect(s.zoomIndex).toBe(MINDMAP_DEFAULT_ZOOM_INDEX)

    // 边界档不动：顶格后再向上滚（放大，deltaY<0）→ false 且状态引用不变
    vp.setZoomIndex(MINDMAP_ZOOM_STEPS.length - 1)
    const before = vp.getState()
    expect(vp.applyWheel({ ctrlKey: true, deltaX: 0, deltaY: -120 })).toBe(false)
    expect(vp.getState()).toBe(before)
  })

  it('applyWheel ctrl 且 deltaY=0：不消费', () => {
    const vp = createMindmapViewport({ width: 800, height: 600 })
    expect(vp.applyWheel({ ctrlKey: true, deltaX: 3, deltaY: 0 })).toBe(false)
  })
})

describe('createMindmapViewport 订阅与整体 patch', () => {
  it('无操作守卫：panBy(0,0) / 重复 setPan / 同尺寸 setViewportSize 均不 emit', () => {
    const vp = createMindmapViewport({ width: 800, height: 600 })
    const listener = vi.fn()
    const unsubscribe = vp.subscribe(listener)
    vp.panBy(0, 0)
    vp.setPan(0, 0)
    vp.setViewportSize({ width: 800, height: 600 })
    expect(listener).not.toHaveBeenCalled()
    vp.panBy(5, 0)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    vp.panBy(7, 0)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('getState 引用稳定；变更后整体替换新对象', () => {
    const vp = createMindmapViewport({ width: 800, height: 600 })
    const a = vp.getState()
    expect(vp.getState()).toBe(a)
    vp.zoomIn()
    const b = vp.getState()
    expect(b).not.toBe(a)
    expect(b.zoomIndex).toBe(MINDMAP_DEFAULT_ZOOM_INDEX + 1)
    expect(b.panX).toBe(a.panX) // zoomIn 无锚点，pan 不动
    vp.resetView()
    expect(vp.getState().zoomIndex).toBe(MINDMAP_DEFAULT_ZOOM_INDEX)
  })
})
