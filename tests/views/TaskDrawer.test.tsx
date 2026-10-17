// @vitest-environment jsdom
//
// T17 · TaskDrawer + DependencyEditor + commandBus 的 link 命令。
//
// 与 T18 同一手法：用**真的 VaultStore + 真的 CommandBus**（不是假 store）——
// 验收 5 要求「Ctrl+Z 撤销走 CommandBus」，假 store 会把撤销栈验成空气。
// 覆盖任务书点名的三条：建依赖 / 改日期 / 成环标红；另加受控契约（rerender 驱动
// props → 抽屉打开并定位）、Esc 关闭、done 强压进度、保存指示三态、link 命令的
// undo/redo 语义（删除逆元带完整 link 体与原下标、patch 逆元字段级还原）。

import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createCommandBus,
  createLinkCommand,
  deleteLinkCommand,
  patchLinkCommand,
  patchTaskCommand,
} from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Dependency, Task, Topic, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import {
  DEPENDENCY_TYPES,
  cycleLinkIds,
  fuzzyScore,
  searchDependencyCandidates,
  splitTaskLinks,
  taskInCycle,
} from '../../src/views/DependencyEditor'
import { TaskDrawer, dateRangeErrorKey, durationLabel, parseTags, sameTags, tagsToInput } from '../../src/views/TaskDrawer'
import type { TaskDrawerProps } from '../../src/views/TaskDrawer'
import type { SaveIndicatorSource } from '../../src/views/SaveIndicator'
import type { SaveState } from '../../src/persistence/autosave'

const NOW = '2026-10-15T09:30:00.000Z'

function topic(id: string, name: string, parentId: string | null, order: string): Topic {
  return { id, name, color: '#4F46E5', parentId, order, archived: false }
}

function task(id: string, topicId: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    topicId,
    title,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note: '',
    order: 'm',
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
    ...overrides,
  }
}

function link(id: string, from: string, to: string, type: Dependency['type'] = 'FS', lagDays = 0): Dependency {
  return { id, from, to, type, lagDays }
}

/**
 * 夹具库：
 *   x = 本任务（前端 / 登录页迭代）—— 所有编辑的落点
 *   y = 运维 / 构建脚本（**跨 topic** 的前置候选）
 *   z = 产品 / 登录页（模糊搜索里与「前端登录页」比排名的对象）
 *   w = 前端 / 监控告警（成环用例的后置）
 * 日历：周一至周五工作；2026-10-05 是周一、2026-10-09 是周五 → 工期 5 个工作日。
 */
function makeVault(overrides: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v-drawer',
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
    topics: [
      topic('t-prod', '产品', null, 'a'),
      topic('t-fe', '前端', 't-prod', 'a'),
      topic('t-ops', '运维', null, 'b'),
    ],
    tasks: [
      task('x', 't-fe', '登录页迭代', { tags: ['bugfix'] }),
      task('y', 't-ops', '构建脚本'),
      task('z', 't-prod', '登录页'),
      task('w', 't-fe', '监控告警'),
    ],
    milestones: [],
    links: [],
    assets: [],
    ...overrides,
  }
}

function t(locale: 'zh' | 'en' = 'zh') {
  return createI18n({ getLocale: () => locale, subscribe: () => () => {} }).t
}

function setup(overrides: Partial<TaskDrawerProps> = {}, vaultOverrides: Partial<Vault> = {}) {
  const store = createVaultStore(makeVault(vaultOverrides))
  const bus = createCommandBus(store)
  const onOpenChange = vi.fn()
  const onSelect = vi.fn()
  const view = render(
    <TaskDrawer
      store={store}
      bus={bus}
      t={t()}
      open
      taskId="x"
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      newId={() => 'link-new'}
      {...overrides}
    />,
  )
  return { store, bus, view, onOpenChange, onSelect }
}

function findTask(store: ReturnType<typeof createVaultStore>, id: string): Task | undefined {
  return store.getVault().tasks.find((item) => item.id === id)
}

/** 最小假保存指示源（与 SaveIndicator.test 同一手法）。 */
function fakeAutosave(initial: SaveState = 'saved') {
  let state = initial
  const listeners = new Set<() => void>()
  function emit() {
    for (const listener of [...listeners]) listener()
  }
  return {
    source: {
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      getState: () => state,
      async retry() {
        state = 'saved'
        emit()
      },
    } satisfies SaveIndicatorSource,
    set(next: SaveState) {
      state = next
      emit()
    },
  }
}

