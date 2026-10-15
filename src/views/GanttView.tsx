// T20 · GanttView：只读甘特的宿主视图（spec 5.1 输入契约 / 5.4 渲染要点）。
//
// 数据流：vault + filter ──buildGanttModel──▶ GanttModel ──投影──▶ GanttTable + GanttCanvas。
// 视图层不做任何排期计算：列 x / 条宽 / 进度宽 / 箭头拐点 / 今日线位置全部来自领域层，
// 这里只负责「看哪一段」——刻度、缩放、滚动、基线开关、虚拟化窗口。
//
// 可挂载性（分支约定第 4 条）：导出默认组件 + 显式 props，vault / filter / scale / viewport 全部由外部传入，
// 不读 store、不改 App.tsx。省略 viewport 时内部自建一个，因此 `<GanttView vault={vault} filter={filter} />` 直接可用。
//
// 只读边界（spec 12 非目标）：不做拖拽改期、不做拖入排期；日期在 TaskDrawer 改。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'

import {
  GANTT_HEADER_HEIGHT,
  GANTT_OVERSCAN_ROWS,
  GANTT_TABLE_WIDTH,
  computeColumnWindow,
  computeRowWindow,
  createGanttViewport,
  splitMilestoneLane,
  zoomFactorAt,
} from '../controllers/ganttViewport'
import type { GanttViewportController } from '../controllers/ganttViewport'
import { buildGanttModel } from '../domain/ganttModel'
import type { Filter, GanttScale, Vault } from '../domain/types'
import { createI18n } from '../locales/i18n'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { GanttCanvas } from './GanttCanvas'
import { GanttTable } from './GanttTable'
import { Icon } from './IconSprite'

const BORDER = '#E5E7EB'
const TEXT = '#111827'
const TEXT_MUTED = '#6B7280'
const INDIGO = '#4F46E5'
const TOOLBAR_HEIGHT = 36

const BODY_FONT = '-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'

/**
 * 兜底文案表：宿主通常会传 i18n.t，但在组件测试或未接线的场景下也要能独立挂载，
 * 所以这里给一份确定的中文兜底（不依赖 navigator.language，避免测试环境抖动）。
 */
const fallbackI18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })

export interface GanttViewProps {
  vault: Vault
  filter: Filter
  /** 初始刻度；只在内部自建控制器时生效（传了 viewport 就以控制器为准）。 */
  scale?: GanttScale
  /** 视口控制器（刻度 / 缩放 / 基线 / 滚动）；省略时内部创建。 */
  viewport?: GanttViewportController
  /** 显式时间范围，透传给 buildGanttModel；省略时按已排期数据推导。 */
  range?: { start?: string; end?: string }
  /** 视口锚定的「今天」（YYYY-MM-DD）；注入以便测试确定化。 */
  today?: string
  /** 画布可视高度（含时间轴表头）；省略时用控制器内的值。 */
  height?: number
  /** 画布可视宽度（不含左侧任务表）；省略时用控制器内的值。 */
  width?: number
  t?: (key: MsgKey, params?: TranslateParams) => string
  style?: CSSProperties
}

