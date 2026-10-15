// @vitest-environment jsdom
//
// T18 · MilestonePanel：列表面板 / CRUD / 跨 topic 置顶分组 / 选中契约 / 删除不影响任务与依赖。
// 与 T14 同一手法：用**真的 VaultStore + 真的 CommandBus**（不是假 store）——
// 验收 1/4 要求写操作落在唯一状态源上，假 store 会把它们验成空气。
// 里程碑写入走 store.update（MutationType 暂无 milestone.*，T14 话题写入的同一先例）。

import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TOPIC_PALETTE } from '../../src/controllers/topicActions'
import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Milestone, Task, Topic, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import {
  MilestonePanel,
  draftFromMilestone,
  isValidDateKey,
  newMilestoneDraft,
  removeMilestone,
  sortMilestones,
  splitMilestoneGroups,
  upsertMilestone,
} from '../../src/views/MilestonePanel'
import type { MilestonePanelProps } from '../../src/views/MilestonePanel'
import { TopicSidebar } from '../../src/views/TopicSidebar'

const NOW = '2026-10-15T09:30:00.000Z'

function topic(id: string, name: string, parentId: string | null, order: string, color = '#4F46E5'): Topic {
  return { id, name, color, parentId, order, archived: false }
}

function task(id: string, topicId: string, title: string, archived = false): Task {
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
    archived,
  }
}

function milestone(
  id: string,
  topicId: string | null,
  title: string,
  date: string,
  done = false,
  color = '#4F46E5',
): Milestone {
  return { id, topicId, title, date, done, color }
}

function makeVault(): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v-1',
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
      topic('p', '产品', null, 'a'),
      topic('p-fe', '前端', 'p', 'a'),
      topic('p-fe-build', '打包', 'p-fe', 'a'),
      topic('p-be', '后端', 'p', 'b'),
      topic('p-be-db', '数据库', 'p-be', 'a'),
      topic('ops', '运维', null, 'b'),
    ],
    tasks: [task('t1', 'p-fe', '登录页'), task('t2', 'p-fe-build', '构建脚本'), task('t3', 'ops', '监控告警')],
    milestones: [
      // 跨话题：日期最晚也必须置顶
      milestone('m-x', null, 'Beta 发布', '2026-11-01', false, '#DC2626'),
      milestone('m-1', 'p', '需求评审', '2026-10-10', true, '#2563EB'),
      milestone('m-2', 'p-fe', '前端联调', '2026-10-20', false, '#059669'),
    ],
    links: [{ id: 'l1', from: 't1', to: 't2', type: 'FS', lagDays: 0 }],
    assets: [],
  }
}

function t(locale: 'zh' | 'en') {
  return createI18n({ getLocale: () => locale, subscribe: () => () => {} }).t
}

function setup(locale: 'zh' | 'en' = 'zh', overrides: Partial<MilestonePanelProps> = {}) {
  const store = createVaultStore(makeVault())
  const bus = createCommandBus(store)
  const onOpenChange = vi.fn()
  const onSelect = vi.fn()
  const view = render(
    <MilestonePanel
      store={store}
      bus={bus}
      t={t(locale)}
      open
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      {...overrides}
    />,
  )
  return { store, bus, view, onOpenChange, onSelect }
}

/** 面板内全部里程碑行，按 DOM 顺序。 */
function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid^="milestone-row-"]')].map(
    (element) => element.getAttribute('data-testid') ?? '',
  )
}

afterEach(cleanup)

