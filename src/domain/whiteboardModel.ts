// T69 · WhiteboardModel：白板的纯几何层（锚点、走线、箭头、边界、文本分行）。
//
// 与 mindmapModel 的分工差别：导图的**位置是算出来的**（布局两趟），白板的**位置是用户摆的**——
// 所以这里不做布局，只做「两个矩形之间那条线怎么画」。视图（WhiteboardCanvas）与导出器
// （WhiteboardExporter）读同一份几何，因此屏幕上的线与导出的线**逐点一致**，不存在两套走线口径。
//
// 零 React / 零 DOM / 零 I/O：这里只用算术，jsdom 与 node 里都能直接断言。
//
// 三条口径：
//   ① 锚点永远取**包围盒边中点**。菱形四顶点就是包围盒四边中点、椭圆的四边中点也在曲线上，
//      所以这一个规则同时贴合 rect / round / ellipse / diamond——不需要按形状分支。
//   ② `auto` 由两端中心的相对方位决定，横向差 ≥ 纵向差就走左右，否则走上下。宽扁的架构图
//      因此自然走横线，竖排的流程图自然走竖线。
//   ③ 正交走线用「出线短段 + 直角折线 + 圆角」，短段沿锚点法线方向 —— 线一定垂直离开矩形边，
//      不会贴着框边擦过去（Miro/draw.io 的手感都来自这一句）。

import type { WhiteboardAnchor, WhiteboardEdge, WhiteboardNode, WhiteboardShape } from './types'

/** 节点标签字号：视图、导出、分行估算三处共用同一个数字，宽度才复算得回来。 */
export const WHITEBOARD_FONT_SIZE = 13
/** 便签字号略大（便签本来就要一眼读到）。 */
export const WHITEBOARD_NOTE_FONT_SIZE = 14
/** 框内边距：文本换行宽度 = 节点宽 - 两侧。 */
export const WHITEBOARD_NODE_PADDING = 12
/** 正交走线的出线短段长度。 */
export const WHITEBOARD_STUB = 18
/** 折角圆角半径。 */
export const WHITEBOARD_CORNER_RADIUS = 8
/** 箭头尺寸（长与半宽）。 */
export const WHITEBOARD_ARROW_LENGTH = 10
export const WHITEBOARD_ARROW_HALF_WIDTH = 5
/** 吸附网格与最小尺寸：拖动按网格落位，缩到比这更小就没法点中了。 */
export const WHITEBOARD_GRID = 8
export const WHITEBOARD_MIN_WIDTH = 48
export const WHITEBOARD_MIN_HEIGHT = 32
/** 双击新建 / 拖拽画出的默认尺寸，按形状给。 */
export const WHITEBOARD_DEFAULT_SIZE: Record<WhiteboardShape, { width: number; height: number }> = {
  rect: { width: 168, height: 56 },
  round: { width: 168, height: 56 },
  ellipse: { width: 152, height: 72 },
  diamond: { width: 168, height: 96 },
  note: { width: 180, height: 120 },
  text: { width: 168, height: 32 },
  frame: { width: 360, height: 240 },
}

export interface WhiteboardPoint {
  x: number
  y: number
}
// ---------------------------------------------------------------------------
// 自定义色（T70）
//
// 语义色（tone）给的是「这一格是干什么的」，自定义色给的是「我就要这个颜色」。
// 两者在数据上并存：`tone` 永远有值（模板与新建都用它），`fill` 是可选的覆盖。
// 覆盖一旦存在，屏幕上与导出里都**只认 fill**——否则会出现「屏幕上是自定义色、
// 导出里是语义色」的两套口径。
//
// 三条口径：
//   ① 字色由底色**算**出来，不另存字段。存了就会出现「底改了、字没改」的脏组合，
//      而这类组合用户没法自己发现（白底白字）。
//   ② 描边由底色**推**出来（浅底压深、深底提亮）。用户只挑一个颜色，不是三个。
//   ③ 自定义色一律**字面量 hex**，不走主题令牌：用户挑的是颜色本身，深浅主题下
//      都该是那个颜色（语义色才需要跟着主题走）。
// ---------------------------------------------------------------------------

