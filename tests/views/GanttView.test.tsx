// @vitest-environment jsdom
//
// T20 · GanttView 渲染层组件测试（spec 5.1 输入契约 / 5.4 渲染要点）。
//
// 断言口径：几何（列 x、条宽、箭头 path、今日线 x）一律取自 buildGanttModel 的 GanttModel，
// 视图只做投影 —— 所以测试里的期望值也从同一份模型推导，而不是把坐标硬编码成常量。
// 1000 任务样本那组用例专门盯虚拟化：渲染出来的行 / 列 / 箭头数必须远小于模型规模。

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import dayjs from 'dayjs'
import { afterEach, describe, expect, it } from 'vitest'

import {
  GANTT_OVERSCAN_ROWS,
  GANTT_ZOOM_STEPS,
  computeRowWindow,
  createGanttViewport,
  resolveZoomStep,
  splitMilestoneLane,
  zoomFactorAt,
} from '../../src/controllers/ganttViewport'
import { GANTT_ROW_HEIGHT, buildGanttModel } from '../../src/domain/ganttModel'
import { createEmptyFilter } from '../../src/domain/queryEngine'
import type { Dependency, Milestone, Task, Topic, Vault, WorkCalendar } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import {
  GANTT_BASELINE_FILL,
  GANTT_OFF_COLUMN_FILL,
  GANTT_TODAY_COLOR,
} from '../../src/views/GanttCanvas'
import GanttViewDefault, { GanttView } from '../../src/views/GanttView'

const t = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t

const CALENDAR: WorkCalendar = {
  workdays: [1, 2, 3, 4, 5],
  holidays: ['2026-10-01'],
  extraWorkdays: ['2026-10-17'],
}

/** 2026-10：10-01 节假日；10-03/04、10-10/11、10-17/18 周末；10-17 周六补班。 */
const OCTOBER = { start: '2026-10-01', end: '2026-10-31' }
const TODAY = '2026-10-15'
const CANVAS_WIDTH = 640
const CANVAS_HEIGHT = 320
const BODY_HEIGHT = CANVAS_HEIGHT - 40

const TOPIC_A_COLOR = '#4F46E5'
const TOPIC_B_COLOR = '#0EA5E9'

function makeTopic(id: string, order: string, color: string): Topic {
  return { id, name: `话题 ${id}`, color, parentId: null, order, archived: false }
}

function makeTask(id: string, topicId: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    topicId,
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

function makeVault(tasks: Task[], milestones: Milestone[], links: Dependency[]): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'vault-t20',
    appVersion: '0.1.0',
    revision: 1,
    updatedAt: '2026-10-15T00:00:00.000Z',
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: CALENDAR,
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
    },
    topics: [makeTopic('a', 'a0', TOPIC_A_COLOR), makeTopic('b', 'b0', TOPIC_B_COLOR)],
    tasks,
    milestones,
    links,
    assets: [],
  }
}

const vault = makeVault(
  [
    makeTask('t1', 'a', { order: 'a0', start: '2026-10-05', due: '2026-10-09', progress: 50 }),
    makeTask('t2', 'a', {
      order: 'b0',
      start: '2026-10-12',
      due: '2026-10-16',
      progress: 20,
      baseline: { start: '2026-10-12', due: '2026-10-14' },
    }),
    makeTask('t3', 'b', { order: 'a0', start: '2026-10-12', due: '2026-10-22', progress: 10 }),
    // 未排期：进 unscheduled，不进 rows（T22 的右侧面板）
    makeTask('t4', 'b', { order: 'b0' }),
    // 归档：默认筛选下从甘特图消失
    makeTask('t5', 'a', { order: 'c0', start: '2026-10-05', due: '2026-10-06', archived: true }),
  ],
  [
    { id: 'm-topic', topicId: 'a', title: '话题内里程碑', date: '2026-10-09', done: false },
    { id: 'm-cross', topicId: null, title: '跨话题里程碑', date: '2026-10-20', done: false },
  ],
  [{ id: 't1->t2', from: 't1', to: 't2', type: 'FS', lagDays: 0 }],
)

const filter = createEmptyFilter()

