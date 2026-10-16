// T20 · GanttCanvas：GanttModel 的 SVG 投影（spec 5.4）。
//
// 本层只**投影**：列 x / 条宽 / 进度宽 / 箭头 path / 今日线 x 全部取自 buildGanttModel 的模型，
// 这里不做任何几何计算。渲染只覆盖「视口 ±10 行 + 可见列」，箭头同样按可视范围裁剪，
// 所以 1000 任务的库铺到 DOM 里的节点数依然很小。
//
// T21 在本文件落地：箭头层 <GanttArrowsLayer> 补齐 SS/FF/SF 端点分流（T19 遗留，只补视图层
// 这一侧，不动 ganttModel.ts）、环上依赖红虚线、关键路径描边/着色与开关、hover 前后一跳高亮。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import { clipArrows, clipHeaderCells, GANTT_HEADER_HEIGHT } from '../controllers/ganttViewport'
import type { GanttColumnWindow, GanttRowWindow } from '../controllers/ganttViewport'
import type { DependencyArrow, GanttBar, GanttModel, GanttRow } from '../domain/ganttModel'
import type { MsgKey, TranslateParams } from '../locales/i18n'

/**
 * 注意（T30）：本文件里这一组色值**必须保持字面量 hex，不能换成 CSS 变量**。
 * 它们最终绑到 SVG 的呈现属性（`fill=` / `stroke=`），而呈现属性不解析 `var()`
 * ——写成 `fill="var(--oe-x)"` 在浏览器里会直接渲染成黑色。下面的 `GRID_COLOR` /
 * `TEXT` / `TEXT_MUTED` 走的是内联 `style`，所以用变量。
 * 另外 GANTT_TODAY_COLOR / GANTT_BASELINE_FILL / GANTT_OFF_COLUMN_FILL 被测试
 * 直接断言，改动等于改契约。
 */

/** 周末 / 节假日列浅灰底（spec 5.4 写死的 #F5F5F5）。 */
export const GANTT_OFF_COLUMN_FILL = '#F5F5F5'
/** 基线细灰条。 */
export const GANTT_BASELINE_FILL = '#9CA3AF'
/** 今日线：1px 红。 */
export const GANTT_TODAY_COLOR = '#DC2626'
/** 任务条浅底：用 topic 色本身 + 透明度，颜色语义与侧栏 swatch 一致。 */
export const GANTT_BAR_OPACITY = 0.18
/** 进度内条：topic 色压暗的比例（深色）。 */
export const GANTT_PROGRESS_MIX = 0.35

const GRID_COLOR = 'var(--oe-border)'
const TOPIC_ROW_FILL = '#FAFAFA'
const LANE_FILL = '#F8FAFC'
/** 普通依赖箭头：中性灰。 */
export const GANTT_ARROW_COLOR = '#9CA3AF'
/** 关键路径高亮：主强调色深靛（spec 7）。 */
export const GANTT_CRITICAL_COLOR = '#4F46E5'
/** 成环依赖：逾期红（spec 7 语义色）+ 虚线，提示先解环（spec 5.3 降级）。 */
export const GANTT_CYCLE_COLOR = '#DC2626'
/** hover 时非直接依赖元素的透明度（T21 验收 4）。 */
export const GANTT_HOVER_DIM_OPACITY = 0.25
/** 关键路径任务条的描边宽度（「描边加粗」）。 */
export const GANTT_CRITICAL_STROKE_WIDTH = 2
/** 环上箭头的虚线样式。 */
const CYCLE_DASH = '5 4'
/** 折线拐点与条边缘的间距；必须与 domain/ganttModel.ts 的 ARROW_GAP 保持一致。 */
const ARROW_GAP = 10
const TEXT_MUTED = 'var(--oe-text-muted)'
const TEXT = 'var(--oe-text-secondary)'
const DEFAULT_TOPIC_COLOR = '#4F46E5'
const MILESTONE_SIZE = 12
export const GANTT_ARROW_MARKER_ID = 'oe-gantt-arrow-head'
export const GANTT_ARROW_MARKER_CRITICAL_ID = 'oe-gantt-arrow-head-critical'
export const GANTT_ARROW_MARKER_CYCLE_ID = 'oe-gantt-arrow-head-cycle'