describe('列表面板', () => {
  it('打开后渲染全部里程碑，跨话题里程碑置顶分组', () => {
    const { view } = setup()
    const panel = view.getByTestId('milestone-panel')

    // 跨话题组在前、话题组在后；组内按日期升序
    expect(rowIds(panel)).toEqual(['milestone-row-m-x', 'milestone-row-m-1', 'milestone-row-m-2'])

    const crossGroup = view.getByTestId('milestone-group-cross')
    const topicGroup = view.getByTestId('milestone-group-topic')
    // 组标题是 div、行内徽标是 span，用 selector 区分二者（文案相同）
    expect(within(crossGroup).getByText('跨话题', { selector: 'div' })).toBeDefined()
    expect(within(crossGroup).getByTestId('milestone-row-m-x')).toBeDefined()
    expect(within(topicGroup).getByTestId('milestone-row-m-1')).toBeDefined()
    // 分组是结构性的：跨话题行带标记，话题行带话题色点 + 话题名
    expect(view.getByTestId('milestone-row-m-x').getAttribute('data-cross-topic')).toBe('true')
    expect(view.getByTestId('milestone-row-m-1').getAttribute('data-cross-topic')).toBe('false')
    expect(within(view.getByTestId('milestone-row-m-1')).getByText('产品')).toBeDefined()
    // 完成态：行标记 + 行内芯片文案
    expect(view.getByTestId('milestone-row-m-1').getAttribute('data-done')).toBe('true')
    expect(view.getByTestId('milestone-done-chip-m-1').textContent).toBe('已完成')
    expect(view.getByTestId('milestone-done-chip-m-2').textContent).toBe('未完成')
  })

  it('侧栏「里程碑」入口打开列表面板（T14 入口的接缝）', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <TopicSidebar store={store} bus={bus} t={t('zh')} onOpenMilestones={() => setOpen(true)} />
          <MilestonePanel store={store} bus={bus} t={t('zh')} open={open} onOpenChange={setOpen} />
        </>
      )
    }
    const view = render(<Harness />)

    expect(view.queryByTestId('milestone-panel')).toBeNull()
    fireEvent.click(view.getByTestId('sidebar-open-milestones'))
    expect(view.getByTestId('milestone-panel')).toBeDefined()
    expect(rowIds(view.getByTestId('milestone-panel'))).toHaveLength(3)
  })

  it('无里程碑时显示空态，不显示分组头', () => {
    const store = createVaultStore(makeVault())
    store.update((vault) => ({ ...vault, milestones: [] }))
    const view = render(<MilestonePanel store={store} bus={createCommandBus(store)} t={t('zh')} open />)

    expect(view.getByTestId('milestone-empty')).toBeDefined()
    expect(view.queryByTestId('milestone-group-cross')).toBeNull()
    expect(view.queryByTestId('milestone-group-topic')).toBeNull()
  })
})

