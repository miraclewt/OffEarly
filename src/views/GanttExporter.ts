// T23 · GanttExporter：把 GanttModel 投影成可下载的 PNG / SVG / CSV（spec 5.5）。
//
// 三条口径：
//   1. **只投影不重算**。几何（列 x / 条宽 / 进度宽 / 箭头拐点 / 今日线位置）全部取自
//      buildGanttModel 的 GanttModel；CSV 的日期、进度、依赖同样直接读模型行与模型箭头，
//      导出层不碰 ScheduleEngine / DependencyGraph。
//   2. **样式一律是内联呈现属性**。生成的 SVG 里没有一个 class、没有一个 `var(--…)`
//      （呈现属性根本不解析 CSS 变量，见 GanttCanvas 顶部注释），颜色写成与 theme.css
//      一一对应的字面量 hex，font-family 显式展开成系统字体栈——这是 T01 · R3 的前提：
//      data URI 里的 SVG 只要引用任何外部字体 / 图片，Canvas 就会被 taint，toBlob 随即失败。
//      本文件的产物不含 http(s) 资源，唯一的 `http://` 是 SVG 命名空间声明（不是网络请求）。
//   3. **PNG 走 R3 管线**：SVG → `data:image/svg+xml` → Image → Canvas(2x) → toBlob → 下载。
//      管线不可用（无 2d 上下文 / 图片加载失败 / 画布被污染）时**抛错**，由 UI 禁用按钮并提示，
//      绝不静默产出一个空文件。
//
// 范围（spec 5.5「仅可见区 / 全时间跨度」）：复用 controllers/ganttViewport 的窗口计算
// （只读引用，不改控制器），「仅可见区」按当前滚动位置与视口尺寸裁行列，缺视口状态时退化为全量。

import {
  GANTT_HEADER_HEIGHT,
  clipArrows,
  clipHeaderCells,
  computeColumnWindow,
  computeRowWindow,
  estimateGanttLabelWidth,
  splitMilestoneLane,
  truncateGanttLabel,
} from '../controllers/ganttViewport'
import type { DependencyArrow, GanttBar, GanttColumn, GanttModel, GanttRow } from '../domain/ganttModel'
import {
  GANTT_ARROW_COLOR,
  GANTT_ARROW_MARKER_CRITICAL_ID,
  GANTT_ARROW_MARKER_CYCLE_ID,
  GANTT_ARROW_MARKER_ID,
  GANTT_BAR_OPACITY,
  GANTT_BASELINE_FILL,
  GANTT_CRITICAL_COLOR,
  GANTT_CRITICAL_STROKE_WIDTH,
  GANTT_CYCLE_COLOR,
  GANTT_LABEL_FILL,
  GANTT_LABEL_FONT_SIZE,
  GANTT_OFF_COLUMN_FILL,
  GANTT_TODAY_COLOR,
  dependencyArrowPath,
  milestoneLabelX,
  resolveTaskLabel,
  topicBarFill,
  topicProgressFill,
} from './GanttCanvas'
import { currentUiScale } from '../styles/scale'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'

/**
 * 与 theme.css `--oe-font` 完全一致的系统栈。
 * 必须展开成字面量：SVG 被当作 Image 载入时不会带上页面字体，写 `var(--oe-font)` 等于没写字体，
 * 而一旦浏览器试图去拿外部字体，Canvas 就被 taint（R3 前提）。system-ui 之外一律不写。
 */
export const GANTT_EXPORT_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif"

/**
 * 下列字面量与 theme.css 的 token 一一对应。**不要**换成 CSS 变量：它们最终绑到 SVG 的
 * 呈现属性（`fill=` / `stroke=`），呈现属性不解析 `var()`，写变量会渲染成黑色。
 * 已在 GanttCanvas 导出、且被渲染层与测试共同断言的色值直接复用，避免两套视觉语言漂移。
 */
const sc = (value: number): number => value * currentUiScale()

