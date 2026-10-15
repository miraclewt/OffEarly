// T19 · GanttModel：甘特图领域模型纯函数模块。
// 零 React / 零 DOM / 零 I/O；几何（列 x / 条宽 / 箭头拐点）全部在这里算完，视图层只做投影（spec 5.1）。
// 渲染、导出、单测共用同一份模型。

import dayjs from 'dayjs'

import { createDependencyGraph } from './dependencyGraph'
import { createQueryEngine } from './queryEngine'
import { createScheduleEngine, toDateKey } from './scheduleEngine'
import { createTopicTree } from './topicTree'
import type { Dependency, DependencyType, Filter, Milestone, Task, Topic, Vault } from './types'

export type GanttScale = 'day' | 'week'

/** 行高固定 32px（spec 5.4）；刻度只改列宽，不改行高。 */
export const GANTT_ROW_HEIGHT = 32

export interface GanttViewport {
  /** 视口锚定的「今天」（YYYY-MM-DD）；默认取本地当天，注入以便测试确定化。 */
  today?: string
  /** 显式指定时间范围；缺省或单侧缺省时按已排期数据自动求值，不做 padding。 */
  range?: { start?: string; end?: string }
  /** 数据派生范围两端各留几天（默认 3）；只在未显式给出 range 的一侧生效。 */
  paddingDays?: number
}

export interface GanttColumn {
  date: string
  /** day 刻度 32px、week 刻度 14px（spec 5.4） */
  x: number
  width: number
  isWeekend: boolean
  isHoliday: boolean
  isExtraWorkday: boolean
  /** 综合周末/节假日/补班后的最终判定 */
  isWorkday: boolean
  isToday: boolean
  isMonthStart: boolean
  isWeekStart: boolean
}

export interface GanttHeaderCell {
  label: string
  x: number
  width: number
}

export interface GanttBar {
  x: number
  y: number
  width: number
  height: number
  /** 深色进度内条宽度 = width × progress% */
  progressWidth: number
}

export type GanttRowKind = 'topic' | 'task' | 'milestone'

export interface GanttRow {
  kind: GanttRowKind
  id: string
  label: string
  /** 展开层级：topic 头为 0，其任务为 1，里程碑轨道为 0 */
  depth: number
  rowIndex: number
  y: number
  height: number
  topicId: string | null
  color: string | null
  task: Task | null
  milestone: Milestone | null
  /** 主条几何；分组头、或落在视口外的任务为 null */
  bar: GanttBar | null
  /** 基线细灰条；无 baseline 时为 null */
  baseline: GanttBar | null
  critical: boolean
  blocked: boolean
}

export interface DependencyArrow {
  id: string
  from: string
  to: string
  type: DependencyType
  /** 两端都在关键路径上才算关键箭头 */
  critical: boolean
  points: Array<{ x: number; y: number }>
  /** 已拼好的 SVG path d，视图可直接绑到 <path> */
  path: string
}

export interface GanttModel {
  scale: GanttScale
  range: { start: string; end: string }
  columns: GanttColumn[]
  /** 两级表头：day 刻度为 [月, 日]，week 刻度为 [月, 周] */
  headerRows: GanttHeaderCell[][]
  rows: GanttRow[]
  arrows: DependencyArrow[]
  today: string
  criticalIds: Set<string>
  /** 依赖成环时非空；此时 criticalIds 为 emptySet（spec 5.3 降级） */
  cycles: string[][]
  /** 未排期任务：start 或 due 缺失，进右侧折叠面板而非 rows */
  unscheduled: Task[]
  /** 画布总宽 = columns.length × 列宽 */
  width: number
  rowHeight: number
}

const TASK_BAR_HEIGHT = 14
const BASELINE_BAR_HEIGHT = 4
const MILESTONE_SIZE = 12
const ARROW_GAP = 10

function cellWidthOf(scale: GanttScale): number {
  return scale === 'day' ? 32 : 14
}

function labelOf(date: string): string {
  return date.slice(5)
}

