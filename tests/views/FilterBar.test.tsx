// @vitest-environment jsdom
//
// T16 · FilterBar：组合筛选 UI + lastFilter 落盘 + 重开恢复 + 看板/甘特共用。
//
// 与 T14/T15/T18 同一手法：用**真的 VaultStore + 真的 CommandBus**（不是假 store）——
// 验收 3「写入 settings.lastFilter 并落盘」要求状态落在唯一状态源上、且经 settings.patch
// 命令（可撤销），假 store 会把这条验成空气。
//
// 「重开应用恢复」用「同一 vault 对象灌进新 store」模拟：persistence 层只负责把
// vault.settings 写进 / 读出 vault.json，恢复的落点就是 settings.lastFilter。
//
// 「看板与甘特共用」按 spec 6.2 的口径验：**同一份 Filter 交给两边各自的 QueryEngine**
// （FilterBar 只产出 Filter，不接触查询结果）；切视图用条件渲染模拟，筛选条件存在
// settings 里，视图组件卸载重挂都不丢。

import { cleanup, fireEvent, render } from '@testing-library/react'
import { useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_HOP_DEPTH,
  clampHopDepth,
  clearFilter,
  commitFilter,
  countActiveFilters,
  isFilterEmpty,
  isSameFilter,
  normalizeFilter,
  setDateRange,
  setHopDepth,
  setTagMode,
  setText,
  toggleAssignee,
  toggleFlag,
  toggleKind,
  togglePriority,
  toggleStatus,
  toggleTag,
  toggleTopicId,
} from '../../src/controllers/filters'
import { createCommandBus } from '../../src/domain/commandBus'
import { createEmptyFilter, createQueryEngine } from '../../src/domain/queryEngine'
import { createVaultStore } from '../../src/domain/store'
import type { Filter, Task, Topic, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import { BoardView } from '../../src/views/BoardView'
import { FilterBar } from '../../src/views/FilterBar'
import { GanttView } from '../../src/views/GanttView'

const NOW = '2026-10-15T09:30:00.000Z'
const TODAY = '2026-10-15'

function topic(id: string, name: string, parentId: string | null, order: string): Topic {
  return { id, name, color: '#4F46E5', parentId, order, archived: false }
}

function task(id: string, topicId: string, overrides: Partial<Task> = {}): Task {
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
    order: 'm',
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
    ...overrides,
  }
}

/**
 * 四个话题 / 四个任务，刻意覆盖全部筛选维度：
 *   t1 doing  feature P1  [ui]        alice  10-10..10-20  有笔记  被 t2 阻塞
 *   t2 todo   bug     P0  [ui, perf]  bob    10-11..10-19  无笔记  阻塞 t1
 *   t3 review chore   P2  []          alice  10-01..10-05  有笔记  逾期
 *   t4 done   doc     P3  [docs]      —      10-12..10-18  有笔记
 */
function makeVault(): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v-t16',
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
    topics: [topic('tp', '产品', null, 'a'), topic('tf', '前端', 'tp', 'a'), topic('to', '运维', null, 'b')],
    tasks: [
      task('t1', 'tf', {
        title: '登录页改造',
        status: 'doing',
        kind: 'feature',
        priority: 'P1',
        tags: ['ui'],
        assignee: 'alice',
        start: '2026-10-10',
        due: '2026-10-20',
        progress: 50,
        note: '改造登录页，接入验证码',
        order: 'a',
      }),
      task('t2', 'tf', {
        title: '修复构建脚本',
        status: 'todo',
        kind: 'bug',
        priority: 'P0',
        tags: ['ui', 'perf'],
        assignee: 'bob',
        start: '2026-10-11',
        due: '2026-10-19',
        order: 'b',
      }),
      task('t3', 'to', {
        title: '监控告警巡检',
        status: 'review',
        kind: 'chore',
        priority: 'P2',
        assignee: 'alice',
        start: '2026-10-01',
        due: '2026-10-05',
        note: '每周巡检一次',
        order: 'c',
      }),
      task('t4', 'to', {
        title: '更新用户手册',
        status: 'done',
        kind: 'doc',
        priority: 'P3',
        tags: ['docs'],
        start: '2026-10-12',
        due: '2026-10-18',
        progress: 100,
        note: '补一页纸手册',
        order: 'd',
      }),
    ],
    milestones: [],
    // t2 → t1：t1 被 t2 阻塞（t2 未完成）
    links: [{ id: 'l1', from: 't2', to: 't1', type: 'FS', lagDays: 0 }],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
  }
}

function t(locale: 'zh' | 'en' = 'zh') {
  return createI18n({ getLocale: () => locale, subscribe: () => () => {} }).t
}