const EXPORT_SURFACE = '#FFFFFF' // --oe-surface
const EXPORT_TEXT = '#111827' // --oe-text
const EXPORT_TEXT_SECONDARY = '#374151' // --oe-text-secondary
const EXPORT_TEXT_MUTED = '#6B7280' // --oe-text-muted
const EXPORT_BORDER = '#E5E7EB' // --oe-border
const EXPORT_ON_TODAY = '#FFFFFF' // --oe-on-accent
const EXPORT_LANE_FILL = '#F8FAFC' // --oe-lane-fill（同 GanttCanvas.LANE_FILL）
const EXPORT_TOPIC_ROW_FILL = '#FAFAFA' // 同 GanttCanvas.TOPIC_ROW_FILL
const EXPORT_DEFAULT_TOPIC_COLOR = '#4F46E5' // 话题无颜色时的兜底（同 GanttCanvas）

/** 左侧任务表（任务名 gutter）宽度；比屏幕上的 320 窄，导出图更紧凑。 */
const EXPORT_GUTTER_WIDTH = 200
const EXPORT_FONT_SIZE = 12
const EXPORT_HEADER_FONT_SIZE = 11
const EXPORT_DOWNLOAD_BASE = 'offearly-gantt'
/** 里程碑菱形边长（与画布 GanttCanvas 的 MILESTONE_SIZE 一致）。 */
const GANTT_MILESTONE_SIZE = 12
/** 下载 URL 的回收延迟：立即 revoke 有切断尚未开始的下载的风险。 */
const REVOKE_DELAY_MS = 30_000

export type GanttExportFormat = 'png' | 'svg' | 'csv'
export type GanttExportRange = 'visible' | 'full'

export interface GanttExportViewport {
  scrollTop: number
  scrollLeft: number
  /** 画布可视宽度（不含左侧任务表） */
  width: number
  /** 画布可视高度（含时间轴表头） */
  height: number
  /** x 轴投影倍率；行高不随缩放变化 */
  zoom: number
}

export interface GanttExportScopeInput {
  range: GanttExportRange
  /** 「仅可见区」需要；缺省时退化为全时间跨度（不静默出空图）。 */
  viewport?: GanttExportViewport
}

/** 一次导出实际要画出来的行列子集 + 坐标原点（模型空间）。 */
export interface GanttExportScope {
  /** 跨话题里程碑轨道（不参与行虚拟化，始终整条保留） */
  lane: GanttRow[]
  /** 参与导出的 body 行（已按可见区裁剪；跨话题里程碑已剥离） */
  body: GanttRow[]
  columns: GanttColumn[]
  arrows: DependencyArrow[]
  /** lane 有内容时占一行高，否则为 0 */
  laneHeight: number
  /** 导出图左上角对应的模型 x / y；全量时为 0 */
  originX: number
  originY: number
  contentWidth: number
  bodyHeight: number
}

export interface GanttSvgOptions extends GanttExportScopeInput {
  baselineVisible?: boolean
  criticalPathVisible?: boolean
  /** 今日线顶部标签文案（本地化由调用方给） */
  todayLabel?: string
}

export interface GanttCsvHeaders {
  task: string
  start: string
  end: string
  progress: string
  dependency: string
}

export interface GanttCsvOptions extends GanttExportScopeInput {
  headers?: GanttCsvHeaders
}

export interface SvgRasterInput {
  markup: string
  width: number
  height: number
}

export interface GanttExportRequest {
  model: GanttModel
  format: GanttExportFormat
  range: GanttExportRange
  viewport?: GanttExportViewport
  baselineVisible?: boolean
  criticalPathVisible?: boolean
  csvHeaders?: GanttCsvHeaders
  todayLabel?: string
  /** PNG 倍率，默认 2（高 DPI）。 */
  pngScale?: number
}

export interface GanttExportResult {
  filename: string
  format: GanttExportFormat
  bytes: number
}

const DEFAULT_CSV_HEADERS: GanttCsvHeaders = {
  task: '任务',
  start: '开始',
  end: '结束',
  progress: '进度',
  dependency: '依赖',
}

const CSV_BOM = '\uFEFF'
const CSV_NEWLINE = '\r\n'

/** R3 探针用的最小 SVG：尺寸确定、零外部引用。 */
const PROBE_MARKUP =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4">' +
  '<rect x="0" y="0" width="4" height="4" fill="#ffffff"/></svg>'

