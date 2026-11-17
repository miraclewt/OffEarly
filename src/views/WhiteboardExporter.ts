// T69 · WhiteboardExporter：把白板投影成可下载的 PNG / SVG。
//
// 与 GanttExporter / MindMapExporter 同一条管线：**只投影不重算**、样式一律内联呈现属性、
// PNG 走 svgToPngBlob 的 2x 栅格。几何取自 domain/whiteboardModel（buildEdgeView），
// 所以导出的线与屏幕上的线是同一条 path。
//
// 唯一的妥协：屏幕上的文字靠 CSS 自动换行，导出没有浏览器排版，只能按
// whiteboardModel.wrapText 的估算折行。同一段文字在两处的断行位置**接近但不保证逐字相同**——
// 这是 SVG 文本的固有上限（甘特导出同一处境），所以导出宽度按「估算宽度 + 余量」给。
//
// 颜色是 theme.css 令牌的**字面量**：呈现属性不解析 var()。改主题时这里要同步
// （与 MindMapExporter 的 MINDMAP_EXPORT_* 同一约定）。

import {
  WHITEBOARD_LINE_HEIGHT,
  WHITEBOARD_NODE_PADDING,
  buildEdgeView,
  resolveNodeFontSize,
  resolveNodePaint,
  whiteboardBounds,
  whiteboardRenderOrder,
  wrapText,
} from '../domain/whiteboardModel'
import type { WhiteboardTone, Whiteboard, WhiteboardNode, WhiteboardShape } from '../domain/types'
import { GANTT_EXPORT_FONT_STACK, svgToPngBlob, triggerDownload } from './GanttExporter'

export type WhiteboardExportFormat = 'png' | 'svg'
export type WhiteboardExportRange = 'visible' | 'full'

/** 导出的四周留白（与导图 / 甘特同一档）。 */
const EXPORT_PADDING = 40
const SVG_NS = 'http://www.w3.org/2000/svg'
const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'

/** tone → 呈现属性用的字面量（fill / fill-opacity / stroke / 文字色）。 */
const TONE_PAINT: Record<
  WhiteboardTone,
  { fill: string; fillOpacity?: number; stroke: string; strokeOpacity?: number; text: string }
> = {
  plain: { fill: '#FFFFFF', stroke: '#000000', strokeOpacity: 0.12, text: '#1D1D1F' },
  accent: { fill: '#5E5CE6', fillOpacity: 0.13, stroke: '#5E5CE6', text: '#4038C8' },
  ok: { fill: '#34C759', fillOpacity: 0.13, stroke: '#34C759', text: '#1D1D1F' },
  warn: { fill: '#FF9500', fillOpacity: 0.15, stroke: '#FF9500', text: '#9A4D00' },
  danger: { fill: '#FF3B30', fillOpacity: 0.12, stroke: '#FF3B30', text: '#FF3B30' },
  muted: { fill: '#787880', fillOpacity: 0.06, stroke: '#000000', strokeOpacity: 0.12, text: '#6E6E73' },
}

/** 连线 / 箭头：--oe-text-faint 与 --oe-border 的字面量。 */
const EDGE_STROKE = '#98989D'
const LABEL_FILL = '#6E6E73'
const SURFACE = '#FFFFFF'
/** 图片没读出来时的占位底（--oe-fill-subtle 的字面量）。 */
const IMAGE_PLACEHOLDER = '#F2F2F7'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

export interface WhiteboardExportViewport {
  panX: number
  panY: number
  zoom: number
  width: number
  height: number
}

export interface WhiteboardSvgOptions {
  range: WhiteboardExportRange
  /** 「仅可见区」需要；缺省时退化为全图（不静默出空图）。 */
  viewport?: WhiteboardExportViewport
  background?: string
  /**
   * T74：`assets/<id>.<ext>` → dataURL（由调用方预先读好）。
   *
   * 为什么必须内嵌：单文件产物是 `file://` 打开的，导出的 SVG 里写 `assets/x.png`
   * 在别的机器（甚至同一台机器的下载目录里）都是死链。导出物的定义是**自包含**。
   * 缺了这个键就画灰底占位——宁可看到「图没带上」，也不出一个指向空处的 `<image>`。
   */
  images?: ReadonlyMap<string, string>
}

export interface WhiteboardExportRequest extends WhiteboardSvgOptions {
  whiteboard: Whiteboard
  format: WhiteboardExportFormat
  fileName: string
  pngScale?: number
}

export interface WhiteboardExportResult {
  filename: string
  format: WhiteboardExportFormat
  bytes: number
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function el(tag: string, attrs: Record<string, string | number | undefined>): SVGElement {
  const element = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    element.setAttribute(name, String(value))
  }
  return element
}

