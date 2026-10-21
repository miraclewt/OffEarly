// T15 · TaskCard：看板卡片，C 方案（spec 6.1 / §7，效果图 03/04）。
//
// 卡片信息刻意克制为 6 项（spec §7「信息密度」上限）：
//   ① 话题色点 + 话题名  ② 标题  ③ 类别 chip  ④ 优先级点
//   ⑤ 到期日（逾期转 --oe-overdue）  ⑥ 依赖角标（前置数量）
// 有笔记时加一个线性文档图标；**无任何条纹 / 无整卡底色**（Global Constraints：
// 禁左色条 / 禁顶线 / 禁话题色整卡底色——那是方案 D，产品"简洁"主张的硬约束）。
//
// 拖拽由 dnd-kit useSortable 驱动；点击只暴露 onOpenTask(taskId) 回调
// （TaskDrawer 是 T17，这里不 import 任何尚不存在的组件）。
//
// 颜色一律取 theme.css 的 --oe-* token，不写死 hex（唯一例外是 SVG 呈现属性，
// 而本组件只有 CSS 内联样式）。优先级点的三色梯度复用既有语义 token：
// P0=逾期红 / P1=阻塞琥珀边 / P2=完成绿 / P3=弱化灰——效果图 01 的
// 「高→红橙、中→琥珀、低→绿」梯度即此映射（P3 无效果图样例，取最弱一档）。

import { memo } from 'react'
import type { CSSProperties } from 'react'
import { useSortable } from '@dnd-kit/sortable'

import type { Priority, Task, Topic } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { Icon } from './IconSprite'
import { fs, px, sp } from '../styles/scale'

const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'
const FAINT = 'var(--oe-text-faint)'
const SURFACE = 'var(--oe-surface)'
const OVERDUE = 'var(--oe-overdue)'

/** 优先级点：四档梯度，全部取自既有 token（不在本任务扩 theme.css）。 */
const PRIORITY_DOT: Record<Priority, string> = {
  P0: 'var(--oe-overdue)',
  P1: 'var(--oe-blocked-border)',
  P2: 'var(--oe-done)',
  P3: 'var(--oe-text-faint)',
}

/** 琥珀阻塞标记（theme.css 的阻塞三件套中此处用两件套：文字色 + 浅底）。 */
const BLOCKED_COLOR = 'var(--oe-blocked)'
const BLOCKED_BG = 'var(--oe-blocked-bg)'

export interface TaskCardProps {
  task: Task
  /** 所属话题；话题被删/归档时退化显示（色点转灰、话题名留空）。 */
  topic: Topic | undefined
  /** 直接前置数量（依赖角标计数，来自 DependencyGraph.blockedBy）。 */
  dependencyCount: number
  /** 是否存在未完成前置（doing/review 列据此显示琥珀阻塞标记）。 */
  blocked: boolean
  /** 判定逾期的今天（YYYY-MM-DD）；由 BoardView 注入以便测试确定化。 */
  today: string
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 点击卡片（打开详情弹窗，T17 接线）；键盘 Enter/Space 同样触发。 */
  onOpenTask?: (taskId: string) => void
  style?: CSSProperties
}

/** 逾期：有到期日、尚未 done、到期日早于今天（与 QueryEngine 的 isOverdue 同口径）。 */
export function isOverdue(task: Task, today: string): boolean {
  if (!task.due) return false
  if (task.status === 'done') return false
  return task.due < today
}

/** dnd-kit 排序位移 → CSS transform。不引 @dnd-kit/utilities（传递依赖，
 * 且 sortable 的 transform 只有 x/y，手拼即可，少一个直接依赖）。 */