function modelOf(v: Vault = vault, scale: 'day' | 'week' = 'day') {
  return buildGanttModel(v, filter, scale, { today: TODAY, range: OCTOBER })
}

function renderGantt(props: Partial<Parameters<typeof GanttView>[0]> = {}) {
  return render(
    <GanttView
      vault={vault}
      filter={filter}
      scale="day"
      range={OCTOBER}
      today={TODAY}
      width={CANVAS_WIDTH}
      height={CANVAS_HEIGHT}
      t={t}
      {...props}
    />,
  )
}

/** 与实现无关的亮度计算：用来独立验证「深色进度内条」。 */
function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** jsdom 不做布局，scrollTop/scrollLeft 只能显式写进去再派发事件。 */
function scrollTo(el: HTMLElement, next: { scrollTop?: number; scrollLeft?: number }): void {
  if (next.scrollTop !== undefined) {
    Object.defineProperty(el, 'scrollTop', { value: next.scrollTop, writable: true, configurable: true })
  }
  if (next.scrollLeft !== undefined) {
    Object.defineProperty(el, 'scrollLeft', { value: next.scrollLeft, writable: true, configurable: true })
  }
  fireEvent.scroll(el)
}

function zoomOf(view: ReturnType<typeof render>): number {
  return Number(view.getByTestId('gantt-canvas-svg').getAttribute('data-zoom'))
}

afterEach(cleanup)

