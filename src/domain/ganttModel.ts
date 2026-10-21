// T19 · GanttModel：甘特图领域模型纯函数模块。
// 零 React / 零 DOM / 零 I/O；几何（列 x / 条宽 / 箭头拐点）全部在这里算完，视图层只做投影（spec 5.1）。
// 渲染、导出、单测共用同一份模型。

import dayjs from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek'

import { createDependencyGraph } from './dependencyGraph'
import { createQueryEngine } from './queryEngine'
import { createScheduleEngine, toDateKey } from './scheduleEngine'
import { createTopicTree } from './topicTree'
import type { Dependency, DependencyType, Filter, Milestone, Task, Topic, Vault } from './types'

// week 刻度的表头要出 ISO-8601 周号（CW42），isoWeek/isoWeekYear 来自该插件（其余日期运算仍用裸 dayjs）。
dayjs.extend(isoWeek)

export type GanttScale = 'day' | 'week'

/** 行高固定 32px（spec 5.4）；刻度只改列宽，不改行高。 */
export const GANTT_ROW_HEIGHT = 32

/**
 * 自动范围的最小跨度（天，约 6 周）。
 *
 * 曾经的口径是「数据范围 + 两侧各留 3 天」——库里只有几个任务时，时间线只有十来格，
 * 右侧一大片空白、也看不出任务处在什么时间背景下（用户报的现象）。
 * 现在派生范围一律拉够这个跨度；显式传 `range` 的调用方（导出、单测）不受影响。
 */
export const GANTT_MIN_SPAN_DAYS = 42

/** 最小跨度里分给「未来」的比例；剩下的给过去。往前看比往回翻更常用。 */
const FUTURE_SHARE = 2 / 3

