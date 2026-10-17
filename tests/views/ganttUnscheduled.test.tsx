// @vitest-environment jsdom
//
// T22 · 未排期侧栏 + 甘特图与筛选联动（spec 5.4：未排期任务列右侧折叠面板，点击补日期）。
//
// 断言口径：侧栏数据一律取自 buildGanttModel 的 unscheduled（与 rows 同源、随 filter 收缩），
// 所以测试里的期望集合也从同一份模型推导，不把任务清单硬编码成常量。
// 点击不外派到 TaskDrawer（T17 组件，本任务不 import）：只验证 onOpenTask(taskId) 回调契约，
// 接线归集成窗口（App.tsx 已有 drawer 受控状态与看板 onOpenTask 先例）。

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildGanttModel, colorOfTopic } from '../../src/domain/ganttModel'
import { createEmptyFilter } from '../../src/domain/queryEngine'
import type { Filter, Task, Vault, WorkCalendar } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
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

const TOPIC_A_COLOR = '#4F46E5'
const TOPIC_B_COLOR = '#0EA5E9'
/** 跨话题 / 话题已删时的中性色点（与 TaskCard 的 topic?.color ?? FAINT 同语言）。 */
const NEUTRAL_DOT = 'var(--oe-text-faint)'

function makeTopic(id: string, order: string, color: string) {
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

function makeVault(tasks: Task[]): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'vault-t22',
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
    milestones: [],
    links: [],
    assets: [],
  }
}

/** u3 刻意用 null 话题（脏数据/跨话题）：QueryEngine 的话题筛选会排除它，但空筛选下它仍在 unscheduled 里。 */
const NULL_TOPIC_TASK = makeTask('u3', null as unknown as string)

const vault = makeVault([
  makeTask('s1', 'a', { order: 'a0', start: '2026-10-05', due: '2026-10-09' }),
  makeTask('s2', 'a', { order: 'b0', start: '2026-10-12', due: '2026-10-16' }),
  makeTask('u1', 'b', { order: 'a0' }),
  makeTask('u2', 'a', { order: 'c0' }),
  makeTask('s3', 'b', { order: 'b0', start: '2026-10-05', due: '2026-10-09' }),
  NULL_TOPIC_TASK,
])

/** 补完日期的 u1：rerender 这个 vault 即模拟「TaskDrawer 里补了排期」。 */
const vaultScheduled = makeVault(
  vault.tasks.map((task) => (task.id === 'u1' ? { ...task, start: '2026-10-19', due: '2026-10-23' } : task)),
)

const emptyFilter = createEmptyFilter()
const topicAFilter: Filter = { ...emptyFilter, topicIds: ['a'] }
const topicBFilter: Filter = { ...emptyFilter, topicIds: ['b'] }

function modelOf(v: Vault = vault, filter: Filter = emptyFilter) {
  return buildGanttModel(v, filter, 'day', { today: TODAY, range: OCTOBER })
}