afterEach(cleanup)

describe('受控契约与开合', () => {
  it('外部传入 taskId → 抽屉打开并定位（rerender 驱动 props）', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const view = render(<TaskDrawer store={store} bus={bus} t={t()} open taskId={null} />)

    // 没有选中任务时不渲染抽屉
    expect(view.queryByTestId('task-drawer')).toBeNull()

    view.rerender(<TaskDrawer store={store} bus={bus} t={t()} open taskId="x" />)
    const drawer = view.getByTestId('task-drawer')
    expect(within(drawer).getByTestId('drawer-title-display').textContent).toBe('登录页迭代')

    // 换一个 id → 定位到另一条（同一入口服务看板卡片与甘特条）
    view.rerender(<TaskDrawer store={store} bus={bus} t={t()} open taskId="w" />)
    expect(within(view.getByTestId('task-drawer')).getByTestId('drawer-title-display').textContent).toBe('监控告警')
  })

  it('受控开合：onOpenChange 外送，关掉后不再渲染', () => {
    const onOpenChange = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(false)
      const [taskId, setTaskId] = useState<string | null>(null)
      return (
        <>
          {/* 模拟看板卡片点击：把任务 id 交给抽屉的外部选中契约 */}
          <button
            type="button"
            data-testid="open-x"
            onClick={() => {
              setTaskId('x')
            }}
          >
            open
          </button>
          <TaskDrawer
            store={store}
            bus={bus}
            t={t()}
            open={open}
            taskId={taskId}
            onOpenChange={(next) => {
              onOpenChange(next)
              setOpen(next)
            }}
          />
        </>
      )
    }
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const view = render(<Harness />)

    expect(view.queryByTestId('task-drawer')).toBeNull()
    fireEvent.click(view.getByTestId('open-x'))
    // 外部选中 → 面板自拉起（onOpenChange(true) 被接线方接受）
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(view.getByTestId('task-drawer')).toBeDefined()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(view.queryByTestId('task-drawer')).toBeNull()
  })

  it('Esc 关闭：onOpenChange(false) + onSelect(null) 外送', () => {
    const { onOpenChange, onSelect } = setup()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('非受控模式下外部 taskId 自拉起，关闭按钮真的收起', () => {
    const onOpenChange = vi.fn()
    const onSelect = vi.fn()
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const view = render(
      <TaskDrawer store={store} bus={bus} t={t()} taskId="x" onOpenChange={onOpenChange} onSelect={onSelect} />,
    )

    expect(view.getByTestId('task-drawer')).toBeDefined()
    expect(onOpenChange).toHaveBeenCalledWith(true)

    fireEvent.click(view.getByTestId('drawer-close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSelect).toHaveBeenCalledWith(null)
    expect(view.queryByTestId('task-drawer')).toBeNull()
  })

  it('外部传入的 taskId 找不到任务时显示缺任务态而不是静默无反应', () => {
    const { view } = setup({ taskId: 'ghost' })
    expect(view.getByTestId('drawer-missing-task')).toBeDefined()
    expect(view.queryByTestId('drawer-title-section')).toBeNull()
  })
})

describe('标题 inline 编辑', () => {
  it('点标题进入编辑，回车提交走 CommandBus（一条命令进撤销栈）', () => {
    const { store, bus, view } = setup()

    fireEvent.click(view.getByTestId('drawer-title-display'))
    const input = view.getByTestId('drawer-title-input')
    fireEvent.change(input, { target: { value: '登录页迭代 v2' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(findTask(store, 'x')?.title).toBe('登录页迭代 v2')
    expect(bus.undoDepth()).toBe(1)
    expect(view.getByTestId('drawer-title-display').textContent).toBe('登录页迭代 v2')
  })

  it('空标题回落「未命名任务」，不产生空白标题', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('drawer-title-display'))
    fireEvent.change(view.getByTestId('drawer-title-input'), { target: { value: '   ' } })
    fireEvent.keyDown(view.getByTestId('drawer-title-input'), { key: 'Enter' })

    expect(findTask(store, 'x')?.title).toBe('未命名任务')
  })

  it('Esc 取消编辑不写 store', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('drawer-title-display'))
    fireEvent.change(view.getByTestId('drawer-title-input'), { target: { value: '不该写进去' } })
    fireEvent.keyDown(view.getByTestId('drawer-title-input'), { key: 'Escape' })

    expect(findTask(store, 'x')?.title).toBe('登录页迭代')
  })
})

describe('属性行', () => {
  it('状态 / 类别 / 优先级 / 话题 / 负责人 / 标签 逐项写入 store', () => {
    const { store, view } = setup()

    fireEvent.change(view.getByTestId('drawer-status-select'), { target: { value: 'review' } })
    fireEvent.change(view.getByTestId('drawer-kind-select'), { target: { value: 'bug' } })
    fireEvent.change(view.getByTestId('drawer-priority-select'), { target: { value: 'P0' } })
    fireEvent.change(view.getByTestId('drawer-topic-select'), { target: { value: 't-ops' } })

    const assignee = view.getByTestId('drawer-assignee-input')
    fireEvent.change(assignee, { target: { value: '小林' } })
    fireEvent.blur(assignee)

    const tags = view.getByTestId('drawer-tags-input')
    fireEvent.change(tags, { target: { value: '登录, 前端, 登录' } })
    fireEvent.blur(tags)

    const updated = findTask(store, 'x')
    expect(updated?.status).toBe('review')
    expect(updated?.kind).toBe('bug')
    expect(updated?.priority).toBe('P0')
    expect(updated?.topicId).toBe('t-ops')
    expect(updated?.assignee).toBe('小林')
    // 中英文逗号都能分隔，重复项去重
    expect(updated?.tags).toEqual(['登录', '前端'])
    // 话题下拉含跨话题层级（子树项存在）
    expect(within(view.getByTestId('drawer-topic-select')).getByText('运维')).toBeDefined()
  })

  it('status=done 强制 progress=100 且滑块禁用', () => {
    const { store, view } = setup({}, { tasks: [task('x', 't-fe', '登录页迭代', { progress: 40 })] })

    expect(view.getByTestId('drawer-progress-value').textContent).toBe('40%')
    fireEvent.change(view.getByTestId('drawer-status-select'), { target: { value: 'done' } })

    expect(findTask(store, 'x')?.progress).toBe(100)
    expect(view.getByTestId('drawer-progress-value').textContent).toBe('100%')
    expect(view.getByTestId('drawer-progress-input').hasAttribute('disabled')).toBe(true)
    expect(view.getByTestId('drawer-progress-locked')).toBeDefined()
  })
})

describe('日期与进度', () => {
  it('起止日期写入 store，工期只读来自 ScheduleEngine（周一→周五 = 5 个工作日）', () => {
    const { store, view } = setup()

    // 无日期时工期显示占位符
    expect(view.getByTestId('drawer-duration').textContent).toBe('—')

    fireEvent.change(view.getByTestId('drawer-start-input'), { target: { value: '2026-10-05' } })
    fireEvent.change(view.getByTestId('drawer-due-input'), { target: { value: '2026-10-09' } })

    expect(findTask(store, 'x')?.start).toBe('2026-10-05')
    expect(findTask(store, 'x')?.due).toBe('2026-10-09')
    expect(view.getByTestId('drawer-duration').textContent).toBe('5 个工作日')
  })

  it('结束早于开始 → 不写入并提示；清空日期合法', () => {
    const { store, view } = setup({}, { tasks: [task('x', 't-fe', '登录页迭代', { start: '2026-10-09' })] })

    fireEvent.change(view.getByTestId('drawer-due-input'), { target: { value: '2026-10-05' } })
    expect(view.getByTestId('drawer-date-error').textContent).toBe('结束日期不能早于开始日期')
    expect(findTask(store, 'x')?.due).toBeUndefined()

    // date 输入框自身会把「2026-02-30」这类伪日期消毒成空串（浏览器与 jsdom 同行为），
    // 于是它落到「清空」这条合法分支上——伪日期的拦截由纯函数 dateRangeErrorKey 兜底覆盖。
    fireEvent.change(view.getByTestId('drawer-start-input'), { target: { value: '2026-02-30' } })
    expect((view.getByTestId('drawer-start-input') as HTMLInputElement).value).toBe('')
    expect(findTask(store, 'x')?.start).toBeUndefined()
    expect(view.queryByTestId('drawer-date-error')).toBeNull()
  })

  it('进度滑块写入 store', () => {
    const { store, view } = setup()

    fireEvent.change(view.getByTestId('drawer-progress-input'), { target: { value: '65' } })

    expect(findTask(store, 'x')?.progress).toBe(65)
    expect(view.getByTestId('drawer-progress-value').textContent).toBe('65%')
  })
})

describe('依赖：添加（全库模糊搜索，跨 topic）', () => {
  it('输入关键词命中跨 topic 任务，选中即建 FS 依赖（选中任务 → 本任务）', () => {
    const { store, bus, view } = setup()

    expect(view.getByTestId('dep-empty')).toBeDefined()
    fireEvent.change(view.getByTestId('dep-search-input'), { target: { value: '构建' } })

    // y 属「运维」，本任务属「前端」——候选不按话题过滤
    const option = view.getByTestId('dep-search-option-y')
    expect(within(option).getByText('运维')).toBeDefined()
    fireEvent.click(option)

    const created = store.getVault().links.find((item) => item.to === 'x')
    expect(created).toEqual({ id: 'link-new', from: 'y', to: 'x', type: 'FS', lagDays: 0 })
    expect(bus.undoDepth()).toBe(1)

    // 行渲染为「前置」方向，搜索框清空、下拉关闭
    const row = view.getByTestId('dep-row-link-new')
    expect(row.getAttribute('data-direction')).toBe('predecessor')
    expect(within(row).getByText('构建脚本')).toBeDefined()
    expect(row.getAttribute('data-cyclic')).toBe('false')
    expect(view.queryByTestId('dep-search-dropdown')).toBeNull()
    expect((view.getByTestId('dep-search-input') as HTMLInputElement).value).toBe('')
  })

  it('候选剔除自身与已有同方向前置；无匹配显示空态', () => {
    const { view } = setup({}, { links: [link('l0', 'y', 'x')] })

    // 已有 y→x，y 不再出现在候选里
    fireEvent.change(view.getByTestId('dep-search-input'), { target: { value: '构建' } })
    expect(view.getByTestId('dep-search-empty')).toBeDefined()

    // 自身（x 的标题）也不出现
    fireEvent.change(view.getByTestId('dep-search-input'), { target: { value: '登录页迭代' } })
    expect(view.getByTestId('dep-search-empty')).toBeDefined()

    // 后置方向的任务仍可作为前置候选（会形成环，但允许——见成环用例）
    fireEvent.change(view.getByTestId('dep-search-input'), { target: { value: '监控' } })
    expect(view.getByTestId('dep-search-option-w')).toBeDefined()
  })

  it('空关键词不刷全库（下拉不展示）', () => {
    const { view } = setup()
    fireEvent.focus(view.getByTestId('dep-search-input'))
    expect(view.queryByTestId('dep-search-dropdown')).toBeNull()
  })
})

describe('依赖：修改与删除', () => {
  it('改类型与 lagDays 走 patchLinkCommand；删除走 deleteLinkCommand', () => {
    const { store, bus, view } = setup({}, { links: [link('l1', 'y', 'x'), link('l2', 'x', 'w')] })

    fireEvent.change(view.getByTestId('dep-row-l1-type'), { target: { value: 'SS' } })
    expect(store.getVault().links.find((item) => item.id === 'l1')?.type).toBe('SS')

    const lag = view.getByTestId('dep-row-l1-lag')
    fireEvent.change(lag, { target: { value: '3' } })
    fireEvent.blur(lag)
    expect(store.getVault().links.find((item) => item.id === 'l1')?.lagDays).toBe(3)

    // 后置方向的行渲染为 successor（本任务 → 对端）
    expect(view.getByTestId('dep-row-l2').getAttribute('data-direction')).toBe('successor')

    fireEvent.click(view.getByTestId('dep-row-l2-delete'))
    expect(store.getVault().links.map((item) => item.id)).toEqual(['l1'])
    expect(bus.undoDepth()).toBe(3)
  })

  it('类型枚举恰为 FS/SS/FF/SF 四档', () => {
    const { view } = setup({}, { links: [link('l1', 'y', 'x')] })
    const options = within(view.getByTestId('dep-row-l1-type')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([...DEPENDENCY_TYPES])
  })
})

describe('依赖：成环标红但允许保存', () => {
  it('x→w 已存在时再加 w→x：两行都标红 + 分区提示，链接仍在 store', () => {
    const { store, view } = setup({}, { links: [link('l1', 'x', 'w')] })

    fireEvent.change(view.getByTestId('dep-search-input'), { target: { value: '监控' } })
    fireEvent.click(view.getByTestId('dep-search-option-w'))

    // 环成立：l1(x→w) 与新建的 link-new(w→x) 都在环里
    expect(view.getByTestId('dep-row-l1').getAttribute('data-cyclic')).toBe('true')
    expect(view.getByTestId('dep-row-link-new').getAttribute('data-cyclic')).toBe('true')
    expect(view.getByTestId('dep-row-link-new-cycle').textContent).toBe('成环')
    expect(view.getByTestId('dep-cycle-hint').textContent).toContain('检测到依赖环')

    // 「允许保存」= 环没有任何写入拦截，两条链接都在库里
    expect(store.getVault().links.map((item) => item.id).sort()).toEqual(['l1', 'link-new'])
  })

  it('无环时不出现环提示与徽标', () => {
    const { view } = setup({}, { links: [link('l1', 'y', 'x')] })
    expect(view.queryByTestId('dep-cycle-hint')).toBeNull()
    expect(view.getByTestId('dep-row-l1').getAttribute('data-cyclic')).toBe('false')
  })
})

describe('顶部保存指示与撤销', () => {
  it('三态联动（假 Autosave 源驱动）', () => {
    const fake = fakeAutosave()
    const { view } = setup({ autosave: fake.source })

    const indicator = view.getByTestId('save-indicator')
    expect(indicator.getAttribute('data-state')).toBe('saved')
    expect(indicator.textContent).toContain('已保存')

    act(() => {
      fake.set('dirty')
    })
    expect(view.getByTestId('save-indicator').getAttribute('data-state')).toBe('dirty')
    expect(view.getByTestId('save-indicator').textContent).toContain('未保存')

    act(() => {
      fake.set('error')
    })
    expect(view.getByTestId('save-indicator').textContent).toContain('保存失败')
    expect(view.getByRole('button', { name: '重试' })).toBeDefined()
  })

  it('不传 autosave 源时不渲染指示器（独立挂载仍可用）', () => {
    const { view } = setup()
    expect(view.queryByTestId('save-indicator')).toBeNull()
  })

  it('Ctrl+Z 撤销走 CommandBus（属性改动可还原），Ctrl+Shift+Z 重做', () => {
    const { store, bus, view } = setup()

    fireEvent.change(view.getByTestId('drawer-status-select'), { target: { value: 'doing' } })
    expect(findTask(store, 'x')?.status).toBe('doing')

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    expect(findTask(store, 'x')?.status).toBe('todo')
    expect(bus.redoDepth()).toBe(1)

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(findTask(store, 'x')?.status).toBe('doing')
  })

  it('标题编辑中按 Ctrl+Z：先提交草稿再撤销，净效果是还原标题', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('drawer-title-display'))
    const input = view.getByTestId('drawer-title-input')
    fireEvent.change(input, { target: { value: '临时改的' } })
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })

    expect(findTask(store, 'x')?.title).toBe('登录页迭代')
  })
})