describe('新建', () => {
  it('标题/日期/所属话题/完成态/颜色写入 store，任务与依赖原样', () => {
    const { store, view } = setup()
    const before = { tasks: store.getVault().tasks, links: store.getVault().links }

    fireEvent.click(view.getByTestId('milestone-new'))
    const editor = view.getByTestId('milestone-editor')
    expect(editor.getAttribute('data-mode')).toBe('new')

    fireEvent.change(view.getByTestId('milestone-title-input'), { target: { value: '压测完成' } })
    fireEvent.change(view.getByTestId('milestone-date-input'), { target: { value: '2026-12-01' } })
    fireEvent.change(view.getByTestId('milestone-topic-select'), { target: { value: 'ops' } })
    fireEvent.click(view.getByTestId('milestone-done-toggle'))

    const swatches = within(view.getByTestId('milestone-color-palette')).getAllByRole('button')
    fireEvent.click(swatches[5] as HTMLElement)

    fireEvent.click(view.getByTestId('milestone-save'))

    const created = store.getVault().milestones.find((candidate) => candidate.title === '压测完成')
    expect(created).toBeDefined()
    expect(created?.date).toBe('2026-12-01')
    expect(created?.topicId).toBe('ops')
    expect(created?.done).toBe(true)
    expect(created?.color).toBe(TOPIC_PALETTE[5])
    // 验收 4：删除/新建里程碑都不触碰任务与依赖
    expect(store.getVault().tasks).toEqual(before.tasks)
    expect(store.getVault().links).toEqual(before.links)
    // 列表立即出现新行，编辑器收起
    expect(view.getByTestId(`milestone-row-${created?.id ?? ''}`)).toBeDefined()
    expect(view.queryByTestId('milestone-editor')).toBeNull()
  })

  it('跨话题里程碑（topicId=null）落在置顶分组，与日期无关', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('milestone-new'))
    fireEvent.change(view.getByTestId('milestone-title-input'), { target: { value: '年度复盘' } })
    // 日期最早，仍应排在跨话题组最前（分组按 topicId，不按日期）
    fireEvent.change(view.getByTestId('milestone-date-input'), { target: { value: '2026-09-01' } })
    fireEvent.click(view.getByTestId('milestone-save'))

    const created = store.getVault().milestones.find((candidate) => candidate.title === '年度复盘')
    expect(created?.topicId).toBeNull()

    const panel = view.getByTestId('milestone-panel')
    expect(rowIds(panel)[0]).toBe(`milestone-row-${created?.id ?? ''}`)
    expect(within(view.getByTestId('milestone-group-cross')).getByTestId(`milestone-row-${created?.id ?? ''}`)).toBeDefined()
  })

  it('空标题回落为占位文案，不产生空白里程碑', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('milestone-new'))
    fireEvent.change(view.getByTestId('milestone-date-input'), { target: { value: '2026-10-30' } })
    fireEvent.click(view.getByTestId('milestone-save'))

    expect(store.getVault().milestones.some((candidate) => candidate.title === '未命名里程碑')).toBe(true)
  })

  it('非法日期不保存并提示（2026-02-30 这类伪日期拒绝）', () => {
    const { store, view } = setup()
    const before = store.getVault().milestones.length

    fireEvent.click(view.getByTestId('milestone-new'))
    fireEvent.change(view.getByTestId('milestone-title-input'), { target: { value: '坏日期' } })
    fireEvent.change(view.getByTestId('milestone-date-input'), { target: { value: '2026-02-30' } })
    fireEvent.click(view.getByTestId('milestone-save'))

    expect(view.getByTestId('milestone-error')).toBeDefined()
    expect(store.getVault().milestones).toHaveLength(before)
  })

  it('颜色取自固定 12 色调色板，与话题色同一套', () => {
    const { view } = setup()

    fireEvent.click(view.getByTestId('milestone-new'))
    const swatches = within(view.getByTestId('milestone-color-palette')).getAllByRole('button')
    expect(swatches).toHaveLength(12)
    expect(swatches.map((swatch) => swatch.getAttribute('data-color'))).toEqual([...TOPIC_PALETTE])
  })
})

describe('编辑', () => {
  it('点击行打开编辑器并保存全部字段的修改', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('milestone-open-m-1'))
    const editor = view.getByTestId('milestone-editor')
    expect(editor.getAttribute('data-mode')).toBe('edit')
    expect(editor.getAttribute('data-editing-id')).toBe('m-1')
    expect((view.getByTestId('milestone-title-input') as HTMLInputElement).value).toBe('需求评审')
    expect((view.getByTestId('milestone-date-input') as HTMLInputElement).value).toBe('2026-10-10')

    fireEvent.change(view.getByTestId('milestone-title-input'), { target: { value: '需求评审（二轮）' } })
    fireEvent.change(view.getByTestId('milestone-date-input'), { target: { value: '2026-10-12' } })
    // 改为跨话题
    fireEvent.change(view.getByTestId('milestone-topic-select'), { target: { value: '' } })
    // 已完成 → 取消完成
    fireEvent.click(view.getByTestId('milestone-done-toggle'))
    fireEvent.click(view.getByTestId('milestone-save'))

    const updated = store.getVault().milestones.find((candidate) => candidate.id === 'm-1')
    expect(updated?.title).toBe('需求评审（二轮）')
    expect(updated?.date).toBe('2026-10-12')
    expect(updated?.topicId).toBeNull()
    expect(updated?.done).toBe(false)
    // 话题里程碑改为跨topic后，列表里换组
    expect(within(view.getByTestId('milestone-group-cross')).getByTestId('milestone-row-m-1')).toBeDefined()
  })

  it('取消编辑器回到列表，不写 store', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('milestone-open-m-2'))
    fireEvent.change(view.getByTestId('milestone-title-input'), { target: { value: '改个名字' } })
    fireEvent.click(view.getByTestId('milestone-cancel'))

    expect(view.queryByTestId('milestone-editor')).toBeNull()
    expect(store.getVault().milestones.find((candidate) => candidate.id === 'm-2')?.title).toBe('前端联调')
  })

  it('行内芯片直接切换完成态', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('milestone-done-chip-m-2'))
    expect(store.getVault().milestones.find((candidate) => candidate.id === 'm-2')?.done).toBe(true)

    fireEvent.click(view.getByTestId('milestone-done-chip-m-2'))
    expect(store.getVault().milestones.find((candidate) => candidate.id === 'm-2')?.done).toBe(false)
  })
})