/**
 * 自定义色板：浅底六格（便签/分组常用）+ 中间调五格 + 黑白两格，两行摆开。
 * 一律小写——存进 vault 的就是这些字面量，大写会让「当前选中的是不是这一格」比较不上。
 */
export const WHITEBOARD_SWATCHES: readonly string[] = [
  '#fdecec',
  '#fef3c7',
  '#e3f7e8',
  '#dceefe',
  '#ede9fe',
  '#fce7f3',
  '#f1f5f9',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#8b5cf6',
  '#ef4444',
  '#1d1d1f',
  '#ffffff',
]

/** 深底用纯白（半透明白会让小字发灰），浅底用与 `--oe-text` 同族的近黑。 */
const INK_DARK = '#1D1D1F'
const INK_LIGHT = '#FFFFFF'

/**
 * 收一个用户输入的颜色：接受 `#aabbcc` / `aabbcc` / `#abc` / `abc`（大小写不论），
 * 一律归成小写 `#aabbcc`。收不了就返回 null——**不猜、不兜底**，由调用方决定提示。
 */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`
  return null
}

function channels(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHex(hex) ?? '#000000'
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  }
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** 0..1，WCAG 相对亮度（sRGB 先线性化，再加权）。判断「浅底 / 深底」只用它。 */
export function hexLuminance(hex: string): number {
  const { r, g, b } = channels(hex)
  const linear = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** 底色上放什么字：浅底给近黑，深底给纯白。 */
export function readableInk(hex: string): string {
  return hexLuminance(hex) > 0.42 ? INK_DARK : INK_LIGHT
}

/** 把一个颜色往黑（amount < 0）或往白（amount > 0）推，amount ∈ [-1, 1]。 */
export function shadeHex(hex: string, amount: number): string {
  const { r, g, b } = channels(hex)
  const target = amount < 0 ? 0 : 255
  const t = Math.min(1, Math.abs(amount))
  const to = (value: number): string => clampChannel(value + (target - value) * t).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** 两色按比例混（t = 0 取 a，t = 1 取 b）。分组框的淡底就是「底色混进背景色」。 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = channels(a)
  const cb = channels(b)
  const ratio = Math.max(0, Math.min(1, t))
  const to = (from: number, target: number): string =>
    clampChannel(from + (target - from) * ratio)
      .toString(16)
      .padStart(2, '0')
  return `#${to(ca.r, cb.r)}${to(ca.g, cb.g)}${to(ca.b, cb.b)}`
}

