// @vitest-environment jsdom
//
// T21 · 依赖箭头 + 关键路径高亮 + hover 依赖高亮（spec 5.3 降级 / 5.4 渲染要点）。
//
// 断言口径与 T20 一致：几何期望从 buildGanttModel 的同一份模型推导，不硬编码坐标。
// SS/FF/SF 的端点由视图层按 link.type 分流（T19 遗留：领域层只算了 FS「右→左」，
// 且 ganttModel.ts 已合入主干、本任务不改），因此核心断言是：
//   ① 首末点落在正确的条边缘（SS 左→左 / FF 右→右 / FS 右→左 / SF 左→右）；
//   ② 折线相邻段一横一竖、且不穿过任一条的内部；
//   ③ 环上依赖红虚线、关键路径描边加粗、checkbox 可关、hover 前后各一跳高亮。

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { buildGanttModel } from '../../src/domain/ganttModel'
import type { DependencyArrow, GanttBar } from '../../src/domain/ganttModel'
import { createEmptyFilter } from '../../src/domain/queryEngine'
import type { Dependency, DependencyType, Milestone, Task, Topic, Vault, WorkCalendar } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import {
  GANTT_ARROW_COLOR,
  GANTT_CRITICAL_COLOR,
  GANTT_CRITICAL_STROKE_WIDTH,
  GANTT_CYCLE_COLOR,
  GANTT_HOVER_DIM_OPACITY,
  GANTT_TODAY_COLOR,
  dependencyArrowPath,
} from '../../src/views/GanttCanvas'
import { GanttView } from '../../src/views/GanttView'

const t = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t

const CALENDAR: WorkCalendar = {
  workdays: [1, 2, 3, 4, 5],
  holidays: ['2026-10-01'],
  extraWorkdays: ['2026-10-17'],
}
const OCTOBER = { start: '2026-10-01', end: '2026-10-31' }
const TODAY = '2026-10-15'
const CANVAS_WIDTH = 640
const CANVAS_HEIGHT = 320
const TOPIC_COLOR = '#4F46E5'
const filter = createEmptyFilter()

interface Pt {
  x: number
  y: number
}

function makeTopic(id: string, order: string, color = TOPIC_COLOR): Topic {
  return { id, name: `话题 ${id}`, color, parentId: null, order, archived: false }
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

function makeVault(tasks: Task[], links: Dependency[], milestones: Milestone[] = []): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'vault-t21',
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
    topics: [makeTopic('a', 'a0')],
    tasks,
    milestones,
    links,
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
  }
}

function link(id: string, from: string, to: string, type: DependencyType): Dependency {
  return { id, from, to, type, lagDays: 0 }
}

function modelOf(vault: Vault) {
  return buildGanttModel(vault, filter, 'day', { today: TODAY, range: OCTOBER })
}

function renderGantt(vault: Vault) {
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
    />,
  )
}

function barOf(model: ReturnType<typeof modelOf>, id: string): GanttBar {
  const row = model.rows.find((r) => r.id === id)
  if (row?.bar === undefined || row.bar === null) throw new Error(`no bar for ${id}`)
  return row.bar
}

/** 解析 "M x y L x y …" 为拐点数组。 */
function pointsOf(d: string): Pt[] {
  const tokens = d.trim().split(/\s+/)
  const points: Pt[] = []
  for (let i = 0; i < tokens.length; i += 3) {
    expect(tokens[i]).toMatch(/^[ML]$/)
    points.push({ x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) })
  }
  return points
}

const leftAnchor = (bar: GanttBar): Pt => ({ x: bar.x, y: bar.y + bar.height / 2 })
const rightAnchor = (bar: GanttBar): Pt => ({ x: bar.x + bar.width, y: bar.y + bar.height / 2 })

/** 相邻段必须一横一竖（轴对齐折线）。 */
function expectAxisAligned(points: Pt[]): void {
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!
    const cur = points[i]!
    expect(prev.x === cur.x || prev.y === cur.y).toBe(true)
  }
}