function isoWeekStartOf(date: string): string {
  const d = dayjs(date)
  const dow = d.day()
  const delta = dow === 0 ? -6 : 1 - dow
  return d.add(delta, 'day').format('YYYY-MM-DD')
}

/** 取数据派生范围：已排期任务与里程碑的 [最早 start, 最晚 due|date]。 */
function deriveRange(tasks: readonly Task[], milestones: readonly Milestone[]): { start: string; end: string } | null {
  let start: string | null = null
  let end: string | null = null
  const take = (from: string | undefined, to: string | undefined): void => {
    if (from && (start === null || from < start)) start = from
    if (to && (end === null || to > end)) end = to
  }
  for (const task of tasks) {
    if (task.start && task.due) take(task.start, task.due)
  }
  for (const milestone of milestones) take(milestone.date, milestone.date)
  return start !== null && end !== null ? { start, end } : null
}

function inScope(scope: Set<string> | null, topicId: string | null): boolean {
  if (topicId === null) return true
  return scope === null || scope.has(topicId)
}

function clampBar(
  start: string,
  end: string,
  index: Map<string, number>,
  cellWidth: number,
  columnCount: number,
  y: number,
  height: number,
  progressWidth: (width: number) => number,
): GanttBar | null {
  const rawStart = index.get(start)
  const rawEnd = index.get(end)
  if (rawStart === undefined || rawEnd === undefined) return null
  const from = Math.max(rawStart, 0)
  const to = Math.min(rawEnd, columnCount - 1)
  if (to < from) return null
  const width = (to - from + 1) * cellWidth
  return { x: from * cellWidth, y, width, height, progressWidth: progressWidth(width) }
}