function toTransform(transform: { x: number; y: number } | null): string | undefined {
  if (transform === null) return undefined
  return `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
}

/**
 * 卡片是 memo 的：看板一次变更要把整列重渲染，而绝大多数卡片的入参没变
 * （task 对象来自不可变更新，未改动的任务引用不变）。不 memo 时新建一张卡
 * 会连带重渲染全部卡片 + 全部 useSortable 订阅者，库稍大就是几十毫秒的掉帧。
 * 调用方必须保证 `t` / `onOpenTask` 引用稳定，否则 memo 白做。
 */
export const TaskCard = memo(function TaskCard(props: TaskCardProps) {
  const { task, topic, dependencyCount, blocked, today, t } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })

  const overdue = isOverdue(task, today)
  const hasNote = task.note.trim() !== ''
  const topicColor = topic?.color ?? FAINT

  const cardStyle: CSSProperties = {
    // C 方案：白底卡片 + 发丝边框 + 12px 圆角 + 静态双层柔影；左色条 / 顶线 / 话题色整卡底色一律没有
    background: SURFACE,
    border: '0.5px solid var(--oe-card-border)',
    borderRadius: 'var(--oe-radius-card)',
    boxShadow: 'var(--oe-shadow-card)',
    padding: `${sp(10)} ${sp(12)}`,
    cursor: 'grab',
    transform: toTransform(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    ...props.style,
  }

  return (
    <div
      {...listeners}
      {...attributes}
      ref={setNodeRef}
      data-testid={`task-card-${task.id}`}
      data-task-id={task.id}
      data-status={task.status}
      data-kind={task.kind}
      data-priority={task.priority}
      data-blocked={blocked ? 'true' : 'false'}
      data-overdue={overdue ? 'true' : 'false'}
      data-has-note={hasNote ? 'true' : 'false'}
      data-deps={dependencyCount}
      className="oe-card"
      role="button"
      tabIndex={0}
      aria-label={task.title}
      style={cardStyle}
      onClick={() => {
        props.onOpenTask?.(task.id)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpenTask?.(task.id)
        }
      }}
    >
      {/* 第一行：标题 + 右上角标（琥珀阻塞标记 / 依赖角标） */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: sp(6) }}>
        <span
          title={task.title}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: fs(13),
            fontWeight: 600,
            lineHeight: 1.4,
            color: TEXT,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {task.title}
        </span>

        {blocked ? (
          <span
            data-testid={`task-blocked-${task.id}`}
            title={t('card.blockedHint')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              flex: '0 0 auto',
              padding: `0 ${sp(6)}`,
              fontSize: fs(11),
              lineHeight: sp(16),
              color: BLOCKED_COLOR,
              background: BLOCKED_BG,
              borderRadius: sp(6),
            }}
          >
            {t('card.blocked')}
          </span>
        ) : null}

        <span
          data-testid={`task-deps-${task.id}`}
          title={dependencyCount > 0 ? t('card.blockedBy', { n: dependencyCount }) : t('card.noDependency')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: sp(3),
            flex: '0 0 auto',
            color: MUTED,
            fontSize: fs(11),
          }}
        >
          <Icon name="dependency" size={14} />
          <span>{dependencyCount}</span>
        </span>
      </div>

      {/* 第二行 meta：话题色点+话题名 / 类别 chip / 优先级点 / 到期日 / 笔记图标 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: sp(6), marginTop: sp(6) }}>
        <span
          data-testid={`task-topic-dot-${task.id}`}
          data-color={topicColor}
          title={topic?.name}
          style={{
            width: sp(8),
            height: sp(8),
            flex: px('0 0 8px'),
            borderRadius: '50%',
            background: topicColor,
          }}
        />
        <span
          style={{
            fontSize: fs(11),
            color: MUTED,
            maxWidth: sp(96),
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {topic?.name ?? ''}
        </span>

        <span
          data-testid={`task-kind-${task.id}`}
          style={{
            padding: `0 ${sp(6)}`,
            fontSize: fs(11),
            lineHeight: sp(16),
            color: 'var(--oe-text-secondary)',
            background: 'var(--oe-fill)',
            borderRadius: sp(6),
          }}
        >
          {t(`card.kind.${task.kind}` as MsgKey)}
        </span>

        <span style={{ flex: 1 }} />

        <span
          data-testid={`task-priority-${task.id}`}
          data-priority={task.priority}
          title={task.priority}
          style={{
            width: sp(8),
            height: sp(8),
            flex: px('0 0 8px'),
            borderRadius: '50%',
            background: PRIORITY_DOT[task.priority],
          }}
        />

        {task.due === undefined ? null : (
          <span
            data-testid={`task-due-${task.id}`}
            data-overdue={overdue ? 'true' : 'false'}
            title={task.due}
            style={{
              fontSize: fs(11),
              color: overdue ? OVERDUE : MUTED,
              fontWeight: overdue ? 600 : 400,
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {task.due}
          </span>
        )}

        {hasNote ? (
          <span
            data-testid={`task-note-${task.id}`}
            title={t('card.hasNote')}
            style={{ display: 'inline-flex', flex: '0 0 auto', color: FAINT }}
          >
            <Icon name="note" size={13} />
          </span>
        ) : null}
      </div>
    </div>
  )
})

export default TaskCard
