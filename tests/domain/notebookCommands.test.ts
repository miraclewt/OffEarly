// T49 · 知识库领域：schema 默认值 / 命令与逆元 / 文档树纯函数。
//
// 与 T41 导图用例同款：用真的 VaultStore + 真的 CommandBus，
// 因为「删掉整个笔记本后 Ctrl+Z 能原样回来」这种承诺只能对着撤销栈验。

import { describe, expect, it } from 'vitest'

import {
  applyCreateDoc,
  applyCreateNotebook,
  applyDeleteDoc,
  applyDeleteNotebook,
  applyRenameDoc,
  applySaveDocContent,
} from '../../src/controllers/notebookActions'
import { createCommandBus, deleteNoteDocCommand, patchNoteDocCommand, patchNotebookCommand } from '../../src/domain/commandBus'
import {
  buildDocTree,
  docPath,
  docSubtreeIds,
  flattenDocTree,
  matchesDocQuery,
  nextDocOrder,
} from '../../src/domain/notebookTree'
import { migrate } from '../../src/domain/schema'
import { createVaultStore } from '../../src/domain/store'
import type { NoteDoc, Notebook, Vault } from '../../src/domain/types'

const NOW = '2026-10-22T09:00:00.000Z'

function baseVault(): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: 'OffEarly 0.2.0',
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
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
  }
}

function notebook(id: string, order = 'U'): Notebook {
  return { id, name: `NB ${id}`, order, createdAt: NOW, updatedAt: NOW }
}