export function buildGanttModel(
  vault: Vault,
  filter: Filter,
  scale: GanttScale,
  viewport: GanttViewport = {},
): GanttModel {
  const today = viewport.today ?? toDateKey(new Date())
  const calendar = vault.settings.calendar
  const engine = createScheduleEngine(calendar)

  const query = createQueryEngine(vault.topics, vault.tasks, vault.links, {
    today,
    duration: (task) => engine.duration(task) ?? 1,
  })
  const graph = createDependencyGraph(vault.links, vault.tasks, {
    duration: (task) => engine.duration(task) ?? 1,
  })
  const tree = createTopicTree(vault.topics)

  const matched = query.query(filter)

  const scope: Set<string> | null = filter.topicIds.length === 0 ? null : new Set<string>(
    filter.topicIds.flatMap((id) => (filter.includeDescendants ? [...tree.subtreeIds(id)] : [id])),
  )

  // 排期任务才进甘特图；start/due 缺一的进未排期侧栏（spec 5.4）
  const scheduled = matched.filter((task) => Boolean(task.start && task.due))
  const unscheduled = matched.filter((task) => !task.start || !task.due)

  const visibleMilestones = vault.milestones
    .filter((milestone) => inScope(scope, milestone.topicId))
    .slice()
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1))

  const derived = deriveRange(scheduled, visibleMilestones)
  const padding = viewport.paddingDays ?? 3
  const rangeStart =
    viewport.range?.start ?? (derived ? dayjs(derived.start).subtract(padding, 'day').format('YYYY-MM-DD') : today)
  const rangeEnd =
    viewport.range?.end ?? (derived ? dayjs(derived.end).add(padding, 'day').format('YYYY-MM-DD') : today)

  const cellWidth = cellWidthOf(scale)
  const columnDates: string[] = []
  for (let cursor = dayjs(rangeStart); !cursor.isAfter(dayjs(rangeEnd), 'day'); cursor = cursor.add(1, 'day')) {
    columnDates.push(cursor.format('YYYY-MM-DD'))
  }
  const index = new Map<string, number>()
  columnDates.forEach((date, i) => index.set(date, i))

  const columns: GanttColumn[] = columnDates.map((date, i) => {
    const dow = dayjs(date).day()
    const isWeekend = !calendar.workdays.includes(dow)
    const isHoliday = calendar.holidays.includes(date)
    const isExtraWorkday = calendar.extraWorkdays.includes(date)
    return {
      date,
      x: i * cellWidth,
      width: cellWidth,
      isWeekend,
      isHoliday,
      isExtraWorkday,
      isWorkday: engine.isWorkday(date),
      isToday: date === today,
      isMonthStart: i === 0 || columnDates[i - 1]!.slice(0, 7) !== date.slice(0, 7),
      isWeekStart: i === 0 || isoWeekStartOf(date) === date,
    }
  })

  // 两级表头：首行按自然月合并，次行按天号或周一日期
  const monthCells: GanttHeaderCell[] = []
  for (const column of columns) {
    const label = column.date.slice(0, 7)
    const last = monthCells[monthCells.length - 1]
    if (last && last.label === label) {
      last.width += column.width
    } else {
      monthCells.push({ label, x: column.x, width: column.width })
    }
  }
  const secondCells: GanttHeaderCell[] = []
  if (scale === 'day') {
    for (const column of columns) {
      secondCells.push({ label: column.date.slice(8, 10), x: column.x, width: column.width })
    }
  } else {
    for (const column of columns) {
      if (!column.isWeekStart) {
        const last = secondCells[secondCells.length - 1]
        if (last) last.width += column.width
        continue
      }
      secondCells.push({ label: labelOf(isoWeekStartOf(column.date)), x: column.x, width: column.width })
    }
  }

  const criticalPath = graph.criticalPath()
  const cycles = graph.cycles()
  const criticalIds = criticalPath ?? new Set<string>()

  // rows：先按 topic 树文档序分组（组内任务按 LexoRank 的 order 排序），再挂里程碑独立轨道
  const rows: GanttRow[] = []

  // 话题按 (order, id) 的树序展开；不用 Map 插入序，否则侧栏与甘特的分组顺序会不一致
  const orderedTopics: Topic[] = []
  const collect = (parentId: string | null): void => {
    for (const topic of tree.childrenOf(parentId)) {
      orderedTopics.push(topic)
      collect(topic.id)
    }
  }
  collect(null)
  if (orderedTopics.length < tree.byId.size) {
    // 脏数据成环时树遍历覆盖不到的话题兜底补上，避免整组从甘特图消失
    const seen = new Set(orderedTopics.map((topic) => topic.id))
    const rest = [...tree.byId.values()].filter((topic) => !seen.has(topic.id))
    rest.sort((a, b) => (a.order !== b.order ? (a.order < b.order ? -1 : 1) : a.id < b.id ? -1 : 1))
    orderedTopics.push(...rest)
  }

  const barY = (rowIndex: number): number => rowIndex * GANTT_ROW_HEIGHT + (GANTT_ROW_HEIGHT - TASK_BAR_HEIGHT) / 2

  const pushRow = (row: Omit<GanttRow, 'rowIndex' | 'y' | 'height'>): number => {
    const rowIndex = rows.length
    rows.push({ ...row, rowIndex, y: rowIndex * GANTT_ROW_HEIGHT, height: GANTT_ROW_HEIGHT })
    return rowIndex
  }

  for (const topic of orderedTopics) {
    const own = scheduled
      .filter((task) => task.topicId === topic.id)
      .slice()
      .sort((a, b) => (a.order !== b.order ? (a.order < b.order ? -1 : 1) : a.id < b.id ? -1 : 1))
    if (own.length === 0) continue

    pushRow({
      kind: 'topic',
      id: topic.id,
      label: topic.name,
      depth: 0,
      topicId: topic.id,
      color: topic.color,
      task: null,
      milestone: null,
      bar: null,
      baseline: null,
      critical: false,
      blocked: false,
    })

    for (const task of own) {
      const rowIndex = pushRow({
        kind: 'task',
        id: task.id,
        label: task.title,
        depth: 1,
        topicId: task.topicId,
        color: topic.color,
        task,
        milestone: null,
        bar: null,
        baseline: null,
        critical: criticalIds.has(task.id),
        blocked: graph.isBlocked(task.id),
      })
      const y = barY(rowIndex)
      const row = rows[rowIndex]!
      row.bar = clampBar(task.start!, task.due!, index, cellWidth, columns.length, y, TASK_BAR_HEIGHT, (width) =>
        Math.round((width * task.progress) / 100),
      )
      if (task.baseline?.start && task.baseline.due) {
        row.baseline = clampBar(
          task.baseline.start,
          task.baseline.due,
          index,
          cellWidth,
          columns.length,
          y + TASK_BAR_HEIGHT + 2,
          BASELINE_BAR_HEIGHT,
          () => 0,
        )
      }
    }
  }

  for (const milestone of visibleMilestones) {
    const columnIndex = index.get(milestone.date)
    const rowIndex = pushRow({
      kind: 'milestone',
      id: milestone.id,
      label: milestone.title,
      depth: 0,
      topicId: milestone.topicId,
      color: milestone.color ?? null,
      task: null,
      milestone,
      bar: null,
      baseline: null,
      critical: false,
      blocked: false,
    })
    if (columnIndex === undefined) continue
    const centerX = columnIndex * cellWidth + cellWidth / 2
    rows[rowIndex]!.bar = {
      x: centerX - MILESTONE_SIZE / 2,
      y: rowIndex * GANTT_ROW_HEIGHT + (GANTT_ROW_HEIGHT - MILESTONE_SIZE) / 2,
      width: MILESTONE_SIZE,
      height: MILESTONE_SIZE,
      progressWidth: 0,
    }
  }

  // arrows：FS 语义「前置右端 → 后置左端」，拐点在这里算完
  const rowOfTask = new Map<string, GanttRow>()
  for (const row of rows) if (row.kind === 'task') rowOfTask.set(row.id, row)

  const arrows: DependencyArrow[] = []
  for (const link of vault.links as readonly Dependency[]) {
    const from = rowOfTask.get(link.from)
    const to = rowOfTask.get(link.to)
    if (!from?.bar || !to?.bar) continue
    const sx = from.bar.x + from.bar.width
    const sy = from.bar.y + from.bar.height / 2
    const tx = to.bar.x
    const ty = to.bar.y + to.bar.height / 2

    let points: Array<{ x: number; y: number }>
    if (tx >= sx + ARROW_GAP * 2) {
      const midX = sx + ARROW_GAP
      points = [
        { x: sx, y: sy },
        { x: midX, y: sy },
        { x: midX, y: ty },
        { x: tx, y: ty },
      ]
    } else {
      // 空间不足时绕行：先向右出、再走贴近目标行的横沟、最后从左侧切入
      const outX = sx + ARROW_GAP
      const backX = tx - ARROW_GAP
      const channelY = ty >= sy ? ty - ARROW_GAP : ty + ARROW_GAP
      points = [
        { x: sx, y: sy },
        { x: outX, y: sy },
        { x: outX, y: channelY },
        { x: backX, y: channelY },
        { x: backX, y: ty },
        { x: tx, y: ty },
      ]
    }

    arrows.push({
      id: link.id,
      from: link.from,
      to: link.to,
      type: link.type,
      critical: criticalIds.has(link.from) && criticalIds.has(link.to),
      points,
      path: points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' '),
    })
  }

  return {
    scale,
    range: { start: rangeStart, end: rangeEnd },
    columns,
    headerRows: [monthCells, secondCells],
    rows,
    arrows,
    today,
    criticalIds,
    cycles,
    unscheduled,
    width: columns.length * cellWidth,
    rowHeight: GANTT_ROW_HEIGHT,
  }
}

/** 视图层便捷入口：从 topic 列表取色，未知 topic 返回 null。 */
export function colorOfTopic(topics: readonly Topic[], topicId: string | null): string | null {
  if (topicId === null) return null
  return topics.find((topic) => topic.id === topicId)?.color ?? null
}
