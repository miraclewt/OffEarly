// T20 · GanttCanvas：GanttModel 的 SVG 投影（spec 5.4）。
//
// 本层只**投影**：列 x / 条宽 / 进度宽 / 箭头 path / 今日线 x 全部取自 buildGanttModel 的模型，
// 这里不做任何几何计算。渲染只覆盖「视口 ±10 行 + 可见列」，箭头同样按可视范围裁剪，
// 所以 1000 任务的库铺到 DOM 里的节点数依然很小。
//
// 箭头层刻意独立成 <GanttArrowsLayer>：T21 要在它上面加关键路径高亮、FS/SS/FF/SF 四锚点与 hover 高亮，
// props 里已经把 zoom / offsetY / height 备齐，T21 不需要动本文件的其它部分。

import { useEffect, useRef } from 'react'

import { clipArrows, clipHeaderCells, GANTT_HEADER_HEIGHT } from '../controllers/ganttViewport'
import type { GanttColumnWindow, GanttRowWindow } from '../controllers/ganttViewport'
import type { DependencyArrow, GanttModel, GanttRow } from '../domain/ganttModel'
import type { MsgKey, TranslateParams } from '../locales/i18n'

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

const GRID_COLOR = '#E5E7EB'
const TOPIC_ROW_FILL = '#FAFAFA'
const LANE_FILL = '#F8FAFC'
const ARROW_COLOR = '#9CA3AF'
const TEXT_MUTED = '#6B7280'
const TEXT = '#374151'
const DEFAULT_TOPIC_COLOR = '#4F46E5'
const MILESTONE_SIZE = 12
const ARROW_MARKER_ID = 'oe-gantt-arrow-head'

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

export interface GanttArrowsLayerProps {
  arrows: readonly DependencyArrow[]
  /** x 轴投影倍率（列宽缩放），与任务条保持同一套投影 */
  zoom: number
  /** body 行整体下移量（顶部里程碑轨道占用的高度） */
  offsetY: number
  /** 内容区总高，T21 做关键路径分组 / hover 淡出时会用到 */
  height: number
}

/**
 * 依赖箭头层。本任务只把 buildGanttModel 算好的折线 path 原样绑到 <path>：
 * 拐点坐标、绕行分支都在领域层完成，渲染层不重算（T19 已知遗留：SS/FF/SF 端点分支留给 T21）。
 */
export function GanttArrowsLayer(props: GanttArrowsLayerProps) {
  return (
    <g
      data-gantt-layer="arrows"
      transform={`translate(0 ${props.offsetY}) scale(${props.zoom} 1)`}
      fill="none"
      stroke={ARROW_COLOR}
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.arrows.map((arrow) => (
        <path
          key={arrow.id}
          data-gantt-arrow={arrow.id}
          data-from={arrow.from}
          data-to={arrow.to}
          data-type={arrow.type}
          data-critical={arrow.critical}
          d={arrow.path}
          markerEnd={`url(#${ARROW_MARKER_ID})`}
          vectorEffect="non-scaling-stroke"
        />
      ))}
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
  scrollLeft: number
  t: (key: MsgKey, params?: TranslateParams) => string
  onScroll(input: { scrollTop: number; scrollLeft: number }): void
  onZoomWheel(event: WheelEvent): void
}

export function GanttCanvas(props: GanttCanvasProps) {
  const { model, zoom, columnWindow, t } = props
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const { onZoomWheel, onScroll } = props

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

  return (
    <div
      data-testid="gantt-canvas"
      style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#FFFFFF' }}
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
                color: '#FFFFFF',
                background: GANTT_TODAY_COLOR,
                borderRadius: 3,
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
              <marker
                id={ARROW_MARKER_ID}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0 0 L8 4 L0 8 Z" fill={ARROW_COLOR} />
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

            <g data-gantt-body="true" transform={`translate(0 ${laneHeight})`}>
              {props.rows.map((row, index) => {
                const offset = displayOffset(row, index)
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

            <GanttArrowsLayer arrows={arrows} zoom={zoom} offsetY={laneHeight} height={totalHeight} />

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
              />
            )}
          </svg>
        </div>
      )}
    </div>
  )
}
