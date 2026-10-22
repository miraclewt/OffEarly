import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'

import { GANTT_MIN_SPAN_DAYS, buildGanttModel, GANTT_ROW_HEIGHT } from '../../src/domain/ganttModel'
import { createEmptyFilter } from '../../src/domain/queryEngine'
import type { Dependency, Milestone, Task, Topic, Vault, WorkCalendar } from '../../src/domain/types'

function makeTopic(id: string, overrides: Partial<Topic> = {}): Topic {
  return { id, name: `话题 ${id}`, color: '#4F46E5', parentId: null, order: 'a0', archived: false, ...overrides }
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    topicId: 'a',
    title: `任务 ${id}`,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note: '',
    order: 'a0',
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    archived: false,
    ...overrides,
  }
}

function link(from: string, to: string): Dependency {
  return { id: `${from}->${to}`, from, to, type: 'FS', lagDays: 0 }
}

function makeMilestone(id: string, overrides: Partial<Milestone> = {}): Milestone {
  return { id, topicId: null, title: `里程碑 ${id}`, date: '2026-10-20', done: false, ...overrides }
}

// 2026-10-01 为周四：10-03/04、10-10/11、10-17/18 为周末；10-01 节假日；10-17 周六补班
const calendar: WorkCalendar = {
  workdays: [1, 2, 3, 4, 5],
  holidays: ['2026-10-01'],
  extraWorkdays: ['2026-10-17'],
}

function makeVault(overrides: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'vault-1',
    appVersion: '0.1.0',
    revision: 1,
    updatedAt: '2026-10-15T00:00:00.000Z',
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar,
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
      noteFontSize: 13,
    },
    topics: [makeTopic('a', { order: 'a0' }), makeTopic('b', { order: 'b0' }), makeTopic('c', { order: 'c0' })],
    tasks: [
      makeTask('t1', { topicId: 'a', start: '2026-10-05', due: '2026-10-09', order: 'a0', progress: 50 }),
      makeTask('t2', {
        topicId: 'a',
        start: '2026-10-12',
        due: '2026-10-16',
        order: 'b0',
        baseline: { start: '2026-10-12', due: '2026-10-14' },
      }),
      makeTask('t3', { topicId: 'b', start: '2026-10-12', due: '2026-10-22', order: 'a0' }),
      makeTask('t4', { topicId: 'a', order: 'c0' }),
      makeTask('t5', { topicId: 'a', start: '2026-10-05', due: '2026-10-06', archived: true }),
      makeTask('t6', { topicId: 'b', start: '2026-10-14' }),
    ],
    milestones: [makeMilestone('m1', { date: '2026-10-20' })],
    links: [link('t1', 't2'), link('t2', 't3')],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    ...overrides,
  }
}

const OCTOBER = { start: '2026-10-01', end: '2026-10-31' }
const viewport = { today: '2026-10-15', range: OCTOBER }
const filter = createEmptyFilter()
const vault = makeVault()