function doc(id: string, notebookId: string, parentId: string | null, order: string, content = ''): NoteDoc {
  return {
    id,
    notebookId,
    parentId,
    title: `DOC ${id}`,
    content,
    order,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function world(seed: Partial<Vault> = {}) {
  const store = createVaultStore({ ...baseVault(), ...seed })
  return { store, bus: createCommandBus(store) }
}

const deps = { newId: () => 'n1', now: () => new Date(NOW) }

describe('T49-1 · schema 默认值', () => {
  it('旧库没有 notebooks/noteDocs 键时补空数组，schemaVersion 不变', () => {
    const raw = baseVault() as unknown as Record<string, unknown>
    delete raw.notebooks
    delete raw.noteDocs
    const vault = migrate(raw)
    expect(vault.notebooks).toEqual([])
    expect(vault.noteDocs).toEqual([])
    expect(vault.schemaVersion).toBe(1)
  })
})

describe('T49-2 · 笔记本命令', () => {
  it('新建 → 改名 → 撤销依次回退，redo 再前进', () => {
    const { store, bus } = world()
    const id = applyCreateNotebook(bus, store.getVault(), '  手册  ', '未命名笔记本', deps)
    expect(store.getVault().notebooks.map((item) => item.name)).toEqual(['手册'])

    bus.apply(patchNotebookCommand(store.getVault(), id, { name: '手册 2', updatedAt: NOW }))
    expect(store.getVault().notebooks[0]?.name).toBe('手册 2')

    bus.undo()
    expect(store.getVault().notebooks[0]?.name).toBe('手册')
    bus.undo()
    expect(store.getVault().notebooks).toEqual([])
    bus.redo()
    expect(store.getVault().notebooks.map((item) => item.name)).toEqual(['手册'])
  })

  it('删除笔记本连同其文档一起消失，撤销后文档与位置一起回来', () => {
    const { store, bus } = world({
      notebooks: [notebook('n1', 'U'), notebook('n2', 'V')],
      noteDocs: [doc('d1', 'n1', null, 'U'), doc('d2', 'n2', null, 'U')],
    })
    expect(applyDeleteNotebook(bus, store.getVault(), 'n1')).toBe(true)
    expect(store.getVault().notebooks.map((item) => item.id)).toEqual(['n2'])
    expect(store.getVault().noteDocs.map((item) => item.id)).toEqual(['d2'])

    bus.undo()
    expect(store.getVault().notebooks.map((item) => item.id)).toEqual(['n1', 'n2'])
    expect(store.getVault().noteDocs.map((item) => item.id)).toEqual(['d1', 'd2'])
  })
})

describe('T49-3 · 文档命令', () => {
  it('新建文档挂到父级下，排序键落在同父兄弟尾部', () => {
    const { store, bus } = world({ notebooks: [notebook('n1')] })
    const a = applyCreateDoc(bus, store.getVault(), { notebookId: 'n1', fallbackTitle: '未命名文档' }, { ...deps, newId: () => 'd1' })
    const b = applyCreateDoc(
      bus,
      store.getVault(),
      { notebookId: 'n1', parentId: a, fallbackTitle: '未命名文档' },
      { ...deps, newId: () => 'd2' },
    )
    const c = applyCreateDoc(
      bus,
      store.getVault(),
      { notebookId: 'n1', parentId: a, fallbackTitle: '未命名文档' },
      { ...deps, newId: () => 'd3' },
    )
    expect(b).toBe('d2')
    expect(c).toBe('d3')
    const siblings = store.getVault().noteDocs.filter((item) => item.parentId === 'd1')
    expect(siblings.map((item) => item.id)).toEqual(['d2', 'd3'])
    expect(siblings[0]?.order).toBeDefined()
    expect(siblings[0]!.order < siblings[1]!.order).toBe(true)
  })

  it('父级不存在时退化为顶层而不是丢掉这次新建', () => {
    const { store, bus } = world({ notebooks: [notebook('n1')] })
    const id = applyCreateDoc(
      bus,
      store.getVault(),
      { notebookId: 'n1', parentId: 'ghost', fallbackTitle: '未命名文档' },
      deps,
    )
    expect(store.getVault().noteDocs.find((item) => item.id === id)?.parentId).toBeNull()
  })

  it('保存正文：内容未变零写入；变了可撤销回上一版', () => {
    const { store, bus } = world({ notebooks: [notebook('n1')], noteDocs: [doc('d1', 'n1', null, 'U', '旧文')] })
    expect(applySaveDocContent(bus, store.getVault(), 'd1', '旧文', deps)).toBe(false)
    expect(bus.undoDepth()).toBe(0)

    expect(applySaveDocContent(bus, store.getVault(), 'd1', '新文', deps)).toBe(true)
    expect(store.getVault().noteDocs[0]?.content).toBe('新文')
    bus.undo()
    expect(store.getVault().noteDocs[0]?.content).toBe('旧文')
  })

  it('删除父文档级联删掉整棵子树，撤销后子树与顺序原样还原', () => {
    const { store, bus } = world({
      notebooks: [notebook('n1')],
      noteDocs: [doc('d1', 'n1', null, 'U'), doc('d2', 'n1', 'd1', 'U'), doc('d3', 'n1', 'd2', 'U'), doc('d4', 'n1', null, 'V')],
    })
    expect(applyDeleteDoc(bus, store.getVault(), 'd2')).toBe(true)
    expect(store.getVault().noteDocs.map((item) => item.id)).toEqual(['d1', 'd4'])

    bus.undo()
    expect(store.getVault().noteDocs.map((item) => item.id)).toEqual(['d1', 'd2', 'd3', 'd4'])
  })

  it('把文档移进自己的子树 → 构造期抛错，撤销栈不受污染', () => {
    const { store, bus } = world({
      notebooks: [notebook('n1')],
      noteDocs: [doc('d1', 'n1', null, 'U'), doc('d2', 'n1', 'd1', 'U')],
    })
    expect(() => patchNoteDocCommand(store.getVault(), 'd1', { parentId: 'd2' })).toThrow()
    expect(bus.undoDepth()).toBe(0)
  })

  it('重命名空白不提交；改名后可撤销', () => {
    const { store, bus } = world({ notebooks: [notebook('n1')], noteDocs: [doc('d1', 'n1', null, 'U')] })
    expect(applyRenameDoc(bus, store.getVault(), 'd1', '   ', deps)).toBe(false)
    expect(applyRenameDoc(bus, store.getVault(), 'd1', '新标题', deps)).toBe(true)
    expect(store.getVault().noteDocs[0]?.title).toBe('新标题')
    bus.undo()
    expect(store.getVault().noteDocs[0]?.title).toBe('DOC d1')
  })

  it('删除文档的命令逆元带完整子树（直接构造命令也一致）', () => {
    const { store } = world({
      notebooks: [notebook('n1')],
      noteDocs: [doc('d1', 'n1', null, 'U'), doc('d2', 'n1', 'd1', 'U')],
    })
    const command = deleteNoteDocCommand(store.getVault(), 'd1')
    expect(command.inverse.type).toBe('doc.restore')
    if (command.inverse.type === 'doc.restore') {
      expect(command.inverse.payload.docs.map((entry) => entry.doc.id)).toEqual(['d1', 'd2'])
      expect(command.inverse.payload.docs.map((entry) => entry.index)).toEqual([0, 1])
    }
  })
})

describe('T49-4 · 文档树', () => {
  const docs = [
    doc('a', 'n1', null, 'U'),
    doc('b', 'n1', 'a', 'U'),
    doc('c', 'n1', 'a', 'V'),
    doc('d', 'n1', 'b', 'U'),
    doc('orphan', 'n1', 'ghost', 'W'),
    doc('other', 'n2', null, 'U'),
  ]

  it('只树化同一笔记本；父级缺失的孤儿当顶层，绝不消失', () => {
    const tree = buildDocTree(docs, 'n1')
    expect(tree.map((node) => node.doc.id)).toEqual(['a', 'orphan'])
    expect(tree[0]!.children.map((node) => node.doc.id)).toEqual(['b', 'c'])
    expect(tree[0]!.children[0]!.children.map((node) => node.doc.id)).toEqual(['d'])
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(2)
  })

  it('展平按折叠跳过子树；路径从根排到自身', () => {
    const tree = buildDocTree(docs, 'n1')
    expect(flattenDocTree(tree, new Set()).map((node) => node.doc.id)).toEqual(['a', 'b', 'd', 'c', 'orphan'])
    expect(flattenDocTree(tree, new Set(['a'])).map((node) => node.doc.id)).toEqual(['a', 'orphan'])
    expect(docPath(docs, 'd').map((item) => item.id)).toEqual(['a', 'b', 'd'])
  })

  it('环数据不崩：环上的文档退化为顶层', () => {
    const cyclic = [doc('x', 'n1', 'y', 'U'), doc('y', 'n1', 'x', 'V')]
    const tree = buildDocTree(cyclic, 'n1')
    expect(tree.map((node) => node.doc.id).sort()).toEqual(['x', 'y'])
  })

  it('子树的 id 集合、兄弟尾部排序键、全文匹配', () => {
    expect(docSubtreeIds(docs, 'a').sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(nextDocOrder(docs, 'n1', null) > 'U').toBe(true)
    expect(matchesDocQuery(docs[0]!, '  doc a ')).toBe(true)
    expect(matchesDocQuery({ ...docs[0]!, content: '关于发布流程' }, '发布')).toBe(true)
    expect(matchesDocQuery(docs[0]!, 'zzz')).toBe(false)
  })
})
