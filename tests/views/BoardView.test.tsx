// @vitest-environment jsdom
//
// T15 · BoardView + TaskCard：列头 / C 方案卡片六项 / 逾期 / 阻塞标记 / 归档排除 /
// 筛选驱动 / 拖拽换列。
//
// 测试策略（任务书第 4 步）：jsdom 下 dnd-kit 的 pointer 事件序列很难稳定模拟，
// 因此拖拽的**判定逻辑**在 src/controllers/boardDnd.ts 的纯函数上单测（含跨列换列、
// 同列换序、仅被拖记录变化、原地 noop）；DOM 层只断言渲染结构与阻塞标记，
// 再用 applyBoardDrop（与 onDragEnd 完全同一入口）驱动一次真实 store 写入，
// 验证「换列」在组件上的可见结果。

import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { useStore } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyBoardDrop, isAboveCenter, planBoardDrop, sortByOrder } from '../../src/controllers/boardDnd'
import type { BoardDrop } from '../../src/controllers/boardDnd'
import { createCommandBus } from '../../src/domain/commandBus'
import { createEmptyFilter, createQueryEngine } from '../../src/domain/queryEngine'
import { createVaultStore } from '../../src/domain/store'
import type { Task, Topic, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import { BoardView } from '../../src/views/BoardView'

const TODAY = '2026-10-15'
const NOW = '2026-10-15T09:30:00.000Z'

function topic(id: string, name: string, color: string): Topic {
  return { id, name, color, parentId: null, order: 'a', archived: false }
}

function task(
  id: string,
  status: Task['status'],
  kind: Task['kind'],
  priority: Task['priority'],
  topicId: string,
  order: string,
  extra: Partial<Task> = {},
): Task {
  return {
    id,
    topicId,
    title: `任务-${id}`,
    status,
    kind,
    priority,
    progress: 0,
    tags: [],
    note: '',
    order,
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
    ...extra,
  }
}

/**
 * 夹具库（today = 2026-10-15）：
 *   todo    k1(P0,feature,tA,'a',due 10-20 未逾期,有笔记) / k2(P1,bug,tA,'b',due 10-10 逾期) / k8(P1,doc,tA,'c')
 *   doing   k3(P1,feature,tB,'a',进度40) / k4(P2,chore,tB,'b',无到期日,进度60)
 *   review  k5(P0,doc,tA,'a',进度80)
 *   done    k6(P3,feature,tA,'a',进度100)
 *   todo    k7(已归档，不得渲染)
 * 依赖：k6→k3（前置已完成→不阻塞）/ k1→k5（前置未完成→阻塞）/ k3→k4（阻塞）/ k1→k2（阻塞但在 todo 列不显示）
 */
function makeVault(): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v-board',
    appVersion: 'OffEarly 0.1.0',
    revision: 0,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
    },
    topics: [topic('tA', '支付重构', '#4F46E5'), topic('tB', '风控模型', '#059669')],
    tasks: [
      task('k1', 'todo', 'feature', 'P0', 'tA', 'a', { due: '2026-10-20', note: '## 拆分\n\n- 收敛入口', progress: 0 }),
      task('k2', 'todo', 'bug', 'P1', 'tA', 'b', { due: '2026-10-10' }),
      task('k8', 'todo', 'doc', 'P1', 'tA', 'c'),
      task('k3', 'doing', 'feature', 'P1', 'tB', 'a', { due: '2026-10-25', progress: 40 }),
      task('k4', 'doing', 'chore', 'P2', 'tB', 'b', { progress: 60 }),
      task('k5', 'review', 'doc', 'P0', 'tA', 'a', { due: '2026-10-12', progress: 80 }),
      task('k6', 'done', 'feature', 'P3', 'tA', 'a', { due: '2026-10-01', progress: 100 }),
      task('k7', 'todo', 'research', 'P2', 'tA', 'a', { archived: true }),
    ],
    milestones: [],
    links: [
      { id: 'l1', from: 'k6', to: 'k3', type: 'FS', lagDays: 0 },
      { id: 'l2', from: 'k1', to: 'k5', type: 'FS', lagDays: 0 },
      { id: 'l3', from: 'k3', to: 'k4', type: 'FS', lagDays: 0 },
      { id: 'l4', from: 'k1', to: 'k2', type: 'FS', lagDays: 0 },
    ],
    assets: [],
  }
}