/** 轴对齐线段是否穿过矩形内部（不含边界）。 */
function segmentCrossesInterior(a: Pt, b: Pt, rect: GanttBar): boolean {
  const inside = (p: Pt): boolean =>
    p.x > rect.x && p.x < rect.x + rect.width && p.y > rect.y && p.y < rect.y + rect.height
  if (inside(a) || inside(b)) return true
  if (a.y === b.y) {
    if (a.y <= rect.y || a.y >= rect.y + rect.height) return false
    return Math.min(a.x, b.x) < rect.x + rect.width && Math.max(a.x, b.x) > rect.x
  }
  if (a.x === b.x) {
    if (a.x <= rect.x || a.x >= rect.x + rect.width) return false
    return Math.min(a.y, b.y) < rect.y + rect.height && Math.max(a.y, b.y) > rect.y
  }
  return true
}

function expectNotCrossingBars(points: Pt[], bars: GanttBar[]): void {
  for (let i = 1; i < points.length; i += 1) {
    for (const bar of bars) {
      expect(segmentCrossesInterior(points[i - 1]!, points[i]!, bar)).toBe(false)
    }
  }
}

// ---------------------------------------------------------------------------
// 样本库 A：四种依赖类型 × 目标在右/在左，共 7 条链接
// ---------------------------------------------------------------------------

const anchorVault = makeVault(
  [
    makeTask('p1', { order: 'a0', start: '2026-10-05', due: '2026-10-07' }),
    makeTask('p2', { order: 'a1', start: '2026-10-12', due: '2026-10-14' }),
    makeTask('s1', { order: 'a2', start: '2026-10-05', due: '2026-10-07' }),
    makeTask('s2', { order: 'a3', start: '2026-10-08', due: '2026-10-10' }),
    makeTask('s3', { order: 'a4', start: '2026-10-19', due: '2026-10-21' }),
    makeTask('s4', { order: 'a5', start: '2026-10-08', due: '2026-10-10' }),
    makeTask('f1', { order: 'a6', start: '2026-10-05', due: '2026-10-07' }),
    makeTask('f2', { order: 'a7', start: '2026-10-12', due: '2026-10-14' }),
    makeTask('f3', { order: 'a8', start: '2026-10-19', due: '2026-10-21' }),
    makeTask('f4', { order: 'a9', start: '2026-10-12', due: '2026-10-14' }),
    makeTask('c1', { order: 'b0', start: '2026-10-05', due: '2026-10-07' }),
    makeTask('c2', { order: 'b1', start: '2026-10-19', due: '2026-10-21' }),
    makeTask('c3', { order: 'b2', start: '2026-10-19', due: '2026-10-21' }),
    makeTask('c4', { order: 'b3', start: '2026-10-12', due: '2026-10-14' }),
  ],
  [
    link('L-FS', 'p1', 'p2', 'FS'),
    link('L-SS', 's1', 's2', 'SS'),
    link('L-SS-BACK', 's3', 's4', 'SS'),
    link('L-FF', 'f1', 'f2', 'FF'),
    link('L-FF-BACK', 'f3', 'f4', 'FF'),
    link('L-SF', 'c1', 'c2', 'SF'),
    link('L-SF-BACK', 'c3', 'c4', 'SF'),
  ],
)

/** 每条用例：链接 id / 源 / 目标 / 源锚点边 / 目标锚点边。 */
const ANCHOR_CASES: Array<{ id: string; from: string; to: string; src: 'left' | 'right'; tgt: 'left' | 'right' }> = [
  { id: 'L-FS', from: 'p1', to: 'p2', src: 'right', tgt: 'left' },
  { id: 'L-SS', from: 's1', to: 's2', src: 'left', tgt: 'left' },
  { id: 'L-SS-BACK', from: 's3', to: 's4', src: 'left', tgt: 'left' },
  { id: 'L-FF', from: 'f1', to: 'f2', src: 'right', tgt: 'right' },
  { id: 'L-FF-BACK', from: 'f3', to: 'f4', src: 'right', tgt: 'right' },
  { id: 'L-SF', from: 'c1', to: 'c2', src: 'left', tgt: 'right' },
  { id: 'L-SF-BACK', from: 'c3', to: 'c4', src: 'left', tgt: 'right' },
]

afterEach(cleanup)

