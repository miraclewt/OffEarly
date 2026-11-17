// @vitest-environment jsdom
//
// T62 · 标签管理（改名 / 合并 / 删除）——面板内的标签清单。
//
// 验收要点：
//   ① 改名改的是全库批量：一条命令、一次撤销，不是 N 个任务 N 次撤销；
//   ② 改到已存在的名字 = 合并，任务上的重复标签要去掉；
//   ③ 上一次筛选里挂着的同名标签必须跟着改——否则改完立刻零命中，
//      而「任务改好了、筛选没改」这种半状态用户没法自己发现；
//   ④ 删除是两段式（误点代价大），且同样可撤销。

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { applyDeleteTag, applyRenameTag, listTags } from '../../src/controllers/tagActions'
import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Task, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import { FilterBar } from '../../src/views/FilterBar'

const NOW = '2026-10-15T09:30:00.000Z'

function task(id: string, tags: string[]): Task {
  return {
    id,
    topicId: 'tp',
    title: `任务 ${id}`,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags,
    note: '',
    order: id,
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
  }
}

function makeVault(): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v-t62',
    appVersion: 'OffEarly 0.3.0',
    revision: 0,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
      noteFontSize: 13,
    },
    topics: [{ id: 'tp', name: '产品', color: '#4F46E5', parentId: null, order: 'a', archived: false }],
    tasks: [task('a', ['风控', '前端']), task('b', ['风控']), task('c', ['设计'])],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    trash: [],
    whiteboards: [],
  }
}

function t(locale: 'zh' | 'en' = 'zh') {
  return createI18n({ getLocale: () => locale, subscribe: () => () => {} }).t
}

function setup() {
  const vault = makeVault()
  const store = createVaultStore(vault)
  const bus = createCommandBus(store)
  const view = render(<FilterBar store={store} bus={bus} t={t()} open />)
  return { store, bus, view }
}

afterEach(cleanup)

/** 按标签名取行：排序规则（ICU 拼音/笔画）不该成为断言的隐含依赖。 */
function rowOf(view: ReturnType<typeof setup>['view'], tag: string): HTMLElement {
  const row = view.getAllByTestId('filter-tag-row').find((item) => item.getAttribute('data-tag') === tag)
  if (row === undefined) throw new Error(`标签行不存在：${tag}`)
  return row
}

describe('listTags', () => {
  it('统计使用次数并按名字排序', () => {
    expect(listTags(makeVault())).toEqual([
      { tag: '风控', count: 2 },
      { tag: '前端', count: 1 },
      { tag: '设计', count: 1 },
    ])
  })
})

describe('applyRenameTag / applyDeleteTag', () => {
  it('改名一次撤销即整体回退，且保留每个任务的标签顺序', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)

    expect(applyRenameTag(bus, store.getVault(), '风控', '风控合规')).toBe(true)
    expect(store.getVault().tasks.map((item) => item.tags)).toEqual([
      ['风控合规', '前端'],
      ['风控合规'],
      ['设计'],
    ])

    // 一次撤销就把两个任务一起改回去——不是按任务数退两次
    expect(bus.undo()).toBe(true)
    expect(store.getVault().tasks.map((item) => item.tags)).toEqual([['风控', '前端'], ['风控'], ['设计']])
  })

  it('改名到已存在的标签 = 合并，同一任务内的重复标签被去掉', () => {
    const vault = makeVault()
    vault.tasks[0] = task('a', ['风控', '设计'])
    const store = createVaultStore(vault)
    const bus = createCommandBus(store)

    expect(applyRenameTag(bus, store.getVault(), '风控', '设计')).toBe(true)
    expect(store.getVault().tasks[0]?.tags).toEqual(['设计'])
    expect(store.getVault().tasks[1]?.tags).toEqual(['设计'])
  })

  it('空名字 / 同名 / 不存在的标签都是 no-op，不进撤销栈', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)

    expect(applyRenameTag(bus, store.getVault(), '风控', '  ')).toBe(false)
    expect(applyRenameTag(bus, store.getVault(), '风控', '风控')).toBe(false)
    expect(applyRenameTag(bus, store.getVault(), '不存在', '别的')).toBe(false)
    expect(applyDeleteTag(bus, store.getVault(), '不存在')).toBe(false)
    expect(bus.canUndo()).toBe(false)
  })

  it('删除标签可撤销', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)

    expect(applyDeleteTag(bus, store.getVault(), '风控')).toBe(true)
    expect(store.getVault().tasks.map((item) => item.tags)).toEqual([['前端'], [], ['设计']])

    expect(bus.undo()).toBe(true)
    expect(store.getVault().tasks.map((item) => item.tags)).toEqual([['风控', '前端'], ['风控'], ['设计']])
  })

  it('上一次筛选挂着这个标签时跟着改写，撤销一起回退', () => {
    const vault = makeVault()
    vault.settings.lastFilter = {
      topicIds: [],
      includeDescendants: false,
      statuses: [],
      kinds: [],
      priorities: [],
      tags: ['风控'],
      tagMode: 'any',
      assignees: [],
    }
    const store = createVaultStore(vault)
    const bus = createCommandBus(store)

    applyRenameTag(bus, store.getVault(), '风控', '风控合规')
    expect(store.getVault().settings.lastFilter?.tags).toEqual(['风控合规'])

    bus.undo()
    expect(store.getVault().settings.lastFilter?.tags).toEqual(['风控'])
  })

  it('筛选里没挂这个标签时不碰筛选（不产生多余的 settings 变更）', () => {
    const vault = makeVault()
    vault.settings.lastFilter = {
      topicIds: [],
      includeDescendants: false,
      statuses: [],
      kinds: [],
      priorities: [],
      tags: ['设计'],
      tagMode: 'any',
      assignees: [],
    }
    const store = createVaultStore(vault)
    const bus = createCommandBus(store)

    applyDeleteTag(bus, store.getVault(), '风控')
    expect(store.getVault().settings.lastFilter?.tags).toEqual(['设计'])
  })
})