// ── 范围 ──────────────────────────────────────────────────────────────────────

/**
 * 把模型裁成一次导出要画的子集。
 * 「仅可见区」复用视图层同一套窗口函数：行窗口扣掉表头高度、列窗口按 zoom 投影后换算回模型坐标。
 * 跨话题里程碑轨道始终整条保留（与画布一致：它不参与行虚拟化）。
 */
export function resolveGanttScope(model: GanttModel, input: GanttExportScopeInput): GanttExportScope {
  const { lane, body } = splitMilestoneLane(model.rows)
  const laneHeight = lane.length > 0 ? model.rowHeight : 0
  const viewport = input.viewport

  if (input.range !== 'visible' || viewport === undefined) {
    return {
      lane,
      body: [...body],
      columns: [...model.columns],
      arrows: [...model.arrows],
      laneHeight,
      originX: 0,
      originY: 0,
      contentWidth: model.width,
      bodyHeight: body.length * model.rowHeight,
    }
  }

  const rowWindow = computeRowWindow({
    rowCount: body.length,
    scrollTop: viewport.scrollTop,
    offsetY: laneHeight,
    height: Math.max(0, viewport.height - sc(GANTT_HEADER_HEIGHT)),
    rowHeight: model.rowHeight,
  })
  const columnWindow = computeColumnWindow({
    columns: model.columns,
    zoom: viewport.zoom,
    scrollLeft: viewport.scrollLeft,
    width: viewport.width,
  })
  const columns = model.columns.slice(columnWindow.startCol, columnWindow.endCol)
  const bodySlice = body.slice(rowWindow.startRow, rowWindow.endRow)
  const originX = columns[0]?.x ?? 0
  const originY = rowWindow.startRow * model.rowHeight
  const last = columns[columns.length - 1]
  const contentWidth = last === undefined ? 0 : last.x + last.width - originX
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1
  const arrows = clipArrows(
    model.arrows,
    {
      left: columnWindow.left / zoom,
      right: columnWindow.right / zoom,
      top: originY,
      bottom: rowWindow.endRow * model.rowHeight,
    },
    1,
  )

  return {
    lane,
    body: bodySlice,
    columns,
    arrows,
    laneHeight,
    originX,
    originY,
    contentWidth,
    bodyHeight: bodySlice.length * model.rowHeight,
  }
}

// ── SVG ───────────────────────────────────────────────────────────────────────

function svgEl(tag: string, attrs: Record<string, string | number | undefined>): SVGElement {
  const element = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    element.setAttribute(name, String(value))
  }
  return element
}

function svgText(
  x: number,
  y: number,
  content: string,
  attrs: Record<string, string | number | undefined> = {},
): SVGElement {
  const element = svgEl('text', {
    x,
    y,
    'font-family': GANTT_EXPORT_FONT_STACK,
    'font-size': sc(EXPORT_FONT_SIZE),
    fill: EXPORT_TEXT,
    ...attrs,
  })
  element.textContent = content
  return element
}

/** 环上依赖（spec 5.3 降级）：两端落在同一个强连通分量里的箭头。 */
function deriveCycleArrowIds(model: GanttModel): Set<string> {
  const ids = new Set<string>()
  for (const cycle of model.cycles) {
    const members = new Set(cycle)
    for (const arrow of model.arrows) {
      if (members.has(arrow.from) && members.has(arrow.to)) ids.add(arrow.id)
    }
  }
  return ids
}

function appendRowSwatch(group: SVGElement, row: GanttRow, centreY: number): void {
  const color = row.color ?? EXPORT_DEFAULT_TOPIC_COLOR
  if (row.kind === 'milestone') {
    const half = 4
    const diamond = svgEl('g', { transform: `translate(${10 + half} ${centreY}) rotate(45)` })
    diamond.appendChild(svgEl('rect', { x: -half, y: -half, width: half * 2, height: half * 2, fill: color }))
    group.appendChild(diamond)
    return
  }
  group.appendChild(svgEl('circle', { cx: 14, cy: centreY, r: 4, fill: color }))
}

