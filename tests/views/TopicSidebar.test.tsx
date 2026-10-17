// @vitest-environment jsdom
//
// T14 · TopicSidebar：树的渲染 / 无限层展开 / CRUD / 归档 / 筛选联动 / 底部四入口。
// 这里刻意用**真的 VaultStore + 真的 CommandBus**（不是假 store）：验收标准里
// 「点击 topic 设置筛选 topicIds」「归档 topic 其任务从看板/甘特图消失」都要求
// 状态落在唯一状态源上、且经既有写入口，假 store 会把这两条验成空气。

import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderResult } from '@testing-library/react'

import { TOPIC_PALETTE, createTopicActions } from '../../src/controllers/topicActions'
import { createCommandBus } from '../../src/domain/commandBus'
import { createEmptyFilter, createQueryEngine } from '../../src/domain/queryEngine'
import { createVaultStore } from '../../src/domain/store'
import type { Task, Topic, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
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

/**
 * 话题树（三层 + 两个根）：
 *   产品 p ── 前端 p-fe ── 打包 p-fe-build
 *          └─ 后端 p-be ── 数据库 p-be-db
 *   运维 ops
 */
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
    tasks: [
      task('t1', 'p-fe', '登录页'),
      task('t2', 'p-fe-build', '构建脚本'),
      task('t3', 'ops', '监控告警'),
      task('t4', 'p', '历史需求', true),
    ],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
  }
}

function setup(locale: 'zh' | 'en' = 'zh') {
  const store = createVaultStore(makeVault())
  const bus = createCommandBus(store)
  const i18n = createI18n({ getLocale: () => locale, subscribe: () => () => {} })
  const handlers = {
    onOpenMilestones: vi.fn(),
    onOpenFilters: vi.fn(),
    onOpenBackup: vi.fn(),
    onOpenSettings: vi.fn(),
  }
  const view = render(<TopicSidebar store={store} bus={bus} t={i18n.t} {...handlers} />)
  return { store, bus, view, handlers, i18n }
}

/** 行内联编辑：改值 + 回车提交。 */
function typeInto(view: RenderResult, testId: string, value: string) {
  const input = view.getByTestId(testId)
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

function topicOf(store: ReturnType<typeof createVaultStore>, id: string): Topic {
  const found = store.getVault().topics.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`fixture: 话题不存在（${id}）`)
  return found
}

afterEach(cleanup)

describe('话题树渲染', () => {
  it('每个话题渲染 色块 swatch + 名称 + 计数 + chevron', () => {
    const { view } = setup()

    const product = view.getByTestId('topic-row-p')
    expect(within(product).getByText('产品')).toBeDefined()
    expect(view.getByTestId('topic-swatch-p').getAttribute('data-color')).toBe('#4F46E5')
    // 计数 = 子树内未归档任务数：t1/t2 命中，已归档的 t4 不计
    expect(view.getByTestId('topic-count-p').textContent).toBe('2')
    expect(view.getByTestId('topic-count-ops').textContent).toBe('1')

    // 有子话题的行才有 chevron；叶子没有
    expect(view.getByTestId('topic-toggle-p')).toBeDefined()
    expect(view.queryByTestId('topic-toggle-p-be-db')).toBeNull()
  })

  it('默认展开两层：孙辈隐藏，点 chevron 后逐层露出（无限层）', () => {
    const { view } = setup()

    expect(view.getByTestId('topic-row-p')).toBeDefined()
    expect(view.getByTestId('topic-row-p-fe')).toBeDefined()
    expect(view.queryByTestId('topic-row-p-fe-build')).toBeNull()

    fireEvent.click(view.getByTestId('topic-toggle-p-fe'))
    expect(view.getByTestId('topic-row-p-fe-build')).toBeDefined()

    // 第三层同样可继续展开，层数不受限
    fireEvent.click(view.getByTestId('topic-toggle-p-be'))
    expect(view.getByTestId('topic-row-p-be-db')).toBeDefined()
  })
})

describe('新建话题', () => {
  it('悬浮显示「+」新建子话题，回车后按同级末尾插入并取自调色板', () => {
    const { store, view } = setup()

    // 未悬浮时没有「+」
    expect(view.queryByTestId('topic-add-child-p')).toBeNull()

    act(() => {
      fireEvent.mouseOver(view.getByTestId('topic-row-p'))
    })
    const plus = view.getByTestId('topic-add-child-p')
    fireEvent.click(plus)

    typeInto(view, 'topic-name-input', '设计')

    const created = store.getVault().topics.find((candidate) => candidate.name === '设计')
    expect(created).toBeDefined()
    expect(created?.parentId).toBe('p')
    expect(TOPIC_PALETTE).toContain(created?.color)
    // 同级（p 的子话题）按 order 排在最末
    const siblings = store
      .getVault()
      .topics.filter((candidate) => candidate.parentId === 'p')
      .sort((a, b) => (a.order < b.order ? -1 : 1))
    expect(siblings[siblings.length - 1]?.id).toBe(created?.id)
  })

  it('顶部「+」新建根话题', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('topic-add-root'))
    typeInto(view, 'topic-name-input', '增长')

    const created = store.getVault().topics.find((candidate) => candidate.name === '增长')
    expect(created?.parentId).toBeNull()
  })

  it('空名称回落为占位文案，不产生空白行', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('topic-add-root'))
    typeInto(view, 'topic-name-input', '   ')

    const created = store.getVault().topics.find((candidate) => candidate.name === '未命名话题')
    expect(created).toBeDefined()
  })
})