export function GanttView(props: GanttViewProps) {
  const { vault, filter } = props
  const t = props.t ?? fallbackI18n.t

  // 外部传进来的控制器优先；否则自建（只建一次，刻度/缩放才不会被重渲染抹掉）
  const [ownViewport] = useState(() => createGanttViewport({ scale: props.scale }))
  const viewport = props.viewport ?? ownViewport
  const state = useSyncExternalStore(viewport.subscribe, viewport.getState)

  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    viewport.setViewportSize({ width: props.width, height: props.height })
  }, [viewport, props.width, props.height])

  // 能测到真实容器尺寸就跟它走（file:// 单文件运行时）；测不到（jsdom）沿用注入值
  useEffect(() => {
    const element = rootRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box === undefined || box.width <= 0) return
      viewport.setViewportSize({
        width: Math.max(0, box.width - GANTT_TABLE_WIDTH),
        height: Math.max(0, box.height - TOOLBAR_HEIGHT),
      })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [viewport])

  const model = useMemo(
    () => buildGanttModel(vault, filter, state.scale, { today: props.today, range: props.range }),
    [vault, filter, state.scale, props.today, props.range],
  )

  const { lane, body } = useMemo(() => splitMilestoneLane(model.rows), [model])
  const rowHeight = model.rowHeight
  const laneHeight = lane.length > 0 ? rowHeight : 0
  const zoom = zoomFactorAt(state.zoomIndex[state.scale])
  const baselineVisible = state.baselineVisible

  const canvasHeight = state.height
  const rowWindow = useMemo(
    () =>
      computeRowWindow({
        rowCount: body.length,
        scrollTop: state.scrollTop,
        offsetY: laneHeight,
        height: Math.max(0, canvasHeight - GANTT_HEADER_HEIGHT),
        rowHeight,
        overscan: GANTT_OVERSCAN_ROWS,
      }),
    [body.length, state.scrollTop, laneHeight, canvasHeight, rowHeight],
  )

  const columnWindow = useMemo(
    () => computeColumnWindow({ columns: model.columns, zoom, scrollLeft: state.scrollLeft, width: state.width }),
    [model.columns, zoom, state.scrollLeft, state.width],
  )

  const visibleRows = useMemo(() => body.slice(rowWindow.startRow, rowWindow.endRow), [body, rowWindow])

  const handleScroll = useCallback(
    (input: { scrollTop: number; scrollLeft: number }) => {
      viewport.setScroll(input)
    },
    [viewport],
  )

  const handleZoomWheel = useCallback(
    (event: WheelEvent) => {
      viewport.applyWheel({ ctrlKey: event.ctrlKey || event.metaKey, deltaY: event.deltaY })
    },
    [viewport],
  )

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      viewport.zoomIn()
      return
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      viewport.zoomOut()
    }
  }

  const scaleButton = (scale: GanttScale, label: string): ReactElement => {
    const active = state.scale === scale
    return (
      <button
        key={scale}
        type="button"
        data-testid={`gantt-scale-${scale}`}
        aria-pressed={active}
        onClick={() => viewport.setScale(scale)}
        style={{
          padding: '2px 10px',
          fontSize: 12,
          lineHeight: '20px',
          color: active ? '#FFFFFF' : TEXT,
          background: active ? INDIGO : '#FFFFFF',
          border: `1px solid ${active ? INDIGO : BORDER}`,
          borderRadius: 6,
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    )
  }

  return (
    <div
      ref={rootRef}
      data-testid="gantt-view"
      data-scale={state.scale}
      data-zoom={zoom}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        height: canvasHeight + TOOLBAR_HEIGHT,
        background: '#FFFFFF',
        color: TEXT,
        fontFamily: BODY_FONT,
        outline: 'none',
        ...props.style,
      }}
    >
      <div
        data-testid="gantt-toolbar"
        style={{
          height: TOOLBAR_HEIGHT,
          flex: `0 0 ${TOOLBAR_HEIGHT}px`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          borderBottom: `1px solid ${BORDER}`,
          boxSizing: 'border-box',
        }}
      >
        {scaleButton('day', t('gantt.scale.day'))}
        {scaleButton('week', t('gantt.scale.week'))}

        <span style={{ width: 8 }} />

        <button
          type="button"
          data-testid="gantt-zoom-out"
          aria-label={t('gantt.zoomOut')}
          onClick={() => viewport.zoomOut()}
          style={iconButtonStyle}
        >
          <Icon name="zoom-out" />
        </button>
        <button
          type="button"
          data-testid="gantt-zoom-label"
          aria-label={t('gantt.resetZoom')}
          onClick={() => viewport.resetZoom()}
          style={{ ...iconButtonStyle, width: 46, color: TEXT_MUTED }}
        >
          {`${Math.round(zoom * 100)}%`}
        </button>
        <button
          type="button"
          data-testid="gantt-zoom-in"
          aria-label={t('gantt.zoomIn')}
          onClick={() => viewport.zoomIn()}
          style={iconButtonStyle}
        >
          <Icon name="zoom-in" />
        </button>

        <span style={{ flex: 1, minWidth: 8 }} />

        <label
          data-testid="gantt-baseline-label"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: TEXT_MUTED, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            data-testid="gantt-baseline-toggle"
            checked={baselineVisible}
            onChange={() => viewport.toggleBaseline()}
          />
          {t('baseline')}
        </label>
      </div>

      <div style={{ display: 'flex', height: canvasHeight, minHeight: 0 }}>
        <GanttTable
          lane={lane}
          rows={visibleRows}
          window={rowWindow}
          rowHeight={rowHeight}
          laneHeight={laneHeight}
          bodyRowCount={body.length}
          scrollTop={state.scrollTop}
          width={GANTT_TABLE_WIDTH}
          height={canvasHeight}
          t={t}
        />
        <GanttCanvas
          model={model}
          rows={visibleRows}
          lane={lane}
          window={rowWindow}
          columnWindow={columnWindow}
          zoom={zoom}
          baselineVisible={baselineVisible}
          scrollLeft={state.scrollLeft}
          t={t}
          onScroll={handleScroll}
          onZoomWheel={handleZoomWheel}
        />
      </div>
    </div>
  )
}

const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 24,
  padding: 0,
  fontSize: 12,
  color: TEXT,
  background: '#FFFFFF',
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  cursor: 'pointer',
}

export default GanttView
