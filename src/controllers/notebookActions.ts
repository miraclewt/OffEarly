// T49 · 知识库构造层：把「笔记本视图的一次交互」翻译成一条可 apply 的命令。
//
// 与 controllers/mindmapActions.ts 同款：视图只转发事件，命令构造与 id/时间戳在这里，
// 领域写入一律经 CommandBus（撤销栈天然覆盖「删掉一整篇文档」「删掉整个笔记本」）。
//
// 三条口径：
//   ① 兜底文案由视图注入（控制器不 import i18n）：空白标题走 fallback，而不是报错——
//      知识库允许「先建一篇空白文档再写标题」，这跟看板「空标题不建任务」是不同场景。
//   ② 排序键：新笔记本追加到 notebooks 尾部，新文档追加到**同一父级**的兄弟序列尾部。
//   ③ 正文保存只在内容真的变了时才写：debounce 之后的回声不该刷出空命令、白占撤销栈。

import { nanoid } from 'nanoid'

import {
  createNoteDocCommand,
  createNotebookCommand,
  deleteNoteDocCommand,
  deleteNotebookCommand,
  patchNoteDocCommand,
  patchNotebookCommand,
} from '../domain/commandBus'
import type { CommandBus } from '../domain/commandBus'
import { mid } from '../domain/lexorank'
import { nextDocOrder } from '../domain/notebookTree'
import type { NoteDoc, Notebook, Vault } from '../domain/types'

/** 注入 id 生成与时钟，便于测试确定化。 */
export interface NotebookActionDeps {
  newId?: () => string
  now?: () => Date
}

function genId(deps: NotebookActionDeps): string {
  return (deps.newId ?? (() => nanoid()))()
}

function stamp(deps: NotebookActionDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString()
}

function trimOr(text: string | undefined, fallback: string): string {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' ? fallback : trimmed
}

/** 新建笔记本并返回 id；空白名称走 fallbackName。 */
export function applyCreateNotebook(
  bus: CommandBus,
  vault: Vault,
  name: string | undefined,
  fallbackName: string,
  deps: NotebookActionDeps = {},
): string {
  const now = stamp(deps)
  const last = [...vault.notebooks].sort((a, b) => (a.order < b.order ? -1 : 1)).at(-1)
  const notebook: Notebook = {
    id: genId(deps),
    name: trimOr(name, fallbackName),
    order: mid(last?.order, undefined),
    createdAt: now,
    updatedAt: now,
  }
  bus.apply(createNotebookCommand(notebook))
  return notebook.id
}

export function applyRenameNotebook(
  bus: CommandBus,
  vault: Vault,
  id: string,
  name: string,
  deps: NotebookActionDeps = {},
): boolean {
  const notebook = vault.notebooks.find((candidate) => candidate.id === id)
  if (notebook === undefined) return false
  const next = name.trim()
  if (next === '' || next === notebook.name) return false
  bus.apply(patchNotebookCommand(vault, id, { name: next, updatedAt: stamp(deps) }))
  return true
}

export function applyDeleteNotebook(bus: CommandBus, vault: Vault, id: string): boolean {
  if (!vault.notebooks.some((notebook) => notebook.id === id)) return false
  bus.apply(deleteNotebookCommand(vault, id))
  return true
}

/**
 * 新建文档并返回 id。parentId 必须与 notebookId 同库（视图只传树里的父级，这里再兜一层）。
 * 父级不存在时退化为顶层——比静默丢掉一次点击好。
 */
export function applyCreateDoc(
  bus: CommandBus,
  vault: Vault,
  input: {
    notebookId: string
    parentId?: string | null
    title?: string
    /** 新建文档的初始正文（通常是空串，测试/模板场景可预填）。 */
    content?: string
    fallbackTitle: string
  },
  deps: NotebookActionDeps = {},
): string | null {
  if (!vault.notebooks.some((notebook) => notebook.id === input.notebookId)) return null
  const parent = input.parentId === undefined || input.parentId === null
    ? undefined
    : vault.noteDocs.find((doc) => doc.id === input.parentId)
  const parentId = parent !== undefined && parent.notebookId === input.notebookId ? parent.id : null
  const now = stamp(deps)
  const doc: NoteDoc = {
    id: genId(deps),
    notebookId: input.notebookId,
    parentId,
    title: trimOr(input.title, input.fallbackTitle),
    content: input.content ?? '',
    order: nextDocOrder(vault.noteDocs, input.notebookId, parentId),
    createdAt: now,
    updatedAt: now,
  }
  bus.apply(createNoteDocCommand(doc))
  return doc.id
}

export function applyRenameDoc(
  bus: CommandBus,
  vault: Vault,
  id: string,
  title: string,
  deps: NotebookActionDeps = {},
): boolean {
  const doc = vault.noteDocs.find((candidate) => candidate.id === id)
  if (doc === undefined) return false
  const next = title.trim()
  if (next === '' || next === doc.title) return false
  bus.apply(patchNoteDocCommand(vault, id, { title: next, updatedAt: stamp(deps) }))
  return true
}

/** 保存正文：内容未变则零写入（debounce 回声 / 打开即规范化都不进撤销栈）。 */
export function applySaveDocContent(
  bus: CommandBus,
  vault: Vault,
  id: string,
  content: string,
  deps: NotebookActionDeps = {},
): boolean {
  const doc = vault.noteDocs.find((candidate) => candidate.id === id)
  if (doc === undefined || doc.content === content) return false
  bus.apply(patchNoteDocCommand(vault, id, { content, updatedAt: stamp(deps) }))
  return true
}

export function applyDeleteDoc(bus: CommandBus, vault: Vault, id: string): boolean {
  if (!vault.noteDocs.some((doc) => doc.id === id)) return false
  bus.apply(deleteNoteDocCommand(vault, id))
  return true
}