describe('标签管理 UI', () => {
  it('「管理」展开清单：点名字按该标签筛选', () => {
    const { store, view } = setup()
    expect(view.queryByTestId('filter-tag-manager')).toBeNull()

    fireEvent.click(view.getByTestId('filter-tag-manage'))
    const rows = view.getAllByTestId('filter-tag-row')
    expect(rows.map((row) => row.getAttribute('data-tag'))).toEqual(['风控', '前端', '设计'])
    expect(rowOf(view, '风控').textContent).toContain('2')

    fireEvent.click(rowOf(view, '风控').querySelector('[data-testid="filter-tag-apply"]') as HTMLElement)
    expect(store.getVault().settings.lastFilter?.tags).toEqual(['风控'])
  })

  it('改名：回车提交并退出编辑态', () => {
    const { store, view } = setup()
    fireEvent.click(view.getByTestId('filter-tag-manage'))

    fireEvent.click(rowOf(view, '风控').querySelector('[data-testid="filter-tag-rename"]') as HTMLElement)

    const input = view.getByTestId('filter-tag-rename-input')
    fireEvent.change(input, { target: { value: '风控合规' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(store.getVault().tasks.map((item) => item.tags)).toEqual([
      ['风控合规', '前端'],
      ['风控合规'],
      ['设计'],
    ])
    expect(view.queryByTestId('filter-tag-rename-input')).toBeNull()
  })

  it('改名：Esc 放弃，库里不变', () => {
    const { store, view } = setup()
    fireEvent.click(view.getByTestId('filter-tag-manage'))
    fireEvent.click(rowOf(view, '风控').querySelector('[data-testid="filter-tag-rename"]') as HTMLElement)

    const input = view.getByTestId('filter-tag-rename-input')
    fireEvent.change(input, { target: { value: '改坏了' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(store.getVault().tasks.map((item) => item.tags)).toEqual([['风控', '前端'], ['风控'], ['设计']])
    expect(view.queryByTestId('filter-tag-rename-input')).toBeNull()
  })

  it('删除要按两次：第一次只进入确认态', () => {
    const { store, view } = setup()
    fireEvent.click(view.getByTestId('filter-tag-manage'))

    const button = rowOf(view, '风控').querySelector('[data-testid="filter-tag-delete"]') as HTMLElement

    fireEvent.click(button)
    expect(button.textContent).toBe('确认删除')
    expect(store.getVault().tasks[1]?.tags).toEqual(['风控'])

    fireEvent.click(button)
    expect(store.getVault().tasks.map((item) => item.tags)).toEqual([['前端'], [], ['设计']])
  })

  it('没有标签时清单给空态，不渲染行', () => {
    const vault = makeVault()
    vault.tasks = []
    const store = createVaultStore(vault)
    const view = render(<FilterBar store={store} bus={createCommandBus(store)} t={t()} open />)

    fireEvent.click(view.getByTestId('filter-tag-manage'))
    expect(view.queryAllByTestId('filter-tag-row')).toHaveLength(0)
    expect(view.getByTestId('filter-tag-empty')).toBeTruthy()
  })
})
