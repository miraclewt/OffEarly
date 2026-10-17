// T44 · 思维导图视口控制器（pan/zoom/fit）：平移 / 离散缩放档位 / 适配内容。
//
// 骨架逐条照 controllers/ganttViewport 的 createGanttViewport：纯 TS、零 React、零 DOM，
// 指针与滚轮事件由视图层（T45/T46）翻译成值传进来，因此锚点缩放、fit 选档、无变化不
// emit 都能在 jsdom / node 里直接断言，不需要真布局。
//
// 这里**不算几何**：节点矩形、贝塞尔边、bounds 全部来自 domain/mindmapModel 的 MindMapModel。
// 控制器只管视口状态本身（pan + 缩放档 + 视口尺寸）与两者之间的投影数学。
//
// 屏幕投影口径（T45 视图按此实现 `translate(pan) scale(zoom)`）：
//   screen = content * zoom + pan
// zoomAt 锚点数学：content = (anchor - pan) / z0，换档后 pan' = anchor - content * z1，
// 锚点处的内容点在屏幕上纹丝不动。

import type { MindMapModel } from '../domain/mindmapModel'

/** 缩放档位：离散档位而不是连续倍数，保证 Ctrl+滚轮 / 工具条 / 测试三处行为一致。 */
export const MINDMAP_ZOOM_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.2, 1.5, 2, 3] as const
export type MindMapZoomStep = (typeof MINDMAP_ZOOM_STEPS)[number]

export const MINDMAP_DEFAULT_ZOOM_INDEX = 4
export const MINDMAP_MIN_ZOOM_INDEX = 0
export const MINDMAP_MAX_ZOOM_INDEX = MINDMAP_ZOOM_STEPS.length - 1

export const MINDMAP_DEFAULT_VIEWPORT_WIDTH = 960
export const MINDMAP_DEFAULT_VIEWPORT_HEIGHT = 600

/** fitToContent 默认留白（四周各 40px）。 */
export const MINDMAP_FIT_PADDING = 40

/** 视口契约消费 MindMapModel['bounds'] 形状，不另造同构类型。 */
export type MindMapViewBounds = MindMapModel['bounds']

export interface MindMapViewportState {
  /** 屏幕平移量（screen = content * zoom + pan 中的加项） */
  panX: number
  panY: number
  zoomIndex: number
  /** 可视区域宽高（视口，非内容） */
  width: number
  height: number
}

export interface MindMapViewportOptions {
  width?: number
  height?: number
}

export interface MindMapWheelInput {
  ctrlKey: boolean
  deltaX: number
  deltaY: number
}

export interface MindMapViewportController {
  subscribe(listener: () => void): () => void
  /** 返回稳定引用，可直接喂给 useSyncExternalStore。 */
  getState(): MindMapViewportState
  /** 当前缩放倍数。 */
  getZoom(): number
  getZoomIndex(): number
  zoomIn(): void
  zoomOut(): void
  setZoomIndex(index: number): void
  /** 回到默认档（zoom 100%）且 pan 归零。 */
  resetView(): void
  panBy(dx: number, dy: number): void
  setPan(x: number, y: number): void
  setViewportSize(input: { width?: number; height?: number }): void
  /** 以视口坐标 anchor 为不动点缩放 deltaSteps 档；顶格/触底时整体无变化。 */
  zoomAt(anchorX: number, anchorY: number, deltaSteps: number): void
  /** 选最大可容纳档位并把内容中心摆到视口中心。 */
  fitToContent(bounds: MindMapViewBounds, padding?: number): void
  /** Ctrl+滚轮 → 以视口中心为锚缩放一档；普通滚轮 → 平移。返回是否真的变了。 */
  applyWheel(input: MindMapWheelInput): boolean
}

export function clampMindmapZoomIndex(index: number): number {
  if (!Number.isFinite(index)) return MINDMAP_DEFAULT_ZOOM_INDEX
  return Math.min(
    MINDMAP_MAX_ZOOM_INDEX,
    Math.max(MINDMAP_MIN_ZOOM_INDEX, Math.round(index)),
  )
}

export function mindmapZoomFactorAt(index: number): number {
  return MINDMAP_ZOOM_STEPS[clampMindmapZoomIndex(index)] ?? 1
}

/**
 * 滚轮方向 → 缩放方向（与甘特 resolveZoomStep 同口径：向上滚放大）。
 * 只有按住 Ctrl（或 Cmd）才缩放，否则留给平移。
 */