describe('T20-1 · SVG 渲染 rows/arrows/今日线，行高 32，虚拟化受控', () => {
  it('行高固定 32，行带与左侧表行高一致', () => {
    const view = renderGantt()
    expect(GANTT_ROW_HEIGHT).toBe(32)

    const bands = [...view.container.querySelectorAll('[data-gantt-row]')]
    expect(bands.length).toBeGreaterThan(0)
    expect(
      bands.every((band) => band.getAttribute('data-row-height') === '32' && band.getAttribute('height') === '32'),
    ).toBe(true)
  })

  it('今日线 1px 红并带顶部标签，x 取自模型列几何', () => {
    const view = renderGantt()
    const line = view.container.querySelector('[data-gantt-today="line"]')!
    const column = modelOf().columns.find((c) => c.isToday)!

    expect(line.getAttribute('stroke')).toBe(GANTT_TODAY_COLOR)
    expect(Number(line.getAttribute('stroke-width'))).toBe(1)
    expect(Number(line.getAttribute('x1'))).toBe(column.x + column.width / 2)
    expect(Number(line.getAttribute('x1'))).toBe(Number(line.getAttribute('x2')))
    expect(view.getByTestId('gantt-today-label').textContent).toBe('今天')
  })

  it('箭头层直接渲染 buildGanttModel 算好的折线 path', () => {
    const view = renderGantt()
    const model = modelOf()
    const paths = [...view.container.querySelectorAll('[data-gantt-arrow]')]

    expect(model.arrows).toHaveLength(1)
    expect(paths).toHaveLength(model.arrows.length)
    const arrow = model.arrows[0]!
    const path = view.container.querySelector(`[data-gantt-arrow="${arrow.id}"]`)!
    expect(path.getAttribute('d')).toBe(arrow.path)
    expect(path.getAttribute('data-from')).toBe('t1')
    expect(path.getAttribute('data-to')).toBe('t2')
  })

  it('未排期与归档任务不进 rows、不画条', () => {
    const view = renderGantt()
    expect(view.container.querySelector('[data-gantt-bar="t4"]')).toBeNull()
    expect(view.container.querySelector('[data-gantt-row="t4"]')).toBeNull()
    expect(view.container.querySelector('[data-gantt-bar="t5"]')).toBeNull()
    expect(view.container.querySelector('[data-gantt-row="t5"]')).toBeNull()
  })

  it('1000 任务：只渲染视口 ±10 行与可见列，DOM 节点数受控', () => {
    const big = bigVault(1000)
    const model = buildGanttModel(big, filter, 'day', { today: '2026-03-01', range: BIG_RANGE })
    const view = render(
      <GanttView
        vault={big}
        filter={filter}
        scale="day"
        range={BIG_RANGE}
        today="2026-03-01"
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        t={t}
      />,
    )

    expect(big.tasks).toHaveLength(1000)
    expect(model.rows.length).toBeGreaterThan(1000)

    const rowBound = Math.ceil(BODY_HEIGHT / GANTT_ROW_HEIGHT) + 1 + 2 * GANTT_OVERSCAN_ROWS
    const columnBound = Math.ceil(CANVAS_WIDTH / 32) + 1 + 2 * GANTT_OVERSCAN_ROWS

    const rows = [...view.container.querySelectorAll('[data-gantt-row]')]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(rowBound)

    // 可见列：181 天的时间跨度只渲染视口附近那几十列
    expect(model.columns).toHaveLength(181)
    const columns = [...view.container.querySelectorAll('[data-gantt-col]')]
    expect(columns.length).toBeLessThanOrEqual(columnBound)

    // 箭头同样只渲染落在视口里的那几条（全量 50 条依赖）
    expect(model.arrows.length).toBeGreaterThan(40)
    expect(view.container.querySelectorAll('[data-gantt-arrow]').length).toBeLessThanOrEqual(rowBound)

    // 整棵子树的 DOM 节点数也远小于模型规模（实测约 350，模型行数 1000+）
    const nodes = view.container.querySelectorAll('*').length
    expect(nodes).toBeLessThan(450)
    expect(nodes).toBeLessThan(model.rows.length)
  })

  it('1000 任务：滚动后窗口整体下移且行数仍受控', () => {
    const big = bigVault(1000)
    const view = render(
      <GanttView
        vault={big}
        filter={filter}
        scale="day"
        range={BIG_RANGE}
        today="2026-03-01"
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        t={t}
      />,
    )
    const rowBound = Math.ceil(BODY_HEIGHT / GANTT_ROW_HEIGHT) + 1 + 2 * GANTT_OVERSCAN_ROWS
    const rowIds = () =>
      [...view.container.querySelectorAll('[data-gantt-row]')].map((el) => el.getAttribute('data-gantt-row'))

    const before = rowIds()
    scrollTo(view.getByTestId('gantt-canvas-scroll'), { scrollTop: 1600 })
    const after = rowIds()

    expect(after).not.toEqual(before)
    expect(after.length).toBeLessThanOrEqual(rowBound)
    expect(after.length).toBeGreaterThan(0)
  })

  it('行窗口计算：只有视口 ±10 行，且夹在 [0, rowCount] 内', () => {
    expect(computeRowWindow({ rowCount: 1000, scrollTop: 0, height: BODY_HEIGHT, rowHeight: 32, overscan: 10 })).toEqual(
      { startRow: 0, endRow: 20 },
    )
    expect(
      computeRowWindow({ rowCount: 1000, scrollTop: 1600, height: BODY_HEIGHT, rowHeight: 32, overscan: 10 }),
    ).toEqual({ startRow: 40, endRow: 70 })
    // 临末尾时不越界
    expect(
      computeRowWindow({ rowCount: 45, scrollTop: 1440, height: BODY_HEIGHT, rowHeight: 32, overscan: 10 }),
    ).toEqual({ startRow: 35, endRow: 45 })
    // 里程碑轨道占位要参与换算
    expect(
      computeRowWindow({ rowCount: 1000, scrollTop: 32, offsetY: 32, height: BODY_HEIGHT, rowHeight: 32, overscan: 10 }),
    ).toEqual({ startRow: 0, endRow: 20 })
  })
})