function textEl(
  attrs: Record<string, string | number | undefined>,
  content: string,
): SVGTextElement {
  const node = el('text', attrs) as SVGTextElement
  node.textContent = content
  return node
}

/**
 * 导出用的绘制信息：有自定义色就按 `resolveNodePaint`（与屏幕同一个函数）算，
 * 否则回落到语义色的字面量表。**两处口径必须来自同一处判断**，不然会出现
 * 「屏幕上是自定义色、导出里还是语义色」。
 */
function resolveExportPaint(node: WhiteboardNode): (typeof TONE_PAINT)[WhiteboardTone] {
  const custom = resolveNodePaint(node)
  if (custom === null) return TONE_PAINT[node.tone]
  return {
    fill: custom.fill,
    fillOpacity: custom.fillOpacity,
    stroke: custom.stroke,
    strokeOpacity: custom.strokeOpacity,
    text: custom.ink,
  }
}

/** 出图窗口（内容坐标）与像素尺寸。 */
function resolveWindow(options: WhiteboardSvgOptions, whiteboard: Whiteboard) {
  const viewport = options.viewport
  if (options.range === 'visible' && viewport !== undefined && viewport.zoom > 0) {
    const left = (0 - viewport.panX) / viewport.zoom
    const top = (0 - viewport.panY) / viewport.zoom
    const right = (viewport.width - viewport.panX) / viewport.zoom
    const bottom = (viewport.height - viewport.panY) / viewport.zoom
    return {
      x: round1(left),
      y: round1(top),
      width: round1(right - left),
      height: round1(bottom - top),
      pixelWidth: Math.max(1, Math.round(viewport.width)),
      pixelHeight: Math.max(1, Math.round(viewport.height)),
    }
  }
  const bounds = whiteboardBounds(whiteboard.nodes)
  const x = bounds.minX - EXPORT_PADDING
  const y = bounds.minY - EXPORT_PADDING
  const width = bounds.maxX - bounds.minX + EXPORT_PADDING * 2
  const height = bounds.maxY - bounds.minY + EXPORT_PADDING * 2
  return {
    x: round1(x),
    y: round1(y),
    width: round1(width),
    height: round1(height),
    pixelWidth: Math.round(width),
    pixelHeight: Math.round(height),
  }
}

/** 节点形状 → 一个 SVG 图形元素（frame / note / rect 都是 rect，只是圆角与描边不同）。 */
function shapeElement(
  shape: WhiteboardShape,
  rect: { x: number; y: number; width: number; height: number },
  paint: (typeof TONE_PAINT)[WhiteboardTone],
): SVGElement {
  const common = {
    fill: paint.fill,
    'fill-opacity': paint.fillOpacity,
    stroke: paint.stroke,
    'stroke-opacity': paint.strokeOpacity,
    'stroke-width': 1,
  }
  switch (shape) {
    case 'ellipse':
      return el('ellipse', {
        cx: round1(rect.x + rect.width / 2),
        cy: round1(rect.y + rect.height / 2),
        rx: round1(rect.width / 2),
        ry: round1(rect.height / 2),
        ...common,
      })
    case 'diamond':
      return el('polygon', {
        points: [
          `${round1(rect.x + rect.width / 2)},${round1(rect.y)}`,
          `${round1(rect.x + rect.width)},${round1(rect.y + rect.height / 2)}`,
          `${round1(rect.x + rect.width / 2)},${round1(rect.y + rect.height)}`,
          `${round1(rect.x)},${round1(rect.y + rect.height / 2)}`,
        ].join(' '),
        ...common,
      })
    case 'round':
      return el('rect', {
        x: round1(rect.x),
        y: round1(rect.y),
        width: round1(rect.width),
        height: round1(rect.height),
        rx: round1(rect.height / 2),
        ...common,
      })
    case 'note':
      return el('rect', {
        x: round1(rect.x),
        y: round1(rect.y),
        width: round1(rect.width),
        height: round1(rect.height),
        rx: 3,
        ...common,
      })
    case 'frame':
      return el('rect', {
        x: round1(rect.x),
        y: round1(rect.y),
        width: round1(rect.width),
        height: round1(rect.height),
        rx: 12,
        fill: paint.fill,
        'fill-opacity': paint.fillOpacity,
        stroke: paint.stroke,
        'stroke-opacity': paint.strokeOpacity,
        'stroke-width': 1.5,
        'stroke-dasharray': '6 4',
      })
    case 'text':
      // 纯文本节点：没有底、没有边，只有字
      return el('rect', {
        x: round1(rect.x),
        y: round1(rect.y),
        width: round1(rect.width),
        height: round1(rect.height),
        fill: 'none',
        stroke: 'none',
      })
    case 'image':
      // 图片底下垫一层浅灰：图没读出来（或导出时缺 dataURL）时是灰块，不是透明洞
      return el('rect', {
        x: round1(rect.x),
        y: round1(rect.y),
        width: round1(rect.width),
        height: round1(rect.height),
        rx: 8,
        fill: IMAGE_PLACEHOLDER,
        stroke: 'none',
      })
    default:
      return el('rect', {
        x: round1(rect.x),
        y: round1(rect.y),
        width: round1(rect.width),
        height: round1(rect.height),
        rx: 8,
        ...common,
      })
  }
}