function setup(filter = createEmptyFilter()) {
  const store = createVaultStore(makeVault())
  const bus = createCommandBus(store)
  const i18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })
  const onOpenTask = vi.fn()
  // Harness 模拟集成窗口的接线方式：vault 从 store 派生后传给 BoardView
  function Harness() {
    const vault = useStore(store, (state) => state.vault)
    return (
      <BoardView
        vault={vault}
        filter={filter}
        bus={bus}
        t={i18n.t}
        today={TODAY}
        onOpenTask={onOpenTask}
      />
    )
  }
  const view = render(<Harness />)
  return { store, bus, view, onOpenTask, i18n }
}

function drop(partial: Partial<BoardDrop> & Pick<BoardDrop, 'draggedId' | 'targetStatus'>): BoardDrop {
  return { position: 'end', overId: null, ...partial }
}

afterEach(cleanup)

// ─────────────────────────────── 列头与整体结构 ───────────────────────────────

describe('BoardView 列头', () => {
  it('固定四列 todo/doing/review/done，列头含列名 + 计数 + 完成比', () => {
    const { view } = setup()

    for (const [status, name, count, ratio] of [
      ['todo', '待办', '3', '0%'],
      ['doing', '进行中', '2', '50%'],
      ['review', '评审中', '1', '80%'],
      ['done', '已完成', '1', '100%'],
    ] as const) {
      const column = view.getByTestId(`board-column-${status}`)
      expect(within(column).getByText(name)).toBeDefined()
      expect(view.getByTestId(`board-column-count-${status}`).textContent).toBe(count)
      expect(view.getByTestId(`board-column-ratio-${status}`).textContent).toBe(ratio)
    }
  })

  it('空列完成比显示 —（无除以零）', () => {
    const { view } = setup({ ...createEmptyFilter(), statuses: ['todo', 'doing'] })
    expect(view.getByTestId('board-column-ratio-review').textContent).toBe('—')
    expect(view.getByTestId('board-column-empty-review').textContent).toBe('暂无任务')
  })
})

// ─────────────────────────────── C 方案卡片六项 ───────────────────────────────