describe('T20-2 · 刻度切换与缩放（两刻度各自保留状态）', () => {
  it('日/周按钮切列宽（32 / 14），切换刻度各自保留缩放档位', () => {
    const view = renderGantt()
    const svg = () => view.getByTestId('gantt-canvas-svg')

    expect(svg().getAttribute('data-scale')).toBe('day')
    expect(svg().getAttribute('data-cell-width')).toBe('32')

    fireEvent.click(view.getByTestId('gantt-zoom-in'))
    fireEvent.click(view.getByTestId('gantt-zoom-in'))
    const dayZoom = zoomOf(view)
    expect(dayZoom).toBeGreaterThan(1)

    fireEvent.click(view.getByTestId('gantt-scale-week'))
    expect(svg().getAttribute('data-scale')).toBe('week')
    expect(svg().getAttribute('data-cell-width')).toBe('14')
    expect(zoomOf(view)).toBe(1)

    fireEvent.click(view.getByTestId('gantt-zoom-out'))
    const weekZoom = zoomOf(view)
    expect(weekZoom).toBeLessThan(700)

    // 切回 day：day 的缩放档位还在，week 的也各自留着
    fireEvent.click(view.getByTestId('gantt-scale-day'))
    expect(zoomOf(view)).toBe(dayZoom)
    expect(view.getByTestId('gantt-zoom-label').textContent).toBe(`${Math.round(dayZoom * 100)}%`)

    fireEvent.click(view.getByTestId('gantt-scale-week'))
    expect(zoomOf(view)).toBe(weekZoom)
  })

  it('Ctrl+滚轮缩放；普通滚轮不动缩放；+/- 键盘同效', () => {
    const view = renderGantt()
    const scroll = view.getByTestId('gantt-canvas-scroll')
    const base = zoomOf(view)
    expect(base).toBe(1)

    fireEvent.wheel(scroll, { ctrlKey: true, deltaY: -120 })
    const zoomedIn = zoomOf(view)
    expect(zoomedIn).toBeGreaterThan(base)

    fireEvent.wheel(scroll, { ctrlKey: true, deltaY: 120 })
    expect(zoomOf(view)).toBe(base)

    fireEvent.wheel(scroll, { ctrlKey: false, deltaY: -120 })
    expect(zoomOf(view)).toBe(base)

    fireEvent.keyDown(view.getByTestId('gantt-view'), { key: '+' })
    expect(zoomOf(view)).toBe(zoomedIn)
    fireEvent.keyDown(view.getByTestId('gantt-view'), { key: '-' })
    expect(zoomOf(view)).toBe(base)
  })

  it('缩放夹在档位区间内，不会越界', () => {
    expect(resolveZoomStep({ ctrlKey: true, deltaY: -1 })).toBe(1)
    expect(resolveZoomStep({ ctrlKey: true, deltaY: 1 })).toBe(-1)
    expect(resolveZoomStep({ ctrlKey: false, deltaY: -100 })).toBe(0)
    expect(resolveZoomStep({ ctrlKey: true, deltaY: 0 })).toBe(0)

    const vp = createGanttViewport({ scale: 'day' })
    for (let i = 0; i < GANTT_ZOOM_STEPS.length + 5; i += 1) vp.zoomIn()
    expect(vp.getZoom()).toBe(GANTT_ZOOM_STEPS[GANTT_ZOOM_STEPS.length - 1])
    for (let i = 0; i < GANTT_ZOOM_STEPS.length + 5; i += 1) vp.zoomOut()
    expect(vp.getZoom()).toBe(GANTT_ZOOM_STEPS[0])

    // 两刻度各自保留：week 缩放不影响 day
    const two = createGanttViewport({ scale: 'day' })
    two.zoomIn()
    const dayIndex = two.getState().zoomIndex.day
    two.setScale('week')
    two.zoomOut()
    expect(two.getState().zoomIndex.day).toBe(dayIndex)
    expect(two.getState().zoomIndex.week).toBeLessThan(dayIndex)
    expect(zoomFactorAt(dayIndex)).toBeGreaterThan(1)
  })
})