/** 节点文字：按估算换行，非 frame 垂直居中、frame 左上、note 顶部。 */
function appendLabel(
  group: SVGElement,
  node: Whiteboard['nodes'][number],
  paint: (typeof TONE_PAINT)[WhiteboardTone],
): void {
  if (node.text === '') return
  // T75：字号是节点数据，与画布读同一个 resolveNodeFontSize——否则用户调到 32 号，
  // 导出却还是 13 号，产出的图和屏幕上看到的完全是两回事
  const fontSize = resolveNodeFontSize(node)
  const lineHeight = fontSize * WHITEBOARD_LINE_HEIGHT
  const available = Math.max(16, node.width - WHITEBOARD_NODE_PADDING * 2)
  const lines = wrapText(node.text, available, fontSize)
  const isTop = node.shape === 'frame' || node.shape === 'note'
  const left = node.x + WHITEBOARD_NODE_PADDING
  const firstBaseline = isTop
    ? node.y + WHITEBOARD_NODE_PADDING + fontSize * 0.8
    : node.y + node.height / 2 - ((lines.length - 1) * lineHeight) / 2 + fontSize * 0.35

  const text = el('text', {
    'data-whiteboard-label': node.id,
    'font-size': fontSize,
    'text-anchor': 'middle',
    fill: paint.text,
    // T77：分组框标题本来就有 600 的强调；显式加粗时抬到 700（用户点过 B 就该更粗）
    'font-weight': node.bold === true ? 700 : node.shape === 'frame' ? 600 : undefined,
    'font-style': node.italic === true ? 'italic' : undefined,
  }) as SVGTextElement
  lines.forEach((line, index) => {
    const tspan = el('tspan', {
      x: round1(isTop ? left : node.x + node.width / 2),
      y: round1(firstBaseline + index * lineHeight),
    })
    tspan.textContent = line
    text.appendChild(tspan)
  })
  group.appendChild(text)
}

/**
 * 图片元素：`href` 与 `xlink:href` 同时给——旧软件只认后者，现代浏览器认前者。
 *
 * T77：`cover`（等比铺满）用 `slice`；slice 会把图放大到盖住整个框，超出部分按规范
 * 由 `<image>` 自己的 viewport 裁掉，但不少渲染器（含部分 PDF / Office 转换链）并不裁，
 * 于是图会糊到隔壁图元上。这里显式给一层 clipPath：屏幕上是 `object-fit: cover`，
 * 导出里是「slice + 裁到节点矩形」，两边看到的是同一块画面。
 */
function imageElement(node: WhiteboardNode, dataUrl: string): SVGElement {
  const cover = node.imageFit === 'cover'
  const image = el('image', {
    x: round1(node.x),
    y: round1(node.y),
    width: round1(node.width),
    height: round1(node.height),
    preserveAspectRatio: cover ? 'xMidYMid slice' : 'xMidYMid meet',
    href: dataUrl,
  })
  image.setAttributeNS(XLINK_NS, 'xlink:href', dataUrl)
  if (!cover) return image

  const clipId = `wb-clip-${node.id.replace(/[^A-Za-z0-9_-]/g, '')}`
  const group = el('g', {})
  const clip = el('clipPath', { id: clipId })
  clip.appendChild(el('rect', { x: round1(node.x), y: round1(node.y), width: round1(node.width), height: round1(node.height) }))
  image.setAttribute('clip-path', `url(#${clipId})`)
  group.appendChild(clip)
  group.appendChild(image)
  return group
}

/**
 * 生成一份自包含的 SVG。产物里只有呈现属性与文本，没有 class、没有 CSS 变量、没有外部引用。
 */