describe('右键菜单', () => {
  it('含 重命名 / 改色 / 新建子话题 / 归档 四项', () => {
    const { view } = setup()

    fireEvent.contextMenu(view.getByTestId('topic-row-p-fe'))
    const menu = within(view.getByTestId('topic-menu'))
    expect(menu.getByText('重命名')).toBeDefined()
    expect(menu.getByText('改色')).toBeDefined()
    expect(menu.getByText('新建子话题')).toBeDefined()
    expect(menu.getByText('归档')).toBeDefined()
  })

  it('重命名写回 store 并立即反映在树上', () => {
    const { store, view } = setup()

    fireEvent.contextMenu(view.getByTestId('topic-row-p-fe'))
    fireEvent.click(view.getByTestId('topic-menu-rename'))
    expect((view.getByTestId('topic-name-input') as HTMLInputElement).value).toBe('前端')

    typeInto(view, 'topic-name-input', '前端 Web')

    expect(topicOf(store, 'p-fe').name).toBe('前端 Web')
    expect(view.queryByTestId('topic-name-input')).toBeNull()
    expect(view.getByText('前端 Web')).toBeDefined()
  })

  it('改色从固定 12 色调色板选取', () => {
    const { store, view } = setup()

    fireEvent.contextMenu(view.getByTestId('topic-row-p-fe'))
    fireEvent.click(view.getByTestId('topic-menu-color'))

    const palette = view.getByTestId('topic-palette')
    const swatches = within(palette).getAllByRole('button')
    expect(TOPIC_PALETTE).toHaveLength(12)
    expect(swatches).toHaveLength(12)

    const picked = TOPIC_PALETTE[7] as string
    fireEvent.click(swatches[7] as HTMLElement)

    expect(topicOf(store, 'p-fe').color).toBe(picked)
    expect(view.getByTestId('topic-swatch-p-fe').getAttribute('data-color')).toBe(picked)
  })

  it('菜单里的「新建子话题」把新话题挂到该行下', () => {
    const { store, view } = setup()

    fireEvent.contextMenu(view.getByTestId('topic-row-ops'))
    fireEvent.click(view.getByTestId('topic-menu-add-child'))
    typeInto(view, 'topic-name-input', '值班')

    const created = store.getVault().topics.find((candidate) => candidate.name === '值班')
    expect(created?.parentId).toBe('ops')
  })
})

describe('归档', () => {
  it('归档后该话题与其子树的任务从看板/甘特图的数据源里消失', () => {
    const { store, view } = setup()

    fireEvent.contextMenu(view.getByTestId('topic-row-p'))
    fireEvent.click(view.getByTestId('topic-menu-archive'))

    // 话题自身与全部子孙一并归档
    for (const id of ['p', 'p-fe', 'p-fe-build', 'p-be', 'p-be-db']) {
      expect(topicOf(store, id).archived).toBe(true)
    }
    // 子树内任务一并归档 —— 这正是「从看板/甘特图消失」的机制（QueryEngine 默认排除归档任务）
    const archivedTitles = store
      .getVault()
      .tasks.filter((candidate) => candidate.archived)
      .map((candidate) => candidate.title)
    expect(archivedTitles.sort()).toEqual(['历史需求', '构建脚本', '登录页'].sort())

    const vault = store.getVault()
    const engine = createQueryEngine(vault.topics, vault.tasks, vault.links)
    expect(engine.query(createEmptyFilter()).map((candidate) => candidate.title)).toEqual(['监控告警'])

    // 树上不再出现
    expect(view.queryByTestId('topic-row-p')).toBeNull()
    expect(view.queryByTestId('topic-row-p-fe')).toBeNull()
    expect(view.getByTestId('topic-row-ops')).toBeDefined()
  })

  it('归档掉正被筛选的话题时同步摘掉失效的 topicIds（不留点不掉的死筛选）', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('topic-row-p-fe'))
    expect(store.getVault().settings.lastFilter?.topicIds).toEqual(['p-fe'])

    fireEvent.contextMenu(view.getByTestId('topic-row-p'))
    fireEvent.click(view.getByTestId('topic-menu-archive'))

    expect(store.getVault().settings.lastFilter?.topicIds).toEqual([])
  })

  it('「显示已归档」后可取消归档，树与数据一并还原', () => {
    const { store, view } = setup()

    fireEvent.contextMenu(view.getByTestId('topic-row-ops'))
    fireEvent.click(view.getByTestId('topic-menu-archive'))
    expect(view.queryByTestId('topic-row-ops')).toBeNull()

    fireEvent.click(view.getByTestId('sidebar-toggle-archived'))
    const row = view.getByTestId('topic-row-ops')
    expect(row.getAttribute('data-archived')).toBe('true')

    fireEvent.contextMenu(row)
    fireEvent.click(view.getByTestId('topic-menu-archive'))
    expect(topicOf(store, 'ops').archived).toBe(false)

    const vault = store.getVault()
    const engine = createQueryEngine(vault.topics, vault.tasks, vault.links)
    expect(engine.query(createEmptyFilter()).map((candidate) => candidate.title)).toContain('监控告警')
  })
})