describe('T20-3 · 任务条 / 里程碑 / 跨 topic 轨道', () => {
  it('任务条为 topic 色浅底 + 深色进度内条', () => {
    const view = renderGantt()
    const bar = view.container.querySelector('[data-gantt-bar="t1"]')!
    const progress = view.container.querySelector('[data-gantt-progress="t1"]')!

    expect(bar.getAttribute('rx')).toBe('3')
    expect(bar.getAttribute('data-topic-id')).toBe('a')
    expect(bar.getAttribute('fill')).toBe(TOPIC_A_COLOR)
    expect(Number(bar.getAttribute('fill-opacity'))).toBeLessThan(0.5)
    expect(Number(bar.getAttribute('fill-opacity'))).toBeGreaterThan(0)

    expect(progress.getAttribute('fill')).not.toBe(TOPIC_A_COLOR)
    // 进度内条不设 fill-opacity（默认全不透明），与浅底外条形成明暗对比
    expect(progress.getAttribute('fill-opacity')).toBeNull()
    expect(luminance(progress.getAttribute('fill')!)).toBeLessThan(luminance(bar.getAttribute('fill')!))

    // 条宽/进度宽直接来自模型几何（t1 progress = 50）
    const model = modelOf()
    const row = model.rows.find((r) => r.id === 't1')!
    expect(Number(bar.getAttribute('width'))).toBe(row.bar!.width)
    expect(Number(progress.getAttribute('width'))).toBe(row.bar!.progressWidth)
  })

  it('里程碑画成旋转 45° 的菱形，topic 内里程碑留在 rows，跨 topic 里程碑走顶部独立轨道', () => {
    const view = renderGantt()

    const diamond = view.container.querySelector('[data-gantt-milestone="m-topic"]')!
    expect(diamond.getAttribute('transform')).toContain('rotate(45)')
    expect(view.container.querySelectorAll('[data-gantt-row="m-topic"]')).toHaveLength(1)

    const lane = view.container.querySelector('[data-gantt-lane]')!
    expect(lane.querySelector('[data-gantt-milestone="m-cross"]')).not.toBeNull()
    // 跨 topic 里程碑只出现在顶部轨道，不在 rows 里重复一遍
    expect(view.container.querySelectorAll('[data-gantt-row="m-cross"]')).toHaveLength(0)

    // 轨道行在左侧任务表里也有对应一行
    expect(view.container.querySelector('[data-gantt-table-lane]')).not.toBeNull()
  })

  it('splitMilestoneLane 只把 topicId 为 null 的里程碑提到轨道', () => {
    const { lane, body } = splitMilestoneLane(modelOf().rows)
    expect(lane.map((row) => row.id)).toEqual(['m-cross'])
    expect(body.some((row) => row.id === 'm-cross')).toBe(false)
    expect(body.some((row) => row.id === 'm-topic')).toBe(true)
  })
})

describe('T20-4 · 基线开关', () => {
  it('默认不渲染基线；开启后任务条下方出现细灰条，关闭后消失', () => {
    const view = renderGantt()
    expect(view.container.querySelector('[data-gantt-baseline]')).toBeNull()

    const toggle = view.getByTestId('gantt-baseline-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(false)

    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)

    const baseline = view.container.querySelector('[data-gantt-baseline="t2"]')!
    const bar = view.container.querySelector('[data-gantt-bar="t2"]')!
    expect(baseline.getAttribute('fill')).toBe(GANTT_BASELINE_FILL)
    expect(Number(baseline.getAttribute('height'))).toBeLessThanOrEqual(6)
    expect(Number(baseline.getAttribute('y'))).toBeGreaterThan(Number(bar.getAttribute('y')))
    // 只有配了 baseline 的任务才有灰条
    expect(view.container.querySelector('[data-gantt-baseline="t1"]')).toBeNull()

    fireEvent.click(toggle)
    expect(view.container.querySelector('[data-gantt-baseline]')).toBeNull()
  })
})