describe('T19 · 刻度与列几何（验收 2）', () => {
  it('day 刻度列宽 32，31 天共 992 宽', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    expect(model.scale).toBe('day')
    expect(model.range).toEqual(OCTOBER)
    expect(model.columns).toHaveLength(31)
    expect(model.columns.every((c) => c.width === 32)).toBe(true)
    expect(model.width).toBe(992)
    expect(model.rowHeight).toBe(GANTT_ROW_HEIGHT)
  })

  it('week 刻度列宽 14，总宽 434', () => {
    const model = buildGanttModel(vault, filter, 'week', viewport)
    expect(model.columns).toHaveLength(31)
    expect(model.columns.every((c) => c.width === 14)).toBe(true)
    expect(model.width).toBe(434)
  })

  it('周末 / 节假日 / 补班列带正确标记', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    const at = (date: string) => model.columns.find((c) => c.date === date)!

    expect(at('2026-10-03')).toMatchObject({ isWeekend: true, isHoliday: false, isWorkday: false })
    expect(at('2026-10-01')).toMatchObject({ isWeekend: false, isHoliday: true, isWorkday: false })
    expect(at('2026-10-17')).toMatchObject({ isWeekend: true, isExtraWorkday: true, isWorkday: true })
    expect(at('2026-10-15')).toMatchObject({ isToday: true, isWorkday: true })
    expect(at('2026-10-14')).toMatchObject({ isToday: false })
  })

  it('两级表头：首行按自然月合并，次行 day 为日号、week 为 ISO 周号（CW）且跨列合并', () => {
    const day = buildGanttModel(vault, filter, 'day', viewport)
    expect(day.headerRows[0]).toEqual([{ label: '2026-10', x: 0, width: 992 }])
    expect(day.headerRows[1]).toHaveLength(31)
    expect(day.headerRows[1]![0]).toEqual({ label: '01', x: 0, width: 32 })
    expect(day.headerRows[1]![30]).toEqual({ label: '31', x: 960, width: 32 })

    const week = buildGanttModel(vault, filter, 'week', viewport)
    expect(week.headerRows[0]).toEqual([{ label: '2026-10', x: 0, width: 434 }])
    // 周一分组：2026-10 落在 ISO 周 40..44（10-15 那一周正是 CW42）
    expect(week.headerRows[1]).toEqual([
      { label: 'CW40', x: 0, width: 56 },
      { label: 'CW41', x: 56, width: 98 },
      { label: 'CW42', x: 154, width: 98 },
      { label: 'CW43', x: 252, width: 98 },
      { label: 'CW44', x: 350, width: 84 },
    ])
  })

  it('week 次行在 ISO 年切换的那一格补年份，其余只显周号', () => {
    // 2027-01-01(周五) 属 ISO 2026-W53；2027-01-04(周一) 起才是 ISO 2027-W1。
    const model = buildGanttModel(vault, filter, 'week', {
      today: '2027-01-05',
      range: { start: '2027-01-01', end: '2027-01-10' },
    })
    expect(model.headerRows[1]).toEqual([
      { label: 'CW53', x: 0, width: 42 },
      { label: 'CW1 2027', x: 42, width: 98 },
    ])
  })

  it('缺省 viewport.range 时按已排期数据派生，并拉够最小跨度、起点对齐周一', () => {
    // 数据 10-05..10-22（两侧各留 3 天 = 10-02..10-25，仅 24 格）→
    // 补到 42 天：未来 12 天、过去 6 天 → 09-26..11-06；起点再对齐到 ISO 周一 = 09-21
    const model = buildGanttModel(vault, filter, 'day', { today: '2026-10-15' })
    expect(model.range).toEqual({ start: '2026-09-21', end: '2026-11-06' })
    expect(model.columns).toHaveLength(47)
  })
})

describe('T19 · 自动范围（时间线不能只剩几格）', () => {
  const oneDay = () =>
    makeVault({
      tasks: [makeTask('solo', { topicId: 'a', start: '2026-10-15', due: '2026-10-15' })],
      milestones: [],
      links: [],
    })

  it('单个一天任务也铺满最小跨度，而不是 7 格', () => {
    const model = buildGanttModel(oneDay(), filter, 'day', { today: '2026-10-15' })
    expect(model.columns.length).toBeGreaterThanOrEqual(GANTT_MIN_SPAN_DAYS)
    expect(model.columns.some((column) => column.isToday)).toBe(true)
    // 唯一的条仍然完整可见
    expect(model.rows.find((row) => row.id === 'solo')?.bar).not.toBeNull()
  })

  it('窗口总是包含今天：数据在过去但离今天不远时向未来补齐', () => {
    const past = makeVault({
      tasks: [makeTask('old', { topicId: 'a', start: '2026-09-01', due: '2026-09-05' })],
      milestones: [],
      links: [],
    })
    const model = buildGanttModel(past, filter, 'day', { today: '2026-10-15' })
    expect(model.range.end >= '2026-10-15').toBe(true)
    expect(model.columns.some((column) => column.isToday)).toBe(true)
  })

  it('数据离今天很远时不强行把今天塞进窗口（否则会撑成几乎全空白的长卷）', () => {
    const archive = makeVault({
      tasks: [makeTask('ancient', { topicId: 'a', start: '2024-01-02', due: '2024-01-06' })],
      milestones: [],
      links: [],
    })
    const model = buildGanttModel(archive, filter, 'day', { today: '2026-10-15' })
    expect(model.columns.some((column) => column.isToday)).toBe(false)
    expect(model.columns.length).toBeLessThanOrEqual(GANTT_MIN_SPAN_DAYS + 6)
    expect(model.rows.find((row) => row.id === 'ancient')?.bar).not.toBeNull()
  })

  it('起点对齐 ISO 周一，week 刻度次行表头从第一格就有文案', () => {
    const model = buildGanttModel(vault, filter, 'week', { today: '2026-10-15' })
    expect(dayjs(model.range.start).day()).toBe(1)
    expect(model.headerRows[1]?.[0]?.x).toBe(0)
    // 表头覆盖整段跨度：最后一格的右端 = 画布总宽
    const last = model.headerRows[1]![model.headerRows[1]!.length - 1]!
    expect(last.x + last.width).toBe(model.width)
  })

  it('显式 range 不被拉伸：导出与调用方的范围可预期', () => {
    const model = buildGanttModel(oneDay(), filter, 'day', { today: '2026-10-15', range: OCTOBER })
    expect(model.range).toEqual(OCTOBER)
    expect(model.columns).toHaveLength(31)
  })

  it('单侧显式时不改那一侧，只把另一侧补到最小跨度', () => {
    const model = buildGanttModel(oneDay(), filter, 'day', {
      today: '2026-10-15',
      range: { start: '2026-10-10' },
    })
    expect(model.range.start).toBe('2026-10-10')
    expect(model.columns.length).toBeGreaterThanOrEqual(GANTT_MIN_SPAN_DAYS)
  })
})