function renderGantt(props: Partial<Parameters<typeof GanttView>[0]> = {}) {
  return render(
    <GanttView
      vault={vault}
      filter={emptyFilter}
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

/** 侧栏当前列出的任务 id（顺序即模型 unscheduled 的顺序）。 */
function sidebarIds(view: ReturnType<typeof render>): string[] {
  return [...view.container.querySelectorAll('[data-gantt-unscheduled]')].map((el) =>
    String(el.getAttribute('data-gantt-unscheduled')),
  )
}

/** 画布上已渲染的任务条 id（rows 的投影）。 */
function barIds(view: ReturnType<typeof render>): string[] {
  return [...view.container.querySelectorAll('[data-gantt-bar]')].map((el) => String(el.getAttribute('data-gantt-bar')))
}

afterEach(cleanup)

describe('T22-1 · 右侧折叠面板列出 unscheduled（标题 + topic 色点）', () => {
  it('列出全部未排期任务，色点取 colorOfTopic，跨话题任务给中性色点', () => {
    const view = renderGantt()
    const panel = view.getByTestId('gantt-unscheduled-panel')
    expect(panel.getAttribute('data-open')).toBe('true')

    // 集合与模型 unscheduled 同源同序
    expect(sidebarIds(view)).toEqual(modelOf().unscheduled.map((task) => task.id))
    expect(sidebarIds(view)).toEqual(['u1', 'u2', 'u3'])

    // 标题逐条渲染
    expect(view.getByTestId('gantt-unscheduled-u1').textContent).toContain('任务 u1')
    expect(view.getByTestId('gantt-unscheduled-u2').textContent).toContain('任务 u2')
    expect(view.getByTestId('gantt-unscheduled-u3').textContent).toContain('任务 u3')

    // 计数
    expect(view.getByTestId('gantt-unscheduled-count').textContent).toBe('3 项')

    // 色点：有话题取话题色（colorOfTopic），topicId 为 null 取中性 token
    expect(view.getByTestId('gantt-unscheduled-dot-u1').getAttribute('data-color')).toBe(
      colorOfTopic(vault.topics, 'b'),
    )
    expect(view.getByTestId('gantt-unscheduled-dot-u1').getAttribute('data-color')).toBe(TOPIC_B_COLOR)
    expect(view.getByTestId('gantt-unscheduled-dot-u2').getAttribute('data-color')).toBe(TOPIC_A_COLOR)
    expect(view.getByTestId('gantt-unscheduled-dot-u3').getAttribute('data-color')).toBe(NEUTRAL_DOT)

    // 已排期任务不进侧栏；未排期任务不进画布 rows（同源互斥）
    expect(view.container.querySelector('[data-gantt-unscheduled="s1"]')).toBeNull()
    expect(view.container.querySelector('[data-gantt-bar="u1"]')).toBeNull()
    expect(barIds(view).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('行高与画布行协调（32px），面板挂在画布右侧', () => {
    const view = renderGantt()
    const row = view.getByTestId('gantt-unscheduled-u1')
    expect(row.style.height).toBe('32px')

    const canvas = view.getByTestId('gantt-canvas-scroll')
    const panel = view.getByTestId('gantt-unscheduled-panel')
    // 面板在 DOM 中位于画布之后（右侧），且同处一行；结构分隔取发丝线 token
    expect(canvas.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(panel.getAttribute('style')).toContain('var(--oe-separator)')
  })

  it('没有未排期任务时给一句空态文案（空面板默认收起，先展开再看）', () => {
    const allScheduled = makeVault([makeTask('s1', 'a', { start: '2026-10-05', due: '2026-10-09' })])
    const view = renderGantt({ vault: allScheduled })
    fireEvent.click(view.getByTestId('gantt-unscheduled-toggle'))
    expect(view.getByTestId('gantt-unscheduled-empty').textContent).toBe('所有任务都已排期')
    expect(sidebarIds(view)).toEqual([])
  })

  it('未排期为空时自动收成竖轨；手动展开后不再被自动收回去', () => {
    const allScheduled = makeVault([makeTask('s1', 'a', { start: '2026-10-05', due: '2026-10-09' })])
    const view = renderGantt({ vault: allScheduled })
    const panel = view.getByTestId('gantt-unscheduled-panel')

    expect(panel.getAttribute('data-open')).toBe('false')
    expect(view.getByTestId('gantt-unscheduled-toggle').getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(view.getByTestId('gantt-unscheduled-toggle'))
    expect(panel.getAttribute('data-open')).toBe('true')

    // 模型重算（换一份同样没有未排期任务的库）后仍保持手动展开的状态
    view.rerender(
      <GanttView
        vault={makeVault([makeTask('s9', 'a', { start: '2026-10-05', due: '2026-10-09' })])}
        filter={emptyFilter}
        scale="day"
        range={OCTOBER}
        today={TODAY}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        t={t}
      />,
    )
    expect(view.getByTestId('gantt-unscheduled-panel').getAttribute('data-open')).toBe('true')

    // 手动收起后也不会因为「曾经自动收起过」被弹回来
    fireEvent.click(view.getByTestId('gantt-unscheduled-toggle'))
    expect(view.getByTestId('gantt-unscheduled-panel').getAttribute('data-open')).toBe('false')
  })

  it('有未排期任务时默认展开（补排期入口不能藏起来）', () => {
    const view = renderGantt()
    expect(view.getByTestId('gantt-unscheduled-panel').getAttribute('data-open')).toBe('true')
  })
})

describe('T22-2 · 折叠 / 展开', () => {
  it('默认展开；点开关收起列表再展开，折叠状态存在本地 state', () => {
    const view = renderGantt()
    const toggle = view.getByTestId('gantt-unscheduled-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(view.getByTestId('gantt-unscheduled-panel').getAttribute('data-open')).toBe('false')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-gantt-unscheduled="u1"]')).toBeNull()
    expect(view.queryByTestId('gantt-unscheduled-count')).toBeNull()

    fireEvent.click(toggle)
    expect(view.getByTestId('gantt-unscheduled-panel').getAttribute('data-open')).toBe('true')
    expect(sidebarIds(view)).toEqual(['u1', 'u2', 'u3'])
  })
})

describe('T22-3 · 点击未排期任务经 onOpenTask 外送', () => {
  it('点击行调用 onOpenTask(taskId)；rerender 换 props 后仍走新回调', () => {
    const first = vi.fn()
    const view = renderGantt({ onOpenTask: first })

    fireEvent.click(view.getByTestId('gantt-unscheduled-u1'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith('u1')

    const second = vi.fn()
    view.rerender(
      <GanttView
        vault={vault}
        filter={emptyFilter}
        scale="day"
        range={OCTOBER}
        today={TODAY}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        t={t}
        onOpenTask={second}
      />,
    )
    fireEvent.click(view.getByTestId('gantt-unscheduled-u2'))
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith('u2')
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('键盘 Enter 同样触发回调；未传 onOpenTask 时不崩', () => {
    const onOpenTask = vi.fn()
    const view = renderGantt({ onOpenTask })
    fireEvent.keyDown(view.getByTestId('gantt-unscheduled-u3'), { key: 'Enter' })
    expect(onOpenTask).toHaveBeenCalledWith('u3')

    // 同一用例内二次挂载前先卸掉前一份，否则 document 里有两份同 testid（cleanup 只在 afterEach 跑）
    cleanup()
    const silent = renderGantt()
    fireEvent.click(silent.getByTestId('gantt-unscheduled-u1'))
    expect(silent.getByTestId('gantt-unscheduled-panel')).toBeDefined()
  })
})

describe('T22-4 · 补排期后任务进入甘特图 rows', () => {
  it('rerender 传入已补日期的 vault：任务从侧栏消失、画布出现任务条与行', () => {
    const view = renderGantt()
    expect(sidebarIds(view)).toContain('u1')
    expect(view.container.querySelector('[data-gantt-bar="u1"]')).toBeNull()

    view.rerender(
      <GanttView
        vault={vaultScheduled}
        filter={emptyFilter}
        scale="day"
        range={OCTOBER}
        today={TODAY}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        t={t}
      />,
    )

    expect(sidebarIds(view)).toEqual(['u2', 'u3'])
    expect(view.container.querySelector('[data-gantt-unscheduled="u1"]')).toBeNull()
    expect(view.container.querySelector('[data-gantt-bar="u1"]')).not.toBeNull()
    expect(view.container.querySelector('[data-gantt-row="u1"]')).not.toBeNull()
    // 侧栏集合与模型同源：补完后 u1 进 scheduled，unscheduled 随之收缩
    expect(modelOf(vaultScheduled).unscheduled.map((task) => task.id)).toEqual(['u2', 'u3'])
  })
})

describe('T22-5 · rows 与侧栏受 FilterBar 结果驱动（换 filter 重渲染，同步变化）', () => {
  it('切到话题 a：rows 与侧栏都只剩话题 a 的任务', () => {
    const view = renderGantt()
    expect(sidebarIds(view)).toEqual(['u1', 'u2', 'u3'])
    expect(barIds(view).sort()).toEqual(['s1', 's2', 's3'])

    view.rerender(
      <GanttView
        vault={vault}
        filter={topicAFilter}
        scale="day"
        range={OCTOBER}
        today={TODAY}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        t={t}
      />,
    )

    // 条件与看板一致（同一份 filter 过 QueryEngine）：u3 话题为 null，被话题筛选排除
    expect(sidebarIds(view)).toEqual(modelOf(vault, topicAFilter).unscheduled.map((task) => task.id))
    expect(sidebarIds(view)).toEqual(['u2'])
    expect(barIds(view).sort()).toEqual(['s1', 's2'])
  })

  it('切到话题 b：侧栏与 rows 同步换成话题 b 的集合', () => {
    const view = renderGantt()

    view.rerender(
      <GanttView
        vault={vault}
        filter={topicBFilter}
        scale="day"
        range={OCTOBER}
        today={TODAY}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        t={t}
      />,
    )

    expect(sidebarIds(view)).toEqual(modelOf(vault, topicBFilter).unscheduled.map((task) => task.id))
    expect(sidebarIds(view)).toEqual(['u1'])
    expect(barIds(view).sort()).toEqual(['s3'])
  })
})