/** 画到 CSS 用的 `rgba()`；alpha = 1 时仍给 hex，读起来短一点。 */
export function hexToCss(hex: string, alpha: number): string {
  const normalized = normalizeHex(hex) ?? '#000000'
  if (alpha >= 1) return normalized
  const { r, g, b } = channels(normalized)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

/** 一个图元最终怎么上色（屏幕与导出共用，杜绝「两套口径」）。 */
export interface WhiteboardNodePaint {
  fill: string
  fillOpacity: number
  stroke: string
  strokeOpacity: number
  /** 字色 */
  ink: string
  /** 描边是否虚线（分组框） */
  dashed: boolean
}

/**
 * 自定义色的投影。没有 `fill` 时返回 null —— 调用方回落到语义色（屏幕上还要吃主题令牌，
 * 所以不能在这里把语义色也实体化）。
 */
export function resolveNodePaint(
  node: Pick<WhiteboardNode, 'shape' | 'fill'>,
): WhiteboardNodePaint | null {
  const fill = node.fill
  if (fill === undefined) return null
  if (node.shape === 'text') {
    // 文本图元没有底，「自定义色」就是字色本身——不做亮度换算，用户挑什么就是什么
    return { fill: 'none', fillOpacity: 1, stroke: 'none', strokeOpacity: 1, ink: fill, dashed: false }
  }
  if (node.shape === 'frame') {
    // 分组框面积大，实底会把里面的东西全糊掉：底色按低不透明度铺，字色按混出来的底算
    return {
      fill,
      fillOpacity: 0.14,
      stroke: fill,
      strokeOpacity: 0.7,
      ink: readableInk(mixHex(fill, '#FFFFFF', 0.86)),
      dashed: true,
    }
  }
  return {
    fill,
    fillOpacity: 1,
    stroke: shadeHex(fill, hexLuminance(fill) > 0.42 ? -0.22 : 0.24),
    strokeOpacity: 1,
    ink: readableInk(fill),
    dashed: false,
  }
}

export interface WhiteboardRect {

  x: number
  y: number
  width: number
  height: number
}

export interface WhiteboardBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** 一条边投影后的全部绘制信息（视图与导出器都只读这个）。 */
export interface WhiteboardEdgeView {
  id: string
  fromId: string
  toId: string
  /** 折线 path（含圆角），直线走 `M … L …` */
  path: string
  /** 末端箭头三角的点串（`x,y x,y x,y`）；arrow 不含末端时为 null */
  endArrow: string | null
  /** 起点箭头三角（仅 arrow='both'） */
  startArrow: string | null
  /** 标签落点（路径中点）；label 为空时视图不画，但坐标恒给 */
  labelX: number
  labelY: number
}

export function rectCenter(rect: WhiteboardRect): WhiteboardPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/** 锚点边中点。`auto` 按对方中心方位选边（口径 ②）。 */
export function resolveAnchor(rect: WhiteboardRect, anchor: WhiteboardAnchor, other: WhiteboardRect): 'top' | 'right' | 'bottom' | 'left' {
  if (anchor !== 'auto') return anchor
  const a = rectCenter(rect)
  const b = rectCenter(other)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/** 边中点坐标。 */
export function anchorPoint(rect: WhiteboardRect, side: 'top' | 'right' | 'bottom' | 'left'): WhiteboardPoint {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.width / 2, y: rect.y }
    case 'bottom':
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height }
    case 'left':
      return { x: rect.x, y: rect.y + rect.height / 2 }
    case 'right':
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 }
  }
}

/** 锚点的外法线（正交走线的出线方向）。 */
function normalOf(side: 'top' | 'right' | 'bottom' | 'left'): WhiteboardPoint {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 折线 → 带圆角的 path（每个中间拐点切掉 r，再用二次贝塞尔补角）。 */
function roundedPolyline(points: readonly WhiteboardPoint[], radius: number): string {
  const pts = points.filter(
    (point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y,
  )
  if (pts.length < 2) return ''
  const first = pts[0]!
  let d = `M ${round1(first.x)} ${round1(first.y)}`
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1]!
    const current = pts[i]!
    const next = pts[i + 1]!
    const inLen = Math.hypot(current.x - prev.x, current.y - prev.y)
    const outLen = Math.hypot(next.x - current.x, next.y - current.y)
    const r = Math.min(radius, inLen / 2, outLen / 2)
    if (r < 0.5) {
      d += ` L ${round1(current.x)} ${round1(current.y)}`
      continue
    }
    const inUnit = { x: (current.x - prev.x) / inLen, y: (current.y - prev.y) / inLen }
    const outUnit = { x: (next.x - current.x) / outLen, y: (next.y - current.y) / outLen }
    const entry = { x: current.x - inUnit.x * r, y: current.y - inUnit.y * r }
    const exit = { x: current.x + outUnit.x * r, y: current.y + outUnit.y * r }
    d += ` L ${round1(entry.x)} ${round1(entry.y)} Q ${round1(current.x)} ${round1(current.y)} ${round1(exit.x)} ${round1(exit.y)}`
  }
  const last = pts[pts.length - 1]!
  return `${d} L ${round1(last.x)} ${round1(last.y)}`
}

/**
 * 正交折线：出线短段 → 直角折线 → 入线短段（口径 ③）。
 * 两段短段的方向冲突时（例如目标在起点的反方向），中段取**外侧**中点，
 * 让折线绕出去而不是从框上折回来。
 */