describe('T19 · 分组与未排期（验收 3）', () => {
  it('rows 按话题树序分组，组内任务按 LexoRank 的 order 排序', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    expect(model.rows.map((r) => r.id)).toEqual(['a', 't1', 't2', 'b', 't3', 'm1'])
    expect(model.rows.map((r) => r.kind)).toEqual(['topic', 'task', 'task', 'topic', 'task', 'milestone'])
    expect(model.rows[0]).toMatchObject({ depth: 0, label: '话题 a' })
    expect(model.rows[1]).toMatchObject({ depth: 1, topicId: 'a', critical: true })
    // 空话题 c 不产生行
    expect(model.rows.some((r) => r.id === 'c')).toBe(false)
  })

  it('未排期任务进 unscheduled、不进 rows；归档任务被排除', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    expect(model.unscheduled.map((t) => t.id)).toEqual(['t4', 't6'])
    expect(model.rows.some((r) => r.id === 't4' || r.id === 't6')).toBe(false)
    expect(model.rows.some((r) => r.id === 't5')).toBe(false)
    expect(model.unscheduled.some((t) => t.id === 't5')).toBe(false)
  })

  it('任务条几何：位置取列索引，宽度按跨越天数，进度内条按百分比', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    const t1 = model.rows.find((r) => r.id === 't1')!
    // 10-05..10-09 → 第 4..8 列
    expect(t1.bar).toEqual({ x: 128, y: 41, width: 160, height: 14, progressWidth: 80 })
    const t3 = model.rows.find((r) => r.id === 't3')!
    // 10-12..10-22 → 第 11..21 列
    expect(t3.bar).toMatchObject({ x: 352, width: 352 })
  })

  it('有 baseline 的任务在条下方生成细灰条', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    const t2 = model.rows.find((r) => r.id === 't2')!
    // 10-12..10-14 → 第 11..13 列，落在主条下方
    expect(t2.baseline).toEqual({ x: 352, y: 89, width: 96, height: 4, progressWidth: 0 })
  })

  it('里程碑落在独立轨道，菱形几何居中于当日列', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    const m1 = model.rows.find((r) => r.id === 'm1')!
    expect(m1.kind).toBe('milestone')
    expect(m1.depth).toBe(0)
    // 10-20 → 第 19 列，列中心 19*32+16 = 624
    expect(m1.bar).toEqual({ x: 618, y: 170, width: 12, height: 12, progressWidth: 0 })
  })
})

describe('T19 · 依赖箭头拐点（验收 4）', () => {
  it('FS 语义：首点为前置条右端中点，末点为后置条左端中点', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    const arrow = model.arrows.find((a) => a.from === 't1' && a.to === 't2')!
    expect(arrow.points[0]).toEqual({ x: 288, y: 48 })
    expect(arrow.points[arrow.points.length - 1]).toEqual({ x: 352, y: 80 })
    expect(arrow.path).toBe('M 288 48 L 298 48 L 298 80 L 352 80')
  })

  it('空间不足时绕行，仍是轴对齐折线', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    const arrow = model.arrows.find((a) => a.from === 't2' && a.to === 't3')!
    expect(arrow.points).toEqual([
      { x: 512, y: 80 },
      { x: 522, y: 80 },
      { x: 522, y: 134 },
      { x: 342, y: 134 },
      { x: 342, y: 144 },
      { x: 352, y: 144 },
    ])
  })

  it('每条 link 一条箭头，且相邻段必为一横一竖', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    expect(model.arrows.map((a) => a.id)).toEqual(['t1->t2', 't2->t3'])
    for (const arrow of model.arrows) {
      for (let i = 1; i < arrow.points.length; i += 1) {
        const prev = arrow.points[i - 1]!
        const cur = arrow.points[i]!
        expect(prev.x === cur.x || prev.y === cur.y).toBe(true)
      }
    }
  })
})