describe('删除', () => {
  it('删除里程碑不影响任务与依赖（二次确认后生效）', () => {
    const { store, view } = setup()
    const before = {
      tasks: store.getVault().tasks,
      links: store.getVault().links,
      topics: store.getVault().topics,
    }

    fireEvent.click(view.getByTestId('milestone-open-m-2'))
    fireEvent.click(view.getByTestId('milestone-delete'))
    // 第一次点击只是进入确认态，尚未删除
    expect(store.getVault().milestones.some((candidate) => candidate.id === 'm-2')).toBe(true)
    fireEvent.click(view.getByTestId('milestone-delete-confirm'))

    expect(store.getVault().milestones.some((candidate) => candidate.id === 'm-2')).toBe(false)
    // 验收 4：任务、依赖、话题一个字节都没动
    expect(store.getVault().tasks).toEqual(before.tasks)
    expect(store.getVault().links).toEqual(before.links)
    expect(store.getVault().topics).toEqual(before.topics)
    expect(view.queryByTestId('milestone-row-m-2')).toBeNull()
    expect(view.queryByTestId('milestone-editor')).toBeNull()
  })

  it('确认态可以反悔', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('milestone-open-m-1'))
    fireEvent.click(view.getByTestId('milestone-delete'))
    fireEvent.click(view.getByTestId('milestone-delete-cancel'))

    expect(store.getVault().milestones.some((candidate) => candidate.id === 'm-1')).toBe(true)
    expect(view.getByTestId('milestone-editor').getAttribute('data-editing-id')).toBe('m-1')
  })
})

