// T64 · 回收站领域：软删除的替代方案（独立条目）在真 Store + 真 CommandBus 上的行为。
//
// 这份用例锁住四条承诺：
//   ① 删除后内容真的离开了主数组（看板 / 文档树 / 搜索都看不见），但回收站里有完整副本；
//   ② 恢复回到**原位**（下标、依赖、子树顺序都不变），不是「追加到末尾」；
//   ③ 彻底删除只在回收站里生效，且当前会话仍能撤销；
//   ④ 撤销「新建」仍然走物理删除，回收站里不该多出一条垃圾条目。

import { describe, expect, it } from 'vitest'

import { applyPurgeEntry, applyRestoreEntry, applyTrashDoc, applyTrashTask } from '../../src/controllers/trashActions'
import {
  createCommandBus,
  createNoteDocCommand,
  createTaskCommand,
  deleteTaskCommand,
  purgeTrashCommand,
  restoreTrashCommand,
  trashTaskCommand,
} from '../../src/domain/commandBus'
import { VaultSchema } from '../../src/domain/schema'
import { createVaultStore } from '../../src/domain/store'
import { referencedAssetIds } from '../../src/persistence/assetStore'
import type { Dependency, NoteDoc, Notebook, Task, Topic, Vault } from '../../src/domain/types'

const NOW = '2026-10-28T09:00:00.000Z'

function topic(id: string): Topic {
  return { id, name: id, color: '#6b7cff', parentId: null, order: 'U', archived: false }
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

function link(id: string, from: string, to: string): Dependency {
  return { id, from, to, type: 'FS', lagDays: 0 }
}

function notebook(id: string): Notebook {
  return { id, name: id, order: 'U', createdAt: NOW, updatedAt: NOW }
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

function baseVault(): Vault {
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
    topics: [topic('t1')],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [notebook('nb1')],
    noteDocs: [],
    trash: [],
    whiteboards: [],
  }
}

function world(patch: Partial<Vault> = {}) {
  const store = createVaultStore({ ...baseVault(), ...patch })
  const bus = createCommandBus(store)
  return { store, bus }
}

const deps = { newId: () => 'trash-1', now: () => new Date(NOW) }

describe('T64-1 · schema 兼容', () => {
  it('旧库缺 trash 键 → 解析出空数组，其余字段不受影响', () => {
    const raw = baseVault() as unknown as Record<string, unknown>
    delete raw.trash
    const parsed = VaultSchema.parse(raw)
    expect(parsed.trash).toEqual([])
    expect(parsed.schemaVersion).toBe(1)
  })

  it('条目结构走 discriminated union：kind 不对直接判损坏', () => {
    const raw = baseVault() as unknown as Record<string, unknown>
    raw.trash = [{ id: 'x', kind: 'notebook', deletedAt: NOW }]
    expect(() => VaultSchema.parse(raw)).toThrow()
  })
})

describe('T64-2 · 任务回收', () => {
  it('删除任务：任务与两端依赖一起离开，回收站留下完整副本', () => {
    const { store, bus } = world({
      tasks: [task('a'), task('b'), task('c')],
      links: [link('l1', 'a', 'b'), link('l2', 'b', 'c')],
    })
    expect(applyTrashTask(bus, store.getVault(), 'b', deps)).toBe(true)
    const vault = store.getVault()
    expect(vault.tasks.map((item) => item.id)).toEqual(['a', 'c'])
    expect(vault.links.map((item) => item.id)).toEqual([])
    expect(vault.trash).toHaveLength(1)
    const entry = vault.trash[0]
    expect(entry?.kind).toBe('task')
    if (entry?.kind !== 'task') throw new Error('unreachable')
    expect(entry.task.id).toBe('b')
    expect(entry.index).toBe(1)
    expect(entry.links.map((item) => item.link.id)).toEqual(['l1', 'l2'])
  })

  it('恢复回到原下标，依赖按原下标插回（顺序不翻）', () => {
    const { store, bus } = world({
      tasks: [task('a'), task('b'), task('c')],
      links: [link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'a', 'c')],
    })
    const before = store.getVault()
    bus.apply(trashTaskCommand(before, 'b', { entryId: 'e1', deletedAt: NOW }))
    expect(applyRestoreEntry(bus, store.getVault(), 'e1')).toBeNull()
    expect(store.getVault()).toEqual(before)
    expect(store.getVault().trash).toEqual([])
  })

  it('另一端在这期间被单独删掉 → 恢复时不再插回悬空依赖', () => {
    const { store, bus } = world({
      tasks: [task('a'), task('b'), task('c')],
      links: [link('l1', 'a', 'b'), link('l2', 'b', 'c')],
    })
    bus.apply(trashTaskCommand(store.getVault(), 'b', { entryId: 'e1', deletedAt: NOW }))
    // a 也被删掉（物理删除，模拟「回收站里还有 b，但 a 已被彻底删」）
    bus.apply(deleteTaskCommand(store.getVault(), 'a'))
    expect(applyRestoreEntry(bus, store.getVault(), 'e1')).toBeNull()
    const restored = store.getVault()
    // 原下标 1 已越过数组末尾（`a` 在这期间被删掉了）→ 夹到末尾。
    // 任务在列内的顺序由 `order` 决定，不靠数组下标，所以这一档不需要更精细的补偿。
    expect(restored.tasks.map((item) => item.id)).toEqual(['c', 'b'])
    expect(restored.links.map((item) => item.id)).toEqual(['l2'])
  })

  it('所属话题已删除 → 拒绝恢复，且不进撤销栈', () => {
    const { store, bus } = world({ tasks: [task('a')] })
    bus.apply(trashTaskCommand(store.getVault(), 'a', { entryId: 'e1', deletedAt: NOW }))
    const depth = bus.undoDepth()
    // 模拟话题被删（vault 里的 t1 消失）
    store.setVault({ ...store.getVault(), topics: [] })
    expect(applyRestoreEntry(bus, store.getVault(), 'e1')).toBe('topic')
    expect(bus.undoDepth()).toBe(depth)
    expect(store.getVault().trash).toHaveLength(1)
    expect(() => restoreTrashCommand(store.getVault(), 'e1')).toThrow(/话题已不存在/)
  })
})