function setup(locale: 'zh' | 'en' = 'zh', lastFilter: Vault['settings']['lastFilter'] = null) {
  const vault = makeVault()
  vault.settings.lastFilter = lastFilter
  const store = createVaultStore(vault)
  const bus = createCommandBus(store)
  const view = render(<FilterBar store={store} bus={bus} t={t(locale)} open />)
  return { store, bus, view, vault }
}

/** 回车提交全文搜索框（与侧栏 inline 编辑同一模式：草稿 + Enter/blur 落库）。 */
function search(view: ReturnType<typeof setup>['view'], value: string) {
  const input = view.getByTestId('filter-text-input')
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

afterEach(cleanup)

// ── 纯函数：chip 切换 / 清空 / 归一化（可脱离 DOM 单测） ──────────────────

describe('filters 纯函数', () => {
  it('toggleStatus / toggleKind / togglePriority：点一次加、再点一次减', () => {
    let filter = createEmptyFilter()
    filter = toggleStatus(filter, 'doing')
    expect(filter.statuses).toEqual(['doing'])
    filter = toggleStatus(filter, 'todo')
    expect(filter.statuses).toEqual(['doing', 'todo'])
    filter = toggleStatus(filter, 'doing')
    expect(filter.statuses).toEqual(['todo'])

    filter = toggleKind(filter, 'bug')
    expect(filter.kinds).toEqual(['bug'])
    filter = toggleKind(filter, 'bug')
    expect(filter.kinds).toEqual([])

    filter = togglePriority(filter, 'P0')
    expect(filter.priorities).toEqual(['P0'])
    filter = togglePriority(filter, 'P0')
    expect(filter.priorities).toEqual([])
  })

  it('toggleTag / toggleAssignee 增删（语义即去重）；setTagMode 切换', () => {
    let filter = createEmptyFilter()
    filter = toggleTag(filter, 'ui')
    filter = toggleTag(filter, 'perf')
    expect(filter.tags).toEqual(['ui', 'perf'])
    // 再点一次 = 移除，因此同一标签不可能出现两份
    filter = toggleTag(filter, 'ui')
    expect(filter.tags).toEqual(['perf'])
    filter = toggleTag(filter, 'perf')
    expect(filter.tags).toEqual([])
    // 空白标签被忽略（不写入空项）
    expect(toggleTag(createEmptyFilter(), '   ').tags).toEqual([])

    filter = toggleAssignee(filter, 'alice')
    expect(filter.assignees).toEqual(['alice'])
    filter = toggleAssignee(filter, 'alice')
    expect(filter.assignees).toEqual([])

    filter = setTagMode(filter, 'all')
    expect(filter.tagMode).toBe('all')
    expect(setTagMode(filter, 'all')).toBe(filter)
    filter = setTagMode(filter, 'any')
    expect(filter.tagMode).toBe('any')
  })

  it('toggleTopicId 增删话题；toggleFlag 切换四个布尔维度', () => {
    let filter = createEmptyFilter()
    filter = toggleTopicId(filter, 'tf')
    expect(filter.topicIds).toEqual(['tf'])
    filter = toggleTopicId(filter, 'to')
    expect(filter.topicIds).toEqual(['tf', 'to'])
    filter = toggleTopicId(filter, 'tf')
    expect(filter.topicIds).toEqual(['to'])

    filter = toggleFlag(filter, 'overdueOnly')
    expect(filter.overdueOnly).toBe(true)
    filter = toggleFlag(filter, 'overdueOnly')
    expect(filter.overdueOnly).toBe(false)
    filter = toggleFlag(filter, 'blockedOnly')
    filter = toggleFlag(filter, 'withNotesOnly')
    filter = toggleFlag(filter, 'includeArchived')
    expect([filter.blockedOnly, filter.withNotesOnly, filter.includeArchived]).toEqual([true, true, true])
  })

  it('setDateRange：两端可缺省，两端都空时整个 dateRange 撤销', () => {
    let filter = createEmptyFilter()
    filter = setDateRange(filter, { from: '2026-10-01' })
    expect(filter.dateRange).toEqual({ from: '2026-10-01' })
    filter = setDateRange(filter, { from: '2026-10-01', to: '2026-10-31' })
    expect(filter.dateRange).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    filter = setDateRange(filter, { to: '2026-10-31' })
    expect(filter.dateRange).toEqual({ to: '2026-10-31' })
    filter = setDateRange(filter, { from: '', to: '' })
    expect(filter.dateRange).toBeUndefined()
  })

  it('setText：空白输入等于没有全文条件', () => {
    let filter = createEmptyFilter()
    filter = setText(filter, '登录')
    expect(filter.text).toBe('登录')
    filter = setText(filter, '   ')
    expect(filter.text).toBeUndefined()
    filter = setText(filter, '')
    expect(filter.text).toBeUndefined()
  })

  it('clampHopDepth：NaN / 负值 / 越界 / 小数全部归一到 0–3', () => {
    expect(MAX_HOP_DEPTH).toBe(3)
    expect(clampHopDepth(0)).toBe(0)
    expect(clampHopDepth(2)).toBe(2)
    expect(clampHopDepth(3)).toBe(3)
    expect(clampHopDepth(4)).toBe(3)
    expect(clampHopDepth(99)).toBe(3)
    expect(clampHopDepth(-1)).toBe(0)
    expect(clampHopDepth(2.7)).toBe(2)
    expect(clampHopDepth(Number.NaN)).toBe(0)
  })

  it('setHopDepth：夹取后写入，无变化时返回同一对象', () => {
    const base = createEmptyFilter()
    const up = setHopDepth(base, 'upstream', 5)
    expect(up.upstreamDepth).toBe(MAX_HOP_DEPTH)
    const down = setHopDepth(up, 'downstream', 1)
    expect(down.downstreamDepth).toBe(1)
    expect(setHopDepth(down, 'upstream', 3)).toBe(down)
    expect(setHopDepth(down, 'upstream', -2)).not.toBe(down)
    expect(setHopDepth(down, 'upstream', -2).upstreamDepth).toBe(0)
  })

  it('isFilterEmpty / countActiveFilters / clearFilter', () => {
    const empty = createEmptyFilter()
    expect(isFilterEmpty(empty)).toBe(true)
    expect(countActiveFilters(empty)).toBe(0)
    expect(isFilterEmpty(clearFilter())).toBe(true)

    const busy = normalizeFilter({
      ...empty,
      statuses: ['doing', 'doing'],
      tags: ['ui'],
      overdueOnly: true,
      upstreamDepth: 2,
      text: '登录',
    })
    expect(isFilterEmpty(busy)).toBe(false)
    // statuses / tags / overdueOnly / text / upstreamDepth 共 5 个维度
    expect(countActiveFilters(busy)).toBe(5)
  })

  it('normalizeFilter：null / 非法值 / 重复项 / 越界跳数全部归一', () => {
    expect(normalizeFilter(null)).toEqual(createEmptyFilter())
    expect(normalizeFilter(undefined)).toEqual(createEmptyFilter())
    expect(normalizeFilter('garbage')).toEqual(createEmptyFilter())

    const normalized = normalizeFilter({
      topicIds: ['tf', 'tf', 42],
      includeDescendants: 'nope',
      statuses: ['doing', 'nope', 'todo'],
      kinds: ['bug', 'x'],
      priorities: ['P0', 'P9'],
      tags: ['ui', 'ui', ''],
      tagMode: 'weird',
      assignees: ['alice'],
      dateRange: { from: '', to: '' },
      overdueOnly: 1,
      blockedOnly: true,
      text: '   ',
      upstreamDepth: 9,
      downstreamDepth: -3,
    })
    expect(normalized.topicIds).toEqual(['tf'])
    expect(normalized.includeDescendants).toBe(true)
    expect(normalized.statuses).toEqual(['doing', 'todo'])
    expect(normalized.kinds).toEqual(['bug'])
    expect(normalized.priorities).toEqual(['P0'])
    expect(normalized.tags).toEqual(['ui'])
    expect(normalized.tagMode).toBe('any')
    expect(normalized.assignees).toEqual(['alice'])
    expect(normalized.dateRange).toBeUndefined()
    // 规范形态只保留「生效」的可选字段：false / 0 / 空串一律缺省（等价于默认值）
    expect(normalized.overdueOnly).toBeUndefined()
    expect(normalized.blockedOnly).toBe(true)
    expect(normalized.text).toBeUndefined()
    expect(normalized.upstreamDepth).toBe(MAX_HOP_DEPTH)
    expect(normalized.downstreamDepth).toBeUndefined()
  })

  it('isSameFilter：null 与空筛选等价；数组按集合比较；可选字段缺失即默认', () => {
    expect(isSameFilter(null, createEmptyFilter())).toBe(true)
    expect(isSameFilter(createEmptyFilter(), null)).toBe(true)
    expect(isSameFilter(undefined, null)).toBe(true)

    const a: Filter = { ...createEmptyFilter(), statuses: ['todo', 'doing'] }
    const b: Filter = { ...createEmptyFilter(), statuses: ['doing', 'todo'] }
    expect(isSameFilter(a, b)).toBe(true)

    const c: Filter = { ...createEmptyFilter(), statuses: ['todo'] }
    expect(isSameFilter(a, c)).toBe(false)

    expect(isSameFilter({ ...createEmptyFilter(), text: 'a' }, { ...createEmptyFilter(), text: 'b' })).toBe(false)
    expect(isSameFilter({ ...createEmptyFilter(), upstreamDepth: 1 }, createEmptyFilter())).toBe(false)
    expect(isSameFilter({ ...createEmptyFilter(), includeArchived: true }, createEmptyFilter())).toBe(false)
    expect(
      isSameFilter({ ...createEmptyFilter(), dateRange: { from: '', to: '' } }, createEmptyFilter()),
    ).toBe(true)
  })

  it('commitFilter：无变化不产生命令；有变化走 settings.patch 且可撤销', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)

    // 空筛选 vs null：等价，不该进撤销栈
    commitFilter(store.getVault(), bus, createEmptyFilter())
    expect(bus.undoDepth()).toBe(0)
    expect(store.getVault().settings.lastFilter).toBeNull()

    commitFilter(store.getVault(), bus, toggleStatus(createEmptyFilter(), 'doing'))
    expect(bus.undoDepth()).toBe(1)
    expect(store.getVault().settings.lastFilter?.statuses).toEqual(['doing'])

    // 重复提交同一结果：no-op
    commitFilter(store.getVault(), bus, toggleStatus(createEmptyFilter(), 'doing'))
    expect(bus.undoDepth()).toBe(1)

    // 撤销回到 null
    expect(bus.undo()).toBe(true)
    expect(store.getVault().settings.lastFilter).toBeNull()
    expect(bus.undoDepth()).toBe(0)
  })
})

