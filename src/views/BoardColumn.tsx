// T15 · BoardColumn：看板的固定一列（todo/doing/review/done）。
//
// 列头三项（spec 6.1）：列名 + 计数 + 该列完成比。完成比口径取「该列任务的
// 平均完成度」——按 status 定义的列里「已完成数/本列数」对 todo/doing/review
// 三列恒为 0，只有平均进度能给出随列变化的真实完成比；done 列因 CommandBus
// 把 status=done 的进度强压到 100，该列恒显示 100%，读数自洽。
//
// 列体是 dnd-kit 放置区（useDroppable）：拖到列内空白处即落到列尾。
// 列内卡片由 SortableContext 管理同列换序。归档任务不渲染、筛选结果驱动列内容
// 都由 BoardView 在上游保证（QueryEngine 默认排除归档）。

import type { CSSProperties } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import type { Status, Task, Topic } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { TaskCard } from './TaskCard'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'

/** 列 droppable 的 id 前缀；与任务 id 空间隔离，避免误判成卡片。 */
export const COLUMN_DROPPABLE_PREFIX = 'column:'

export interface BoardColumnProps {
  status: Status
  /** 列名（已本地化，通常取 t(`status.${status}`)）。 */
  title: string
  /** 本列任务，已按 order 升序（BoardView 用 boardDnd.sortByOrder 排好）。 */
  tasks: readonly Task[]
  topicsById: ReadonlyMap<string, Topic>
  /** 被未完成前置阻塞的任务 id 集合（仅 doing/review 列会非空）。 */
  blockedIds: ReadonlySet<string>
  /** 任务 id → 直接前置数量。 */
  dependencyCountById: ReadonlyMap<string, number>
  /** 判定逾期的今天（YYYY-MM-DD）。 */
  today: string
  t: (key: MsgKey, params?: TranslateParams) => string
  onOpenTask?: (taskId: string) => void
}

/** 该列平均完成度（0-100 整数）；空列返回 null（列头显示 —）。 */
export function columnProgressRatio(tasks: readonly Task[]): number | null {
  if (tasks.length === 0) return null
  let sum = 0
  for (const task of tasks) {
    const progress = Number.isFinite(task.progress) ? Math.min(100, Math.max(0, task.progress)) : 0
    sum += progress
  }
  return Math.round(sum / tasks.length)
}

export function BoardColumn(props: BoardColumnProps) {
  const { status, title, tasks, topicsById, blockedIds, dependencyCountById, today, t } = props

  const { setNodeRef, isOver } = useDroppable({
    id: `${COLUMN_DROPPABLE_PREFIX}${status}`,
    data: { type: 'column', status },
  })

  const ratio = columnProgressRatio(tasks)
  const ratioText = ratio === null ? '—' : `${ratio}%`

  const headerCountStyle: CSSProperties = {
    padding: '0 7px',
    fontSize: 11,
    lineHeight: '18px',
    color: 'var(--oe-text-secondary)',
    background: 'var(--oe-surface)',
    border: `1px solid ${BORDER}`,
    borderRadius: 999,
  }

  return (
    <section
      data-testid={`board-column-${status}`}
      data-status={status}
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--oe-fill)',
        border: `1px solid ${BORDER}`,
        borderRadius: 'var(--oe-radius-card)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>{title}</span>
        <span data-testid={`board-column-count-${status}`} style={headerCountStyle}>
          {tasks.length}
        </span>
        <span style={{ flex: 1 }} />
        <span
          data-testid={`board-column-ratio-${status}`}
          title={t('card.progressRatio')}
          style={{ fontSize: 12, color: MUTED }}
        >
          {ratioText}
        </span>
      </header>

      <div
        ref={setNodeRef}
        data-testid={`board-dropzone-${status}`}
        data-dragover={isOver ? 'true' : 'false'}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          background: isOver ? 'var(--oe-fill-subtle)' : 'transparent',
          borderRadius: '0 0 var(--oe-radius-card) var(--oe-radius-card)',
        }}
      >
        <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              topic={topicsById.get(task.topicId)}
              dependencyCount={dependencyCountById.get(task.id) ?? 0}
              blocked={blockedIds.has(task.id)}
              today={today}
              t={t}
              onOpenTask={props.onOpenTask}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 ? (
          <div
            data-testid={`board-column-empty-${status}`}
            style={{ padding: '24px 0', textAlign: 'center', fontSize: 12, color: MUTED }}
          >
            {t('board.emptyColumn')}
          </div>
        ) : null}
      </div>
    </section>
  )
}

export default BoardColumn
