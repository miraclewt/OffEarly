// T49 · 知识库文档树：把扁平的 NoteDoc[] 折成树、算路径与排序键。
//
// 为什么扁平而不是嵌套结构：文档的写操作（改名 / 存正文 / 删除 / 移动）在扁平数组里
// 都是一次「按 id 替换 / 过滤」，命令与逆元都能写成字段级还原；嵌套结构的 undo
// 要重建整棵子树，容易与并发编辑打架。树的形状由本文件的纯函数派生，不落盘。
//
// 两条容错口径（手改 vault.json 能造出来，不能崩）：
//   · 父文档不存在 / 在别的笔记本 / 形成环 → 该文档当作顶层处理，绝不从界面上消失；
//   · order 相同（历史数据）→ 退化为 createdAt、再退化为 id 的比较，排序始终确定。

import { mid } from './lexorank'
import type { NoteDoc } from './types'

export interface DocNode {
  doc: NoteDoc
  /** 缩进层级，顶层为 0。 */
  depth: number
  children: DocNode[]
}

/** 兄弟之间的排序：order → createdAt → id，保证任何数据下顺序都稳定。 */
export function compareDocs(a: NoteDoc, b: NoteDoc): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 某个笔记本的文档（按兄弟序排好），不做树化。 */
export function docsOfNotebook(docs: readonly NoteDoc[], notebookId: string): NoteDoc[] {
  return docs.filter((doc) => doc.notebookId === notebookId).sort(compareDocs)
}

/**
 * 树化：只接「父在同一个笔记本且不成环」的边，其余一律当顶层。
 * 环的检测靠「从自己往上走，看会不会回到自己」，链长最多 n，代价可忽略。
 */
export function buildDocTree(docs: readonly NoteDoc[], notebookId: string): DocNode[] {
  const siblings = docsOfNotebook(docs, notebookId)
  const byId = new Map(siblings.map((doc) => [doc.id, doc]))
  const childrenOf = new Map<string, NoteDoc[]>()
  const roots: NoteDoc[] = []

  function hasCycle(doc: NoteDoc): boolean {
    let cursor = doc.parentId
    let guard = 0
    while (cursor !== null && guard <= siblings.length) {
      if (cursor === doc.id) return true
      const parent = byId.get(cursor)
      if (parent === undefined) return false
      cursor = parent.parentId
      guard += 1
    }
    return guard > siblings.length
  }

  for (const doc of siblings) {
    const parent = doc.parentId === null ? undefined : byId.get(doc.parentId)
    if (parent === undefined || hasCycle(doc)) {
      roots.push(doc)
      continue
    }
    const bucket = childrenOf.get(parent.id)
    if (bucket === undefined) childrenOf.set(parent.id, [doc])
    else bucket.push(doc)
  }

  function wrap(doc: NoteDoc, depth: number): DocNode {
    const children = (childrenOf.get(doc.id) ?? []).sort(compareDocs).map((child) => wrap(child, depth + 1))
    return { doc, depth, children }
  }

  return roots.sort(compareDocs).map((doc) => wrap(doc, 0))
}

/** 展平成可见行（折叠的子树整体跳过）——视图渲染与键盘游走共用一份口径。 */
export function flattenDocTree(nodes: readonly DocNode[], collapsed: ReadonlySet<string>): DocNode[] {
  const out: DocNode[] = []
  function walk(list: readonly DocNode[]): void {
    for (const node of list) {
      out.push(node)
      if (!collapsed.has(node.doc.id)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** 子树内全部文档 id（含自身）。 */
export function docSubtreeIds(docs: readonly NoteDoc[], id: string): string[] {
  const out: string[] = [id]
  let frontier = [id]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const doc of docs) {
      if (doc.parentId !== null && frontier.includes(doc.parentId) && !out.includes(doc.id)) {
        out.push(doc.id)
        next.push(doc.id)
      }
    }
    frontier = next
  }
  return out
}

/** 从根到该文档的路径（含自身）；找不到父链就停在能连上的最远祖先。 */
export function docPath(docs: readonly NoteDoc[], id: string): NoteDoc[] {
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  const path: NoteDoc[] = []
  const seen = new Set<string>()
  let cursor = byId.get(id)
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    path.push(cursor)
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
  }
  return path.reverse()
}

/** 追加到兄弟序列尾部的排序键；同一父下没有任何兄弟时返回首插值。 */
export function nextDocOrder(
  docs: readonly NoteDoc[],
  notebookId: string,
  parentId: string | null,
): string {
  const siblings = docs
    .filter((doc) => doc.notebookId === notebookId && doc.parentId === parentId)
    .sort(compareDocs)
  const last = siblings[siblings.length - 1]
  return mid(last?.order, undefined)
}

/** 全文匹配：标题或正文命中（大小写不敏感）。搜索是只读派生，不改树。 */
export function matchesDocQuery(doc: NoteDoc, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (normalized === '') return true
  return doc.title.toLowerCase().includes(normalized) || doc.content.toLowerCase().includes(normalized)
}