export function buildWhiteboardSvgMarkup(
  whiteboard: Whiteboard,
  options: WhiteboardSvgOptions,
): { markup: string; width: number; height: number } {
  const win = resolveWindow(options, whiteboard)
  const background = options.background ?? SURFACE
  const root = el('svg', {
    width: win.pixelWidth,
    height: win.pixelHeight,
    viewBox: `${win.x} ${win.y} ${win.width} ${win.height}`,
    'font-family': GANTT_EXPORT_FONT_STACK,
  }) as SVGSVGElement
  // 显式声明 xlink 前缀：否则 XMLSerializer 会自己编一个（ns1:href），
  // 老软件读到未知前缀的图片属性等于没给。声明一次，序列化就会用回 xlink。
  root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', XLINK_NS)
  root.appendChild(el('rect', { x: win.x, y: win.y, width: win.width, height: win.height, fill: background }))

  // 连线层：path 来自模型（与屏幕同一条），箭头是手画三角（marker 在导出/克隆里不可靠）
  const edgeLayer = el('g', { 'data-whiteboard-layer': 'edges' })
  const byId = new Map(whiteboard.nodes.map((node) => [node.id, node]))
  for (const edge of whiteboard.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) continue
    const view = buildEdgeView(edge, from, to)
    edgeLayer.appendChild(
      el('path', {
        'data-whiteboard-edge': edge.id,
        d: view.path,
        fill: 'none',
        stroke: EDGE_STROKE,
        'stroke-width': 1.5,
        'stroke-dasharray': edge.dashed ? '6 4' : undefined,
      }),
    )
    if (view.endArrow !== null) edgeLayer.appendChild(el('polygon', { points: view.endArrow, fill: EDGE_STROKE }))
    if (view.startArrow !== null) edgeLayer.appendChild(el('polygon', { points: view.startArrow, fill: EDGE_STROKE }))
    if (edge.label !== '') {
      edgeLayer.appendChild(
        textEl(
          {
            x: round1(view.labelX),
            y: round1(view.labelY - 6),
            'font-size': 11,
            'text-anchor': 'middle',
            fill: LABEL_FILL,
            stroke: background,
            'stroke-width': 3,
            'paint-order': 'stroke',
          },
          edge.label,
        ),
      )
    }
  }
  root.appendChild(edgeLayer)

  // 图元层：frame 沉底（与屏幕同一渲染序）
  const nodeLayer = el('g', { 'data-whiteboard-layer': 'nodes' })
  for (const node of whiteboardRenderOrder(whiteboard.nodes)) {
    const group = el('g', { 'data-whiteboard-node': node.id, 'data-shape': node.shape })
    const paint = resolveExportPaint(node)
    group.appendChild(shapeElement(node.shape, node, paint))
    if (node.shape === 'image') {
      const dataUrl = node.image === undefined ? undefined : options.images?.get(node.image)
      // 只写出「真的拿到了字节」的图：写一个 src 指向不存在的 assets/ 等于给用户一张死图
      if (dataUrl !== undefined) group.appendChild(imageElement(node, dataUrl))
    } else {
      appendLabel(group, node, paint)
    }
    nodeLayer.appendChild(group)
  }
  root.appendChild(nodeLayer)

  const markup = `${XML_PROLOG}${new XMLSerializer().serializeToString(root)}`
  return { markup, width: win.pixelWidth, height: win.pixelHeight }
}

/**
 * T74：blob URL → dataURL。导出时图片必须是**内嵌字节**，否则下载到别的目录就是死链。
 *
 * 为什么经 canvas 而不是 `fetch(url).then(r=>r.blob()).then(FileReader)`：
 * `file://` 页面的 origin 是 "null"，对 blob: 资源发 fetch 在部分 Electron / Edge 版本上
 * 会被 CORS 拦下；而 `<img>` + canvas 这条路是浏览器自己解码的，同源判定只有一次
 * （blob URL 与创建它的页面同源），笔记图片的灯箱也是这么显示的。
 *
 * 读取失败（图被删、格式浏览器不认）返回 null，调用方按「没带上图」处理。
 */
export async function blobUrlToDataUrl(url: string): Promise<string | null> {
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!(width > 0) || !(height > 0)) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) return null
    context.drawImage(image, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** 文件名收敛（Windows / POSIX 都不能用的字符换 "-"）。 */export function sanitizeWhiteboardFileName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').trim()
  return cleaned === '' ? 'offearly-whiteboard' : cleaned
}

/** 两格式统一入口：构 SVG → 转 blob → 触发下载。 */
export async function exportWhiteboard(request: WhiteboardExportRequest): Promise<WhiteboardExportResult> {
  const base = sanitizeWhiteboardFileName(request.fileName)
  const svg = buildWhiteboardSvgMarkup(request.whiteboard, {
    range: request.range,
    viewport: request.viewport,
    background: request.background,
    images: request.images,
  })

  if (request.format === 'svg') {
    const blob = new Blob([svg.markup], { type: 'image/svg+xml;charset=utf-8' })
    const filename = `${base}.svg`
    triggerDownload(blob, filename)
    return { filename, format: 'svg', bytes: blob.size }
  }

  const blob = await svgToPngBlob(svg, request.pngScale ?? 2)
  const filename = `${base}.png`
  triggerDownload(blob, filename)
  return { filename, format: 'png', bytes: blob.size }
}