/** 把 #RRGGBB 与目标色按比例混合；输入非法时原样返回。 */
export function mixColor(hex: string, ratio: number, target = '#000000'): string {
  const from = parseHex(hex)
  const to = parseHex(target)
  if (from === null || to === null) return hex
  const channel = (a: number, b: number): number => Math.round(a + (b - a) * ratio)
  const r = channel(from[0], to[0])
  const g = channel(from[1], to[1])
  const b = channel(from[2], to[2])
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (match === null) return null
  const value = match[1]!
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ]
}

/** 任务条底色：topic 色浅底。 */
export function topicBarFill(color: string | null): string {
  return color ?? DEFAULT_TOPIC_COLOR
}

/** 进度内条：topic 色压暗 35%。 */
export function topicProgressFill(color: string | null): string {
  return mixColor(topicBarFill(color), GANTT_PROGRESS_MIX)
}

/** 折线拐点（模型坐标）。 */
export interface ArrowAnchor {
  x: number
  y: number
}

/**
 * T21 · SS/FF/SF 锚点分流（T19 遗留：领域层只算了 FS「前置右端 → 后置左端」，
 * 且 ganttModel.ts 已合入主干、本任务不改它，端点补算只能落在视图层这一侧）。
 *
 * 语义（spec 4.2 / 依赖编辑）：FS 完成→开始、SS 开始→开始、FF 完成→完成、SF 开始→完成。
 * 锚点：SS 左→左、FF 右→右、FS 右→左、SF 左→右；FS 的 path 领域层已算好、原样使用。
 * 折线保持与领域层一致的「步进 + 横沟」风格，轴对齐且不穿过任一条的内部。
 */
export function routeAnchoredArrow(
  start: ArrowAnchor,
  end: ArrowAnchor,
  exit: 'left' | 'right',
  entry: 'left' | 'right',
): ArrowAnchor[] {
  const { x: sx, y: sy } = start
  const { x: tx, y: ty } = end

  if (exit === 'left' && entry === 'left') {
    // SS：向左出，垂直沟贴在两条左缘的左侧，水平切入目标左端
    const channelX = Math.min(sx, tx) - ARROW_GAP
    return [start, { x: channelX, y: sy }, { x: channelX, y: ty }, end]
  }
  if (exit === 'right' && entry === 'right') {
    // FF：向右出，垂直沟贴在两条右缘的右侧，水平切入目标右端
    const channelX = Math.max(sx, tx) + ARROW_GAP
    return [start, { x: channelX, y: sy }, { x: channelX, y: ty }, end]
  }
  // SF：向左出、从右侧切入目标右端
  if (tx + ARROW_GAP < sx) {
    // 目标整体在源左侧且留有空档：垂直沟直接贴在目标右端外侧
    const channelX = tx + ARROW_GAP
    return [start, { x: channelX, y: sy }, { x: channelX, y: ty }, end]
  }
  // 否则绕行：先向左出，走两行之间的横沟，再贴目标右外侧下切（与领域层 FS 绕行同风格）
  const outX = sx - ARROW_GAP
  const backX = tx + ARROW_GAP
  const channelY = ty >= sy ? ty - ARROW_GAP : ty + ARROW_GAP
  return [start, { x: outX, y: sy }, { x: outX, y: channelY }, { x: backX, y: channelY }, { x: backX, y: ty }, end]
}

