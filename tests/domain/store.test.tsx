// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStore } from 'zustand'

import type { Task, Vault } from '../../src/domain/types'
import { createVaultStore } from '../../src/domain/store'
import type { VaultStore } from '../../src/domain/store'
import type { LocaleSource } from '../../src/locales/i18n'
import type { AutosaveStore } from '../../src/persistence/autosave'
import { createNewVault } from '../../src/persistence/vaultRepository'

const T0 = new Date('2026-10-15T08:00:00.000Z')

function makeTask(id: string, title: string): Task {
  return {
    id,
    topicId: 'topic-1',
    title,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note: '',
    order: 'm',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    archived: false,
  }
}

function withTask(vault: Vault, id: string): Vault {
  return { ...vault, tasks: [...vault.tasks, makeTask(id, id)] }
}

function fresh(): VaultStore {
  return createVaultStore(createNewVault(T0))
}

afterEach(() => {
  cleanup()
})

describe('immutable 更新', () => {
  it('setVault 之后拿到新引用，旧 vault 对象不被修改', () => {
    const store = fresh()
    const before = store.getVault()

    const after = withTask(before, 'A')
    store.setVault(after)

    expect(store.getVault()).toBe(after)
    expect(before.tasks).toEqual([])
    expect(after.tasks).toHaveLength(1)
  })

  it('update 用函数式改法也能保持不可变', () => {
    const store = fresh()
    const before = store.getVault()

    store.update((vault) => withTask(vault, 'A'))

    expect(store.getVault().tasks).toHaveLength(1)
    expect(before.tasks).toHaveLength(0)
  })

  it('getLocale 读的是 vault.settings.locale，跟着库走', () => {
    const store = fresh()
    expect(store.getLocale()).toBe('auto')

    store.update((vault) => ({ ...vault, settings: { ...vault.settings, locale: 'en' } }))

    expect(store.getLocale()).toBe('en')
  })
})

describe('markSaved（T08 autosave 的落点）', () => {
  it('只回写 revision/updatedAt，返回新对象，内容不受影响', () => {
    const store = fresh()
    store.setVault(withTask(store.getVault(), 'A'))

    const next = store.markSaved(7, '2026-10-15T09:30:00.000Z')

    expect(next.revision).toBe(7)
    expect(next.updatedAt).toBe('2026-10-15T09:30:00.000Z')
    // 返回的必须是 Store 里真正持有的那一个：autosave 靠引用相等识别自通知
    expect(store.getVault()).toBe(next)
    expect(next.tasks.map((task) => task.id)).toEqual(['A'])
  })

  it('写盘期间的编辑不会被整体替换吞掉', () => {
    const store = fresh()
    const inFlight = store.getVault()

    store.setVault(withTask(inFlight, 'late'))

    expect(store.markSaved(1, T0.toISOString()).tasks.map((task) => task.id)).toEqual(['late'])
  })
})

describe('订阅精度', () => {
  it('无 selector 的订阅对任何变更都通知', () => {
    const store = fresh()
    let notified = 0
    store.subscribe(() => {
      notified += 1
    })

    store.setVault(withTask(store.getVault(), 'A'))
    store.update((vault) => ({ ...vault, settings: { ...vault.settings, locale: 'en' } }))

    expect(notified).toBe(2)
  })

  it('selector 订阅只在选中切片变化时通知：改 task 不惊动 topic 订阅者', () => {
    const store = fresh()
    const taskCounts: number[] = []
    const topicCounts: number[] = []
    store.subscribeSelector((state) => state.vault.tasks, (tasks) => taskCounts.push(tasks.length))
    store.subscribeSelector((state) => state.vault.topics, (topics) => topicCounts.push(topics.length))

    store.setVault(withTask(store.getVault(), 'A'))
    store.update((vault) => ({ ...vault, settings: { ...vault.settings, locale: 'en' } }))

    expect(taskCounts).toEqual([1])
    expect(topicCounts).toEqual([])
  })

  it('自定义 equals 可以按内容比较切片', () => {
    const store = fresh()
    const seen: string[] = []
    store.subscribeSelector(
      (state) => state.vault.tasks,
      (tasks) => seen.push(tasks.map((task) => task.id).join(',')),
      (a, b) => a.length === b.length && a.every((task, i) => task.id === b[i]?.id),
    )

    store.setVault(withTask(store.getVault(), 'A'))
    // 仅 v0.1 的 updatedAt 变了、任务集合相同 —— 不该通知
    store.update((vault) => ({ ...vault, revision: 99 }))

    expect(seen).toEqual(['A'])
  })

  it('退订后不再收到通知', () => {
    const store = fresh()
    let notified = 0
    const off = store.subscribeSelector(
      (state) => state.vault.tasks,
      () => {
        notified += 1
      },
    )
    off()

    store.setVault(withTask(store.getVault(), 'A'))

    expect(notified).toBe(0)
  })
})

describe('组件订阅（React）', () => {
  it('改 task 只让订阅 tasks 的组件重渲染，订阅 topics 的组件不动', () => {
    const store = fresh()
    let taskRenders = 0
    let topicRenders = 0

    function TasksPane() {
      const tasks = useStore(store, (state) => state.vault.tasks)
      taskRenders += 1
      return <span data-testid="tasks">{tasks.length}</span>
    }
    function TopicsPane() {
      const topics = useStore(store, (state) => state.vault.topics)
      topicRenders += 1
      return <span data-testid="topics">{topics.length}</span>
    }

    const view = render(
      <>
        <TasksPane />
        <TopicsPane />
      </>,
    )
    expect(taskRenders).toBe(1)
    expect(topicRenders).toBe(1)

    act(() => {
      store.setVault(withTask(store.getVault(), 'A'))
    })

    expect(view.getByTestId('tasks').textContent).toBe('1')
    expect(taskRenders).toBe(2)
    expect(topicRenders).toBe(1)
  })

  it('只改 settings 时两个列表组件都不重渲染', () => {
    const store = fresh()
    let taskRenders = 0
    let topicRenders = 0

    function TasksPane() {
      const tasks = useStore(store, (state) => state.vault.tasks)
      taskRenders += 1
      return <span>{tasks.length}</span>
    }
    function TopicsPane() {
      const topics = useStore(store, (state) => state.vault.topics)
      topicRenders += 1
      return <span>{topics.length}</span>
    }

    render(
      <>
        <TasksPane />
        <TopicsPane />
      </>,
    )

    act(() => {
      store.update((vault) => ({ ...vault, settings: { ...vault.settings, locale: 'en' } }))
    })

    expect(taskRenders).toBe(1)
    expect(topicRenders).toBe(1)
  })
})

describe('对上层端口的形状承诺', () => {
  it('VaultStore 直接满足 T04 的 LocaleSource', () => {
    const store = fresh()
    const source: LocaleSource = store

    expect(source.getLocale()).toBe('auto')
    const seen: string[] = []
    source.subscribe(() => seen.push(source.getLocale()))
    store.update((vault) => ({ ...vault, settings: { ...vault.settings, locale: 'zh' } }))

    expect(seen).toEqual(['zh'])
  })

  it('VaultStore 直接满足 T08 的 AutosaveStore（含 markSaved 返回引用）', () => {
    const store = fresh()
    const autosaveStore: AutosaveStore = store

    store.setVault(withTask(store.getVault(), 'A'))
    const saved = autosaveStore.markSaved(1, T0.toISOString())

    expect(autosaveStore.getVault()).toBe(saved)
    expect(saved.revision).toBe(1)
  })
})