describe('TaskCard C 方案六项', () => {
  it('色点+话题名 / 标题 / 类别 chip / 优先级点 / 到期日 / 依赖角标', () => {
    const { view } = setup()
    const card = view.getByTestId('task-card-k1')

    // ① 话题色点取 topic.color，与 TopicSidebar 色块同一份数据
    const dot = within(card).getByTestId('task-topic-dot-k1')
    expect(dot.getAttribute('data-color')).toBe('#4F46E5')
    expect(within(card).getByText('支付重构')).toBeDefined()
    // ② 标题
    expect(within(card).getByText('任务-k1')).toBeDefined()
    // ③ 类别 chip
    expect(within(card).getByTestId('task-kind-k1').textContent).toBe('需求')
    // ④ 优先级点（P0 → 逾期红 token）
    const priority = within(card).getByTestId('task-priority-k1')
    expect(priority.getAttribute('data-priority')).toBe('P0')
    expect(priority.getAttribute('style')).toContain('var(--oe-overdue)')
    // ⑤ 到期日（未逾期 → 次级灰）
    const due = within(card).getByTestId('task-due-k1')
    expect(due.textContent).toBe('2026-10-20')
    expect(due.getAttribute('data-overdue')).toBe('false')
    // ⑥ 依赖角标：直接前置数量（k1→k5、k1→k2 两条出边不算，入边 0）
    expect(within(card).getByTestId('task-deps-k1').textContent).toContain('0')
  })

  it('类别 chip 五类各有译名（t() 走消息表，不写死）', () => {
    const { view } = setup()
    expect(within(view.getByTestId('task-card-k2')).getByTestId('task-kind-k2').textContent).toBe('缺陷')
    expect(within(view.getByTestId('task-card-k4')).getByTestId('task-kind-k4').textContent).toBe('杂务')
    expect(within(view.getByTestId('task-card-k5')).getByTestId('task-kind-k5').textContent).toBe('文档')
  })

  it('有笔记加文档图标，无笔记不出现', () => {
    const { view } = setup()
    expect(view.getByTestId('task-note-k1')).toBeDefined()
    expect(view.queryByTestId('task-note-k3')).toBeNull()
  })

  it('无到期日的卡片不渲染日期位', () => {
    const { view } = setup()
    expect(view.queryByTestId('task-due-k4')).toBeNull()
  })

  it('逾期到期日用 --oe-overdue（#DC2626）；done 列不判逾期', () => {
    const { view } = setup()
    const overdueDue = view.getByTestId('task-due-k2')
    expect(overdueDue.getAttribute('data-overdue')).toBe('true')
    expect(overdueDue.getAttribute('style')).toContain('var(--oe-overdue)')

    const doneDue = view.getByTestId('task-due-k6')
    expect(doneDue.getAttribute('data-overdue')).toBe('false')
    expect(doneDue.getAttribute('style')).toContain('var(--oe-text-muted)')
  })

  it('无任何条纹 / 无整卡底色（C 方案硬约束）', () => {
    const { view } = setup()
    const style = view.getByTestId('task-card-k1').getAttribute('style') ?? ''
    // 中性白底卡片，不是话题色整卡底色（方案 D 被禁）
    expect(style).toContain('var(--oe-surface)')
    expect(style).not.toContain('#4F46E5')
    // 左色条 / 顶线 / 渐变一律没有
    expect(style).not.toMatch(/border-left|border-top|background-image|linear-gradient/)
  })

  it('点击卡片只暴露 onOpenTask(taskId) 回调', () => {
    const { view, onOpenTask } = setup()
    fireEvent.click(view.getByTestId('task-card-k3'))
    expect(onOpenTask).toHaveBeenCalledWith('k3')
  })
})

// ─────────────────────────────── 阻塞标记 ───────────────────────────────

describe('阻塞标记（琥珀，不阻止拖放）', () => {
  it('doing/review 列且 isBlocked 时显示；todo 列不显示；前置已完成不显示', () => {
    const { view } = setup()

    // k5 在 review、前置 k1 未完成 → 有标记
    const marker = view.getByTestId('task-blocked-k5')
    expect(marker.textContent).toBe('阻塞')
    expect(marker.getAttribute('style')).toContain('var(--oe-blocked)')

    // k4 在 doing、前置 k3 未完成 → 有标记
    expect(view.getByTestId('task-blocked-k4')).toBeDefined()

    // k3 在 doing、前置 k6 已完成 → 无标记
    expect(view.queryByTestId('task-blocked-k3')).toBeNull()

    // k2 在 todo、被 k1 阻塞 → 本列不显示（标记只属于 doing/review）
    expect(view.queryByTestId('task-blocked-k2')).toBeNull()
    expect(view.getByTestId('task-card-k2').getAttribute('data-blocked')).toBe('false')
  })

  it('卡片 data-blocked 属性与标记同步', () => {
    const { view } = setup()
    expect(view.getByTestId('task-card-k5').getAttribute('data-blocked')).toBe('true')
    expect(view.getByTestId('task-card-k1').getAttribute('data-blocked')).toBe('false')
  })
})

// ─────────────────────────────── 归档与筛选 ───────────────────────────────

describe('归档与筛选', () => {
  it('归档任务不渲染', () => {
    const { view } = setup()
    expect(view.queryByTestId('task-card-k7')).toBeNull()
    expect(view.queryByText('任务-k7')).toBeNull()
  })

  it('筛选结果驱动列内容（statuses）', () => {
    const { view } = setup({ ...createEmptyFilter(), statuses: ['doing'] })
    expect(view.getByTestId('task-card-k3')).toBeDefined()
    expect(view.getByTestId('task-card-k4')).toBeDefined()
    expect(view.queryByTestId('task-card-k1')).toBeNull()
    expect(view.queryByTestId('task-card-k5')).toBeNull()
    expect(view.getByTestId('board-column-count-todo').textContent).toBe('0')
  })

  it('筛选结果驱动列内容（topicIds）', () => {
    const { view } = setup({ ...createEmptyFilter(), topicIds: ['tB'] })
    expect(view.getByTestId('task-card-k3')).toBeDefined()
    expect(view.getByTestId('task-card-k4')).toBeDefined()
    expect(view.queryByTestId('task-card-k1')).toBeNull()
    expect(view.queryByTestId('task-card-k5')).toBeNull()
  })
})