describe('T64-3 · 笔记回收（整棵子树）', () => {
  it('删父文档 → 一条条目带走整棵子树；恢复后顺序与父子关系原样', () => {
    const { store, bus } = world({
      noteDocs: [doc('d1'), doc('d2', 'd1'), doc('d3', 'd2'), doc('d4')],
    })
    const before = store.getVault()
    expect(applyTrashDoc(bus, store.getVault(), 'd1', deps)).toBe(true)
    const vault = store.getVault()
    expect(vault.noteDocs.map((item) => item.id)).toEqual(['d4'])
    expect(vault.trash).toHaveLength(1)
    const entry = vault.trash[0]
    if (entry?.kind !== 'doc') throw new Error('unreachable')
    expect(entry.rootId).toBe('d1')
    expect(entry.docs.map((item) => item.doc.id)).toEqual(['d1', 'd2', 'd3'])

    expect(applyRestoreEntry(bus, store.getVault(), entry.id)).toBeNull()
    expect(store.getVault()).toEqual(before)
  })

  it('恢复时笔记本已不存在 → 拒绝，条目留在回收站', () => {
    const { store, bus } = world({ noteDocs: [doc('d1')] })
    applyTrashDoc(bus, store.getVault(), 'd1', deps)
    store.setVault({ ...store.getVault(), notebooks: [] })
    expect(applyRestoreEntry(bus, store.getVault(), 'trash-1')).toBe('notebook')
    expect(store.getVault().trash).toHaveLength(1)
    expect(store.getVault().noteDocs).toEqual([])
  })

  it('根文档的外部父级已消失 → 恢复为顶层，子树内部关系不动', () => {
    const { store, bus } = world({ noteDocs: [doc('p'), doc('c', 'p'), doc('g', 'c')] })
    applyTrashDoc(bus, store.getVault(), 'c', deps)
    // p 随后被删掉：`c` 的 parentId 现在指向一个不存在的文档
    store.setVault({ ...store.getVault(), noteDocs: [] })
    expect(applyRestoreEntry(bus, store.getVault(), 'trash-1')).toBeNull()
    const docs = store.getVault().noteDocs
    expect(docs.map((item) => item.id)).toEqual(['c', 'g'])
    expect(docs.find((item) => item.id === 'c')?.parentId).toBeNull()
    expect(docs.find((item) => item.id === 'g')?.parentId).toBe('c')
  })
})

