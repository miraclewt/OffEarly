// T48 · MindMapExporter：把 MindMapModel 投影成可下载的 PNG / SVG（spec 思维导图 §7）。
//
// 架构逐条照 views/GanttExporter.ts，三条口径不变：
//   1. **只投影不重算**。节点矩形 / 贝塞尔 path / bounds 全部取自 domain/mindmapModel 的
//      MindMapModel；导出层不碰布局函数。**喂进来什么模型就导出什么**——视图在「全部折叠」
//      开着时把带 foldAll 展示态的当前模型传进来，导出的就是折叠后的图（MindMapView 已注释）。
//   2. **样式一律是内联呈现属性**。产物里零 class、零 `var(`（docs/visual-audit §4 仓库法，
//      由测试钉住）；颜色写 theme.css 对应 token 的字面量（MINDMAP_* 常量集中在这），
//      rgba token（--oe-border / --oe-fill）拆成 hex + *-opacity，呈现属性里一律可解析。
//      与甘特语义相同的字面量直接复用 GanttCanvas 的共用常量（--oe-text 近黑标签、强调底上白字），
//      避免两套视觉语言漂移。
//   3. **PNG 走 GanttExporter 的 R3 管线**（import svgToPngBlob / triggerDownload / probePngSupport，
//      不复制实现）：SVG → data URI → Image → Canvas(2x) → toBlob → 下载；任何一步失败抛错，
//      绝不静默产出空文件。
//
// 范围：**全图** = model.bounds + padding 40（与控制器 MINDMAP_FIT_PADDING 同档）；
// **仅可见区** = 视口矩形按 screen = content*zoom + pan 的逆变换反算回内容坐标
// （content = (screen - pan) / zoom，与 MindMapCanvas 的 <g transform> 同一契约），
// 出图像素 = 视口屏幕尺寸。缺视口状态时退化为全量（甘特同口径，不静默出空图）。
// 坐标序列化统一收 1 位小数（T43 交接裁决）：模型里的 y 居中值带 0.5，路径与矩形都要过这一道。

import { MINDMAP_FIT_PADDING } from '../controllers/mindmapViewport'
import { MINDMAP_FONT_SIZE } from '../domain/mindmapModel'
import type { MindMapModel } from '../domain/mindmapModel'
import {
  GANTT_LABEL_FILL,
  GANTT_LABEL_ON_PROGRESS_FILL,
} from './GanttCanvas'
import {
  GANTT_EXPORT_FONT_STACK,
  svgToPngBlob,
  triggerDownload,
} from './GanttExporter'

// 与 GanttExporter 一致：探针与下载复用其实现；本文件仅补充导图自己的 SVG 组装与编排。
export { probePngSupport } from './GanttExporter'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'

/**
 * 导图导出配色：与 theme.css / MindMapCanvas 的 var() 一一对应的**字面量**。
 * MindMapCanvas 走内联 style 的 CSS 变量（浏览器解析），这里走呈现属性（不解析 var()），
 * 两组值必须保持同步——改 theme.css 时两处都要改（visual-audit §4 登记）。
 */
export const MINDMAP_EXPORT_ACCENT = '#5E5CE6' // --oe-accent（根节点实底、tier 1/2 描边）
export const MINDMAP_EXPORT_SURFACE = '#FFFFFF' // --oe-surface（画布底 + 普通节点底）
/** 强调底上的标签白：与甘特「深色进度上白字」共用 GanttCanvas 同一常量。 */
export const MINDMAP_EXPORT_ON_ACCENT = GANTT_LABEL_ON_PROGRESS_FILL
/** 节点标签近黑：与甘特任务名标签共用 GanttCanvas 同一常量（--oe-text）。 */
export const MINDMAP_EXPORT_TEXT = GANTT_LABEL_FILL
export const MINDMAP_EXPORT_MUTED = '#6E6E73' // --oe-text-muted（折叠徽标数字）
/** --oe-border 是 rgba(0,0,0,0.12)：呈现属性里拆成 hex + opacity，语义不变。 */
export const MINDMAP_EXPORT_BORDER = '#000000'
export const MINDMAP_EXPORT_BORDER_OPACITY = 0.12
/** --oe-fill = rgba(120,120,128,0.1)：徽标圆底，同手法拆解。 */
export const MINDMAP_EXPORT_BADGE_FILL = '#787880'
export const MINDMAP_EXPORT_BADGE_FILL_OPACITY = 0.1
/** 描边递减两档：MindMapCanvas.nodePaint 的 .45 / .25（「同 accent 递减」）。 */
const MINDMAP_TIER1_STROKE_OPACITY = 0.45
const MINDMAP_TIER2_STROKE_OPACITY = 0.25
/** 圆角与徽标尺寸：与 MindMapCanvas 的现量对齐（rx 只收数字，取 8 / 7 / 10）。 */
const NODE_RADIUS = 8
const BADGE_RADIUS = 7
const BADGE_FONT_SIZE = 10

