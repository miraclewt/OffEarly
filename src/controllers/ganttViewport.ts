// T20 · 甘特视口控制器（spec 5.4）：刻度 / 缩放 / 基线 / 滚动 / 可视窗口。
//
// 纯 TS、零 React、零 DOM —— 滚动与滚轮事件由视图层翻译成值传进来（`applyWheel` / `setScroll`），
// 因此虚拟化窗口、缩放档位、刻度状态都能在 jsdom 里直接断言，不需要真布局。
//
// 这里**不算几何**：列宽（day 32 / week 14）、条宽、箭头拐点全部来自 buildGanttModel 的 GanttModel。
// 控制器只管两件事：看的是哪一段（滚动位置 + 视口尺寸），以及 x 轴的投影倍率（zoom）。

import type { DependencyArrow, GanttColumn, GanttHeaderCell, GanttRow } from '../domain/ganttModel'
import type { GanttScale } from '../domain/types'

/** 缩放档位：离散档位而不是连续倍数，保证 Ctrl+滚轮 / +/- / 测试三处行为一致。 */
export const GANTT_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const
export type GanttZoomStep = (typeof GANTT_ZOOM_STEPS)[number]

export const GANTT_DEFAULT_ZOOM_INDEX = 2
export const GANTT_MIN_ZOOM_INDEX = 0
export const GANTT_MAX_ZOOM_INDEX = GANTT_ZOOM_STEPS.length - 1

/** 时间轴表头高度（两级刻度共用）。 */
export const GANTT_HEADER_HEIGHT = 40
/** 左侧任务表宽度：任务列 144 + 开始/结束各 74 + 进度 52。 */
export const GANTT_TABLE_WIDTH = 344
/** T39 · 任务表折叠后留下的竖轨宽度：只够放一条 11px 竖排「任务」，画布在此拿回 314px。 */
export const GANTT_TABLE_RAIL_WIDTH = 30

export const GANTT_DEFAULT_CANVAS_WIDTH = 960
export const GANTT_DEFAULT_CANVAS_HEIGHT = 480

/** 行虚拟化的上下余量（spec 5.4：只渲染视口 ±10 行）。 */
export const GANTT_OVERSCAN_ROWS = 10
/** 列虚拟化的左右余量。 */
export const GANTT_OVERSCAN_COLUMNS = 10

export interface GanttViewportState {
  scale: GanttScale
  /** 两刻度各自保留缩放档位：切刻度只换列宽，不重置对方的缩放。 */
  zoomIndex: Record<GanttScale, number>
  baselineVisible: boolean
  scrollTop: number
  scrollLeft: number
  /** 画布可视宽度 / 高度（不含左侧任务表） */
  width: number
  height: number
}

export interface GanttRowWindow {
  /** 含 */
  startRow: number
  /** 不含 */
  endRow: number
}

export interface GanttColumnWindow {
  startCol: number
  endCol: number
  /** 投影后的可视横向边界（含 overscan 余量），供表头裁剪与箭头裁剪复用 */
  left: number
  right: number
}

export interface GanttViewportOptions {
  scale?: GanttScale
  width?: number
  height?: number
}

export interface GanttViewportController {
  subscribe(listener: () => void): () => void
  /** 返回稳定引用，可直接喂给 useSyncExternalStore。 */
  getState(): GanttViewportState
  getScale(): GanttScale
  /** 当前刻度的缩放倍数。 */
  getZoom(): number
  getZoomIndex(): number
  setScale(scale: GanttScale): void
  zoomIn(): void
  zoomOut(): void
  setZoomIndex(index: number): void
  /** 当前刻度回到 100%。 */
  resetZoom(): void
  toggleBaseline(): void
  setBaselineVisible(value: boolean): void
  setScroll(input: { scrollTop?: number; scrollLeft?: number }): void
  setViewportSize(input: { width?: number; height?: number }): void
  /** Ctrl+滚轮 → 缩放档位；返回是否真的变了。 */
  applyWheel(input: { ctrlKey: boolean; deltaY: number }): boolean
}

export function clampZoomIndex(index: number): number {
  if (!Number.isFinite(index)) return GANTT_DEFAULT_ZOOM_INDEX
  return Math.min(GANTT_MAX_ZOOM_INDEX, Math.max(GANTT_MIN_ZOOM_INDEX, Math.round(index)))
}

export function zoomFactorAt(index: number): number {
  return GANTT_ZOOM_STEPS[clampZoomIndex(index)] ?? 1
}

/**
 * 滚轮方向 → 缩放方向。只有按住 Ctrl（或 Cmd）才缩放——普通滚轮留给页面滚动，
 * 否则在甘特图上上下滚动会意外缩放。
 */