function appendRowLabel(group: SVGElement, row: GanttRow, centreY: number): void {
  appendRowSwatch(group, row, centreY)
  const label = truncateGanttLabel(row.label, sc(EXPORT_GUTTER_WIDTH) - 30, sc(EXPORT_FONT_SIZE))
  group.appendChild(
    svgText(24, centreY + 4, label, {
      fill: row.kind === 'topic' ? EXPORT_TEXT_SECONDARY : EXPORT_TEXT,
      'font-weight': row.kind === 'topic' ? 600 : 400,
    }),
  )
}

function appendMilestoneDiamond(group: SVGElement, id: string, cx: number, cy: number, fill: string, title: string): void {
  const diamond = svgEl('g', { 'data-gantt-milestone': id, transform: `translate(${cx} ${cy}) rotate(45)` })
  const half = sc(GANTT_MILESTONE_SIZE) / 2
  diamond.appendChild(
    svgEl('rect', {
      x: -half,
      y: -half,
      width: sc(GANTT_MILESTONE_SIZE),
      height: sc(GANTT_MILESTONE_SIZE),
      rx: 1,
      fill,
      stroke: EXPORT_SURFACE,
      'stroke-width': 1,
    }),
  )
  const titleEl = svgEl('title', {})
  titleEl.textContent = title
  diamond.appendChild(titleEl)
  group.appendChild(diamond)
}

/**
 * T39 · 条内 / 条外标签。判定与画布共用 `resolveTaskLabel`（同一份截断 + 深浅规则），
 * 否则「屏幕上有色块没名字，导出图上有名字」两边会各说各话。
 * SVG 没有 dominant-baseline 的跨渲染器保证，这里沿用本文件既有写法：基线取行中心 +4。
 */
function appendBarLabel(group: SVGElement, row: GanttRow): void {
  if (row.bar === null) return
  const label = resolveTaskLabel(row.label, row.bar.x, row.bar.width, row.bar.progressWidth)
  group.appendChild(
    svgText(label.x, row.bar.y + row.bar.height / 2 + 4, label.text, {
      'data-gantt-label': row.id,
      'data-placement': label.placement,
      'font-size': sc(GANTT_LABEL_FONT_SIZE),
      fill: label.fill,
    }),
  )
}

function appendMilestoneLabel(group: SVGElement, row: GanttRow, cx: number, cy: number): void {
  group.appendChild(
    svgText(milestoneLabelX(cx), cy + 4, row.label, {
      'data-gantt-label': row.id,
      'data-placement': 'outside',
      'font-size': sc(GANTT_LABEL_FONT_SIZE),
      fill: GANTT_LABEL_FILL,
    }),
  )
}

/**
 * 生成一份**自包含**的 SVG（含 XML 声明），并回传像素尺寸。
 * 产物里只有呈现属性与 `<title>`/`<text>` 文本，没有 class、没有 CSS 变量、没有外部引用。
 */