describe('笔记区（T24 起换成真编辑器，旧占位退役）', () => {
  it('第 ⑤ 分区挂载 NoteEditor，且不再渲染 T24 占位', () => {
    const { view } = setup()
    const section = view.getByTestId('drawer-notes-section')
    expect(view.queryByTestId('drawer-note-placeholder')).toBeNull()
    expect(section.querySelector('[data-testid="note-editor"]')).not.toBeNull()
    expect(section.querySelector('[data-testid="note-editor-content"]')).not.toBeNull()
  })
})

describe('commandBus · link 命令（T17 授权的唯一 domain 扩展）', () => {
  it('createLinkCommand：apply 追加、undo 移除、redo 还原', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const created = link('l-new', 'y', 'x')

    bus.apply(createLinkCommand(created))
    expect(store.getVault().links).toEqual([created])

    bus.undo()
    expect(store.getVault().links).toEqual([])

    bus.redo()
    expect(store.getVault().links).toEqual([created])
  })

  it('deleteLinkCommand 的逆元带完整 link 体与原下标，undo 后连位置一起还原', () => {
    const initial = [link('l1', 'y', 'x'), link('l2', 'x', 'w'), link('l3', 'z', 'x')]
    const store = createVaultStore(makeVault({ links: initial }))
    const bus = createCommandBus(store)

    bus.apply(deleteLinkCommand(store.getVault(), 'l2'))
    expect(store.getVault().links.map((item) => item.id)).toEqual(['l1', 'l3'])

    bus.undo()
    // 只增删不改：位置（下标 1）与内容都要回来
    expect(store.getVault().links.map((item) => item.id)).toEqual(['l1', 'l2', 'l3'])
    bus.redo()
    expect(store.getVault().links.map((item) => item.id)).toEqual(['l1', 'l3'])
  })

  it('patchLinkCommand 的逆元字段级还原（只回滚改到的字段）', () => {
    const store = createVaultStore(makeVault({ links: [link('l1', 'y', 'x', 'FS', 0)] }))
    const bus = createCommandBus(store)

    bus.apply(patchLinkCommand(store.getVault(), 'l1', { type: 'FF', lagDays: 5 }))
    expect(store.getVault().links[0]).toEqual(link('l1', 'y', 'x', 'FF', 5))

    bus.undo()
    expect(store.getVault().links[0]).toEqual(link('l1', 'y', 'x', 'FS', 0))
  })

  it('对不存在的依赖操作直接抛错，不静默兜底', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    expect(() => patchLinkCommand(store.getVault(), 'ghost', { type: 'SS' })).toThrow()
    expect(() => deleteLinkCommand(store.getVault(), 'ghost')).toThrow()
    expect(() => bus.apply(deleteLinkCommand(store.getVault(), 'ghost'))).toThrow()
  })

  it('既有 task.* 行为不变：link 命令与任务命令共用一条撤销栈', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)

    bus.apply(patchTaskCommand(store.getVault(), 'x', { title: '改过' }))
    bus.apply(createLinkCommand(link('l1', 'y', 'x')))
    expect(bus.undoDepth()).toBe(2)

    bus.undo()
    expect(store.getVault().links).toEqual([])
    expect(findTask(store, 'x')?.title).toBe('改过')

    bus.undo()
    expect(findTask(store, 'x')?.title).toBe('登录页迭代')
  })
})