export interface GanttViewport {
  /** 视口锚定的「今天」（YYYY-MM-DD）；默认取本地当天，注入以便测试确定化。 */
  today?: string
  /**
   * 显式指定时间范围；缺省或单侧缺省时按已排期数据自动求值（见 resolveAutoRange）。
   * 显式给出的一侧原样使用，不做 padding / 最小跨度拉伸。
   */
  range?: { start?: string; end?: string }
  /** 数据派生范围两端各留几天（默认 3）；只在未显式给出 range 的一侧生效。 */
  paddingDays?: number
  /** 自动范围的最小跨度（天）；默认 GANTT_MIN_SPAN_DAYS。显式 range 的一侧不参与拉伸。 */
  minSpanDays?: number
  /**
   * 界面尺度（T40）。几何一律按它放大：行高、列宽、条高、里程碑边长。
   *
   * 不缩放就会出现"字放大了、行没放开"的裁切——甘特的文字、条形、行高、
   * 虚拟化窗口必须来自**同一个**数字。默认 1（单测与导出基线都按设计稿跑）。
   */
  uiScale?: number
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

/**
 * week 次行单元格文案：ISO-8601 周号「CW{n}」。ISO 周分组本就按周一，与列的 isWeekStart 口径一致。
 * `withYear` 只在该格的 ISO 年与前一周格不同时传入（新年份首格补年份，其余不标）。
 */
function weekCellLabel(date: string, withYear: boolean): string {
  const d = dayjs(date)
  const week = d.isoWeek()
  return withYear ? `CW${week} ${d.isoWeekYear()}` : `CW${week}`
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

const DATE_FORMAT = 'YYYY-MM-DD'

/**
 * 自动范围（= 未显式给出的一侧）的求值口径，三条规则依次生效：
 *
 * ① **包含今天**：数据整体在窗口一侧、且离今天不超过一个最小跨度时，把那一侧扩到今天。
 *    隔了半年的旧项目不在此列——为迁就「今天」把时间线撑成一条几乎全是空白的长卷没有意义。
 * ② **拉够最小跨度**：数据只覆盖几天时，缺口按 2/3 给未来、1/3 给过去补足
 *    （时间线太短是用户报的原始问题）。
 * ③ **起点对齐 ISO 周一**：week 刻度的次行表头按周一起格，从周中开始会在最左侧
 *    留一段没有表头文案的空白；对齐后顺带把首月表头也撑得像样些。
 *
 * 显式给出的一侧全程不参与拉伸——导出（range='full'）与单测都靠这个保证范围可预期。
 */
export function resolveAutoRange(input: {
  derived: { start: string; end: string } | null
  today: string
  paddingDays: number
  minSpanDays: number
  explicit?: { start?: string; end?: string }
}): { start: string; end: string } {
  const { derived, today, explicit } = input
  const padding = input.paddingDays
  const minSpan = Math.max(1, Math.floor(input.minSpanDays))
  const autoStart = explicit?.start === undefined
  const autoEnd = explicit?.end === undefined

  const anchorStart = derived?.start ?? today
  const anchorEnd = derived?.end ?? today
  let start = dayjs(explicit?.start ?? anchorStart)
  let end = dayjs(explicit?.end ?? anchorEnd)
  if (autoStart) start = start.subtract(padding, 'day')
  if (autoEnd) end = end.add(padding, 'day')

  const todayDate = dayjs(today)
  if (autoStart && start.isAfter(todayDate, 'day') && start.diff(todayDate, 'day') <= minSpan) {
    start = todayDate.subtract(padding, 'day')
  }
  if (autoEnd && end.isBefore(todayDate, 'day') && todayDate.diff(end, 'day') <= minSpan) {
    end = todayDate.add(padding, 'day')
  }

  const span = end.diff(start, 'day') + 1
  if (span < minSpan) {
    let missing = minSpan - span
    if (autoStart && autoEnd) {
      const future = Math.ceil(missing * FUTURE_SHARE)
      end = end.add(future, 'day')
      missing -= future
      start = start.subtract(missing, 'day')
    } else if (autoEnd) {
      end = end.add(missing, 'day')
    } else if (autoStart) {
      start = start.subtract(missing, 'day')
    }
  }

  if (autoStart) start = dayjs(isoWeekStartOf(start.format(DATE_FORMAT)))

  return { start: start.format(DATE_FORMAT), end: end.format(DATE_FORMAT) }
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
  // T40：所有几何都从这一个系数派生，避免"有的放大了有的没放"。
  const s = viewport.uiScale && viewport.uiScale > 0 ? viewport.uiScale : 1
  const rowHeight = GANTT_ROW_HEIGHT * s
  const taskBarHeight = TASK_BAR_HEIGHT * s
  const baselineBarHeight = BASELINE_BAR_HEIGHT * s
  const milestoneSize = MILESTONE_SIZE * s
  const arrowGap = ARROW_GAP * s

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
  const { start: rangeStart, end: rangeEnd } = resolveAutoRange({
    derived,
    today,
    paddingDays: viewport.paddingDays ?? 3,
    minSpanDays: viewport.minSpanDays ?? GANTT_MIN_SPAN_DAYS,
    explicit: viewport.range,
  })

  const cellWidth = cellWidthOf(scale) * s
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
    let prevIsoYear: number | null = null
    for (const column of columns) {
      if (!column.isWeekStart) {
        const last = secondCells[secondCells.length - 1]
        if (last) last.width += column.width
        continue
      }
      const isoYear = dayjs(column.date).isoWeekYear()
      const withYear = prevIsoYear !== null && isoYear !== prevIsoYear
      prevIsoYear = isoYear
      secondCells.push({ label: weekCellLabel(column.date, withYear), x: column.x, width: column.width })
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

  const barY = (rowIndex: number): number => rowIndex * rowHeight + (rowHeight - taskBarHeight) / 2

  const pushRow = (row: Omit<GanttRow, 'rowIndex' | 'y' | 'height'>): number => {
    const rowIndex = rows.length
    rows.push({ ...row, rowIndex, y: rowIndex * rowHeight, height: rowHeight })
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
      row.bar = clampBar(task.start!, task.due!, index, cellWidth, columns.length, y, taskBarHeight, (width) =>
        Math.round((width * task.progress) / 100),
      )
      if (task.baseline?.start && task.baseline.due) {
        row.baseline = clampBar(
          task.baseline.start,
          task.baseline.due,
          index,
          cellWidth,
          columns.length,
          y + taskBarHeight + 2 * s,
          baselineBarHeight,
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
      x: centerX - milestoneSize / 2,
      y: rowIndex * rowHeight + (rowHeight - milestoneSize) / 2,
      width: milestoneSize,
      height: milestoneSize,
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
    if (tx >= sx + arrowGap * 2) {
      const midX = sx + arrowGap
      points = [
        { x: sx, y: sy },
        { x: midX, y: sy },
        { x: midX, y: ty },
        { x: tx, y: ty },
      ]
    } else {
      // 空间不足时绕行：先向右出、再走贴近目标行的横沟、最后从左侧切入
      const outX = sx + arrowGap
      const backX = tx - arrowGap
      const channelY = ty >= sy ? ty - arrowGap : ty + arrowGap
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
    rowHeight,
  }
}

/** 视图层便捷入口：从 topic 列表取色，未知 topic 返回 null。 */
export function colorOfTopic(topics: readonly Topic[], topicId: string | null): string | null {
  if (topicId === null) return null
  return topics.find((topic) => topic.id === topicId)?.color ?? null
}