// ── 组件：渲染 ────────────────────────────────────────────────────────────

describe('FilterBar 渲染', () => {
  it('渲染全部 chip 组、全文框、跳数输入与清空按钮', () => {
    const { view } = setup()

    // 状态 4 / 类别 5 / 优先级 4 / 开关 4
    for (const status of ['todo', 'doing', 'review', 'done']) {
      expect(view.getByTestId(`filter-chip-status-${status}`)).toBeDefined()
    }
    for (const kind of ['feature', 'bug', 'chore', 'research', 'doc']) {
      expect(view.getByTestId(`filter-chip-kind-${kind}`)).toBeDefined()
    }
    for (const priority of ['P0', 'P1', 'P2', 'P3']) {
      expect(view.getByTestId(`filter-chip-priority-${priority}`)).toBeDefined()
    }
    for (const flag of ['overdue', 'blocked', 'with-notes', 'include-archived']) {
      expect(view.getByTestId(`filter-chip-${flag}`)).toBeDefined()
    }

    expect(view.getByTestId('filter-text-input')).toBeDefined()
    expect(view.getByTestId('filter-upstream-input')).toBeDefined()
    expect(view.getByTestId('filter-downstream-input')).toBeDefined()
    expect(view.getByTestId('filter-tag-input')).toBeDefined()
    expect(view.getByTestId('filter-assignee-input')).toBeDefined()
    expect(view.getByTestId('filter-date-from')).toBeDefined()
    expect(view.getByTestId('filter-date-to')).toBeDefined()
    expect(view.getByTestId('filter-clear')).toBeDefined()
    expect(view.getByTestId('filter-bar')).toBeDefined()
  })

  it('chips 的选中态来自 settings.lastFilter（aria-pressed）', () => {
    const { view } = setup('zh', {
      ...createEmptyFilter(),
      statuses: ['doing'],
      priorities: ['P0'],
      overdueOnly: true,
      includeArchived: true,
      upstreamDepth: 2,
    })

    expect(view.getByTestId('filter-chip-status-doing').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-status-todo').getAttribute('aria-pressed')).toBe('false')
    expect(view.getByTestId('filter-chip-priority-P0').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-overdue').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-blocked').getAttribute('aria-pressed')).toBe('false')
    expect(view.getByTestId('filter-chip-include-archived').getAttribute('aria-pressed')).toBe('true')
    expect((view.getByTestId('filter-upstream-input') as HTMLInputElement).value).toBe('2')
    // 生效维度数：statuses / priorities / overdue / includeArchived / upstream = 5
    expect(view.getByTestId('filter-active-count').textContent).toContain('5')
  })

  it('全部文案走 t()：切到 en 后渲染英文', () => {
    const { view } = setup('en')
    expect(view.getByTestId('filter-chip-status-todo').textContent).toBe('To Do')
    expect(view.getByTestId('filter-chip-overdue').textContent).toBe('Overdue')
    expect(view.getByTestId('filter-clear').textContent).toContain('Clear all filters')
  })
})