describe('点击话题设置筛选', () => {
  it('点击行写入 settings.lastFilter.topicIds，再点取消', () => {
    const { store, bus, view } = setup()

    fireEvent.click(view.getByTestId('topic-row-p-fe'))
    expect(store.getVault().settings.lastFilter?.topicIds).toEqual(['p-fe'])
    expect(view.getByTestId('topic-row-p-fe').getAttribute('data-selected')).toBe('true')
    expect(view.getByTestId('topic-row-p').getAttribute('data-selected')).toBe('false')
    // 走的是 CommandBus（可撤销），不是在组件里私藏一份筛选状态
    expect(bus.undoDepth()).toBe(1)

    fireEvent.click(view.getByTestId('topic-row-p-fe'))
    expect(store.getVault().settings.lastFilter?.topicIds).toEqual([])
    expect(view.getByTestId('topic-row-p-fe').getAttribute('data-selected')).toBe('false')
  })

  it('点 chevron 只折叠，不改筛选', () => {
    const { store, view } = setup()

    fireEvent.click(view.getByTestId('topic-toggle-p'))
    expect(store.getVault().settings.lastFilter).toBeNull()

    // 折叠后子行消失
    expect(view.queryByTestId('topic-row-p-fe')).toBeNull()
  })
})

describe('底部四入口', () => {
  it('渲染 里程碑 / 筛选器 / 备份 / 设置 并可点击', () => {
    const { handlers, view } = setup()

    fireEvent.click(view.getByTestId('sidebar-open-milestones'))
    fireEvent.click(view.getByTestId('sidebar-open-filters'))
    fireEvent.click(view.getByTestId('sidebar-open-backup'))
    fireEvent.click(view.getByTestId('sidebar-open-settings'))

    expect(handlers.onOpenMilestones).toHaveBeenCalledTimes(1)
    expect(handlers.onOpenFilters).toHaveBeenCalledTimes(1)
    expect(handlers.onOpenBackup).toHaveBeenCalledTimes(1)
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('全部文案走 t()：切到 en 后同一组件渲染英文', () => {
    const en = setup('en')
    const enView = en.view

    expect(enView.getByText('Topics')).toBeDefined()
    expect(enView.getByTestId('sidebar-open-milestones').textContent).toContain('Milestones')
    expect(enView.getByTestId('sidebar-open-filters').textContent).toContain('Filters')
    expect(enView.getByTestId('sidebar-open-backup').textContent).toContain('Backup')
    expect(enView.getByTestId('sidebar-open-settings').textContent).toContain('Settings')

    cleanup()

    const zh = setup('zh')
    expect(zh.view.getByText('话题')).toBeDefined()
    expect(zh.view.getByTestId('sidebar-open-milestones').textContent).toContain('里程碑')
  })
})

describe('topicActions 契约', () => {
  it('调色板固定 12 色，非调色板颜色被拒绝', () => {
    expect(TOPIC_PALETTE).toHaveLength(12)
    expect(new Set(TOPIC_PALETTE).size).toBe(12)

    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const actions = createTopicActions({ store, bus })

    expect(() => {
      actions.setTopicColor('p', '#123456')
    }).toThrow()
    actions.setTopicColor('p', TOPIC_PALETTE[3] as string)
    expect(topicOf(store, 'p').color).toBe(TOPIC_PALETTE[3])
  })

  it('新建话题的 id 唯一、order 可比较', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const actions = createTopicActions({ store, bus })

    const first = actions.createTopic(null, 'A')
    const second = actions.createTopic(null, 'B')
    expect(first).not.toBe(second)

    const a = topicOf(store, first)
    const b = topicOf(store, second)
    expect(a.order < b.order).toBe(true)
  })
})