export function resolveMindmapWheel(input: MindMapWheelInput): { zoom: boolean; step: number } {
  if (!input.ctrlKey) return { zoom: false, step: 0 }
  if (input.deltaY < 0) return { zoom: true, step: 1 }
  if (input.deltaY > 0) return { zoom: true, step: -1 }
  return { zoom: true, step: 0 }
}

export function createMindmapViewport(options: MindMapViewportOptions = {}): MindMapViewportController {
  let state: MindMapViewportState = {
    panX: 0,
    panY: 0,
    zoomIndex: MINDMAP_DEFAULT_ZOOM_INDEX,
    width: options.width ?? MINDMAP_DEFAULT_VIEWPORT_WIDTH,
    height: options.height ?? MINDMAP_DEFAULT_VIEWPORT_HEIGHT,
  }

  const listeners = new Set<() => void>()
  function emit(): void {
    for (const listener of [...listeners]) listener()
  }
  /** 状态对象整体替换：useSyncExternalStore 靠引用比较判变化，不能原地改。 */
  function patch(next: Partial<MindMapViewportState>): void {
    state = { ...state, ...next }
    emit()
  }
  function setPan(x: number, y: number): void {
    if (x === state.panX && y === state.panY) return
    patch({ panX: x, panY: y })
  }
  function panBy(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return
    setPan(state.panX + dx, state.panY + dy)
  }
  function setZoomIndex(index: number): void {
    const next = clampMindmapZoomIndex(index)
    if (next === state.zoomIndex) return
    patch({ zoomIndex: next })
  }
  function zoomAt(anchorX: number, anchorY: number, deltaSteps: number): void {
    const next = clampMindmapZoomIndex(state.zoomIndex + deltaSteps)
    if (next === state.zoomIndex) return
    const z0 = mindmapZoomFactorAt(state.zoomIndex)
    const z1 = mindmapZoomFactorAt(next)
    // 锚点内容坐标缩放前后不变：content = (anchor - pan) / z0，pan' = anchor - content * z1
    const contentX = (anchorX - state.panX) / z0
    const contentY = (anchorY - state.panY) / z0
    patch({
      zoomIndex: next,
      panX: anchorX - contentX * z1,
      panY: anchorY - contentY * z1,
    })
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getState: () => state,
    getZoom: () => mindmapZoomFactorAt(state.zoomIndex),
    getZoomIndex: () => state.zoomIndex,
    zoomIn() {
      setZoomIndex(state.zoomIndex + 1)
    },
    zoomOut() {
      setZoomIndex(state.zoomIndex - 1)
    },
    setZoomIndex,
    resetView() {
      const zoom = clampMindmapZoomIndex(MINDMAP_DEFAULT_ZOOM_INDEX)
      if (state.zoomIndex === zoom && state.panX === 0 && state.panY === 0) return
      patch({ zoomIndex: zoom, panX: 0, panY: 0 })
    },
    panBy,
    setPan,
    setViewportSize(input) {
      const width = input.width ?? state.width
      const height = input.height ?? state.height
      if (width === state.width && height === state.height) return
      patch({ width, height })
    },
    zoomAt,
    fitToContent(bounds, padding = MINDMAP_FIT_PADDING) {
      const contentW = Math.max(0, bounds.maxX - bounds.minX)
      const contentH = Math.max(0, bounds.maxY - bounds.minY)
      const availW = state.width - padding * 2
      const availH = state.height - padding * 2
      // 档表从大到小找第一个两维都放得下的档；全放不下 → 最小档（零尺寸内容不会除出 Infinity）。
      let next = MINDMAP_MIN_ZOOM_INDEX
      for (let i = MINDMAP_MAX_ZOOM_INDEX; i >= MINDMAP_MIN_ZOOM_INDEX; i -= 1) {
        const z = MINDMAP_ZOOM_STEPS[i]!
        if (contentW * z <= availW + 1e-9 && contentH * z <= availH + 1e-9) {
          next = i
          break
        }
      }
      const z = mindmapZoomFactorAt(next)
      const centerX = (bounds.minX + bounds.maxX) / 2
      const centerY = (bounds.minY + bounds.maxY) / 2
      const panX = state.width / 2 - centerX * z
      const panY = state.height / 2 - centerY * z
      if (next === state.zoomIndex && panX === state.panX && panY === state.panY) return
      patch({ zoomIndex: next, panX, panY })
    },
    applyWheel(input) {
      const wheel = resolveMindmapWheel(input)
      if (wheel.zoom) {
        if (wheel.step === 0) return false
        const before = state
        zoomAt(state.width * 0.5, state.height * 0.5, wheel.step)
        return state !== before
      }
      const before = state
      panBy(-input.deltaX, -input.deltaY)
      return state !== before
    },
  }
}