describe('T21-1 · FS/SS/FF/SF 四种锚点（验收 1）', () => {
  it('FS：模型算好的折线原样投影（右→左，几何不重算）', () => {
    const view = renderGantt(anchorVault)
    const model = modelOf(anchorVault)
    const arrow = model.arrows.find((a) => a.id === 'L-FS')!

    const path = view.container.querySelector('[data-gantt-arrow="L-FS"]')!
    expect(path.getAttribute('d')).toBe(arrow.path)
    expect(path.getAttribute('data-type')).toBe('FS')

    const points = pointsOf(path.getAttribute('d')!)
    expect(points[0]).toEqual(rightAnchor(barOf(model, 'p1')))
    expect(points[points.length - 1]).toEqual(leftAnchor(barOf(model, 'p2')))
  })

  it.each(ANCHOR_CASES)('$id（$src → $tgt）：首末点锚定正确的条边缘', ({ id, from, to, src, tgt }) => {
    const view = renderGantt(anchorVault)
    const model = modelOf(anchorVault)

    const path = view.container.querySelector(`[data-gantt-arrow="${id}"]`)!
    const d = path.getAttribute('d')!
    const points = pointsOf(d)

    expect(points.length).toBeGreaterThanOrEqual(2)
    expect(points[0]).toEqual(src === 'right' ? rightAnchor(barOf(model, from)) : leftAnchor(barOf(model, from)))
    expect(points[points.length - 1]).toEqual(
      tgt === 'right' ? rightAnchor(barOf(model, to)) : leftAnchor(barOf(model, to)),
    )
    expectAxisAligned(points)
    expectNotCrossingBars(points, [barOf(model, from), barOf(model, to)])
    // marker-end 指向路径方向（orient=auto），三种状态共用 oe-gantt-arrow-head 前缀
    expect(path.getAttribute('marker-end')).toMatch(/^url\(#oe-gantt-arrow-head/)
  })

  it('全部 7 条链接各渲染一条箭头 path', () => {
    const view = renderGantt(anchorVault)
    const model = modelOf(anchorVault)
    expect(model.arrows).toHaveLength(7)
    expect(view.container.querySelectorAll('[data-gantt-arrow]')).toHaveLength(7)
  })
})

describe('T21-2 · 环上依赖红色虚线（验收 2）', () => {
  const cycleVault = makeVault(
    [
      makeTask('t1', { order: 'a0', start: '2026-10-05', due: '2026-10-07' }),
      makeTask('t2', { order: 'a1', start: '2026-10-12', due: '2026-10-14' }),
      makeTask('t3', { order: 'a2', start: '2026-10-19', due: '2026-10-21' }),
    ],
    [link('X-12', 't1', 't2', 'FS'), link('X-23', 't2', 't3', 'FS'), link('X-31', 't3', 't1', 'FS')],
  )

  it('三任务成环：箭头红色虚线，关键路径降级（criticalIds 空、cycles 非空）', () => {
    const model = modelOf(cycleVault)
    expect(model.cycles).toHaveLength(1)
    expect([...model.cycles[0]!].sort()).toEqual(['t1', 't2', 't3'])
    expect(model.criticalIds.size).toBe(0)

    const view = renderGantt(cycleVault)
    for (const id of ['X-12', 'X-23', 'X-31']) {
      const path = view.container.querySelector(`[data-gantt-arrow="${id}"]`)!
      expect(path.getAttribute('stroke')).toBe(GANTT_CYCLE_COLOR)
      expect(path.getAttribute('stroke-dasharray')).toBeTruthy()
      expect(path.getAttribute('data-cycle')).toBe('true')
      expect(path.getAttribute('marker-end')).toBe('url(#oe-gantt-arrow-head-cycle)')
    }
    // 降级后没有任何条被描边加粗
    for (const id of ['t1', 't2', 't3']) {
      expect(view.container.querySelector(`[data-gantt-bar="${id}"]`)!.getAttribute('stroke')).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 样本库 C：t1→t2→t3 链（全部关键）+ t4 孤立 + t5→t6 短链（非关键）
// ---------------------------------------------------------------------------

const chainVault = makeVault(
  [
    makeTask('t1', { order: 'a0', start: '2026-10-05', due: '2026-10-09' }),
    makeTask('t2', { order: 'a1', start: '2026-10-12', due: '2026-10-16' }),
    makeTask('t3', { order: 'a2', start: '2026-10-19', due: '2026-10-23' }),
    makeTask('t4', { order: 'a3', start: '2026-10-05', due: '2026-10-06' }),
    makeTask('t5', { order: 'a4', start: '2026-10-05', due: '2026-10-07' }),
    makeTask('t6', { order: 'a5', start: '2026-10-12', due: '2026-10-14' }),
  ],
  [link('C-12', 't1', 't2', 'FS'), link('C-23', 't2', 't3', 'FS'), link('C-56', 't5', 't6', 'FS')],
)

describe('T21-3 · 关键路径高亮与 checkbox 开关（验收 2/3）', () => {
  it('关键路径上的条描边加粗、关键箭头着色，非关键不加粗', () => {
    const model = modelOf(chainVault)
    expect([...model.criticalIds].sort()).toEqual(['t1', 't2', 't3'])

    const view = renderGantt(chainVault)
    for (const id of ['t1', 't2', 't3']) {
      const bar = view.container.querySelector(`[data-gantt-bar="${id}"]`)!
      expect(bar.getAttribute('stroke')).toBe(GANTT_CRITICAL_COLOR)
      expect(bar.getAttribute('stroke-width')).toBe(String(GANTT_CRITICAL_STROKE_WIDTH))
    }
    for (const id of ['t4', 't5', 't6']) {
      expect(view.container.querySelector(`[data-gantt-bar="${id}"]`)!.getAttribute('stroke')).toBeNull()
    }
    for (const id of ['C-12', 'C-23']) {
      expect(view.container.querySelector(`[data-gantt-arrow="${id}"]`)!.getAttribute('stroke')).toBe(
        GANTT_CRITICAL_COLOR,
      )
    }
    expect(view.container.querySelector('[data-gantt-arrow="C-56"]')!.getAttribute('stroke')).toBe(GANTT_ARROW_COLOR)
  })

  it('「关键路径」checkbox 默认开；关闭后不加粗、不展示计算，再开启恢复', () => {
    const view = renderGantt(chainVault)
    const toggle = view.getByTestId('gantt-critical-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(true)

    fireEvent.click(toggle)
    expect(toggle.checked).toBe(false)
    for (const id of ['t1', 't2', 't3']) {
      expect(view.container.querySelector(`[data-gantt-bar="${id}"]`)!.getAttribute('stroke')).toBeNull()
    }
    expect(view.container.querySelector('[data-gantt-arrow="C-12"]')!.getAttribute('stroke')).toBe(GANTT_ARROW_COLOR)

    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)
    expect(view.container.querySelector('[data-gantt-bar="t1"]')!.getAttribute('stroke')).toBe(GANTT_CRITICAL_COLOR)
    expect(view.container.querySelector('[data-gantt-arrow="C-12"]')!.getAttribute('stroke')).toBe(GANTT_CRITICAL_COLOR)
  })
})

describe('T21-4 · hover 某条：直接依赖高亮、其余淡出（验收 4）', () => {
  it('hover t2：前后各一跳的箭头与条保持不透明，其余降至 0.25', () => {
    const view = renderGantt(chainVault)
    const opacityOf = (selector: string): string | null =>
      view.container.querySelector(selector)!.getAttribute('opacity')

    // hover 前一切如常
    expect(opacityOf('[data-gantt-arrow="C-56"]')).toBeNull()
    expect(opacityOf('[data-gantt-bar="t4"]')).toBeNull()

    fireEvent.mouseOver(view.container.querySelector('[data-gantt-bar="t2"]')!)

    // 直接依赖箭头（t1→t2、t2→t3）与相关条不加淡出
    expect(opacityOf('[data-gantt-arrow="C-12"]')).toBeNull()
    expect(opacityOf('[data-gantt-arrow="C-23"]')).toBeNull()
    for (const id of ['t1', 't2', 't3']) {
      expect(opacityOf(`[data-gantt-bar="${id}"]`)).toBeNull()
    }
    // 其余箭头与条透明度 0.25
    expect(opacityOf('[data-gantt-arrow="C-56"]')).toBe(String(GANTT_HOVER_DIM_OPACITY))
    for (const id of ['t4', 't5', 't6']) {
      expect(opacityOf(`[data-gantt-bar="${id}"]`)).toBe(String(GANTT_HOVER_DIM_OPACITY))
    }

    // 指针移到没有任务条的行带（事件目标不含 data-gantt-bar）→ 高亮撤销
    fireEvent.mouseOver(view.container.querySelector('[data-gantt-row="t4"]')!)
    expect(opacityOf('[data-gantt-arrow="C-56"]')).toBeNull()
    expect(opacityOf('[data-gantt-bar="t4"]')).toBeNull()
  })

  it('hover 无依赖的任务：只有它自己保持不透明', () => {
    const view = renderGantt(chainVault)
    const opacityOf = (selector: string): string | null =>
      view.container.querySelector(selector)!.getAttribute('opacity')

    fireEvent.mouseOver(view.container.querySelector('[data-gantt-bar="t4"]')!)
    expect(opacityOf('[data-gantt-bar="t4"]')).toBeNull()
    expect(opacityOf('[data-gantt-bar="t1"]')).toBe(String(GANTT_HOVER_DIM_OPACITY))
    expect(opacityOf('[data-gantt-arrow="C-12"]')).toBe(String(GANTT_HOVER_DIM_OPACITY))
  })
})

describe('T21-5 · 今日线 1px 红 + 顶部标签（验收 5）', () => {
  it('今日线为 1px 红线，x 取自模型今日列，顶部带标签', () => {
    const view = renderGantt(chainVault)
    const model = modelOf(chainVault)
    const line = view.container.querySelector('[data-gantt-today="line"]')!
    const column = model.columns.find((c) => c.isToday)!

    expect(line.getAttribute('stroke')).toBe(GANTT_TODAY_COLOR)
    expect(Number(line.getAttribute('stroke-width'))).toBe(1)
    expect(Number(line.getAttribute('x1'))).toBe(column.x + column.width / 2)
    expect(view.getByTestId('gantt-today-label').textContent).toBe('今天')
  })
})

describe('T21-6 · 路由函数单测（dependencyArrowPath）', () => {
  const bar = (x: number, y: number, width = 96, height = 14): GanttBar => ({
    x,
    y,
    width,
    height,
    progressWidth: 0,
  })
  const arrow = (id: string, from: string, to: string, type: DependencyType): DependencyArrow => ({
    id,
    from,
    to,
    type,
    critical: false,
    points: [{ x: 0, y: 0 }],
    path: 'M 0 0 L 1 1',
  })

  it('FS 直接用模型 path（几何不重算）', () => {
    const a = arrow('fs', 'f', 't', 'FS')
    expect(dependencyArrowPath(a, new Map())).toBe(a.path)
  })

  it('SS 左→左 / FF 右→右 / SF 左→右，首末点锚定正确边缘', () => {
    const bars = new Map([
      ['f', bar(100, 50)],
      ['t', bar(300, 100)],
    ])
    const ss = pointsOf(dependencyArrowPath(arrow('ss', 'f', 't', 'SS'), bars))
    expect(ss[0]).toEqual({ x: 100, y: 57 })
    expect(ss[ss.length - 1]).toEqual({ x: 300, y: 107 })

    const ff = pointsOf(dependencyArrowPath(arrow('ff', 'f', 't', 'FF'), bars))
    expect(ff[0]).toEqual({ x: 196, y: 57 })
    expect(ff[ff.length - 1]).toEqual({ x: 396, y: 107 })

    const sf = pointsOf(dependencyArrowPath(arrow('sf', 'f', 't', 'SF'), bars))
    expect(sf[0]).toEqual({ x: 100, y: 57 })
    expect(sf[sf.length - 1]).toEqual({ x: 396, y: 107 })
  })

  it('多种相对位置下：折线轴对齐且不穿过任一条的内部', () => {
    const configs: Array<[GanttBar, GanttBar]> = [
      [bar(100, 50), bar(300, 100)], // 目标右下
      [bar(400, 50), bar(100, 100)], // 目标左下
      [bar(100, 50), bar(150, 100)], // 目标右下且 x 相近
      [bar(100, 100), bar(400, 50)], // 目标右上
      [bar(400, 100), bar(100, 50)], // 目标左上
    ]
    for (const [from, to] of configs) {
      const bars = new Map([
        ['f', from],
        ['t', to],
      ])
      for (const type of ['SS', 'FF', 'SF'] as const) {
        const points = pointsOf(dependencyArrowPath(arrow(type.toLowerCase(), 'f', 't', type), bars))
        expect(points.length).toBeGreaterThanOrEqual(2)
        expectAxisAligned(points)
        expectNotCrossingBars(points, [from, to])
      }
    }
  })
})