describe('外部选中契约（甘特图菱形联通的接缝）', () => {
  it('selectedId 传入即打开面板并定位到该条', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const onOpenChange = vi.fn()
    const onSelect = vi.fn()
    const view = render(
      <MilestonePanel
        store={store}
        bus={bus}
        t={t('zh')}
        open={false}
        onOpenChange={onOpenChange}
        onSelect={onSelect}
      />,
    )
    expect(view.queryByTestId('milestone-panel')).toBeNull()

    // 模拟甘特图菱形被点击：外部只改 selectedId
    view.rerender(
      <MilestonePanel
        store={store}
        bus={bus}
        t={t('zh')}
        open={false}
        onOpenChange={onOpenChange}
        onSelect={onSelect}
        selectedId="m-2"
      />,
    )
    expect(onOpenChange).toHaveBeenCalledWith(true)

    // 接线方把 open 置 true 后，编辑器定位在 m-2 上
    view.rerender(
      <MilestonePanel
        store={store}
        bus={bus}
        t={t('zh')}
        open
        onOpenChange={onOpenChange}
        onSelect={onSelect}
        selectedId="m-2"
      />,
    )
    expect(view.getByTestId('milestone-editor').getAttribute('data-editing-id')).toBe('m-2')
    expect((view.getByTestId('milestone-title-input') as HTMLInputElement).value).toBe('前端联调')
    expect(view.getByTestId('milestone-row-m-2').getAttribute('data-selected')).toBe('true')
  })

  it('非受控挂载时 selectedId 也能拉起面板，Esc/关闭按钮收起', () => {
    const store = createVaultStore(makeVault())
    const view = render(<MilestonePanel store={store} bus={createCommandBus(store)} t={t('zh')} />)
    expect(view.queryByTestId('milestone-panel')).toBeNull()

    view.rerender(
      <MilestonePanel store={store} bus={createCommandBus(store)} t={t('zh')} selectedId="m-1" />,
    )
    expect(view.getByTestId('milestone-panel')).toBeDefined()
    expect(view.getByTestId('milestone-editor').getAttribute('data-editing-id')).toBe('m-1')

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(view.queryByTestId('milestone-panel')).toBeNull()
  })

  it('点击列表行经 onSelect 外送，便于甘特图同步高亮', () => {
    const { view, onSelect } = setup()

    fireEvent.click(view.getByTestId('milestone-open-m-x'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-x', topicId: null }))
  })

  it('受控模式下 Esc 与关闭按钮都经 onOpenChange 外送', () => {
    const { view, onOpenChange } = setup()

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    onOpenChange.mockClear()
    fireEvent.click(view.getByTestId('milestone-panel-close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('文案与 i18n', () => {
  it('全部文案走 t()：en 下渲染英文', () => {
    const { view } = setup('en')

    expect(within(view.getByTestId('milestone-panel')).getByText('Milestones')).toBeDefined()
    expect(view.getByTestId('milestone-new').textContent).toContain('New milestone')
    expect(view.getByTestId('milestone-count').textContent).toContain('3')
    expect(view.getByTestId('milestone-badge-m-x').textContent).toBe('Cross-topic')
  })
})

describe('纯函数', () => {
  it('upsert / remove / 分组 / 日期校验语义', () => {
    const vault = makeVault()
    const created: Milestone = {
      id: 'm-new',
      topicId: null,
      title: 'x',
      date: '2026-01-01',
      done: false,
      color: '#4F46E5',
    }

    const added = upsertMilestone(vault, created)
    expect(added.milestones).toHaveLength(vault.milestones.length + 1)
    expect(added.milestones.at(-1)?.id).toBe('m-new')

    const replaced = upsertMilestone(added, { ...created, title: 'y' })
    expect(replaced.milestones).toHaveLength(added.milestones.length)
    expect(replaced.milestones.find((candidate) => candidate.id === 'm-new')?.title).toBe('y')

    const removed = removeMilestone(replaced, 'm-new')
    expect(removed.milestones.some((candidate) => candidate.id === 'm-new')).toBe(false)
    expect(() => removeMilestone(removed, 'm-new')).toThrow()

    const { cross, byTopic } = splitMilestoneGroups(vault.milestones)
    expect(cross.map((candidate) => candidate.id)).toEqual(['m-x'])
    expect(byTopic.map((candidate) => candidate.id)).toEqual(['m-1', 'm-2'])

    expect(sortMilestones(vault.milestones).map((candidate) => candidate.date)).toEqual([
      '2026-10-10',
      '2026-10-20',
      '2026-11-01',
    ])

    expect(isValidDateKey('2026-10-15')).toBe(true)
    expect(isValidDateKey('2026-02-30')).toBe(false)
    expect(isValidDateKey('2026-13-01')).toBe(false)
    expect(isValidDateKey('2026/10/15')).toBe(false)
    expect(isValidDateKey('')).toBe(false)
  })

  it('草稿构造：新建取默认话题与轮转色，编辑取里程碑现值', () => {
    const vault = makeVault()

    const fresh = newMilestoneDraft(vault, 'ops')
    expect(fresh.id).toBeNull()
    expect(fresh.topicId).toBe('ops')
    expect(fresh.done).toBe(false)
    expect(fresh.color).toBe(TOPIC_PALETTE[3])
    // 默认话题不存在时回落跨话题，而不是留下悬空引用
    expect(newMilestoneDraft(vault, 'nope').topicId).toBeNull()

    const m2 = vault.milestones.find((candidate) => candidate.id === 'm-2') as Milestone
    const fromExisting = draftFromMilestone(m2)
    expect(fromExisting).toEqual({
      id: 'm-2',
      title: '前端联调',
      date: '2026-10-20',
      topicId: 'p-fe',
      done: false,
      color: '#059669',
    })
  })
})