export type MindMapExportFormat = 'png' | 'svg'
export type MindMapExportRange = 'visible' | 'full'

/** 导图视口快照（screen = content * zoom + pan 的三个投影参数 + 可视尺寸）。 */
export interface MindMapExportViewport {
  panX: number
  panY: number
  zoom: number
  width: number
  height: number
}

export interface MindMapSvgOptions {
  range: MindMapExportRange
  /** 「仅可见区」需要；缺省时退化为全图（不静默出空图）。 */
  viewport?: MindMapExportViewport
  /** 画布底（默认白）；只接受字面量色，同样不吃 CSS 变量。 */
  background?: string
}

export interface MindMapExportRequest extends MindMapSvgOptions {
  model: MindMapModel
  format: MindMapExportFormat
  /** 图名（不带扩展名）；非法路径字符收敛为 "-"。 */
  fileName: string
  /** PNG 倍率，默认 2（高 DPI）。 */
  pngScale?: number
}

export interface MindMapExportResult {
  filename: string
  format: MindMapExportFormat
  bytes: number
}

/** 坐标序列化统一收 1 位小数（T43 交接裁决）。 */
function round(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 模型贝塞尔串里的数字逐个过 round()（路径只含 M/C 与坐标，无其他数字语义），
 * 否则模型里未取整的控制点会把三位小数带进产物。
 */
function roundPath(d: string): string {
  return d.replace(/-?\d+(?:\.\d+)?/g, (token) => String(round(Number(token))))
}

/**
 * 导出图窗口（内容坐标）+ 出图像素尺寸。
 * full：bounds ± padding；visible：视口矩形反变换，像素 = 屏幕尺寸。
 */
function resolveWindow(options: MindMapSvgOptions, model: MindMapModel) {
  const viewport = options.viewport
  if (options.range === 'visible' && viewport !== undefined && viewport.zoom > 0) {
    const left = (0 - viewport.panX) / viewport.zoom
    const top = (0 - viewport.panY) / viewport.zoom
    const right = (viewport.width - viewport.panX) / viewport.zoom
    const bottom = (viewport.height - viewport.panY) / viewport.zoom
    return {
      x: round(left),
      y: round(top),
      width: round(right - left),
      height: round(bottom - top),
      // PNG 栅格按视口屏幕尺寸出图（所见即所得，1:1 屏幕像素）
      pixelWidth: Math.max(1, Math.round(viewport.width)),
      pixelHeight: Math.max(1, Math.round(viewport.height)),
    }
  }
  const { bounds } = model
  const x = bounds.minX - MINDMAP_FIT_PADDING
  const y = bounds.minY - MINDMAP_FIT_PADDING
  const width = bounds.maxX - bounds.minX + MINDMAP_FIT_PADDING * 2
  const height = bounds.maxY - bounds.minY + MINDMAP_FIT_PADDING * 2
  return {
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(height),
    pixelWidth: round(width),
    pixelHeight: round(height),
  }
}

function svgEl(tag: string, attrs: Record<string, string | number | undefined>): SVGElement {
  const element = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    element.setAttribute(name, String(value))
  }
  return element
}

/** 节点配色：与 MindMapCanvas.nodePaint 同一规则，字面量档（根 accent / tier 描边递减）。 */
function nodePaint(node: MindMapModel['nodes'][number]): {
  fill: string
  stroke: string
  strokeOpacity?: number
  label: string
} {
  if (node.depth === 0) {
    return { fill: MINDMAP_EXPORT_ACCENT, stroke: MINDMAP_EXPORT_ACCENT, label: MINDMAP_EXPORT_ON_ACCENT }
  }
  const surface = { fill: MINDMAP_EXPORT_SURFACE, stroke: MINDMAP_EXPORT_BORDER, strokeOpacity: MINDMAP_EXPORT_BORDER_OPACITY, label: MINDMAP_EXPORT_TEXT }
  switch (node.colorTier) {
    case 1:
      return { fill: surface.fill, stroke: MINDMAP_EXPORT_ACCENT, strokeOpacity: MINDMAP_TIER1_STROKE_OPACITY, label: surface.label }
    case 2:
      return { fill: surface.fill, stroke: MINDMAP_EXPORT_ACCENT, strokeOpacity: MINDMAP_TIER2_STROKE_OPACITY, label: surface.label }
    default:
      return surface
  }
}

/**
 * 生成一份**自包含**的 SVG（含 XML 声明），并回传出图像素尺寸。
 * 产物里只有呈现属性与 <title>/<text> 文本，没有 class、没有 CSS 变量、没有外部引用。
 */