describe('T19 · 关键路径与环降级（验收 5）', () => {
  it('criticalIds 来自 DependencyGraph.criticalPath，并标记关键箭头', () => {
    const model = buildGanttModel(vault, filter, 'day', viewport)
    expect([...model.criticalIds].sort()).toEqual(['t1', 't2', 't3'])
    expect(model.arrows.every((a) => a.critical)).toBe(true)
    expect(model.cycles).toEqual([])
  })

  it('含环时 criticalIds 为空集且 cycles 非空', () => {
    const cyclic = makeVault({ links: [link('t1', 't2'), link('t2', 't3'), link('t3', 't1')] })
    const model = buildGanttModel(cyclic, filter, 'day', viewport)
    expect(model.criticalIds.size).toBe(0)
    expect(model.cycles).toHaveLength(1)
    expect([...model.cycles[0]!].sort()).toEqual(['t1', 't2', 't3'])
    // 环只降级关键路径，不影响行与箭头
    expect(model.arrows).toHaveLength(3)
    expect(model.rows.some((r) => r.id === 't1')).toBe(true)
  })
})

describe('T19 · 筛选联动（验收 1）', () => {
  it('filter 决定哪些任务进入模型', () => {
    const onlyB = buildGanttModel(vault, { ...filter, topicIds: ['b'] }, 'day', viewport)
    // 跨话题里程碑（topicId 为 null）不受话题筛选影响，属全局轨道
    expect(onlyB.rows.map((r) => r.id)).toEqual(['b', 't3', 'm1'])
    expect(onlyB.arrows).toEqual([])
    // 关键路径是全库属性，与 blockedOnly 同口径：不随筛选收缩
    expect([...onlyB.criticalIds].sort()).toEqual(['t1', 't2', 't3'])
  })

  it('不含任何排期任务时仍给足最小跨度（以今天为锚，今天落在窗口内）', () => {
    const empty = makeVault({ tasks: [makeTask('x', { topicId: 'a' })], milestones: [], links: [] })
    const model = buildGanttModel(empty, filter, 'day', { today: '2026-10-15' })
    // 今天两侧各留 3 天 = 7 格 → 补到 42 天（未来 24 / 过去 11）→ 起点对齐周一
    expect(model.range).toEqual({ start: '2026-09-28', end: '2026-11-11' })
    expect(model.columns.length).toBeGreaterThanOrEqual(42)
    expect(model.columns.some((column) => column.isToday)).toBe(true)
    expect(model.rows).toEqual([])
    expect(model.unscheduled.map((t) => t.id)).toEqual(['x'])
  })
})

describe('T40 · 界面尺度：几何等比放大', () => {
  it('行高 / 列宽 / 条高一起放大，箭头端点跟着走', () => {
    const base = buildGanttModel(vault, filter, 'day', { today: '2026-10-15' })
    const big = buildGanttModel(vault, filter, 'day', { today: '2026-10-15', uiScale: 2 })

    expect(big.rowHeight).toBe(base.rowHeight * 2)
    expect(big.columns[0]!.width).toBe(base.columns[0]!.width * 2)

    const baseTask = base.rows.find((row) => row.kind === 'task')!
    const bigTask = big.rows.find((row) => row.id === baseTask.id)!
    expect(bigTask.y).toBe(baseTask.y * 2)
    expect(bigTask.bar!.x).toBe(baseTask.bar!.x * 2)
    expect(bigTask.bar!.width).toBe(baseTask.bar!.width * 2)
    expect(bigTask.bar!.height).toBe(baseTask.bar!.height * 2)

    // 里程碑菱形与依赖箭头同样只由 rowHeight / cellWidth 派生
    const baseMs = base.rows.find((row) => row.kind === 'milestone')!
    const bigMs = big.rows.find((row) => row.id === baseMs.id)!
    expect(bigMs.bar!.x).toBe(baseMs.bar!.x * 2)
    expect(bigMs.bar!.width).toBe(baseMs.bar!.width * 2)
    const points = (path: string): number[] => path.split(/[ ]/).filter((t) => t !== 'M' && t !== 'L').map(Number)
    expect(points(big.arrows[0]!.path)).toEqual(points(base.arrows[0]!.path).map((n) => n * 2))
  })

  it('缺省与非法尺度都回落到 1（导出口径不受影响）', () => {
    expect(buildGanttModel(vault, filter, 'day', { today: '2026-10-15' }).rowHeight).toBe(GANTT_ROW_HEIGHT)
    expect(
      buildGanttModel(vault, filter, 'day', { today: '2026-10-15', uiScale: 0 }).rowHeight,
    ).toBe(GANTT_ROW_HEIGHT)
    expect(
      buildGanttModel(vault, filter, 'day', { today: '2026-10-15', uiScale: -3 }).rowHeight,
    ).toBe(GANTT_ROW_HEIGHT)
  })
})
