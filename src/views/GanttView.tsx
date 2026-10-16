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
import { exportGanttChart, probePngSupport } from './GanttExporter'
import type { GanttExportFormat, GanttExportRange } from './GanttExporter'
import { GanttCanvas } from './GanttCanvas'
import { GanttTable } from './GanttTable'
import { Icon } from './IconSprite'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const TEXT_MUTED = 'var(--oe-text-muted)'
const INDIGO = 'var(--oe-accent)'
const TOOLBAR_HEIGHT = 36

const BODY_FONT = 'var(--oe-font)'

/** T23 导出入口的常量顺序与文案键：集中在这里，避免 JSX 里散落字符串。 */
const EXPORT_FORMAT_ORDER: GanttExportFormat[] = ['png', 'svg', 'csv']
const EXPORT_FORMAT_LABEL: Record<GanttExportFormat, MsgKey> = {
  png: 'ganttExport.png',
  svg: 'ganttExport.svg',
  csv: 'ganttExport.csv',
}
const EXPORT_RANGE_ORDER: GanttExportRange[] = ['visible', 'full']
const EXPORT_RANGE_LABEL: Record<GanttExportRange, MsgKey> = {
  visible: 'ganttExport.rangeVisible',
  full: 'ganttExport.rangeFull',
}

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

  // T21：「关键路径」开关，默认开。计算在领域层（criticalPath）已完成，这里只做投影与开关——
  // 关闭时不加粗、不展示计算结果。状态留在本组件（基线开关在 viewport 控制器里，两者刻意分开：
  // 基线是「看哪一层」的视口属性，关键路径是「是否展示计算结果」的呈现开关）。
  const [criticalPathVisible, setCriticalPathVisible] = useState(true)

  // T23：导出入口状态。默认「仅可见区 + PNG」；pngSupported 为 null 表示探针还在跑。
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<GanttExportFormat>('png')
  const [exportRange, setExportRange] = useState<GanttExportRange>('visible')
  const [pngSupported, setPngSupported] = useState<boolean | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportHint, setExportHint] = useState<string | null>(null)

  // R3 探针（spec 5.5）：挂载时跑一次最小 SVG → Canvas → toBlob。不可用就把 PNG 选项禁用并
  // 提示，而不是等用户点下去才失败。jsdom 里没有真 2d 上下文，探针会如常返回 false。
  useEffect(() => {
    let alive = true
    void probePngSupport().then((supported) => {
      if (alive) setPngSupported(supported)
    })
    return () => {
      alive = false
    }
  }, [])

  const model = useMemo(
    () => buildGanttModel(vault, filter, state.scale, { today: props.today, range: props.range }),
    [vault, filter, state.scale, props.today, props.range],
  )

  const { lane, body } = useMemo(() => splitMilestoneLane(model.rows), [model])
  const rowHeight = model.rowHeight
  const laneHeight = lane.length > 0 ? rowHeight : 0
  const zoom = zoomFactorAt(state.zoomIndex[state.scale])
  const baselineVisible = state.baselineVisible

  /**
   * T23：三种格式共用一条出口。内容一律从当前模型投影（CSV 的行/日期/进度/依赖也直接读模型），
   * 只有「仅可见区」需要把视口状态透传下去。PNG 失败（R3 前提被破坏）时禁用该格式并提示。
   */
  const handleExportConfirm = useCallback(() => {
    setExportHint(null)
    setExporting(true)
    void exportGanttChart({
      model,
      format: exportFormat,
      range: exportRange,
      viewport: { scrollTop: state.scrollTop, scrollLeft: state.scrollLeft, width: state.width, height: state.height, zoom },
      baselineVisible,
      criticalPathVisible,
      csvHeaders: {
        task: t('gantt.task'),
        start: t('gantt.start'),
        end: t('gantt.end'),
        progress: t('gantt.progress'),
        dependency: t('dependency'),
      },
      todayLabel: t('gantt.today'),
    })
      .then((result) => {
        setExportMenuOpen(false)
        setExportHint(t('shell.exported', { name: result.filename }))
      })
      .catch(() => {
        if (exportFormat === 'png') setPngSupported(false)
        setExportHint(t('ganttExport.failed'))
      })
      .finally(() => {
        setExporting(false)
      })
  }, [
    model,
    exportFormat,
    exportRange,
    state.scrollTop,
    state.scrollLeft,
    state.width,
    state.height,
    zoom,
    baselineVisible,
    criticalPathVisible,
    t,
  ])

  const exportDisabled = exporting || (exportFormat === 'png' && pngSupported === false)

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
          color: active ? 'var(--oe-on-accent)' : TEXT,
          background: active ? INDIGO : 'var(--oe-surface)',
          border: `1px solid ${active ? INDIGO : BORDER}`,
          borderRadius: 'var(--oe-radius-control)',
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
        background: 'var(--oe-surface)',
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

        {/* T21：关键路径高亮开关（默认开） */}
        <label
          data-testid="gantt-critical-label"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: TEXT_MUTED, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            data-testid="gantt-critical-toggle"
            checked={criticalPathVisible}
            onChange={() => setCriticalPathVisible((visible) => !visible)}
          />
          {t('criticalPath')}
        </label>

        {/* T23：导出反馈（成功/失败）；PNG 不可用的说明放在弹层内靠近该格式处 */}
        {exportHint === null ? null : (
          <span data-testid="gantt-export-hint" style={{ fontSize: 12, color: TEXT_MUTED, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {exportHint}
          </span>
        )}

        {/* T23：导出入口 —— 选格式（PNG / SVG / CSV）与范围（仅可见区 / 全时间跨度） */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <button
            type="button"
            data-testid="gantt-export-button"
            aria-label={t('ganttExport.button')}
            aria-haspopup="dialog"
            aria-expanded={exportMenuOpen}
            onClick={() => setExportMenuOpen((open) => !open)}
            style={iconButtonStyle}
          >
            <Icon name="download" />
          </button>

          {exportMenuOpen ? (
            <div
              data-testid="gantt-export-menu"
              role="dialog"
              aria-label={t('ganttExport.button')}
              style={{
                position: 'absolute',
                top: 26,
                right: 0,
                zIndex: 5,
                width: 198,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: 10,
                boxSizing: 'border-box',
                background: 'var(--oe-surface)',
                border: `1px solid ${BORDER}`,
                borderRadius: 'var(--oe-radius-card)',
                boxShadow: 'var(--oe-shadow-hover)',
                color: TEXT,
              }}
            >
              <div style={{ fontSize: 12, color: TEXT_MUTED }}>{t('ganttExport.format')}</div>
              <div role="radiogroup" aria-label={t('ganttExport.format')} style={{ display: 'flex', gap: 6 }}>
                {EXPORT_FORMAT_ORDER.map((format) => {
                  const disabled = format === 'png' && pngSupported === false
                  return (
                    <button
                      key={format}
                      type="button"
                      role="radio"
                      aria-checked={exportFormat === format}
                      data-testid={`gantt-export-format-${format}`}
                      disabled={disabled}
                      onClick={() => setExportFormat(format)}
                      style={{
                        ...exportChipStyle,
                        ...(exportFormat === format ? exportChipActiveStyle : null),
                        ...(disabled ? exportChipDisabledStyle : null),
                      }}
                    >
                      {t(EXPORT_FORMAT_LABEL[format])}
                    </button>
                  )
                })}
              </div>

              <div style={{ fontSize: 12, color: TEXT_MUTED }}>{t('ganttExport.range')}</div>
              <div role="radiogroup" aria-label={t('ganttExport.range')} style={{ display: 'flex', gap: 6 }}>
                {EXPORT_RANGE_ORDER.map((range) => (
                  <button
                    key={range}
                    type="button"
                    role="radio"
                    aria-checked={exportRange === range}
                    data-testid={`gantt-export-range-${range}`}
                    onClick={() => setExportRange(range)}
                    style={{ ...exportChipStyle, ...(exportRange === range ? exportChipActiveStyle : null) }}
                  >
                    {t(EXPORT_RANGE_LABEL[range])}
                  </button>
                ))}
              </div>

              {pngSupported === false ? (
                <div data-testid="gantt-export-png-hint" style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--oe-blocked)' }}>
                  {t('ganttExport.pngUnsupported')}
                </div>
              ) : null}

              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  data-testid="gantt-export-cancel"
                  onClick={() => setExportMenuOpen(false)}
                  style={exportChipStyle}
                >
                  {t('ganttExport.cancel')}
                </button>
                <button
                  type="button"
                  data-testid="gantt-export-confirm"
                  disabled={exportDisabled}
                  onClick={handleExportConfirm}
                  style={{
                    ...exportChipStyle,
                    ...exportChipActiveStyle,
                    ...(exportDisabled ? exportChipDisabledStyle : null),
                  }}
                >
                  {exporting ? t('safemode.busy') : t('ganttExport.confirm')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
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
          criticalPathVisible={criticalPathVisible}
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
  background: 'var(--oe-surface)',
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

// T23 导出弹层的选项 chip（格式 / 范围 / 取消 / 导出共用一套）
const exportChipStyle: CSSProperties = {
  padding: '2px 8px',
  fontSize: 12,
  lineHeight: '18px',
  color: TEXT,
  background: 'var(--oe-surface)',
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

const exportChipActiveStyle: CSSProperties = {
  color: 'var(--oe-on-accent)',
  background: INDIGO,
  border: `1px solid ${INDIGO}`,
}

const exportChipDisabledStyle: CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
}

export default GanttView