describe('T20-5 · 左侧任务表与画布同步 / 周末节假日列', () => {
  it('任务表四列且显示开始/结束/进度', () => {
    const view = renderGantt()
    const headers = [...view.container.querySelectorAll('[data-gantt-table-col]')]
    expect(headers.map((el) => el.textContent)).toEqual(['任务', '开始', '结束', '进度'])

    const row = view.container.querySelector('[data-gantt-table-row="t1"]')!
    expect(row.textContent).toContain('任务 t1')
    expect(row.textContent).toContain('2026-10-05')
    expect(row.textContent).toContain('2026-10-09')
    expect(row.textContent).toContain('50%')
  })

  it('画布 scrollTop 变化时左侧表体同步位移', () => {
    const view = renderGantt()
    const body = view.getByTestId('gantt-table-body')
    expect(body.style.transform).toBe('translateY(-0px)')

    scrollTo(view.getByTestId('gantt-canvas-scroll'), { scrollTop: 320 })
    expect(view.getByTestId('gantt-table-body').style.transform).toBe('translateY(-320px)')

    scrollTo(view.getByTestId('gantt-canvas-scroll'), { scrollTop: 96 })
    expect(view.getByTestId('gantt-table-body').style.transform).toBe('translateY(-96px)')
  })

  it('周末与节假日列浅灰底，补班日不灰', () => {
    const view = renderGantt()
    const column = (date: string) => view.container.querySelector(`[data-gantt-col="${date}"]`)!

    expect(column('2026-10-03').getAttribute('fill')).toBe(GANTT_OFF_COLUMN_FILL)
    expect(column('2026-10-03').getAttribute('data-weekend')).toBe('true')
    expect(column('2026-10-01').getAttribute('fill')).toBe(GANTT_OFF_COLUMN_FILL)
    expect(column('2026-10-01').getAttribute('data-holiday')).toBe('true')
    expect(column('2026-10-15').getAttribute('fill')).toBe('transparent')
    // 10-17 是周六但补班：工作日判定为真，不该涂灰
    expect(column('2026-10-17').getAttribute('fill')).toBe('transparent')
    expect(column('2026-10-17').getAttribute('data-workday')).toBe('true')
  })
})

describe('T20-6 · 可挂载性与外部 props', () => {
  it('默认导出，最小 props（只要 vault / filter）即可挂载', () => {
    const view = render(<GanttViewDefault vault={vault} filter={filter} today={TODAY} />)
    expect(view.getByTestId('gantt-view')).toBeDefined()
    // 缺省文案走中文兜底表
    expect(view.getByTestId('gantt-table')).toBeDefined()
  })

  it('外部传入 viewport 控制器时由它驱动刻度与缩放', () => {
    const viewport = createGanttViewport({ scale: 'week' })
    const view = renderGantt({ viewport, scale: undefined })

    expect(view.getByTestId('gantt-canvas-svg').getAttribute('data-scale')).toBe('week')
    act(() => {
      viewport.setScale('day')
      viewport.zoomIn()
    })
    expect(view.getByTestId('gantt-canvas-svg').getAttribute('data-scale')).toBe('day')
    expect(zoomOf(view)).toBeGreaterThan(1)
  })

  it('无已排期任务时渲染空画布而不崩溃', () => {
    const empty = makeVault([makeTask('t9', 'a')], [], [])
    const view = render(
      <GanttView vault={empty} filter={filter} scale="day" today={TODAY} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} t={t} />,
    )
    expect(view.getByTestId('gantt-view')).toBeDefined()
    expect(view.container.querySelectorAll('[data-gantt-row]')).toHaveLength(0)
    expect(view.getByTestId('gantt-empty')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 1000 任务样本：3 个话题 × 1000 条已排期任务，依赖 50 条，跨度 181 天
// ---------------------------------------------------------------------------

const BIG_RANGE = { start: '2026-01-01', end: '2026-06-30' }

function bigVault(count: number): Vault {
  const topics = [makeTopic('a', 'a0', TOPIC_A_COLOR), makeTopic('b', 'b0', TOPIC_B_COLOR)]
  const base = dayjs(BIG_RANGE.start)
  const tasks: Task[] = []
  for (let i = 0; i < count; i += 1) {
    const offset = i % 150
    tasks.push(
      makeTask(`big-${i}`, topics[i % 2]!.id, {
        order: `a${String(i).padStart(5, '0')}`,
        start: base.add(offset, 'day').format('YYYY-MM-DD'),
        due: base.add(offset + 2, 'day').format('YYYY-MM-DD'),
        progress: i % 101,
      }),
    )
  }

  const links: Dependency[] = []
  for (let i = 0; i + 1 < count; i += 20) {
    links.push({ id: `l-${i}`, from: `big-${i}`, to: `big-${i + 1}`, type: 'FS', lagDays: 0 })
  }

  return makeVault(tasks, [{ id: 'm-cross-big', topicId: null, title: '跨话题里程碑', date: '2026-03-10', done: false }], links)
}