describe('T64-4 · 彻底删除与撤销', () => {
  it('purge 只摘条目；undo 连条目带下标一起回来', () => {
    const { store, bus } = world({ tasks: [task('a')] })
    bus.apply(trashTaskCommand(store.getVault(), 'a', { entryId: 'e1', deletedAt: NOW }))
    const trashed = store.getVault()
    expect(applyPurgeEntry(bus, store.getVault(), 'e1')).toBe(true)
    expect(store.getVault().trash).toEqual([])
    // 彻底删除不会把任务带回来：内容在删除那一刻就已经离开 vault
    expect(store.getVault().tasks).toEqual([])

    expect(bus.undo()).toBe(true)
    expect(store.getVault()).toEqual(trashed)
    // 再撤一步才回到「任务还在」——两步是两条独立的命令
    expect(bus.undo()).toBe(true)
    expect(store.getVault().tasks.map((item) => item.id)).toEqual(['a'])
    expect(store.getVault().trash).toEqual([])
  })

  it('redo 把条目再摘一次（redo 复用的就是 purge 命令本身）', () => {
    const { store, bus } = world({ tasks: [task('a')] })
    bus.apply(trashTaskCommand(store.getVault(), 'a', { entryId: 'e1', deletedAt: NOW }))
    bus.apply(purgeTrashCommand(store.getVault(), 'e1'))
    bus.undo()
    expect(store.getVault().trash).toHaveLength(1)
    expect(bus.redo()).toBe(true)
    expect(store.getVault().trash).toEqual([])
  })
})

describe('T64-5 · 与既有命令的边界', () => {
  it('撤销「新建任务」走物理删除，回收站里不多出条目', () => {
    const { store, bus } = world()
    bus.apply(createTaskCommand(task('a')))
    expect(bus.undo()).toBe(true)
    expect(store.getVault().tasks).toEqual([])
    expect(store.getVault().trash).toEqual([])
  })

  it('撤销「新建文档」同理', () => {
    const { store, bus } = world()
    bus.apply(createNoteDocCommand(doc('d1')))
    expect(bus.undo()).toBe(true)
    expect(store.getVault().noteDocs).toEqual([])
    expect(store.getVault().trash).toEqual([])
  })

  it('回收站里的图片仍算「被引用」，GC 不会把可恢复的笔记配图删掉', () => {
    const { store, bus } = world({
      noteDocs: [doc('d1', null, '![](assets/pic1.png)')],
    })
    applyTrashDoc(bus, store.getVault(), 'd1', deps)
    expect(store.getVault().noteDocs).toEqual([])
    expect(referencedAssetIds(store.getVault()).has('pic1')).toBe(true)
  })

  it('回收站里任务的正文同样算引用', () => {
    const { store, bus } = world({ tasks: [task('a', { note: '<img src="assets/pic2.png">' })] })
    applyTrashTask(bus, store.getVault(), 'a', deps)
    expect(referencedAssetIds(store.getVault()).has('pic2')).toBe(true)
  })
})