export function resolveZoomStep(input: { ctrlKey: boolean; deltaY: number }): number {
  if (!input.ctrlKey) return 0
  if (input.deltaY < 0) return 1
  if (input.deltaY > 0) return -1
  return 0
}

/**
 * 行虚拟化窗口：视口可见行 ± overscan。
 * `offsetY` 是滚动内容顶部被表头 / 里程碑轨道占掉的高度，换算时要先扣掉。
 */
export function computeRowWindow(input: {
  rowCount: number
  scrollTop: number
  height: number
  rowHeight: number
  overscan?: number
  offsetY?: number
}): GanttRowWindow {
  const { rowCount, scrollTop, height, rowHeight } = input
  const overscan = input.overscan ?? GANTT_OVERSCAN_ROWS
  const offsetY = input.offsetY ?? 0
  if (rowCount <= 0 || rowHeight <= 0) return { startRow: 0, endRow: 0 }

  const firstVisible = Math.floor(Math.max(0, scrollTop - offsetY) / rowHeight)
  const visibleCount = Math.ceil(height / rowHeight) + 1
  const startRow = Math.max(0, firstVisible - overscan)
  const endRow = Math.min(rowCount, firstVisible + visibleCount + overscan)
  return { startRow, endRow: Math.max(startRow, endRow) }
}

/** 列虚拟化窗口：只保留投影后与视口（含 ±overscan 列）相交的列。 */
export function computeColumnWindow(input: {
  columns: readonly GanttColumn[]
  zoom: number
  scrollLeft: number
  width: number
  overscan?: number
}): GanttColumnWindow {
  const { columns, zoom, scrollLeft, width } = input
  const overscan = input.overscan ?? GANTT_OVERSCAN_COLUMNS
  const padPx = overscan * (columns[0]?.width ?? 0) * zoom
  const left = scrollLeft - padPx
  const right = scrollLeft + width + padPx

  let startCol = columns.length
  let endCol = 0
  for (let i = 0; i < columns.length; i += 1) {
    const column = columns[i]!
    const x0 = column.x * zoom
    const x1 = (column.x + column.width) * zoom
    if (x1 < left) continue
    if (x0 > right) break
    if (i < startCol) startCol = i
    endCol = i + 1
  }

  if (endCol <= startCol) return { startCol: 0, endCol: Math.min(columns.length, 1), left, right }
  return { startCol, endCol, left, right }
}

/** 两级表头同样只渲染可视列，否则一年的日刻度会铺出几千个节点。 */
export function clipHeaderCells(
  cells: readonly GanttHeaderCell[],
  bounds: { left: number; right: number },
  zoom: number,
): GanttHeaderCell[] {
  return cells.filter((cell) => {
    const x0 = cell.x * zoom
    const x1 = (cell.x + cell.width) * zoom
    return x1 >= bounds.left && x0 <= bounds.right
  })
}

/**
 * 箭头裁剪：只保留与可视行列范围相交的箭头。
 * 1000 条依赖在无裁剪时会一次铺出上千条 path，所以这层裁剪是虚拟化的一部分。
 * `bounds` 的 y 用行坐标（不随 zoom 变），x 用投影后的像素。
 */
export function clipArrows(
  arrows: readonly DependencyArrow[],
  bounds: { left: number; right: number; top: number; bottom: number },
  zoom: number,
): DependencyArrow[] {
  return arrows.filter((arrow) => {
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const point of arrow.points) {
      const x = point.x * zoom
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (point.y < minY) minY = point.y
      if (point.y > maxY) maxY = point.y
    }
    return maxX >= bounds.left && minX <= bounds.right && maxY >= bounds.top && minY <= bounds.bottom
  })
}

/**
 * 跨 topic 里程碑（topicId 为 null）在领域模型里是普通行，渲染层要把它们提到顶部独立轨道（spec 5.4）。
 * body 保持原有相对顺序；每行的显示 y 由视图按下标重新投影，因此这里只做分组、不改几何。
 */
export function splitMilestoneLane(rows: readonly GanttRow[]): { lane: GanttRow[]; body: GanttRow[] } {
  const lane: GanttRow[] = []
  const body: GanttRow[] = []
  for (const row of rows) {
    if (row.kind === 'milestone' && row.topicId === null) lane.push(row)
    else body.push(row)
  }
  return { lane, body }
}