// ─────────────────────────────── 拖拽换列（boardDnd 纯函数） ───────────────────────────────

describe('boardDnd 拖拽判定（纯函数）', () => {
  it('跨列拖拽改 status：落到目标列某张卡片下方', () => {
    const vault = makeVault()
    const plan = planBoardDrop(
      vault,
      drop({ draggedId: 'k1', targetStatus: 'doing', position: 'below', overId: 'k4' }),
    )
    expect(plan.kind).toBe('move')
    if (plan.kind !== 'move' || plan.command.type !== 'task.move') {
      throw new Error('expected task.move command')
    }
    expect(plan.command.payload).toMatchObject({ id: 'k1', status: 'doing' })
    // 新键严格落在 k4 之后（列尾）：'b' < 新键
    expect(plan.command.payload.order > 'b').toBe(true)
  })

  it('跨列拖到空列 / 列尾：拿到全新的中点键', () => {
    const vault = makeVault()
    const plan = planBoardDrop(vault, drop({ draggedId: 'k1', targetStatus: 'done' }))
    expect(plan.kind).toBe('move')
    if (plan.kind !== 'move' || plan.command.type !== 'task.move') {
      throw new Error('expected task.move command')
    }
    expect(plan.command.payload.status).toBe('done')
    expect(plan.command.payload.order.length).toBeGreaterThan(0)
  })

  it('同列拖拽改 order：仅被拖记录变化，其余卡片原样', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const before = store.getVault().tasks

    // k1 从 todo 首位拖到 k8 之后（列尾）
    const plan = applyBoardDrop(
      bus,
      store.getVault(),
      drop({ draggedId: 'k1', targetStatus: 'todo', position: 'below', overId: 'k8' }),
    )
    expect(plan.kind).toBe('move')

    const after = store.getVault().tasks
    expect(after.length).toBe(before.length)
    for (const task of before) {
      const next = after.find((candidate) => candidate.id === task.id)!
      if (task.id === 'k1') {
        // 只有被拖任务的 order 变了；status 不变
        expect(next.order).not.toBe(task.order)
        expect(next.status).toBe('todo')
      } else {
        // 其余卡片一个字段都没动（引用相等即未重建）
        expect(next).toBe(task)
      }
    }
    // 撤销栈正好一条，undo 后整体还原
    expect(bus.undoDepth()).toBe(1)
    expect(bus.undo()).toBe(true)
    expect(store.getVault().tasks).toEqual(before)
  })

  it('跨列拖入 doing 后，被拖卡片在原列消失、进入目标列', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    applyBoardDrop(bus, store.getVault(), drop({ draggedId: 'k2', targetStatus: 'doing', position: 'above', overId: 'k3' }))

    const tasks = store.getVault().tasks
    const moved = tasks.find((task) => task.id === 'k2')!
    expect(moved.status).toBe('doing')
    // 插到 k3 之前：新键 < k3 的键
    expect(moved.order < tasks.find((task) => task.id === 'k3')!.order).toBe(true)
    // 其余任务未被动过
    for (const id of ['k1', 'k8', 'k3', 'k4', 'k5', 'k6', 'k7']) {
      expect(tasks.find((task) => task.id === id)).toBe(store.getInitialState().vault.tasks.find((task) => task.id === id))
    }
  })

  it('原地放下（含落到自己身上）返回 noop，不写 store、不进撤销栈', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const before = store.getVault()

    // 同列内把 k1 放回原位（k2 上方 = 它本来的位置）。
    // 注意夹具里归档任务 k7（order 'a'）正夹在 k1 与 k2 之间：看板不渲染归档任务，
    // 「原地放下」必须按可见序列判定为 noop，否则一次误放就会白进撤销栈
    expect(applyBoardDrop(bus, before, drop({ draggedId: 'k1', targetStatus: 'todo', position: 'above', overId: 'k2' })).kind).toBe('noop')
    // 把已在列尾的 k8 往列尾放
    expect(applyBoardDrop(bus, before, drop({ draggedId: 'k8', targetStatus: 'todo' })).kind).toBe('noop')
    // 落到自己身上
    expect(applyBoardDrop(bus, before, drop({ draggedId: 'k3', targetStatus: 'doing', position: 'below', overId: 'k3' })).kind).toBe('noop')

    expect(store.getVault()).toBe(before)
    expect(bus.undoDepth()).toBe(0)
  })

  it('LexoRank 中点键落在上下邻居之间（同列插入中间位）', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    applyBoardDrop(bus, store.getVault(), drop({ draggedId: 'k1', targetStatus: 'todo', position: 'above', overId: 'k8' }))

    const todo = sortByOrder(store.getVault().tasks.filter((task) => !task.archived && task.status === 'todo'))
    const ids = todo.map((task) => task.id)
    expect(ids).toEqual(['k2', 'k1', 'k8'])
    // 键严格递增，无冲突
    expect(todo[0]!.order < todo[1]!.order).toBe(true)
    expect(todo[1]!.order < todo[2]!.order).toBe(true)
  })

  it('不合法输入抛错（被拖任务不存在 / 邻居不在目标列）', () => {
    const vault = makeVault()
    expect(() => planBoardDrop(vault, drop({ draggedId: 'nope', targetStatus: 'todo' }))).toThrow()
    expect(() =>
      planBoardDrop(vault, drop({ draggedId: 'k1', targetStatus: 'doing', position: 'above', overId: 'k2' })),
    ).toThrow()
  })

  it('isAboveCenter：指针在邻居中心线上方判 above', () => {
    expect(isAboveCenter({ top: 0, height: 20 }, { top: 100, height: 20 })).toBe(true)
    expect(isAboveCenter({ top: 100, height: 20 }, { top: 0, height: 20 })).toBe(false)
    expect(isAboveCenter({ top: 90, height: 20 }, { top: 100, height: 20 })).toBe(true)
  })
})