export function buildMindMapSvgMarkup(model: MindMapModel, options: MindMapSvgOptions): { markup: string; width: number; height: number } {
  const win = resolveWindow(options, model)
  const background = options.background ?? MINDMAP_EXPORT_SURFACE

  // 不手动 setAttribute('xmlns')：根元素建在 SVG 命名空间里，XMLSerializer 自动补声明
  // （根节点用 createElementNS，与 GanttExporter 同一手法；手动再写会序列化出双属性）。
  const root = svgEl('svg', {
    width: win.pixelWidth,
    height: win.pixelHeight,
    viewBox: `${win.x} ${win.y} ${win.width} ${win.height}`,
    'font-family': GANTT_EXPORT_FONT_STACK,
  }) as SVGSVGElement

  // 不透明底铺满 viewBox（不是铺满内容）：PNG 不透明，可见区导出时也整窗着色
  root.appendChild(svgEl('rect', { x: win.x, y: win.y, width: win.width, height: win.height, fill: background }))

  // 内容一律按模型坐标画；范围裁剪交给 viewBox（窗口外的渲染期裁掉，几何不重算）
  const edges = svgEl('g', { 'data-mindmap-layer': 'edges', fill: 'none' })
  for (const edge of model.edges) {
    edges.appendChild(
      svgEl('path', {
        'data-mindmap-edge': edge.childId,
        d: roundPath(edge.path),
        stroke: MINDMAP_EXPORT_BORDER,
        'stroke-opacity': MINDMAP_EXPORT_BORDER_OPACITY,
        'stroke-width': 1,
      }),
    )
  }
  root.appendChild(edges)

  const nodes = svgEl('g', { 'data-mindmap-layer': 'nodes' })
  for (const node of model.nodes) {
    const paint = nodePaint(node)
    const centerY = round(node.y + node.height / 2)
    const group = svgEl('g', { 'data-mindmap-node': node.id })

    const rect = svgEl('rect', {
      x: round(node.x),
      y: round(node.y),
      width: round(node.width),
      height: round(node.height),
      rx: NODE_RADIUS,
      fill: paint.fill,
      stroke: paint.stroke,
      'stroke-opacity': paint.strokeOpacity,
      'stroke-width': 1,
    })
    const title = svgEl('title', {})
    title.textContent = node.text
    rect.appendChild(title)
    group.appendChild(rect)

    // 标签：SVG 的 dominant-baseline 没有跨渲染器保证（GanttExporter 同注释），
    // 基线取中心 + 字号的视觉修正量（13px → +4，与甘特行标签同一写法）。
    const label = svgEl('text', {
      'data-mindmap-label': node.id,
      x: round(node.x + node.width / 2),
      y: round(node.y + node.height / 2 + 4),
      'font-size': MINDMAP_FONT_SIZE,
      'text-anchor': 'middle',
      fill: paint.label,
    })
    label.textContent = node.text
    group.appendChild(label)

    // 折叠徽标：节点右缘小圆 + `+N`（与 MindMapCanvas 同结构，色走字面量）
    if (node.folded && node.hasChildren) {
      const badge = svgEl('g', { 'data-mindmap-foldbadge': node.id })
      badge.appendChild(
        svgEl('circle', {
          cx: round(node.x + node.width),
          cy: centerY,
          r: BADGE_RADIUS,
          fill: MINDMAP_EXPORT_BADGE_FILL,
          'fill-opacity': MINDMAP_EXPORT_BADGE_FILL_OPACITY,
          stroke: MINDMAP_EXPORT_BORDER,
          'stroke-opacity': MINDMAP_EXPORT_BORDER_OPACITY,
          'stroke-width': 1,
        }),
      )
      const badgeText = svgEl('text', {
        x: round(node.x + node.width),
        y: round(node.y + node.height / 2 + 3),
        'font-size': BADGE_FONT_SIZE,
        'text-anchor': 'middle',
        fill: MINDMAP_EXPORT_MUTED,
      })
      badgeText.textContent = `+${node.hiddenCount}`
      badge.appendChild(badgeText)
      group.appendChild(badge)
    }
    nodes.appendChild(group)
  }
  root.appendChild(nodes)

  const markup = `${XML_PROLOG}${new XMLSerializer().serializeToString(root)}`
  return { markup, width: win.pixelWidth, height: win.pixelHeight }
}

/** Windows / POSIX 都不能用的路径字符统一收敛为 "-"：图名直接做下载文件名。 */
export function sanitizeMindMapFileName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '-').trim()
  return cleaned === '' ? 'offearly-mindmap' : cleaned
}

/** 两格式统一入口：构 SVG → 转 blob → 触发下载，回传文件名供 UI 提示（甘特同构）。 */
export async function exportMindMap(request: MindMapExportRequest): Promise<MindMapExportResult> {
  const { model, format } = request
  const base = sanitizeMindMapFileName(request.fileName)
  const svg = buildMindMapSvgMarkup(model, {
    range: request.range,
    viewport: request.viewport,
    background: request.background,
  })

  if (format === 'svg') {
    const blob = new Blob([svg.markup], { type: 'image/svg+xml;charset=utf-8' })
    const filename = `${base}.svg`
    triggerDownload(blob, filename)
    return { filename, format, bytes: blob.size }
  }

  const blob = await svgToPngBlob(svg, request.pngScale ?? 2)
  const filename = `${base}.png`
  triggerDownload(blob, filename)
  return { filename, format, bytes: blob.size }
}