function orthoPoints(p1: WhiteboardPoint, n1: WhiteboardPoint, p2: WhiteboardPoint, n2: WhiteboardPoint): WhiteboardPoint[] {
  const a = { x: p1.x + n1.x * WHITEBOARD_STUB, y: p1.y + n1.y * WHITEBOARD_STUB }
  const b = { x: p2.x + n2.x * WHITEBOARD_STUB, y: p2.y + n2.y * WHITEBOARD_STUB }
  const horizontal1 = n1.x !== 0
  const horizontal2 = n2.x !== 0
  const points: WhiteboardPoint[] = [p1, a]
  if (horizontal1 && horizontal2) {
    if (a.x < b.x) {
      const midX = (a.x + b.x) / 2
      points.push({ x: midX, y: a.y }, { x: midX, y: b.y })
    } else {
      // 反向：起点必须往目标的外侧绕。两框同高时中段长度为 0，直接折会叠成一条线
      // （看起来像「线断了」），所以补一段绕行通道，走成 U 形。
      const midX = Math.max(a.x, b.x) + WHITEBOARD_STUB
      if (Math.abs(a.y - b.y) < 1) {
        const lane = a.y + WHITEBOARD_STUB * 2
        points.push({ x: midX, y: a.y }, { x: midX, y: lane }, { x: b.x, y: lane })
      } else {
        points.push({ x: midX, y: a.y }, { x: midX, y: b.y })
      }
    }
  } else if (!horizontal1 && !horizontal2) {
    if (a.y < b.y) {
      const midY = (a.y + b.y) / 2
      points.push({ x: a.x, y: midY }, { x: b.x, y: midY })
    } else {
      const midY = Math.max(a.y, b.y) + WHITEBOARD_STUB
      if (Math.abs(a.x - b.x) < 1) {
        const lane = a.x + WHITEBOARD_STUB * 2
        points.push({ x: a.x, y: midY }, { x: lane, y: midY }, { x: lane, y: b.y })
      } else {
        points.push({ x: a.x, y: midY }, { x: b.x, y: midY })
      }
    }
  } else if (horizontal1) {
    points.push({ x: b.x, y: a.y })
  } else {
    points.push({ x: a.x, y: b.y })
  }
  points.push(b, p2)
  return points
}

/** 箭头三角：tip 为尖端，angle 为**指向尖端**的方向（弧度）。 */
export function arrowPoints(tip: WhiteboardPoint, angle: number, length = WHITEBOARD_ARROW_LENGTH, half = WHITEBOARD_ARROW_HALF_WIDTH): string {
  const back = { x: tip.x - Math.cos(angle) * length, y: tip.y - Math.sin(angle) * length }
  const nx = Math.sin(angle)
  const ny = -Math.cos(angle)
  const left = { x: back.x + nx * half, y: back.y + ny * half }
  const right = { x: back.x - nx * half, y: back.y - ny * half }
  return `${round1(tip.x)},${round1(tip.y)} ${round1(left.x)},${round1(left.y)} ${round1(right.x)},${round1(right.y)}`
}

/**
 * 把一条边投影成可绘制形态。两端节点缺失时返回 null——视图跳过（数据里残留的悬空边
 * 不会画出来，但也不会被悄悄删掉：删不删是数据层的决定，几何层只回答「画不了」）。
 */
export function buildEdgeView(
  edge: WhiteboardEdge,
  from: WhiteboardRect,
  to: WhiteboardRect,
): WhiteboardEdgeView {
  const fromSide = resolveAnchor(from, edge.fromAnchor, to)
  const toSide = resolveAnchor(to, edge.toAnchor, from)
  const p1 = anchorPoint(from, fromSide)
  const p2 = anchorPoint(to, toSide)
  const n1 = normalOf(fromSide)
  const n2 = normalOf(toSide)

  let path: string
  let endAngle = 0
  let startAngle = 0
  let labelX = (p1.x + p2.x) / 2
  let labelY = (p1.y + p2.y) / 2
  if (edge.route === 'straight') {
    path = `M ${round1(p1.x)} ${round1(p1.y)} L ${round1(p2.x)} ${round1(p2.y)}`
    // 指向尖端的方向 = 从起点指向终点
    endAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
    startAngle = Math.atan2(p1.y - p2.y, p1.x - p2.x)
  } else {
    const points = orthoPoints(p1, n1, p2, n2)
    path = roundedPolyline(points, WHITEBOARD_CORNER_RADIUS)
    // 末段方向 = 入线短段的反向（从 b 指向 p2）
    endAngle = Math.atan2(p2.y - (p2.y + n2.y * WHITEBOARD_STUB), p2.x - (p2.x + n2.x * WHITEBOARD_STUB))
    startAngle = Math.atan2(p1.y - (p1.y + n1.y * WHITEBOARD_STUB), p1.x - (p1.x + n1.x * WHITEBOARD_STUB))
    const mid = points[Math.floor(points.length / 2)]!
    labelX = mid.x
    labelY = mid.y
  }

  return {
    id: edge.id,
    fromId: edge.from,
    toId: edge.to,
    path,
    endArrow: edge.arrow === 'end' || edge.arrow === 'both' ? arrowPoints(p2, endAngle) : null,
    startArrow: edge.arrow === 'both' ? arrowPoints(p1, startAngle) : null,
    labelX,
    labelY,
  }
}