// ─────────────────────────────── 拖拽换列（组件级，经同一入口驱动） ───────────────────────────────

describe('拖拽换列的组件级结果', () => {
  it('经 applyBoardDrop（onDragEnd 同一入口）写入后，卡片跨列且计数/列头随之更新', () => {
    const { store, bus, view } = setup()

    act(() => {
      applyBoardDrop(bus, store.getVault(), drop({ draggedId: 'k2', targetStatus: 'doing', position: 'below', overId: 'k4' }))
    })

    // k2 出现在 doing 列、从 todo 列消失
    expect(within(view.getByTestId('board-column-doing')).getByTestId('task-card-k2')).toBeDefined()
    expect(within(view.getByTestId('board-column-todo')).queryByTestId('task-card-k2')).toBeNull()
    // 计数与完成比重算：todo 3→2，doing 2→3
    expect(view.getByTestId('board-column-count-todo').textContent).toBe('2')
    expect(view.getByTestId('board-column-count-doing').textContent).toBe('3')
    // 拖入 doing 且 k2 被 k1 阻塞 → 琥珀标记出现（不阻止）
    expect(view.getByTestId('task-blocked-k2')).toBeDefined()
  })

  it('换列后 QueryEngine 视角一致：新状态进入查询结果', () => {
    const { store, bus } = setup()
    act(() => {
      applyBoardDrop(bus, store.getVault(), drop({ draggedId: 'k1', targetStatus: 'review' }))
    })
    const engine = createQueryEngine(store.getVault().topics, store.getVault().tasks, store.getVault().links, { today: TODAY })
    const review = engine.query(createEmptyFilter()).filter((task) => task.status === 'review')
    expect(review.map((task) => task.id).sort()).toEqual(['k1', 'k5'])
  })
})