export function buildGanttSvgMarkup(model: GanttModel, options: GanttSvgOptions): { markup: string; width: number; height: number } {
  const baselineVisible = options.baselineVisible ?? false
  const criticalPathVisible = options.criticalPathVisible ?? true
  const todayLabel = options.todayLabel ?? '今天'
  const scope = resolveGanttScope(model, options)

  const rowHeight = model.rowHeight
  const width = sc(EXPORT_GUTTER_WIDTH) + scope.contentWidth
  const bodyTop = sc(GANTT_HEADER_HEIGHT) + scope.laneHeight
  const height = bodyTop + scope.bodyHeight
  /** 模型 x → 导出图 x */
  const toX = (modelX: number): number => sc(EXPORT_GUTTER_WIDTH) + modelX - scope.originX
  /** body 内容整体平移量：列/条/箭头/今日线都按模型坐标画在这个 group 里 */
  const bodyShiftX = sc(EXPORT_GUTTER_WIDTH) - scope.originX
  const bodyShiftY = bodyTop - scope.originY

  // 注意：**不手动 setAttribute('xmlns', …)**。根元素由 createElementNS 建在 SVG 命名空间里，
  // XMLSerializer 会自动补上 xmlns 声明；手动再写一次会序列化出两个同名属性，XML 反而不合法。
  const root = svgEl('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    'font-family': GANTT_EXPORT_FONT_STACK,
    'font-size': sc(EXPORT_FONT_SIZE),
    fill: EXPORT_TEXT,
  }) as SVGSVGElement

  // 不透明底：PNG 不透明，粘到白底文档上不会出现半透明叠色
  root.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: EXPORT_SURFACE }))

  // 箭头三态 marker（与画布同一套语义：普通灰 / 关键路径深靛 / 成环红）
  const defs = svgEl('defs', {})
  for (const [id, color] of [
    [GANTT_ARROW_MARKER_ID, GANTT_ARROW_COLOR],
    [GANTT_ARROW_MARKER_CRITICAL_ID, GANTT_CRITICAL_COLOR],
    [GANTT_ARROW_MARKER_CYCLE_ID, GANTT_CYCLE_COLOR],
  ] as const) {
    const marker = svgEl('marker', { id, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto' })
    marker.appendChild(svgEl('path', { d: 'M0 0 L8 4 L0 8 Z', fill: color }))
    defs.appendChild(marker)
  }
  root.appendChild(defs)

  // ── 表头（月 / 日或周）+ 今日标签 ─────────────────────────────────────────
  const header = svgEl('g', { 'data-gantt-layer': 'header' })
  const headerBounds = { left: scope.originX, right: scope.originX + scope.contentWidth }
  const monthRow = sc(GANTT_HEADER_HEIGHT) / 2
  const topCells = clipHeaderCells(model.headerRows[0] ?? [], headerBounds, 1)
  for (const cell of topCells) {
    header.appendChild(
      svgEl('line', { x1: toX(cell.x), y1: 0, x2: toX(cell.x), y2: sc(GANTT_HEADER_HEIGHT), stroke: EXPORT_BORDER, 'stroke-width': 1 }),
    )
    header.appendChild(svgText(toX(cell.x) + 4, monthRow - 6, cell.label, { 'font-size': sc(EXPORT_HEADER_FONT_SIZE), fill: EXPORT_TEXT_MUTED }))
  }
  const bottomCells = clipHeaderCells(model.headerRows[1] ?? [], headerBounds, 1)
  for (const cell of bottomCells) {
    header.appendChild(
      svgEl('line', { x1: toX(cell.x), y1: monthRow, x2: toX(cell.x), y2: sc(GANTT_HEADER_HEIGHT), stroke: EXPORT_BORDER, 'stroke-width': 1 }),
    )
    header.appendChild(
      svgText(toX(cell.x) + 4, sc(GANTT_HEADER_HEIGHT) - 6, cell.label, { 'font-size': sc(EXPORT_HEADER_FONT_SIZE), fill: EXPORT_TEXT_SECONDARY }),
    )
  }
  root.appendChild(header)

  // ── 今日线（含顶部标签）位置 ──────────────────────────────────────────────
  const todayColumn = model.columns.find((column) => column.isToday)
  const todayCentre = todayColumn === undefined ? null : todayColumn.x + todayColumn.width / 2
  const todayInScope = todayCentre !== null && todayCentre >= scope.originX && todayCentre <= scope.originX + scope.contentWidth
  if (todayCentre !== null && todayInScope) {
    const labelWidth = estimateGanttLabelWidth(todayLabel, sc(EXPORT_HEADER_FONT_SIZE)) + 10
    header.appendChild(
      svgEl('rect', { 'data-gantt-today-label': 'true', x: toX(todayCentre) - labelWidth / 2, y: 2, width: labelWidth, height: 16, rx: 6, fill: GANTT_TODAY_COLOR }),
    )
    header.appendChild(
      svgText(toX(todayCentre), 13, todayLabel, {
        'font-size': sc(EXPORT_HEADER_FONT_SIZE),
        fill: EXPORT_ON_TODAY,
        'text-anchor': 'middle',
      }),
    )
  }

  // ── 跨话题里程碑轨道（始终整条保留，与画布一致） ──────────────────────────
  if (scope.laneHeight > 0) {
    const lane = svgEl('g', { 'data-gantt-layer': 'lane' })
    lane.appendChild(svgEl('rect', { 'data-gantt-lane': 'true', x: 0, y: sc(GANTT_HEADER_HEIGHT), width, height: scope.laneHeight, fill: EXPORT_LANE_FILL }))
    for (const row of scope.lane) {
      if (row.bar === null) continue
      const cx = toX(row.bar.x + row.bar.width / 2)
      const cy = sc(GANTT_HEADER_HEIGHT) + scope.laneHeight / 2
      appendMilestoneDiamond(lane, row.id, cx, cy, topicBarFill(row.color), row.label)
      appendMilestoneLabel(lane, row, cx, cy)
    }
    root.appendChild(lane)
  }

  // ── body：列底纹 / 行底 / 任务条 / 基线 / 里程碑菱形 ───────────────────────
  const body = svgEl('g', { 'data-gantt-layer': 'body', transform: `translate(${bodyShiftX} ${bodyShiftY})` })

  for (const column of scope.columns) {
    if (column.isWorkday) continue
    body.appendChild(
      svgEl('rect', {
        'data-gantt-col': column.date,
        x: column.x,
        y: -scope.laneHeight,
        width: column.width,
        height: scope.laneHeight + scope.bodyHeight,
        fill: GANTT_OFF_COLUMN_FILL,
      }),
    )
  }

  for (const row of scope.body) {
    // 每行都有一条行带（topic 分组头带浅底），与画布的 <rect data-gantt-row> 同构，
    // 既是行分隔的落点，也让「范围裁剪后到底画了哪些行」在产物里可断言。
    body.appendChild(
      svgEl('rect', {
        'data-gantt-row': row.id,
        'data-row-kind': row.kind,
        x: 0,
        y: row.y,
        width: scope.contentWidth,
        height: row.height,
        fill: row.kind === 'topic' ? EXPORT_TOPIC_ROW_FILL : 'none',
      }),
    )
    if (row.bar === null) continue

    if (row.kind === 'milestone') {
      const cx = row.bar.x + row.bar.width / 2
      const cy = row.bar.y + row.bar.height / 2
      appendMilestoneDiamond(body, row.id, cx, cy, topicBarFill(row.color), row.label)
      appendMilestoneLabel(body, row, cx, cy)
      continue
    }

    const barCritical = criticalPathVisible && row.critical
    const bar = svgEl('rect', {
      'data-gantt-bar': row.id,
      'data-topic-id': row.topicId ?? undefined,
      x: row.bar.x,
      y: row.bar.y,
      width: row.bar.width,
      height: row.bar.height,
      rx: 3,
      fill: topicBarFill(row.color),
      'fill-opacity': GANTT_BAR_OPACITY,
      stroke: barCritical ? GANTT_CRITICAL_COLOR : undefined,
      'stroke-width': barCritical ? GANTT_CRITICAL_STROKE_WIDTH : undefined,
    })
    const barTitle = svgEl('title', {})
    barTitle.textContent = row.label
    bar.appendChild(barTitle)
    body.appendChild(bar)

    if (row.bar.progressWidth > 0) {
      body.appendChild(
        svgEl('rect', {
          'data-gantt-progress': row.id,
          x: row.bar.x,
          y: row.bar.y,
          width: row.bar.progressWidth,
          height: row.bar.height,
          rx: 2,
          fill: topicProgressFill(row.color),
        }),
      )
    }
    appendBarLabel(body, row)

    if (baselineVisible && row.baseline !== null) {
      body.appendChild(
        svgEl('rect', {
          'data-gantt-baseline': row.id,
          x: row.baseline.x,
          y: row.baseline.y,
          width: row.baseline.width,
          height: row.baseline.height,
          rx: 2,
          fill: GANTT_BASELINE_FILL,
        }),
      )
    }
  }
  root.appendChild(body)

  // ── 箭头：几何来自模型（FS）或按 type 补算（SS/FF/SF），沿用画布的同一函数 ──
  const bars = new Map<string, GanttBar>()
  for (const row of model.rows) {
    if (row.kind === 'task' && row.bar !== null) bars.set(row.id, row.bar)
  }
  const cycleArrowIds = deriveCycleArrowIds(model)
  const arrows = svgEl('g', {
    'data-gantt-layer': 'arrows',
    transform: `translate(${bodyShiftX} ${bodyShiftY})`,
    fill: 'none',
    stroke: GANTT_ARROW_COLOR,
    'stroke-width': 1,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })
  for (const arrow of scope.arrows) {
    const onCycle = cycleArrowIds.has(arrow.id)
    const critical = criticalPathVisible && arrow.critical
    const stroke = onCycle ? GANTT_CYCLE_COLOR : critical ? GANTT_CRITICAL_COLOR : GANTT_ARROW_COLOR
    const markerId = onCycle ? GANTT_ARROW_MARKER_CYCLE_ID : critical ? GANTT_ARROW_MARKER_CRITICAL_ID : GANTT_ARROW_MARKER_ID
    arrows.appendChild(
      svgEl('path', {
        'data-gantt-arrow': arrow.id,
        'data-from': arrow.from,
        'data-to': arrow.to,
        'data-type': arrow.type,
        d: dependencyArrowPath(arrow, bars),
        stroke,
        'marker-end': `url(#${markerId})`,
        'stroke-dasharray': onCycle ? '5 4' : undefined,
      }),
    )
  }
  root.appendChild(arrows)

  // ── 今日线（压在箭头之上）────────────────────────────────────────────────
  if (todayCentre !== null && todayInScope) {
    const todayGroup = svgEl('g', { transform: `translate(${bodyShiftX} ${bodyShiftY})` })
    todayGroup.appendChild(
      svgEl('line', {
        'data-gantt-today': 'line',
        x1: todayCentre,
        y1: -scope.laneHeight,
        x2: todayCentre,
        y2: scope.bodyHeight,
        stroke: GANTT_TODAY_COLOR,
        'stroke-width': 1,
      }),
    )
    root.appendChild(todayGroup)
  }

  // ── gutter：任务名 + 行分隔线（导出图没有 HTML 表格兜底，这里自己画） ──────
  const gutter = svgEl('g', { 'data-gantt-layer': 'gutter' })
  for (const row of scope.lane) {
    appendRowLabel(gutter, row, sc(GANTT_HEADER_HEIGHT) + scope.laneHeight / 2)
  }
  scope.body.forEach((row, index) => {
    appendRowLabel(gutter, row, bodyTop + index * rowHeight + rowHeight / 2)
  })
  gutter.appendChild(
    svgEl('line', { x1: 0, y1: sc(GANTT_HEADER_HEIGHT), x2: width, y2: sc(GANTT_HEADER_HEIGHT), stroke: EXPORT_BORDER, 'stroke-width': 1 }),
  )
  if (scope.laneHeight > 0) {
    gutter.appendChild(svgEl('line', { x1: 0, y1: bodyTop, x2: width, y2: bodyTop, stroke: EXPORT_BORDER, 'stroke-width': 1 }))
  }
  scope.body.forEach((_row, index) => {
    const y = bodyTop + (index + 1) * rowHeight
    gutter.appendChild(svgEl('line', { x1: 0, y1: y, x2: width, y2: y, stroke: EXPORT_BORDER, 'stroke-width': 1 }))
  })
  gutter.appendChild(
    svgEl('line', { x1: sc(EXPORT_GUTTER_WIDTH), y1: sc(GANTT_HEADER_HEIGHT), x2: sc(EXPORT_GUTTER_WIDTH), y2: height, stroke: EXPORT_BORDER, 'stroke-width': 1 }),
  )
  root.appendChild(gutter)

  const markup = `${XML_PROLOG}${new XMLSerializer().serializeToString(root)}`
  return { markup, width, height }
}

// ── CSV ───────────────────────────────────────────────────────────────────────

/** RFC 4180 风格转义：含分隔符 / 引号 / 换行才加引号，内部引号翻倍。 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(',')
}

/**
 * 任务 / 里程碑行导出为 CSV（spec 5.5：任务 + 开始 + 结束 + 进度 + 依赖）。
 * 数据一律来自模型：日期与进度读模型行的 task / milestone，依赖读模型箭头（前置 + 类型）。
 * 带 UTF-8 BOM，Excel 双击打开中文不乱码；分隔符用 CRLF。
 */
export function buildGanttCsv(model: GanttModel, options: GanttCsvOptions): string {
  const headers = options.headers ?? DEFAULT_CSV_HEADERS
  const scope = resolveGanttScope(model, options)

  const titleOf = new Map<string, string>()
  for (const row of model.rows) titleOf.set(row.id, row.label)

  const predecessors = new Map<string, string[]>()
  for (const arrow of model.arrows) {
    const list = predecessors.get(arrow.to) ?? []
    list.push(`${titleOf.get(arrow.from) ?? arrow.from}(${arrow.type})`)
    predecessors.set(arrow.to, list)
  }

  const lines: string[] = [csvLine([headers.task, headers.start, headers.end, headers.progress, headers.dependency])]
  for (const row of [...scope.lane, ...scope.body]) {
    if (row.kind === 'task' && row.task !== null) {
      lines.push(
        csvLine([
          row.task.title,
          row.task.start ?? '',
          row.task.due ?? '',
          `${row.task.progress}%`,
          (predecessors.get(row.id) ?? []).join('; '),
        ]),
      )
      continue
    }
    if (row.kind === 'milestone' && row.milestone !== null) {
      lines.push(csvLine([row.milestone.title, row.milestone.date, row.milestone.date, '', '']))
    }
  }

  return `${CSV_BOM}${lines.join(CSV_NEWLINE)}${CSV_NEWLINE}`
}

// ── PNG 管线（R3） ────────────────────────────────────────────────────────────

/**
 * R3 管线：SVG → `data:image/svg+xml` → Image → Canvas(scale×) → toBlob。
 * 任何一步失败都抛错（不返回空 blob）：无 2d 上下文、图片加载失败、画布被 taint 时
 * toBlob 回调拿到 null。调用方据此禁用 PNG 按钮并提示。
 */
export async function svgToPngBlob(input: SvgRasterInput, scale = 2): Promise<Blob> {
  const { markup, width, height } = input
  if (!(width > 0) || !(height > 0)) throw new Error('gantt export: svg has no size')

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('gantt export: 2d context unavailable')

  const image = new Image()
  return await new Promise<Blob>((resolve, reject) => {
    image.onload = () => {
      try {
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        context.scale(scale, scale)
        context.drawImage(image, 0, 0, width, height)
        canvas.toBlob((blob) => {
          if (blob === null) reject(new Error('gantt export: canvas toBlob failed (tainted canvas?)'))
          else resolve(blob)
        }, 'image/png')
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    image.onerror = () => {
      reject(new Error('gantt export: svg image failed to load'))
    }
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  })
}

/**
 * 探测 PNG 管线是否可用（R3）。挂载时跑一次最小 SVG：不可用就让 PNG 按钮禁用并提示，
 * 而不是等用户点下去才失败。
 */
export async function probePngSupport(): Promise<boolean> {
  try {
    const blob = await svgToPngBlob({ markup: PROBE_MARKUP, width: 4, height: 4 }, 1)
    return blob.size > 0
  } catch {
    return false
  }
}

// ── 下载 ──────────────────────────────────────────────────────────────────────

/** blob:+a[download]。延迟 revoke：立刻回收有可能切断尚未开始的下载。 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, REVOKE_DELAY_MS)
}

// ── 编排 ──────────────────────────────────────────────────────────────────────

/** 三格式统一入口：构内容 → 转 blob → 触发下载，回传文件名供 UI 提示。 */
export async function exportGanttChart(request: GanttExportRequest): Promise<GanttExportResult> {
  const { model, format } = request
  const base = `${EXPORT_DOWNLOAD_BASE}-${model.today}`

  if (format === 'csv') {
    const blob = new Blob([buildGanttCsv(model, { range: request.range, viewport: request.viewport, headers: request.csvHeaders })], {
      type: 'text/csv;charset=utf-8',
    })
    const filename = `${base}.csv`
    triggerDownload(blob, filename)
    return { filename, format, bytes: blob.size }
  }

  const svg = buildGanttSvgMarkup(model, {
    range: request.range,
    viewport: request.viewport,
    baselineVisible: request.baselineVisible,
    criticalPathVisible: request.criticalPathVisible,
    todayLabel: request.todayLabel,
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