/** 渲染用 path d：FS 用领域层算好的几何；SS/FF/SF 在视图层按 type 补算端点。 */
export function dependencyArrowPath(arrow: DependencyArrow, bars: ReadonlyMap<string, GanttBar>): string {
  const from = bars.get(arrow.from)
  const to = bars.get(arrow.to)
  if (from === undefined || to === undefined) return arrow.path
  const mid = (bar: GanttBar): number => bar.y + bar.height / 2

  let start: ArrowAnchor
  let end: ArrowAnchor
  let exit: 'left' | 'right'
  let entry: 'left' | 'right'
  switch (arrow.type) {
    case 'SS':
      start = { x: from.x, y: mid(from) }
      end = { x: to.x, y: mid(to) }
      exit = 'left'
      entry = 'left'
      break
    case 'FF':
      start = { x: from.x + from.width, y: mid(from) }
      end = { x: to.x + to.width, y: mid(to) }
      exit = 'right'
      entry = 'right'
      break
    case 'SF':
      start = { x: from.x, y: mid(from) }
      end = { x: to.x + to.width, y: mid(to) }
      exit = 'left'
      entry = 'right'
      break
    default:
      // FS：领域层几何（右→左）已算好，不重算
      return arrow.path
  }
  const points = routeAnchoredArrow(start, end, exit, entry)
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

export interface GanttArrowsLayerProps {
  arrows: readonly DependencyArrow[]
  /** x 轴投影倍率（列宽缩放），与任务条保持同一套投影 */
  zoom: number
  /** body 行整体下移量（顶部里程碑轨道占用的高度） */
  offsetY: number
  /** 内容区总高，T21 做关键路径分组 / hover 淡出时会用到 */
  height: number
  /** task id → 条几何（模型坐标）；SS/FF/SF 端点分流用（T19 遗留，见 dependencyArrowPath） */
  bars: ReadonlyMap<string, GanttBar>
  /** 环上依赖的箭头 id：红色虚线（spec 5.3 降级） */
  cycleArrowIds: ReadonlySet<string>
  /** 「关键路径」开关（默认开）：关闭时不加粗、不展示计算结果 */
  criticalPathVisible: boolean
  /** 当前 hover 的任务 id；非空时其直接依赖箭头高亮、其余淡出至 0.25 */
  hoveredTaskId: string | null
}

/**
 * 依赖箭头层（T21）。拐点来自领域层（FS）或按 type 补算（SS/FF/SF，见 dependencyArrowPath）；
 * 视觉状态三选一：环上 → 红虚线；关键路径开关打开且箭头关键 → 深靛；其余 → 中性灰。
 * hover 某条时，它的直接依赖箭头保持不透明，其余淡出。箭头不拦截指针事件（纯装饰）。
 */
export function GanttArrowsLayer(props: GanttArrowsLayerProps) {
  const { arrows, zoom, offsetY, criticalPathVisible, cycleArrowIds, hoveredTaskId, bars } = props
  return (
    <g
      data-gantt-layer="arrows"
      transform={`translate(0 ${offsetY}) scale(${zoom} 1)`}
      fill="none"
      stroke={GANTT_ARROW_COLOR}
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents="none"
    >
      {arrows.map((arrow) => {
        const onCycle = cycleArrowIds.has(arrow.id)
        const critical = criticalPathVisible && arrow.critical
        const stroke = onCycle ? GANTT_CYCLE_COLOR : critical ? GANTT_CRITICAL_COLOR : GANTT_ARROW_COLOR
        const markerId = onCycle
          ? GANTT_ARROW_MARKER_CYCLE_ID
          : critical
            ? GANTT_ARROW_MARKER_CRITICAL_ID
            : GANTT_ARROW_MARKER_ID
        const dimmed = hoveredTaskId !== null && arrow.from !== hoveredTaskId && arrow.to !== hoveredTaskId
        return (
          <path
            key={arrow.id}
            data-gantt-arrow={arrow.id}
            data-from={arrow.from}
            data-to={arrow.to}
            data-type={arrow.type}
            data-critical={arrow.critical}
            data-cycle={onCycle}
            d={dependencyArrowPath(arrow, bars)}
            markerEnd={`url(#${markerId})`}
            stroke={stroke}
            strokeDasharray={onCycle ? CYCLE_DASH : undefined}
            opacity={dimmed ? GANTT_HOVER_DIM_OPACITY : undefined}
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
    </g>
  )
}

function MilestoneDiamond(props: { id: string; cx: number; cy: number; fill: string; title: string }) {
  const half = MILESTONE_SIZE / 2
  return (
    <g data-gantt-milestone={props.id} transform={`translate(${props.cx} ${props.cy}) rotate(45)`}>
      <rect
        x={-half}
        y={-half}
        width={MILESTONE_SIZE}
        height={MILESTONE_SIZE}
        rx={1}
        fill={props.fill}
        stroke="#FFFFFF"
        strokeWidth={1}
      />
      <title>{props.title}</title>
    </g>
  )
}

export interface GanttCanvasProps {
  model: GanttModel
  /** 已按窗口切好的 body 行（不含顶部里程碑轨道） */
  rows: readonly GanttRow[]
  /** 跨 topic 里程碑：顶部独立轨道 */
  lane: readonly GanttRow[]
  window: GanttRowWindow
  columnWindow: GanttColumnWindow
  zoom: number
  baselineVisible: boolean
  /** 「关键路径」开关（T21）：开启时关键条描边加粗、关键箭头着色；关闭时不展示计算结果 */
  criticalPathVisible: boolean
  scrollLeft: number
  t: (key: MsgKey, params?: TranslateParams) => string
  onScroll(input: { scrollTop: number; scrollLeft: number }): void
  onZoomWheel(event: WheelEvent): void
}

export function GanttCanvas(props: GanttCanvasProps) {
  const { model, zoom, columnWindow, t } = props
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const { onZoomWheel, onScroll } = props

  // T21 · hover 某条：高亮其全部直接依赖（前后各一跳），其余透明度降至 0.25
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null)

  // Ctrl+滚轮必须拦掉浏览器自带的页面缩放，所以用非 passive 的原生监听（React 的 onWheel 是 passive 的）。
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    function handleWheel(event: WheelEvent): void {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      onZoomWheel(event)
    }
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', handleWheel)
    }
  }, [onZoomWheel])

  const rowHeight = model.rowHeight
  const laneHeight = props.lane.length > 0 ? rowHeight : 0
  const bodyRowCount = Math.max(0, model.rows.length - props.lane.length)
  const totalHeight = laneHeight + bodyRowCount * rowHeight
  const contentWidth = model.width * zoom

  const visibleColumns = model.columns.slice(columnWindow.startCol, columnWindow.endCol)
  const headerTop = clipHeaderCells(model.headerRows[0] ?? [], columnWindow, zoom)
  const headerBottom = clipHeaderCells(model.headerRows[1] ?? [], columnWindow, zoom)
  const todayColumn = model.columns.find((column) => column.isToday)
  const todayX = todayColumn === undefined ? null : (todayColumn.x + todayColumn.width / 2) * zoom

  // 行显示 y 由视图按下标重新投影（跨 topic 里程碑被提到顶部轨道后，模型行号会有空洞）
  const displayOffset = (row: GanttRow, index: number): number => (props.window.startRow + index) * rowHeight - row.y

  const arrows = clipArrows(
    model.arrows,
    {
      left: columnWindow.left,
      right: columnWindow.right,
      top: props.window.startRow * rowHeight,
      bottom: props.window.endRow * rowHeight,
    },
    zoom,
  )

  const empty = model.rows.length === 0

  // T21：SS/FF/SF 端点分流需要的条几何。取全量行而不是视口内的行——
  // 被裁剪渲染的箭头，其端点任务可能落在视口外，锚点仍要能查到。
  const bars = useMemo(() => {
    const map = new Map<string, GanttBar>()
    for (const row of model.rows) {
      if (row.kind === 'task' && row.bar !== null) map.set(row.id, row.bar)
    }
    return map
  }, [model.rows])

  // T21：环上依赖 = 两端都落在同一个强连通分量里的箭头（红色虚线，spec 5.3 降级）
  const cycleArrowIds = useMemo(() => {
    const ids = new Set<string>()
    for (const cycle of model.cycles) {
      const members = new Set(cycle)
      for (const arrow of model.arrows) {
        if (members.has(arrow.from) && members.has(arrow.to)) ids.add(arrow.id)
      }
    }
    return ids
  }, [model.cycles, model.arrows])

  // T21：hover 任务的前后各一跳邻居（含自身）；其余条与箭头淡出至 0.25
  const hoverNeighbours = useMemo(() => {
    if (hoveredTaskId === null) return null
    const set = new Set<string>([hoveredTaskId])
    for (const arrow of model.arrows) {
      if (arrow.from === hoveredTaskId) set.add(arrow.to)
      if (arrow.to === hoveredTaskId) set.add(arrow.from)
    }
    return set
  }, [hoveredTaskId, model.arrows])

  // hover 命中判定挂在 body <g> 上：事件目标最近的 [data-gantt-bar] 祖先即当前 hover 的任务；
  // 指针移到没有任务条的位置（行带 / 空白）时置空，撤销高亮。
  const handleBodyMouseOver = (event: ReactMouseEvent<SVGGElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const bar = target.closest('[data-gantt-bar]')
    setHoveredTaskId(bar === null ? null : bar.getAttribute('data-gantt-bar'))
  }

  return (
    <div
      data-testid="gantt-canvas"
      style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--oe-surface)' }}
    >
      <div
        data-testid="gantt-header"
        style={{
          height: GANTT_HEADER_HEIGHT,
          flex: `0 0 ${GANTT_HEADER_HEIGHT}px`,
          position: 'relative',
          overflow: 'hidden',
          borderBottom: `1px solid ${GRID_COLOR}`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: contentWidth,
            height: GANTT_HEADER_HEIGHT,
            transform: `translateX(-${props.scrollLeft}px)`,
          }}
        >
          {headerTop.map((cell) => (
            <div
              key={`h0-${cell.label}`}
              data-gantt-header-cell={cell.label}
              style={{
                position: 'absolute',
                top: 0,
                left: cell.x * zoom,
                width: cell.width * zoom,
                height: 20,
                boxSizing: 'border-box',
                paddingLeft: 4,
                borderLeft: `1px solid ${GRID_COLOR}`,
                fontSize: 11,
                lineHeight: '20px',
                color: TEXT_MUTED,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {cell.label}
            </div>
          ))}
          {headerBottom.map((cell) => (
            <div
              key={`h1-${cell.label}-${cell.x}`}
              style={{
                position: 'absolute',
                top: 20,
                left: cell.x * zoom,
                width: cell.width * zoom,
                height: 20,
                boxSizing: 'border-box',
                paddingLeft: 4,
                borderLeft: `1px solid ${GRID_COLOR}`,
                fontSize: 11,
                lineHeight: '20px',
                color: TEXT,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {cell.label}
            </div>
          ))}
          {todayX === null ? null : (
            <div
              data-testid="gantt-today-label"
              style={{
                position: 'absolute',
                top: 0,
                left: todayX,
                transform: 'translateX(-50%)',
                padding: '0 4px',
                height: 18,
                lineHeight: '18px',
                fontSize: 10,
                color: 'var(--oe-on-accent)',
                background: GANTT_TODAY_COLOR,
                borderRadius: 'var(--oe-radius-control)',
                whiteSpace: 'nowrap',
              }}
            >
              {t('gantt.today')}
            </div>
          )}
        </div>
      </div>

      {empty ? (
        <div
          data-testid="gantt-empty"
          style={{ flex: 1, display: 'grid', placeItems: 'center', fontSize: 12, color: TEXT_MUTED }}
        >
          {t('gantt.empty')}
        </div>
      ) : (
        <div
          ref={scrollRef}
          data-testid="gantt-canvas-scroll"
          onScroll={(event) => {
            onScroll({ scrollTop: event.currentTarget.scrollTop, scrollLeft: event.currentTarget.scrollLeft })
          }}
          style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}
        >
          <svg
            data-testid="gantt-canvas-svg"
            data-scale={model.scale}
            data-zoom={zoom}
            data-cell-width={model.columns[0]?.width ?? 0}
            data-rows-visible={props.rows.length}
            width={contentWidth}
            height={totalHeight}
            role="img"
            aria-label={t('gantt.title')}
            style={{ display: 'block', fontFamily: 'inherit' }}
          >
            <defs>
              {/* 箭头头部三态：普通灰 / 关键路径深靛 / 成环红（与 path stroke 同色） */}
              <marker
                id={GANTT_ARROW_MARKER_ID}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0 0 L8 4 L0 8 Z" fill={GANTT_ARROW_COLOR} />
              </marker>
              <marker
                id={GANTT_ARROW_MARKER_CRITICAL_ID}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0 0 L8 4 L0 8 Z" fill={GANTT_CRITICAL_COLOR} />
              </marker>
              <marker
                id={GANTT_ARROW_MARKER_CYCLE_ID}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0 0 L8 4 L0 8 Z" fill={GANTT_CYCLE_COLOR} />
              </marker>
            </defs>

            {/* 列底纹：周末 / 节假日 / 补班由模型的 isWorkday 综合判定 */}
            {visibleColumns.map((column) => (
              <rect
                key={`col-${column.date}`}
                data-gantt-col={column.date}
                data-weekend={column.isWeekend}
                data-holiday={column.isHoliday}
                data-workday={column.isWorkday}
                x={column.x * zoom}
                y={0}
                width={column.width * zoom}
                height={totalHeight}
                fill={column.isWorkday ? 'transparent' : GANTT_OFF_COLUMN_FILL}
              />
            ))}

            {/* 顶部独立轨道：跨 topic 里程碑 */}
            {laneHeight === 0 ? null : (
              <g data-gantt-lane="true">
                <rect
                  data-gantt-lane-band="true"
                  x={0}
                  y={0}
                  width={contentWidth}
                  height={laneHeight}
                  fill={LANE_FILL}
                />
                {props.lane.map((row) =>
                  row.bar === null ? null : (
                    <MilestoneDiamond
                      key={`lane-${row.id}`}
                      id={row.id}
                      cx={(row.bar.x + row.bar.width / 2) * zoom}
                      cy={laneHeight / 2}
                      fill={topicBarFill(row.color)}
                      title={row.label}
                    />
                  ),
                )}
              </g>
            )}

            <g
              data-gantt-body="true"
              transform={`translate(0 ${laneHeight})`}
              onMouseOver={handleBodyMouseOver}
              onMouseLeave={() => setHoveredTaskId(null)}
            >
              {props.rows.map((row, index) => {
                const offset = displayOffset(row, index)
                // T21：hover 某条时，非前后一跳邻居的任务条整体淡出
                const dimmed = hoverNeighbours !== null && !hoverNeighbours.has(row.id)
                // T21：关键路径开关打开时，criticalIds 内的任务条描边加粗
                const barCritical = props.criticalPathVisible && row.critical
                const dimOpacity = dimmed ? GANTT_HOVER_DIM_OPACITY : undefined
                return (
                  <g key={`row-${row.id}`}>
                    <rect
                      data-gantt-row={row.id}
                      data-row-kind={row.kind}
                      data-row-height={row.height}
                      x={0}
                      y={props.window.startRow * rowHeight + index * rowHeight}
                      width={contentWidth}
                      height={row.height}
                      fill={row.kind === 'topic' ? TOPIC_ROW_FILL : 'transparent'}
                    />
                    {row.bar !== null && row.kind === 'task' ? (
                      <>
                        <rect
                          data-gantt-bar={row.id}
                          data-topic-id={row.topicId ?? undefined}
                          x={row.bar.x * zoom}
                          y={row.bar.y + offset}
                          width={row.bar.width * zoom}
                          height={row.bar.height}
                          rx={3}
                          fill={topicBarFill(row.color)}
                          fillOpacity={GANTT_BAR_OPACITY}
                          stroke={barCritical ? GANTT_CRITICAL_COLOR : undefined}
                          strokeWidth={barCritical ? GANTT_CRITICAL_STROKE_WIDTH : undefined}
                          opacity={dimOpacity}
                        >
                          <title>{row.label}</title>
                        </rect>
                        {row.bar.progressWidth > 0 ? (
                          <rect
                            data-gantt-progress={row.id}
                            x={row.bar.x * zoom}
                            y={row.bar.y + offset}
                            width={row.bar.progressWidth * zoom}
                            height={row.bar.height}
                            rx={2}
                            fill={topicProgressFill(row.color)}
                            opacity={dimOpacity}
                            pointerEvents="none"
                          />
                        ) : null}
                        {props.baselineVisible && row.baseline !== null ? (
                          <rect
                            data-gantt-baseline={row.id}
                            x={row.baseline.x * zoom}
                            y={row.baseline.y + offset}
                            width={row.baseline.width * zoom}
                            height={row.baseline.height}
                            rx={2}
                            fill={GANTT_BASELINE_FILL}
                            opacity={dimOpacity}
                            pointerEvents="none"
                          />
                        ) : null}
                      </>
                    ) : null}
                    {row.bar !== null && row.kind === 'milestone' ? (
                      <MilestoneDiamond
                        id={row.id}
                        cx={(row.bar.x + row.bar.width / 2) * zoom}
                        cy={row.bar.y + row.bar.height / 2 + offset}
                        fill={topicBarFill(row.color)}
                        title={row.label}
                      />
                    ) : null}
                  </g>
                )
              })}
            </g>

            <GanttArrowsLayer
              arrows={arrows}
              zoom={zoom}
              offsetY={laneHeight}
              height={totalHeight}
              bars={bars}
              cycleArrowIds={cycleArrowIds}
              criticalPathVisible={props.criticalPathVisible}
              hoveredTaskId={hoveredTaskId}
            />

            {todayX === null ? null : (
              <line
                data-gantt-today="line"
                x1={todayX}
                y1={0}
                x2={todayX}
                y2={totalHeight}
                stroke={GANTT_TODAY_COLOR}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}
          </svg>
        </div>
      )}
    </div>
  )
}