describe('纯函数', () => {
  it('fuzzyScore：子序列命中有分，连续与靠前得分更低，不命中为 null', () => {
    expect(fuzzyScore('登录页', '登录')).not.toBeNull()
    expect(fuzzyScore('前端登录页', '登录')).not.toBeNull()
    // 靠前 + 连续 → 得分更低（排序在前）
    expect(fuzzyScore('登录页', '登录')!).toBeLessThan(fuzzyScore('前端登录页', '登录')!)
    // 字序颠倒不命中
    expect(fuzzyScore('登录页', '页登')).toBeNull()
    expect(fuzzyScore('登录页', '构建')).toBeNull()
  })

  it('searchDependencyCandidates：跨话题、剔自身与已建前置、按分排序、限量', () => {
    const tasks = [
      task('x', 't-fe', '登录页迭代'),
      task('z', 't-prod', '登录页'),
      task('y', 't-ops', '前端登录页'),
      task('w', 't-fe', '监控告警'),
    ]
    const hit = searchDependencyCandidates(tasks, '登录', { taskId: 'x', existingPredecessorIds: new Set() })
    // 「登录页」完全前缀、最靠前 → 排在「前端登录页」之前
    expect(hit.map((item) => item.id)).toEqual(['z', 'y'])

    const excluded = searchDependencyCandidates(tasks, '登录', {
      taskId: 'x',
      existingPredecessorIds: new Set(['z']),
    })
    expect(excluded.map((item) => item.id)).toEqual(['y'])

    // 空关键词不刷全库
    expect(searchDependencyCandidates(tasks, '  ', { taskId: 'x', existingPredecessorIds: new Set() })).toEqual([])

    const limited = searchDependencyCandidates(
      [task('a', 't-fe', '登录'), task('b', 't-fe', '登录'), task('c', 't-fe', '登录')],
      '登录',
      { taskId: 'x', existingPredecessorIds: new Set(), limit: 2 },
    )
    expect(limited).toHaveLength(2)
  })

  it('splitTaskLinks：按方向拆开，自环归前置组', () => {
    const links = [link('l1', 'y', 'x'), link('l2', 'x', 'w'), link('l3', 'x', 'x')]
    const groups = splitTaskLinks(links, 'x')
    expect(groups.predecessors.map((item) => item.id)).toEqual(['l1', 'l3'])
    expect(groups.successors.map((item) => item.id)).toEqual(['l2'])
    // 与本任务无关的链接不出现
    expect(splitTaskLinks([link('l9', 'a', 'b')], 'x')).toEqual({ predecessors: [], successors: [] })
  })

  it('cycleLinkIds / taskInCycle：只标记真正落在环里的链接（复用 T12 的 SCC 判定）', () => {
    const links = [link('l1', 'x', 'w'), link('l2', 'w', 'x'), link('l3', 'y', 'x')]
    const tasks = makeVault().tasks
    const cyclic = cycleLinkIds(links, tasks)
    expect([...cyclic].sort()).toEqual(['l1', 'l2'])
    expect(taskInCycle('x', links, tasks)).toBe(true)
    expect(taskInCycle('y', links, tasks)).toBe(false)

    // 链式依赖无环
    const acyclic = [link('l1', 'y', 'x'), link('l2', 'x', 'w')]
    expect(cycleLinkIds(acyclic, tasks).size).toBe(0)
    expect(taskInCycle('x', acyclic, tasks)).toBe(false)

    // 自环同样计入
    expect([...cycleLinkIds([link('s', 'x', 'x')], tasks)]).toEqual(['s'])
  })

  it('parseTags / tagsToInput / sameTags', () => {
    expect(parseTags('登录, 前端，，登录 ')).toEqual(['登录', '前端'])
    expect(parseTags('   ')).toEqual([])
    expect(tagsToInput(['a', 'b'])).toBe('a, b')
    expect(sameTags(['a'], ['a'])).toBe(true)
    expect(sameTags(['a'], ['a', 'b'])).toBe(false)
  })

  it('dateRangeErrorKey：伪日期与区间颠倒分别给出对应文案键', () => {
    expect(dateRangeErrorKey('due', '2026-02-30', {})).toBe('drawer.invalidDate')
    expect(dateRangeErrorKey('due', '2026-10-05', { start: '2026-10-09' })).toBe('drawer.dateRangeError')
    expect(dateRangeErrorKey('start', '2026-10-05', { due: '2026-10-09' })).toBeNull()
    expect(dateRangeErrorKey('due', '', { start: '2026-10-09' })).toBeNull()
  })

  it('durationLabel：工期口径来自 ScheduleEngine，缺日期/非法日期退化为占位符', () => {
    const cal = makeVault().settings.calendar
    const tr = t()
    expect(durationLabel({ start: '2026-10-05', due: '2026-10-09' }, cal, tr)).toBe('5 个工作日')
    // 跨周末：周五 → 下周二 = 3 个工作日（周一、周二各 1，含端点算法为 5→+1）
    expect(durationLabel({ start: '2026-10-09', due: '2026-10-13' }, cal, tr)).toBe('3 个工作日')
    expect(durationLabel({}, cal, tr)).toBe('—')
    expect(durationLabel({ start: '2026-02-30', due: '2026-10-09' }, cal, tr)).toBe('—')
  })
})