/**
 * T39 · 任务名标签的宽度估算。
 *
 * 度量走「估」而不是 `getComputedTextLength()`：甘特要在 1000 行规模下每帧投影，
 * 而且 `GanttExporter` 是脱离 DOM 用 `createElementNS` 重画一遍 SVG 的，那里根本没有可
 * 度量的挂载点。CJK / 假名 / 谚文 / 全角按 1em，拉丁数字标点按 0.55em，误差在截断
 * 口径内可接受（截断偏保守，宁可早点加省略号，也不让字溢出条外）。
 */
const LABEL_LATIN_RATIO = 0.55
const LABEL_ELLIPSIS = '…'

function isWideLabelChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  // 省略号在 CJK 混排里按整宽排，截断预算必须按 1em 留位
  if (code === 0x2026) return true
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x20000
  )
}

export function estimateGanttLabelWidth(text: string, fontSize: number): number {
  let units = 0
  for (const ch of text) units += isWideLabelChar(ch) ? 1 : LABEL_LATIN_RATIO
  return units * fontSize
}

/** 超出预算则截断补 `…`；一个词都放不下时返回空串（宁可不画标签，也不留孤立省略号）。 */
export function truncateGanttLabel(text: string, maxWidthPx: number, fontSize: number): string {
  if (estimateGanttLabelWidth(text, fontSize) <= maxWidthPx) return text
  const budget = maxWidthPx - fontSize
  let used = 0
  let out = ''
  for (const ch of text) {
    const width = isWideLabelChar(ch) ? fontSize : fontSize * LABEL_LATIN_RATIO
    if (used + width > budget + 1e-9) break
    used += width
    out += ch
  }
  return out === '' ? '' : `${out}${LABEL_ELLIPSIS}`
}

/** 深色进度条盖掉标签一半以上时，标签要用浅色字才读得清。 */
export function labelOverProgress(progressPx: number, labelPx: number): boolean {
  if (labelPx <= 0) return false
  return progressPx > labelPx / 2
}

export function createGanttViewport(options: GanttViewportOptions = {}): GanttViewportController {
  const scale: GanttScale = options.scale ?? 'day'
  let state: GanttViewportState = {
    scale,
    zoomIndex: { day: GANTT_DEFAULT_ZOOM_INDEX, week: GANTT_DEFAULT_ZOOM_INDEX },
    baselineVisible: false,
    scrollTop: 0,
    scrollLeft: 0,
    width: options.width ?? GANTT_DEFAULT_CANVAS_WIDTH,
    height: options.height ?? GANTT_DEFAULT_CANVAS_HEIGHT,
  }

  const listeners = new Set<() => void>()
  function emit(): void {
    for (const listener of [...listeners]) listener()
  }
  /** 状态对象整体替换：useSyncExternalStore 靠引用比较判变化，不能原地改。 */
  function patch(next: Partial<GanttViewportState>): void {
    state = { ...state, ...next }
    emit()
  }
  function patchZoom(delta: number): void {
    const current = state.zoomIndex[state.scale]
    const next = clampZoomIndex(current + delta)
    if (next === current) return
    patch({ zoomIndex: { ...state.zoomIndex, [state.scale]: next } })
  }
  function setZoomIndex(index: number): void {
    const next = clampZoomIndex(index)
    if (next === state.zoomIndex[state.scale]) return
    patch({ zoomIndex: { ...state.zoomIndex, [state.scale]: next } })
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getState: () => state,
    getScale: () => state.scale,
    getZoom: () => zoomFactorAt(state.zoomIndex[state.scale]),
    getZoomIndex: () => state.zoomIndex[state.scale],
    setScale(next) {
      if (next === state.scale) return
      patch({ scale: next })
    },
    zoomIn() {
      patchZoom(1)
    },
    zoomOut() {
      patchZoom(-1)
    },
    setZoomIndex,
    resetZoom() {
      setZoomIndex(GANTT_DEFAULT_ZOOM_INDEX)
    },
    toggleBaseline() {
      patch({ baselineVisible: !state.baselineVisible })
    },
    setBaselineVisible(value) {
      if (value === state.baselineVisible) return
      patch({ baselineVisible: value })
    },
    setScroll(input) {
      const scrollTop = input.scrollTop ?? state.scrollTop
      const scrollLeft = input.scrollLeft ?? state.scrollLeft
      if (scrollTop === state.scrollTop && scrollLeft === state.scrollLeft) return
      patch({ scrollTop, scrollLeft })
    },
    setViewportSize(input) {
      const width = input.width ?? state.width
      const height = input.height ?? state.height
      if (width === state.width && height === state.height) return
      patch({ width, height })
    },
    applyWheel(input) {
      const step = resolveZoomStep(input)
      if (step === 0) return false
      const before = state.zoomIndex[state.scale]
      patchZoom(step)
      return state.zoomIndex[state.scale] !== before
    },
  }
}