/** 所有节点的包围盒（空画布给一个以原点为中心的默认框，避免 fit 时除零）。 */
export function whiteboardBounds(nodes: readonly WhiteboardRect[]): WhiteboardBounds {
  if (nodes.length === 0) return { minX: -200, minY: -120, maxX: 200, maxY: 120 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * 渲染序：**frame 永远在最底层**，其余保持数组序（后加的盖在上面）。
 * 用户把框当成「层」用：层框必须托住里面的节点，否则拖一下就被盖住、点不中。
 * 这是稳定排序（同组内保持原序），导出器复用同一函数，产物与屏幕一致。
 */
export function whiteboardRenderOrder(nodes: readonly WhiteboardNode[]): WhiteboardNode[] {
  const frames: WhiteboardNode[] = []
  const rest: WhiteboardNode[] = []
  for (const node of nodes) {
    if (node.shape === 'frame') frames.push(node)
    else rest.push(node)
  }
  return [...frames, ...rest]
}

/** 吸附网格：拖动落点按 8px 归整（缩放档很小的时候仍按内容坐标吸附，视觉上一致）。 */
export function snapToGrid(value: number): number {
  return Math.round(value / WHITEBOARD_GRID) * WHITEBOARD_GRID
}

/** 命中检测：内容坐标点是否落在矩形内（框选与连线落点共用）。 */
export function rectContains(rect: WhiteboardRect, point: WhiteboardPoint): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

/** 两个矩形是否相交（框选）。 */
export function rectsIntersect(a: WhiteboardRect, b: WhiteboardRect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
}

/**
 * 字符宽度估算：中文/全角 1em，其余 0.55em。与导出器的分行共用，
 * 因此导出的换行位置与屏幕上（CSS 自动换行）**接近但不保证逐字相同**——
 * 导出没有浏览器排版，这是 SVG 文本的固有上限（甘特导出同一处境）。
 */
export function estimateCharWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  // 拉丁字母、数字、常见标点按半角；其余（CJK、全角标点、emoji）按整字
  if (code < 0x2e80) return 0.55
  return 1
}

export function measureText(text: string, fontSize: number): number {
  let width = 0
  for (const char of text) width += estimateCharWidth(char) * fontSize
  return width
}

/** 按可用宽度硬换行（导出用）；`\n` 先断开，超宽再折。 */
export function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }
    let current = ''
    let currentWidth = 0
    for (const char of paragraph) {
      const width = estimateCharWidth(char) * fontSize
      if (current !== '' && currentWidth + width > maxWidth) {
        lines.push(current)
        current = char
        currentWidth = width
      } else {
        current += char
        currentWidth += width
      }
    }
    lines.push(current)
  }
  return lines
}

/** 节点的文本可用宽度（两侧内边距）。 */
export function nodeTextWidth(node: Pick<WhiteboardNode, 'width'>): number {
  return Math.max(12, node.width - WHITEBOARD_NODE_PADDING * 2)
}

/** 导出的行高：字号 × 1.5（与视图的 line-height 对齐）。 */
export const WHITEBOARD_LINE_HEIGHT = 1.5