describe('视图接线边界', () => {
  it('弹窗不渲染任何“保存”按钮：写操作即时落库，由 Autosave 负责落盘', () => {
    const { view } = setup()
    expect(view.queryByRole('button', { name: '保存' })).toBeNull()
  })
})

// ─────────────────────── T36 · 居中弹窗呈现（不再是右侧抽屉） ───────────────────────
//
// 产品方要求「任务编辑用弹窗，不要从侧边弹出」。以下用例把弹窗语义钉住：
// 遮罩居中、role=dialog、三条关闭出路、以及「拖选文字不误关」这条只有富文本弹窗才有的坑。

describe('T36 · 居中弹窗呈现', () => {
  it('遮罩铺满视口并居中承载面板，面板不再是贴右的 400px 侧栏', () => {
    const { view } = setup()
    const overlay = view.getByTestId('task-modal')
    const panel = view.getByTestId('task-drawer')

    expect(overlay.style.position).toBe('fixed')
    expect(overlay.style.inset).toBe('0px')
    expect(overlay.style.display).toBe('flex')
    expect(overlay.style.justifyContent).toBe('center')
    expect(overlay.style.alignItems).toBe('center')
    expect(overlay.style.background).toContain('--oe-scrim')

    // 面板必须挂在遮罩里（不是各自 fixed 的兄弟节点）
    expect(panel.parentElement).toBe(overlay)
    expect(panel.style.position).toBe('')
    expect(panel.style.right).toBe('')
    expect(panel.style.top).toBe('')
    expect(panel.style.width).toBe('100%')
    expect(panel.style.maxWidth).toBe('760px')
    // 高度顶住遮罩内容盒，内部滚动交给分区容器
    expect(panel.style.maxHeight).toBe('100%')
    expect(panel.style.overflow).toBe('hidden')
  })

  it('面板是对话框本体：role=dialog + aria-modal + 可聚焦 + 弹窗标记', () => {
    const { view } = setup()
    const panel = view.getByTestId('task-drawer')
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.getAttribute('aria-label')).toBe('任务详情')
    expect(panel.getAttribute('data-presentation')).toBe('modal')
    // tabIndex=-1：程序化焦点落点（Tab 顺序不进入它）
    expect(panel.getAttribute('tabindex')).toBe('-1')
  })

  it('样式可被外部覆写（面板宽度与遮罩内边距）', () => {
    const { view } = setup({ style: { maxWidth: 560 } })
    expect(view.getByTestId('task-drawer').style.maxWidth).toBe('560px')
    expect(view.getByTestId('task-modal').style.padding).toBe('24px')
  })

  it('点遮罩空白处关闭：onOpenChange(false) + onSelect(null)', () => {
    const { view, onOpenChange, onSelect } = setup()
    const overlay = view.getByTestId('task-modal')
    fireEvent.mouseDown(overlay)
    fireEvent.click(overlay)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('从面板内往外拖选文字（按下在面板、click 落在共同祖先）不会误关弹窗', () => {
    // setup() 用 taskId="x" 挂载 → 组件会在挂载时按「外部选中」外送一次 onOpenChange(true)，
    // 这里只关心「关闭」，所以先清账（既有用例断言的是 toHaveBeenCalledWith(false)，不受影响）
    const { view, onOpenChange, onSelect } = setup()
    onOpenChange.mockClear()
    onSelect.mockClear()

    const overlay = view.getByTestId('task-modal')
    // 浏览器把跨元素的 click 派发到「按下与抬起」的共同祖先，也就是这个遮罩
    fireEvent.mouseDown(view.getByTestId('drawer-title-display'))
    fireEvent.click(overlay)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    // 但认定过一次「按下在外部」之后，标记要复位——否则下次真点外部会被上一次性状放行
    fireEvent.mouseDown(overlay)
    fireEvent.click(overlay)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('点面板内部不关闭', () => {
    const { view, onOpenChange } = setup()
    onOpenChange.mockClear()
    const panel = view.getByTestId('task-drawer')
    fireEvent.mouseDown(panel)
    fireEvent.click(panel)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('关闭按钮是第三条出路，与 Esc / 点遮罩等价', () => {
    const { view, onOpenChange, onSelect } = setup()
    fireEvent.click(view.getByTestId('drawer-close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('打开时焦点进面板，关闭后还给打开它的那个元素', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    // 照 App 的真实接线：选中 id 与开合都是状态，任务 id 起手为 null（看板卡片点击时才给）
    function Harness() {
      const [open, setOpen] = useState(false)
      const [taskId, setTaskId] = useState<string | null>(null)
      return (
        <>
          <button
            type="button"
            data-testid="board-card-x"
            onClick={() => {
              setTaskId('x')
              setOpen(true)
            }}
          >
            登录页迭代
          </button>
          <TaskDrawer store={store} bus={bus} t={t()} open={open} taskId={taskId} onOpenChange={setOpen} />
        </>
      )
    }
    const view = render(<Harness />)
    const trigger = view.getByTestId('board-card-x')
    trigger.focus()
    fireEvent.click(trigger)

    expect(document.activeElement).toBe(view.getByTestId('task-drawer'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByTestId('task-drawer')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('弹窗里仍是那五个分区（密度上限不因改呈现而变）', () => {
    const { view } = setup()
    const panel = view.getByTestId('task-drawer')
    expect(panel.querySelectorAll('[data-testid$="-section"]').length).toBe(5)
  })
})
