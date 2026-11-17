// @vitest-environment jsdom
//
// T64 · 回收站面板：看得见、恢复得回、删得掉。
//
// 用真的 Store + 真的 CommandBus：面板的每个按钮最终都落到一条命令上，
// 假 bus 只能验「点了没崩」，验不了「恢复后真的回到原位」。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyPurgeEntry, applyRestoreEntry, applyTrashDoc, applyTrashTask } from '../../src/controllers/trashActions'
import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { NoteDoc, Notebook, Task, Topic, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import { TrashPanel, entryBody, entryTitle, plainPreview } from '../../src/views/TrashPanel'

const NOW = '2026-10-28T09:00:00.000Z'

function t(locale: 'zh' | 'en' = 'zh') {
  return createI18n({ getLocale: () => locale, subscribe: () => () => {} }).t
}

function topic(id = 't1'): Topic {
  return { id, name: '研发', color: '#6b7cff', parentId: null, order: 'U', archived: false }
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    topicId: 't1',
    title: `任务 ${id}`,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note: '',
    order: 'U',
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
    ...over,
  }
}

function notebook(id = 'nb1'): Notebook {
  return { id, name: '手册', order: 'U', createdAt: NOW, updatedAt: NOW }
}

function doc(id: string, parentId: string | null = null, content = ''): NoteDoc {
  return {
    id,
    notebookId: 'nb1',
    parentId,
    title: `文档 ${id}`,
    content,
    order: 'U',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function baseVault(patch: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: 'OffEarly 0.4.0',
    revision: 1,
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
    topics: [topic()],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [notebook()],
    noteDocs: [],
    trash: [],
    whiteboards: [],
    ...patch,
  }
}

function setup(patch: Partial<Vault> = {}, onOpenChange = vi.fn()) {
  const store = createVaultStore(baseVault(patch))
  const bus = createCommandBus(store)
  const view = render(
    <TrashPanel open onOpenChange={onOpenChange} store={store} bus={bus} t={t()} />,
  )
  return { store, bus, onOpenChange, view }
}

afterEach(cleanup)

describe('T64-7 · 预览纯文本', () => {
  it('去掉图片语法与 HTML 标签，只留读得懂的字', () => {
    const text = plainPreview('## 标题\n\n![](assets/a.png)\n\n<img src="assets/b.png"> 正文**加粗**')
    expect(text).toContain('标题')
    expect(text).toContain('正文')
    expect(text).toContain('加粗')
    expect(text).not.toContain('assets/')
    expect(text).not.toContain('<img')
  })

  it('超长内容截断并加省略号', () => {
    const text = plainPreview('甲'.repeat(400), 20)
    expect(text).toHaveLength(21)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('T64-8 · 列表', () => {
  it('空回收站给空态，不渲染任何条目', () => {
    setup()
    expect(screen.getByTestId('trash-empty')).toBeTruthy()
    expect(screen.getByTestId('trash-count').textContent).toContain('0')
  })

  it('删掉的笔记按删除时间倒序展示，带类型徽标与正文预览', () => {
    const store = createVaultStore(baseVault({ noteDocs: [doc('d1', null, '这是一篇会被删掉的笔记正文')] }))
    const bus = createCommandBus(store)
    applyTrashDoc(bus, store.getVault(), 'd1', { newId: () => 'e-doc', now: () => new Date(NOW) })
    render(<TrashPanel open onOpenChange={vi.fn()} store={store} bus={bus} t={t()} />)

    expect(screen.getByTestId('trash-entry-e-doc')).toBeTruthy()
    expect(screen.getByTestId('trash-entry-title-e-doc').textContent).toBe('文档 d1')
    expect(screen.getByTestId('trash-entry-preview-e-doc').textContent).toContain('会被删掉的笔记正文')
    expect(screen.getByTestId('trash-count').textContent).toContain('1')
  })

  it('删掉的子树显示「含 N 篇子文档」', () => {
    const store = createVaultStore(
      baseVault({ noteDocs: [doc('d1'), doc('d2', 'd1'), doc('d3', 'd2')] }),
    )
    const bus = createCommandBus(store)
    applyTrashDoc(bus, store.getVault(), 'd1', { newId: () => 'e-doc', now: () => new Date(NOW) })
    render(<TrashPanel open onOpenChange={vi.fn()} store={store} bus={bus} t={t()} />)
    expect(screen.getByTestId('trash-entry-e-doc').textContent).toContain('含 2 篇子文档')
  })

  it('点预览展开全文，再点收起', () => {
    const body = `${'很长的正文'.repeat(60)}`
    const store = createVaultStore(baseVault({ noteDocs: [doc('d1', null, body)] }))
    const bus = createCommandBus(store)
    applyTrashDoc(bus, store.getVault(), 'd1', { newId: () => 'e-doc', now: () => new Date(NOW) })
    render(<TrashPanel open onOpenChange={vi.fn()} store={store} bus={bus} t={t()} />)

    const preview = screen.getByTestId('trash-entry-preview-e-doc')
    expect(preview.textContent?.endsWith('…')).toBe(true)
    fireEvent.click(preview)
    expect(preview.textContent).toBe(body)
    fireEvent.click(preview)
    expect(preview.textContent?.endsWith('…')).toBe(true)
  })
})

describe('T64-9 · 恢复与彻底删除', () => {
  it('恢复任务：回到库里的原话题，条目消失', () => {
    const store = createVaultStore(baseVault({ tasks: [task('a')] }))
    const bus = createCommandBus(store)
    applyTrashTask(bus, store.getVault(), 'a', { newId: () => 'e-task', now: () => new Date(NOW) })
    render(<TrashPanel open onOpenChange={vi.fn()} store={store} bus={bus} t={t()} />)

    fireEvent.click(screen.getByTestId('trash-restore-e-task'))
    expect(store.getVault().tasks.map((item) => item.id)).toEqual(['a'])
    expect(store.getVault().trash).toEqual([])
    expect(screen.getByTestId('trash-empty')).toBeTruthy()
    expect(screen.getByTestId('trash-notice').textContent).toContain('已恢复')
  })

  it('恢复失败给出具体原因，而不是「失败了」', () => {
    const store = createVaultStore(baseVault({ tasks: [task('a')] }))
    const bus = createCommandBus(store)
    applyTrashTask(bus, store.getVault(), 'a', { newId: () => 'e-task', now: () => new Date(NOW) })
    // 话题被删掉：恢复出来也无处安放
    store.setVault({ ...store.getVault(), topics: [] })
    render(<TrashPanel open onOpenChange={vi.fn()} store={store} bus={bus} t={t()} />)

    fireEvent.click(screen.getByTestId('trash-restore-e-task'))
    expect(screen.getByTestId('trash-notice').textContent).toContain('话题已被删除')
    expect(store.getVault().trash).toHaveLength(1)
    expect(store.getVault().tasks).toEqual([])
  })

  it('彻底删除要两次点击：第一次只是变成确认态', () => {
    const store = createVaultStore(baseVault({ tasks: [task('a')] }))
    const bus = createCommandBus(store)
    applyTrashTask(bus, store.getVault(), 'a', { newId: () => 'e-task', now: () => new Date(NOW) })
    render(<TrashPanel open onOpenChange={vi.fn()} store={store} bus={bus} t={t()} />)

    fireEvent.click(screen.getByTestId('trash-purge-e-task'))
    expect(store.getVault().trash).toHaveLength(1)
    expect(screen.getByTestId('trash-purge-e-task').textContent).toContain('再点一次')

    fireEvent.click(screen.getByTestId('trash-purge-e-task'))
    expect(store.getVault().trash).toEqual([])
    expect(store.getVault().tasks).toEqual([])
  })

  it('彻底删除后仍可撤销（本次会话里），撤销回来的是同一条条目', () => {
    const store = createVaultStore(baseVault({ tasks: [task('a')] }))
    const bus = createCommandBus(store)
    applyTrashTask(bus, store.getVault(), 'a', { newId: () => 'e-task', now: () => new Date(NOW) })
    const purged = store.getVault()
    applyPurgeEntry(bus, store.getVault(), 'e-task')
    expect(store.getVault().trash).toEqual([])
    bus.undo()
    expect(store.getVault()).toEqual(purged)
  })

  it('恢复入口对同一份数据是幂等的：条目没了就报「不在回收站里」', () => {
    const store = createVaultStore(baseVault())
    const bus = createCommandBus(store)
    expect(applyRestoreEntry(bus, store.getVault(), 'nope')).toBe('missing')
    expect(bus.undoDepth()).toBe(0)
  })
})

describe('T64-10 · 条目读取口径', () => {
  it('entryTitle / entryBody 取子树根那一篇，而不是第一个子文档', () => {
    const store = createVaultStore(baseVault({ noteDocs: [doc('d1'), doc('d2', 'd1')] }))
    const bus = createCommandBus(store)
    applyTrashDoc(bus, store.getVault(), 'd1', { newId: () => 'e-doc', now: () => new Date(NOW) })
    const entry = store.getVault().trash[0]
    if (entry === undefined) throw new Error('unreachable')
    expect(entryTitle(entry)).toBe('文档 d1')
    expect(entryBody(entry)).toBe('')
  })
})