// ── 验收 3：筛选变更写入 settings.lastFilter 并落盘 ──────────────────────

describe('筛选变更落盘（settings.lastFilter）', () => {
  it('点状态 chip 写入 lastFilter，再点取消；走 CommandBus 可撤销', () => {
    const { store, bus, view } = setup()

    fireEvent.click(view.getByTestId('filter-chip-status-doing'))
    expect(store.getVault().settings.lastFilter?.statuses).toEqual(['doing'])
    expect(view.getByTestId('filter-chip-status-doing').getAttribute('aria-pressed')).toBe('true')
    expect(bus.undoDepth()).toBe(1)

    fireEvent.click(view.getByTestId('filter-chip-status-doing'))
    expect(store.getVault().settings.lastFilter?.statuses).toEqual([])
    expect(view.getByTestId('filter-chip-status-doing').getAttribute('aria-pressed')).toBe('false')
    expect(bus.undoDepth()).toBe(2)

    expect(bus.undo()).toBe(true)
    expect(store.getVault().settings.lastFilter?.statuses).toEqual(['doing'])
  })

  it('全文搜索框回车后落盘；清空则撤销该维度', () => {
    const { store, view } = setup()

    search(view, '登录')
    expect(store.getVault().settings.lastFilter?.text).toBe('登录')
    expect((view.getByTestId('filter-text-input') as HTMLInputElement).value).toBe('登录')

    search(view, '')
    expect(store.getVault().settings.lastFilter?.text).toBeUndefined()
    expect((view.getByTestId('filter-text-input') as HTMLInputElement).value).toBe('')
  })

  it('标签：回车添加、点 chip 移除、any/all 模式切换', () => {
    const { store, view } = setup()

    const tagInput = view.getByTestId('filter-tag-input')
    fireEvent.change(tagInput, { target: { value: 'ui' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    fireEvent.change(tagInput, { target: { value: 'perf' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    expect(store.getVault().settings.lastFilter?.tags).toEqual(['ui', 'perf'])

    fireEvent.click(view.getByTestId('filter-tagmode-all'))
    expect(store.getVault().settings.lastFilter?.tagMode).toBe('all')
    expect(view.getByTestId('filter-tagmode-all').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(view.getByTestId('filter-tagmode-any'))
    expect(store.getVault().settings.lastFilter?.tagMode).toBe('any')

    fireEvent.click(view.getByTestId('filter-tag-chip-0'))
    expect(store.getVault().settings.lastFilter?.tags).toEqual(['perf'])
  })

  it('负责人：回车添加、点 chip 移除', () => {
    const { store, view } = setup()

    const input = view.getByTestId('filter-assignee-input')
    fireEvent.change(input, { target: { value: 'alice' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(store.getVault().settings.lastFilter?.assignees).toEqual(['alice'])

    fireEvent.click(view.getByTestId('filter-assignee-chip-0'))
    expect(store.getVault().settings.lastFilter?.assignees).toEqual([])
  })

  it('日期范围：from/to 各自落盘，两端清空后撤销该维度', () => {
    const { store, view } = setup()

    fireEvent.change(view.getByTestId('filter-date-from'), { target: { value: '2026-10-01' } })
    expect(store.getVault().settings.lastFilter?.dateRange).toEqual({ from: '2026-10-01' })
    fireEvent.change(view.getByTestId('filter-date-to'), { target: { value: '2026-10-31' } })
    expect(store.getVault().settings.lastFilter?.dateRange).toEqual({ from: '2026-10-01', to: '2026-10-31' })

    fireEvent.change(view.getByTestId('filter-date-from'), { target: { value: '' } })
    fireEvent.change(view.getByTestId('filter-date-to'), { target: { value: '' } })
    expect(store.getVault().settings.lastFilter?.dateRange).toBeUndefined()
  })

  it('四个开关 chip 各自落盘', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('filter-chip-blocked'))
    fireEvent.click(view.getByTestId('filter-chip-with-notes'))
    fireEvent.click(view.getByTestId('filter-chip-include-archived'))

    const lastFilter = store.getVault().settings.lastFilter
    expect(lastFilter?.blockedOnly).toBe(true)
    expect(lastFilter?.withNotesOnly).toBe(true)
    expect(lastFilter?.includeArchived).toBe(true)
    expect(lastFilter?.overdueOnly).toBeFalsy()
  })

  it('话题 chip 可移除（侧栏选中的话题在这里可见且可取消）', () => {
    const { store, view } = setup('zh', { ...createEmptyFilter(), topicIds: ['tf', 'to'] })

    expect(view.getByTestId('filter-topic-chip-tf')).toBeDefined()
    fireEvent.click(view.getByTestId('filter-topic-chip-tf'))
    expect(store.getVault().settings.lastFilter?.topicIds).toEqual(['to'])
  })

  it('依赖跳数：0–3 夹取；越界输入落盘为 3，负值落盘为 0', () => {
    const { store, view } = setup()

    const upstream = view.getByTestId('filter-upstream-input')
    fireEvent.change(upstream, { target: { value: '5' } })
    expect(store.getVault().settings.lastFilter?.upstreamDepth).toBe(MAX_HOP_DEPTH)
    expect((upstream as HTMLInputElement).value).toBe('3')

    fireEvent.change(upstream, { target: { value: '-2' } })
    // 0 与「缺省」等价（QueryEngine 读 `?? 0`），规范形态里不写这个键
    expect(store.getVault().settings.lastFilter?.upstreamDepth ?? 0).toBe(0)
    expect((upstream as HTMLInputElement).value).toBe('0')

    fireEvent.change(view.getByTestId('filter-downstream-input'), { target: { value: '2' } })
    expect(store.getVault().settings.lastFilter?.downstreamDepth).toBe(2)
  })
})

// ── 验收 3（恢复）：重开应用后筛选条件回来 ────────────────────────────────

describe('重开应用恢复', () => {
  it('库里的 lastFilter 原样恢复到 UI（chip / 输入框 / 模式）', () => {
    const { view } = setup('zh', {
      ...createEmptyFilter(),
      statuses: ['review'],
      kinds: ['chore'],
      priorities: ['P2'],
      tags: ['docs'],
      tagMode: 'all',
      assignees: ['alice'],
      dateRange: { from: '2026-10-01', to: '2026-10-31' },
      blockedOnly: true,
      withNotesOnly: true,
      includeArchived: true,
      text: '巡检',
      upstreamDepth: 1,
      downstreamDepth: 3,
    })

    expect(view.getByTestId('filter-chip-status-review').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-kind-chore').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-priority-P2').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-blocked').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-with-notes').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-include-archived').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-tagmode-all').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-tag-chip-0').textContent).toContain('docs')
    expect(view.getByTestId('filter-assignee-chip-0').textContent).toContain('alice')
    expect((view.getByTestId('filter-date-from') as HTMLInputElement).value).toBe('2026-10-01')
    expect((view.getByTestId('filter-date-to') as HTMLInputElement).value).toBe('2026-10-31')
    expect((view.getByTestId('filter-text-input') as HTMLInputElement).value).toBe('巡检')
    expect((view.getByTestId('filter-upstream-input') as HTMLInputElement).value).toBe('1')
    expect((view.getByTestId('filter-downstream-input') as HTMLInputElement).value).toBe('3')
  })

  it('磁盘上的旧/脏 lastFilter 被归一化后恢复（不崩、不丢合法维度）', () => {
    const { view } = setup('zh', {
      topicIds: ['tf', 'tf'],
      includeDescendants: true,
      statuses: ['doing', 'nope'],
      kinds: ['bug'],
      priorities: ['P0'],
      tags: ['ui', 'ui'],
      tagMode: 'all',
      assignees: ['alice'],
      overdueOnly: true,
      text: '登录',
      upstreamDepth: 9,
    } as unknown as Vault['settings']['lastFilter'])

    expect(view.getByTestId('filter-chip-status-doing').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-kind-bug').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByTestId('filter-chip-overdue').getAttribute('aria-pressed')).toBe('true')
    expect((view.getByTestId('filter-upstream-input') as HTMLInputElement).value).toBe('3')
    expect((view.getByTestId('filter-text-input') as HTMLInputElement).value).toBe('登录')
  })

  it('改筛选 → 用同一 vault 开新 store（模拟重开）→ 条件仍在', () => {
    const { store, view } = setup()
    fireEvent.click(view.getByTestId('filter-chip-status-doing'))
    search(view, '登录')
    fireEvent.change(view.getByTestId('filter-upstream-input'), { target: { value: '2' } })

    // persistence 层落盘的就是 vault.settings；重开 = 同一份 settings 进新 store
    const saved = store.getVault()
    expect(saved.settings.lastFilter?.statuses).toEqual(['doing'])
    expect(saved.settings.lastFilter?.text).toBe('登录')
    expect(saved.settings.lastFilter?.upstreamDepth).toBe(2)

    cleanup()
    const reopened = createVaultStore(saved)
    const view2 = render(<FilterBar store={reopened} bus={createCommandBus(reopened)} t={t()} open />)

    expect(view2.getByTestId('filter-chip-status-doing').getAttribute('aria-pressed')).toBe('true')
    expect((view2.getByTestId('filter-text-input') as HTMLInputElement).value).toBe('登录')
    expect((view2.getByTestId('filter-upstream-input') as HTMLInputElement).value).toBe('2')
  })
})

// ── 验收 4：看板与甘特图共用同一 QueryEngine 结果 ────────────────────────

describe('看板与甘特共用同一筛选', () => {
  const setupRef: {
    store: ReturnType<typeof createVaultStore>
    bus: ReturnType<typeof createCommandBus>
  } = {
    store: undefined as unknown as ReturnType<typeof createVaultStore>,
    bus: undefined as unknown as ReturnType<typeof createCommandBus>,
  }

  function Harness(props: { view: 'board' | 'gantt' }) {
    const store = setupRef.store
    const bus = setupRef.bus
    const vault = useStore(store, (state) => state.vault)
    const filter = useMemo(() => vault.settings.lastFilter ?? createEmptyFilter(), [vault.settings.lastFilter])
    return (
      <>
        <FilterBar store={store} bus={bus} t={t()} open />
        {props.view === 'board' ? (
          <BoardView vault={vault} filter={filter} bus={bus} t={t()} today={TODAY} />
        ) : (
          <GanttView
            vault={vault}
            filter={filter}
            scale="day"
            today={TODAY}
            width={640}
            height={320}
            t={t()}
          />
        )}
      </>
    )
  }

  function mount(view: 'board' | 'gantt') {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    setupRef.store = store
    setupRef.bus = bus
    return render(<Harness view={view} />)
  }

  /** 甘特表里的任务行 id（话题分组行 kind=topic 不计）。 */
  function ganttTaskIds(container: HTMLElement): string[] {
    return [...container.querySelectorAll('[data-gantt-table-row][data-row-kind="task"]')].map(
      (row) => row.getAttribute('data-gantt-table-row') ?? '',
    )
  }

  it('FilterBar 改状态筛选后，看板与甘特同时只显示 doing 的任务', () => {
    const view = mount('board')

    fireEvent.click(view.getByTestId('filter-chip-status-doing'))

    // 看板：只剩 t1（doing）；t2/t3/t4 不在列内
    expect(view.getByTestId('task-card-t1')).toBeDefined()
    expect(view.queryByTestId('task-card-t2')).toBeNull()
    expect(view.queryByTestId('task-card-t3')).toBeNull()
    expect(view.queryByTestId('task-card-t4')).toBeNull()
    expect(view.getByTestId('board-column-count-doing').textContent).toBe('1')

    // 切到甘特：同一份 filter 仍生效（条件存在 settings，不随视图卸载丢失）
    view.rerender(<Harness view="gantt" />)
    expect(ganttTaskIds(view.container)).toEqual(['t1'])

    // 再切回看板：条件依旧
    view.rerender(<Harness view="board" />)
    expect(view.getByTestId('task-card-t1')).toBeDefined()
    expect(view.queryByTestId('task-card-t2')).toBeNull()

    // 清空后两边都恢复全量
    fireEvent.click(view.getByTestId('filter-clear'))
    expect(view.queryByTestId('task-card-t2')).toBeDefined()
    expect(view.queryByTestId('task-card-t3')).toBeDefined()
    expect(view.queryByTestId('task-card-t4')).toBeDefined()
  })

  it('下游 1 跳把被阻塞的任务带回来（todo 的 t2 + 它的下游 t1）', () => {
    const view = mount('gantt')

    // 只留 todo：命中集合 = {t2}
    fireEvent.click(view.getByTestId('filter-chip-status-todo'))
    expect(ganttTaskIds(view.container)).toEqual(['t2'])

    // 下游 1 跳：t2 → t1（l1: t2 阻塞 t1），扩展邻居不受其余维度约束
    fireEvent.change(view.getByTestId('filter-downstream-input'), { target: { value: '1' } })
    expect(ganttTaskIds(view.container).sort()).toEqual(['t1', 't2'])
  })

  it('FilterBar 只产出 Filter：面板不自行查询，结果由两边各自的 QueryEngine 算出', () => {
    const { store, view } = setup()
    fireEvent.click(view.getByTestId('filter-chip-status-doing'))

    // 面板侧没有任何任务 DOM（不渲染卡片/行，只渲染控件）
    expect(view.container.querySelector('[data-testid^="task-card-"]')).toBeNull()
    expect(view.container.querySelector('[data-gantt-table-row]')).toBeNull()

    // 同一 filter 喂给两个独立 engine，结果一致
    const vault = store.getVault()
    const filter = vault.settings.lastFilter
    expect(filter).not.toBeNull()
    const engineA = createQueryEngine(vault.topics, vault.tasks, vault.links, { today: TODAY })
    const engineB = createQueryEngine(vault.topics, vault.tasks, vault.links, { today: TODAY })
    expect(engineA.query(filter!).map((task) => task.id)).toEqual(['t1'])
    expect(engineB.query(filter!).map((task) => task.id)).toEqual(['t1'])
  })
})

// ── 验收 5：清空按钮一键重置 ─────────────────────────────────────────────

describe('清空', () => {
  it('一键重置全部维度并落盘（lastFilter 回到空筛选）', () => {
    const { store, bus, view } = setup('zh', {
      ...createEmptyFilter(),
      topicIds: ['tf'],
      statuses: ['doing', 'todo'],
      kinds: ['bug'],
      priorities: ['P0'],
      tags: ['ui'],
      assignees: ['alice'],
      dateRange: { from: '2026-10-01', to: '2026-10-31' },
      overdueOnly: true,
      blockedOnly: true,
      withNotesOnly: true,
      includeArchived: true,
      text: '登录',
      upstreamDepth: 2,
      downstreamDepth: 1,
    })

    fireEvent.click(view.getByTestId('filter-clear'))

    const lastFilter = store.getVault().settings.lastFilter
    expect(lastFilter).not.toBeNull()
    expect(isFilterEmpty(lastFilter!)).toBe(true)

    // UI 同步复位
    expect(view.getByTestId('filter-chip-status-doing').getAttribute('aria-pressed')).toBe('false')
    expect(view.getByTestId('filter-chip-overdue').getAttribute('aria-pressed')).toBe('false')
    expect((view.getByTestId('filter-text-input') as HTMLInputElement).value).toBe('')
    expect((view.getByTestId('filter-upstream-input') as HTMLInputElement).value).toBe('0')
    expect(view.queryByTestId('filter-tag-chip-0')).toBeNull()
    expect(view.queryByTestId('filter-assignee-chip-0')).toBeNull()
    expect(view.queryByTestId('filter-topic-chip-tf')).toBeNull()
    expect(view.queryByTestId('filter-active-count')).toBeNull()

    // 清空是一次可撤销的写（不是静默改 UI）
    expect(bus.undoDepth()).toBe(1)
    expect(bus.undo()).toBe(true)
    expect(store.getVault().settings.lastFilter?.statuses).toEqual(['doing', 'todo'])
  })

  it('已经是空筛选时点清空不产生命令', () => {
    const { bus, view } = setup()
    fireEvent.click(view.getByTestId('filter-clear'))
    expect(bus.undoDepth()).toBe(0)
  })
})

// ── 面板开合 ─────────────────────────────────────────────────────────────

describe('面板开合', () => {
  it('受控：Esc / 关闭按钮 / 遮罩关闭都只经 onOpenChange 外送 false', () => {
    const store = createVaultStore(makeVault())
    const onOpenChange = vi.fn()
    const view = render(
      <FilterBar store={store} bus={createCommandBus(store)} t={t()} open onOpenChange={onOpenChange} />,
    )
    expect(view.getByTestId('filter-bar')).toBeDefined()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    onOpenChange.mockClear()
    fireEvent.click(view.getByTestId('filter-close'))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    onOpenChange.mockClear()
    fireEvent.click(view.getByTestId('filter-backdrop'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('关面板不改筛选：收起后库里条件仍在，重开还是原样', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)

    function Harness() {
      const [open, setOpen] = useState(true)
      return <FilterBar store={store} bus={bus} t={t()} open={open} onOpenChange={setOpen} />
    }

    const view = render(<Harness />)
    fireEvent.click(view.getByTestId('filter-chip-status-doing'))
    expect(store.getVault().settings.lastFilter?.statuses).toEqual(['doing'])

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByTestId('filter-bar')).toBeNull()
    // 条件存在 settings 里，面板的生死与它无关
    expect(store.getVault().settings.lastFilter?.statuses).toEqual(['doing'])

    // 重新打开（模拟侧栏「筛选器」入口再次拉起）→ 仍是 doing
    view.rerender(<Harness key="closed" />)
    expect(store.getVault().settings.lastFilter?.statuses).toEqual(['doing'])
  })

  it('open 省略时默认关闭（可安全挂载，等集成窗口接线）', () => {
    const store = createVaultStore(makeVault())
    const view = render(<FilterBar store={store} bus={createCommandBus(store)} t={t()} />)
    expect(view.queryByTestId('filter-bar')).toBeNull()
  })
})
