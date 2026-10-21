// T20 · GanttTable：甘特图左侧固定任务表（spec 5.4：任务 / 开始 / 结束 / 进度）。
//
// 与画布共用同一份行窗口与行高，纵向位移由画布的 scrollTop 驱动（表自身不滚动），
// 因此两边的行永远对齐。里程碑轨道的行在这里也占一行，且不参与画布的滚动计算之外的对齐逻辑。

import { GANTT_HEADER_HEIGHT } from '../controllers/ganttViewport'
import type { GanttRowWindow } from '../controllers/ganttViewport'
import type { GanttRow } from '../domain/ganttModel'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { fs, sp, px } from '../styles/scale'

const TEXT = 'var(--oe-text)'
const TEXT_MUTED = 'var(--oe-text-muted)'
const LANE_FILL = 'var(--oe-lane-fill)'
const DEFAULT_TOPIC_COLOR = '#5E5CE6'

/** 日期列：11px 等宽数字的 `YYYY-MM-DD` 约 62px，再加 10px 列间距才不会与下一列粘连。 */
const DATE_WIDTH = 74
const DATE_GUTTER = 10
const PROGRESS_WIDTH = 52

export interface GanttTableProps {
  /** 顶部轨道的跨 topic 里程碑行 */
  lane: readonly GanttRow[]
  /** 已按窗口切好的 body 行 */
  rows: readonly GanttRow[]
  window: GanttRowWindow
  rowHeight: number
  laneHeight: number
  /** body 行总数（= 模型行数 - 轨道行数），用来撑出与画布一致的滚动内容高度 */
  bodyRowCount: number
  scrollTop: number
  width: number
  height: number
  t: (key: MsgKey, params?: TranslateParams) => string
}

function Swatch(props: { color: string | null }) {
  return (
    <span
      data-gantt-swatch="true"
      style={{
        width: sp(8),
        height: sp(8),
        flex: px('0 0 8px'),
        borderRadius: '50%',
        background: props.color ?? DEFAULT_TOPIC_COLOR,
      }}
    />
  )
}

function Row(props: { row: GanttRow; top: number; height: number; t: GanttTableProps['t'] }) {
  const { row } = props
  const progress = row.task === null ? null : `${row.task.progress}%`
  const start = row.task?.start ?? (row.milestone === null ? '' : row.milestone.date)
  const due = row.task?.due ?? ''
  const indent = row.depth > 0 ? 18 : 8

  return (
    <div
      data-gantt-table-row={row.id}
      data-row-kind={row.kind}
      style={{
        position: 'absolute',
        top: props.top,
        left: 0,
        right: 0,
        height: props.height,
        display: 'flex',
        alignItems: 'center',
        boxSizing: 'border-box',
        borderBottom: '1px solid var(--oe-separator)',
        fontSize: fs(12),
        color: TEXT,
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: sp(6),
          paddingLeft: indent,
          paddingRight: sp(6),
        }}
      >
        {row.kind === 'milestone' ? (
          <span
            data-gantt-table-diamond="true"
            style={{
              width: sp(8),
              height: sp(8),
              flex: px('0 0 8px'),
              background: row.color ?? DEFAULT_TOPIC_COLOR,
              transform: 'rotate(45deg)',
            }}
          />
        ) : (
          <Swatch color={row.color} />
        )}
        <span
          style={{
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            fontWeight: row.kind === 'topic' ? 600 : 400,
          }}
        >
          {row.label}
        </span>
      </div>
      <div
        style={{
          width: sp(DATE_WIDTH),
          color: TEXT_MUTED,
          flex: `0 0 ${sp(DATE_WIDTH)}`,
          paddingRight: sp(DATE_GUTTER),
          boxSizing: 'border-box',
          whiteSpace: 'nowrap',
          fontSize: fs(11),
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {start}
      </div>
      <div
        style={{
          width: sp(DATE_WIDTH),
          color: TEXT_MUTED,
          flex: `0 0 ${sp(DATE_WIDTH)}`,
          paddingRight: sp(DATE_GUTTER),
          boxSizing: 'border-box',
          whiteSpace: 'nowrap',
          fontSize: fs(11),
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {due}
      </div>
      <div
        style={{
          width: sp(PROGRESS_WIDTH),
          flex: `0 0 ${sp(PROGRESS_WIDTH)}`,
          textAlign: 'right',
          paddingRight: sp(8),
          color: TEXT_MUTED,
        }}
      >
        {progress}
      </div>
    </div>
  )
}

export function GanttTable(props: GanttTableProps) {
  const { t, lane, rows, window: rowWindow, rowHeight, laneHeight } = props
  const totalHeight = laneHeight + props.bodyRowCount * rowHeight

  return (
    <div
      data-testid="gantt-table"
      style={{
        width: props.width,
        flex: `0 0 ${props.width}px`,
        height: props.height,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--oe-surface)',
        borderRight: '1px solid var(--oe-separator)',
        boxSizing: 'border-box',
      }}
    >
      <div
        data-testid="gantt-table-header"
        style={{
          height: sp(GANTT_HEADER_HEIGHT),
          flex: `0 0 ${sp(GANTT_HEADER_HEIGHT)}`,
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid var(--oe-separator)',
          fontSize: fs(11),
          color: TEXT_MUTED,
          boxSizing: 'border-box',
        }}
      >
        <div data-gantt-table-col="task" style={{ flex: 1, minWidth: 0, paddingLeft: sp(8) }}>
          {t('gantt.task')}
        </div>
        <div
          data-gantt-table-col="start"
          style={{ width: sp(DATE_WIDTH), flex: `0 0 ${sp(DATE_WIDTH)}`, paddingRight: sp(DATE_GUTTER), boxSizing: 'border-box' }}
        >
          {t('gantt.start')}
        </div>
        <div
          data-gantt-table-col="end"
          style={{ width: sp(DATE_WIDTH), flex: `0 0 ${sp(DATE_WIDTH)}`, paddingRight: sp(DATE_GUTTER), boxSizing: 'border-box' }}
        >
          {t('gantt.end')}
        </div>
        <div
          data-gantt-table-col="progress"
          style={{ width: sp(PROGRESS_WIDTH), flex: `0 0 ${sp(PROGRESS_WIDTH)}`, textAlign: 'right', paddingRight: sp(8) }}
        >
          {t('gantt.progress')}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        <div
          data-testid="gantt-table-body"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: totalHeight,
            transform: `translateY(-${props.scrollTop}px)`,
          }}
        >
          {lane.length === 0 ? null : (
            <div
              data-gantt-table-lane="true"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: laneHeight,
                display: 'flex',
                alignItems: 'center',
                gap: sp(6),
                paddingLeft: sp(8),
                boxSizing: 'border-box',
                background: LANE_FILL,
                borderBottom: '1px solid var(--oe-separator)',
                fontSize: fs(12),
                fontWeight: 600,
                color: TEXT,
              }}
            >
              <span
                data-gantt-table-diamond="true"
                style={{ width: sp(8), height: sp(8), flex: px('0 0 8px'), background: DEFAULT_TOPIC_COLOR, transform: 'rotate(45deg)' }}
              />
              <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {t('gantt.crossTopicMilestone')}
              </span>
              <span style={{ color: TEXT_MUTED }}>{lane.length}</span>
            </div>
          )}

          {rows.map((row, index) => (
            <Row
              key={`table-${row.id}`}
              row={row}
              top={laneHeight + (rowWindow.startRow + index) * rowHeight}
              height={rowHeight}
              t={t}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
