// CommandBus：唯一写入口 + 撤销栈（spec 3「三条硬规则」第 2 条）。
//
// 任何变更都表达为 `Command { type, payload, inverse }`：
//   apply(cmd) -> 用 reducer 算出新 vault -> setVault -> 压 undo 栈 -> 清 redo 栈
//   undo()     -> 应用栈顶命令的 inverse，把命令挪到 redo 栈
//   redo()     -> 重新应用命令，把它挪回 undo 栈
//
// inverse 是「另一个 Mutation」而不是嵌套 Command —— 逆元再没有逆元，
// 这样 undo 的语义唯一，栈里也不会出现无限嵌套。
//
// dirty 不在这里标记：Store 一变，T08 的 Autosave 就通过 store.subscribe 进入 dirty 态。
// 撤销栈与 dirty 因此天然对齐，不存在「改了但没标脏」的野写路径。

import type {
  Dependency,
  MindMap,
  MindNode,
  NoteDoc,
  Notebook,
  Settings,
  Status,
  Task,
  TrashDocEntry,
  TrashEntry,
  TrashTaskEntry,
  Vault,
} from './types'
import {
  findNode,
  findParent,
  insertChild,
  isDescendant,
  mapTree,
  removeNode,
} from './mindmapTree'
import { docSubtreeIds } from './notebookTree'
import type { VaultStore } from './store'

/** 任务的可改字段；id 与 createdAt 不可改。 */
export type TaskPatch = Partial<Omit<Task, 'id' | 'createdAt'>>
export type SettingsPatch = Partial<Settings>
/** 依赖的可改字段：类型 / lag / 备注（id 与两端 from、to 不可改——改端点等于换一条链）。 */
export type LinkPatch = Partial<Omit<Dependency, 'id' | 'from' | 'to'>>
// T41 追加：图级只改 name/updatedAt（root 走 node.* 命令，order/createdAt 不进 patch）；
// 节点级只改 text/folded（id/order/children 由 add/delete/move 命令负责）。
export type MapPatch = Partial<Omit<MindMap, 'id' | 'createdAt' | 'root' | 'order'>>
export type NodePatch = Partial<Omit<MindNode, 'id' | 'order' | 'children'>>
// T49：笔记本只改 name/updatedAt；文档可改标题 / 正文 / 父级 / 归属 / 排序（id 与 createdAt 不可改）。
export type NotebookPatch = Partial<Omit<Notebook, 'id' | 'createdAt' | 'order'>>
export type NoteDocPatch = Partial<Omit<NoteDoc, 'id' | 'createdAt'>>

export interface MutationPayloads {
  'task.create': { task: Task; index: number | null }
  'task.delete': { id: string }
  /**
   * T55：删除任务会连带摘掉两端指向它的依赖，所以逆元不能只是 task.create——
   * 那样 undo 之后任务回来了、依赖却永久没了。restore 携完整任务体、原下标，
   * 以及被摘掉的那些依赖（同样带原下标），一次逆元把三者都放回原位。
   */
  'task.restore': { task: Task; index: number; links: { link: Dependency; index: number }[] }
  'task.patch': { id: string; patch: TaskPatch }
  'task.move': { id: string; status: Status; order: string }
  'settings.patch': { patch: SettingsPatch }
  // T62 · 标签是自由文本，改一次名要动所有用到它的任务。逐条 patch 会刷出 N 条撤销项，
  // 所以单开一条批量命令：逆元携「受影响任务的原始 tags」，undo 一次全回来。
  'tag.rewrite': { from: string; to: string | null }
  // filterTags：改写前 settings.lastFilter.tags 的原值（仅在筛选里挂着这个标签时出现）。
  // 省略 = 筛选没被这次改名碰到，undo 不要动它。
  'tag.restore': { tasks: { id: string; tags: string[] }[]; filterTags?: string[] }
  // T17 追加：依赖链命令（TaskDrawer 的依赖编辑写入口）。
  // link.create 的 index 与 task.create 同义：deleteLinkCommand 的逆元靠它把链接还原回原下标。
  'link.create': { link: Dependency; index: number | null }
  'link.delete': { id: string }
  'link.patch': { id: string; patch: LinkPatch }
  // T41 追加：思维导图命令（spec 3 表格）。node.move 的 index 按「remove 之后」的兄弟序列解释，
  // 同父换序不补偿位移；合法性由命令工厂在构造期拦截（根恒在、不移入自身子树），reducer 直接执行。
  'mindmap.create': { map: MindMap; index: number | null }
  'mindmap.delete': { id: string }
  'mindmap.patch': { id: string; patch: MapPatch }
  'mindmap.node.add': { mapId: string; parentId: string; node: MindNode; index: number | null }
  'mindmap.node.delete': { mapId: string; nodeId: string }
  'mindmap.node.patch': { mapId: string; nodeId: string; patch: NodePatch }
  'mindmap.node.move': { mapId: string; nodeId: string; newParentId: string; index: number }
  // T49 追加：知识库命令。删除是级联的（笔记本删文档、文档删子树），
  // 所以逆元必须携完整被删对象与它们的原始下标——undo 后连数组位置一起还原。
  'notebook.create': { notebook: Notebook; index: number | null }
  'notebook.patch': { id: string; patch: NotebookPatch }
  'notebook.delete': { id: string }
  'notebook.restore': {
    notebook: Notebook
    index: number
    docs: { doc: NoteDoc; index: number }[]
  }
  'doc.create': { doc: NoteDoc; index: number | null }
  'doc.patch': { id: string; patch: NoteDocPatch }
  'doc.delete': { id: string }
  'doc.restore': { docs: { doc: NoteDoc; index: number }[] }
  /**
   * T64 · 回收站。四个 mutation 两两成对，每一对都做完「数组 + 内容」两侧的改动，
   * 因此任何一步都能被一条逆元精确回退：
   *   trash.add     删除 → 内容出库、条目进回收站      ↔ trash.restore 条目出站、内容回库
   *   trash.purge   条目出站（内容早已不在）           ↔ trash.reinsert 条目回站（不进内容）
   *
   * `index` 一律是**当时在数组里的下标**：删除时 trash 追加（null），恢复/回插时用记下的值，
   * 这样 undo / redo 不会把条目或任务越挪越乱。
   */
  'trash.add': { entry: TrashEntry; index: number | null }
  'trash.restore': { entry: TrashEntry }
  'trash.purge': { entry: TrashEntry; index: number }
  'trash.reinsert': { entry: TrashEntry; index: number }
}

export type MutationType = keyof MutationPayloads

/**
 * T53 · 撤销栈容量上限。栈里每条命令都携着自己的逆元（笔记正文的逆 patch 带一整段
 * Markdown），拖拽与连续输入都会进栈，长会话不刷新会一直涨。200 对个人工具足够深，
 * 正常使用到不了；触顶时丢最旧的一条（见 `createCommandBus` 的 `trim`）。
 */
export const COMMAND_STACK_LIMIT = 200

/** 一次事实变更（无逆元），undo/redo 的统一执行单位。 */
export type Mutation = {
  [K in MutationType]: { type: K; payload: MutationPayloads[K] }
}[MutationType]

/** 用户级命令：变更 + 它的逆变更。 */
export type Command = {
  [K in MutationType]: { type: K; payload: MutationPayloads[K]; inverse: Mutation }
}[MutationType]

export interface CommandBus {
  apply(command: Command): void
  /** 回到 apply 之前；空栈返回 false。 */
  undo(): boolean
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean
  undoDepth(): number
  redoDepth(): number
  /** 栈深变化通知（顶栏撤销/重做按钮的禁用态）。 */
  subscribe(listener: () => void): () => void
  clear(): void
}

function findTask(vault: Vault, id: string): Task {
  const task = vault.tasks.find((candidate) => candidate.id === id)
  if (task === undefined) throw new Error(`commandBus: 任务不存在（${id}）`)
  return task
}

function findLink(vault: Vault, id: string): Dependency {
  const link = vault.links.find((candidate) => candidate.id === id)
  if (link === undefined) throw new Error(`commandBus: 依赖不存在（${id}）`)
  return link
}

/**
 * spec 4.2 的联动约束：status=done 时 progress 强制 100。
 * 目标状态取 patch 里的 status，没给就用任务当前状态（已 done 的任务改进度同样被压到 100）。
 */
function normalizePatch(task: Task, patch: TaskPatch): TaskPatch {
  const status = patch.status ?? task.status
  if (status === 'done') return { ...patch, progress: 100 }
  return patch
}

function patchedTask(task: Task, patch: TaskPatch): Task {
  return { ...task, ...normalizePatch(task, patch) }
}

function mapTask(vault: Vault, id: string, recipe: (task: Task) => Task): Vault {
  findTask(vault, id)
  return { ...vault, tasks: vault.tasks.map((task) => (task.id === id ? recipe(task) : task)) }
}

/**
 * 标签列表的一次改写：`from` 换成 `to`（null = 删除），结果去重。
 * 任务上的 tags 与筛选里的 tags 共用这一段——两处口径必须一致，否则改名后
 * 「任务上有新标签」而「筛选还挂着旧标签」。
 */
function rewriteTagList(tags: readonly string[], from: string, to: string | null): string[] {
  const next: string[] = []
  for (const tag of tags) {
    const value = tag === from ? to : tag
    if (value === null) continue
    if (!next.includes(value)) next.push(value)
  }
  return next
}

/** 逆 patch：把 patch 覆盖到的每个字段还原成任务当前的值。 */
function invertPatch(task: Task, patch: TaskPatch): TaskPatch {
  const source = task as unknown as Record<string, unknown>
  const inverse: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) inverse[key] = source[key]
  return inverse as TaskPatch
}

/** 逆 patch（依赖版）：字段级还原，与 invertPatch 同一手法——undo 语义唯一性的关键。 */
function invertLinkPatch(link: Dependency, patch: LinkPatch): LinkPatch {
  const source = link as unknown as Record<string, unknown>
  const inverse: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) inverse[key] = source[key]
  return inverse as LinkPatch
}

function mapLink(vault: Vault, id: string, recipe: (link: Dependency) => Dependency): Vault {
  findLink(vault, id)
  return { ...vault, links: vault.links.map((link) => (link.id === id ? recipe(link) : link)) }
}

function findMap(vault: Vault, id: string): MindMap {
  const map = vault.mindmaps.find((candidate) => candidate.id === id)
  if (map === undefined) throw new Error(`commandBus: 思维导图不存在（${id}）`)
  return map
}

/** 节点定位走 mindmapTree.findNode；未命中直接抛错（工厂与 reducer 共用同一失败语义）。 */
function findMapNode(map: MindMap, id: string): MindNode {
  const node = findNode(map.root, id)
  if (node === null) throw new Error(`commandBus: 思维导图节点不存在（${id}）`)
  return node
}

function mapMind(vault: Vault, id: string, recipe: (map: MindMap) => MindMap): Vault {
  findMap(vault, id)
  return { ...vault, mindmaps: vault.mindmaps.map((map) => (map.id === id ? recipe(map) : map)) }
}

/** 逆 patch（图级）：字段级还原，与 invertPatch / invertLinkPatch 同一手法。 */
function invertMapPatch(map: MindMap, patch: MapPatch): MapPatch {
  const source = map as unknown as Record<string, unknown>
  const inverse: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) inverse[key] = source[key]
  return inverse as MapPatch
}

/** 逆 patch（节点级）：字段级还原（text/folded），undo 语义唯一性的关键。 */
function invertNodePatch(node: MindNode, patch: NodePatch): NodePatch {
  const source = node as unknown as Record<string, unknown>
  const inverse: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) inverse[key] = source[key]
  return inverse as NodePatch
}

// ── T49 · 知识库：定位 / 逆 patch / 批量插入 ─────────────────────────────

function findNotebook(vault: Vault, id: string): Notebook {
  const notebook = vault.notebooks.find((candidate) => candidate.id === id)
  if (notebook === undefined) throw new Error(`commandBus: 笔记本不存在（${id}）`)
  return notebook
}

function findNoteDoc(vault: Vault, id: string): NoteDoc {
  const doc = vault.noteDocs.find((candidate) => candidate.id === id)
  if (doc === undefined) throw new Error(`commandBus: 文档不存在（${id}）`)
  return doc
}

function invertNotebookPatch(notebook: Notebook, patch: NotebookPatch): NotebookPatch {
  const source = notebook as unknown as Record<string, unknown>
  const inverse: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) inverse[key] = source[key]
  return inverse as NotebookPatch
}

function invertNoteDocPatch(doc: NoteDoc, patch: NoteDocPatch): NoteDocPatch {
  const source = doc as unknown as Record<string, unknown>
  const inverse: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) inverse[key] = source[key]
  return inverse as NoteDocPatch
}

function mapNotebook(vault: Vault, id: string, recipe: (notebook: Notebook) => Notebook): Vault {
  findNotebook(vault, id)
  return {
    ...vault,
    notebooks: vault.notebooks.map((notebook) => (notebook.id === id ? recipe(notebook) : notebook)),
  }
}

function mapNoteDoc(vault: Vault, id: string, recipe: (doc: NoteDoc) => NoteDoc): Vault {
  findNoteDoc(vault, id)
  return {
    ...vault,
    noteDocs: vault.noteDocs.map((doc) => (doc.id === id ? recipe(doc) : doc)),
  }
}

/** 批量还原：按记录的下标升序 splice，多文档 undo 后顺序与删除前一致。 */
function insertNoteDocs(vault: Vault, entries: readonly { doc: NoteDoc; index: number }[]): Vault {
  const noteDocs = [...vault.noteDocs]
  for (const entry of [...entries].sort((a, b) => a.index - b.index)) {
    noteDocs.splice(Math.min(entry.index, noteDocs.length), 0, entry.doc)
  }
  return { ...vault, noteDocs }
}

/** 纯函数：命令（或逆命令）作用在 vault 上的结果。不合法输入直接抛错，不静默兜底。 */
export function reduce(vault: Vault, mutation: Mutation): Vault {
  switch (mutation.type) {
    case 'task.create': {
      const { task, index } = mutation.payload
      const tasks = [...vault.tasks]
      tasks.splice(index ?? tasks.length, 0, task)
      return { ...vault, tasks }
    }
    case 'task.delete': {
      const { id } = mutation.payload
      findTask(vault, id)
      // T55：任务没了，两端还指着它的依赖必须一起摘掉——否则图上留下指向空节点的箭头，
      // 关键路径与阻塞标记都会算到不存在的任务上。逆元 task.restore 负责把它们放回去。
      return {
        ...vault,
        tasks: vault.tasks.filter((task) => task.id !== id),
        links: vault.links.filter((link) => link.from !== id && link.to !== id),
      }
    }
    case 'task.restore': {
      const { task, index, links } = mutation.payload
      const tasks = [...vault.tasks]
      tasks.splice(index, 0, task)
      const restored = [...vault.links]
      // 升序插回：每次插入都会把后面的元素右移，按原下标从小到大依次插才能精确复原来位置。
      for (const entry of [...links].sort((a, b) => a.index - b.index)) {
        restored.splice(entry.index, 0, entry.link)
      }
      return { ...vault, tasks, links: restored }
    }
    case 'task.patch': {
      const { id, patch } = mutation.payload
      return mapTask(vault, id, (task) => patchedTask(task, patch))
    }
    case 'tag.rewrite': {
      const { from, to } = mutation.payload
      const tasks = vault.tasks.map((task) => {
        if (!task.tags.includes(from)) return task
        // 原位替换：标签顺序是用户自己排的，不要因为改名把它挪到末尾
        return { ...task, tags: rewriteTagList(task.tags, from, to) }
      })
      // 上一次筛选里若还挂着被改名/删掉的标签，会立刻变成「零命中」——同一命令里改掉，
      // 这样一次撤销能把任务和筛选一起还原（拆成两条命令就得按两次 Ctrl+Z）。
      const filter = vault.settings.lastFilter
      if (filter === null || !filter.tags.includes(from)) return { ...vault, tasks }
      return {
        ...vault,
        tasks,
        settings: { ...vault.settings, lastFilter: { ...filter, tags: rewriteTagList(filter.tags, from, to) } },
      }
    }
    case 'tag.restore': {
      const { tasks: entries, filterTags } = mutation.payload
      const restore = new Map(entries.map((entry) => [entry.id, entry.tags]))
      const tasks = vault.tasks.map((task) => {
        const tags = restore.get(task.id)
        return tags === undefined ? task : { ...task, tags }
      })
      const filter = vault.settings.lastFilter
      if (filterTags === undefined || filter === null) return { ...vault, tasks }
      return { ...vault, tasks, settings: { ...vault.settings, lastFilter: { ...filter, tags: filterTags } } }
    }
    case 'task.move': {
      const { id, status, order } = mutation.payload
      return mapTask(vault, id, (task) => patchedTask(task, { status, order }))
    }
    case 'settings.patch':
      return { ...vault, settings: { ...vault.settings, ...mutation.payload.patch } }
    case 'link.create': {
      const { link, index } = mutation.payload
      const links = [...vault.links]
      links.splice(index ?? links.length, 0, link)
      return { ...vault, links }
    }
    case 'link.delete': {
      const { id } = mutation.payload
      findLink(vault, id)
      return { ...vault, links: vault.links.filter((link) => link.id !== id) }
    }
    case 'link.patch': {
      const { id, patch } = mutation.payload
      return mapLink(vault, id, (link) => ({ ...link, ...patch }))
    }
    case 'mindmap.create': {
      const { map, index } = mutation.payload
      const mindmaps = [...vault.mindmaps]
      mindmaps.splice(index ?? mindmaps.length, 0, map)
      return { ...vault, mindmaps }
    }
    case 'mindmap.delete': {
      const { id } = mutation.payload
      findMap(vault, id)
      return { ...vault, mindmaps: vault.mindmaps.filter((map) => map.id !== id) }
    }
    case 'mindmap.patch': {
      const { id, patch } = mutation.payload
      return mapMind(vault, id, (map) => ({ ...map, ...patch }))
    }
    case 'mindmap.node.add': {
      const { mapId, parentId, node, index } = mutation.payload
      return mapMind(vault, mapId, (map) => ({
        ...map,
        root: insertChild(map.root, parentId, node, index),
      }))
    }
    case 'mindmap.node.delete': {
      const { mapId, nodeId } = mutation.payload
      return mapMind(vault, mapId, (map) => ({ ...map, root: removeNode(map.root, nodeId).next }))
    }
    case 'mindmap.node.patch': {
      const { mapId, nodeId, patch } = mutation.payload
      return mapMind(vault, mapId, (map) => ({
        ...map,
        root: mapTree(map.root, nodeId, (node) => ({ ...node, ...patch })),
      }))
    }
    case 'mindmap.node.move': {
      // 命令工厂已完成合法性检查（根不移、目标不在自身子树内），这里直接「remove 后 insert」。
      // index 按移除后的兄弟序列解释——同父换序不补偿位移（Task 47 拖拽按此对齐）。
      const { mapId, nodeId, newParentId, index } = mutation.payload
      return mapMind(vault, mapId, (map) => {
        const { next, removed } = removeNode(map.root, nodeId)
        return { ...map, root: insertChild(next, newParentId, removed, index) }
      })
    }
    case 'notebook.create': {
      const { notebook, index } = mutation.payload
      const notebooks = [...vault.notebooks]
      notebooks.splice(index ?? notebooks.length, 0, notebook)
      return { ...vault, notebooks }
    }
    case 'notebook.patch': {
      const { id, patch } = mutation.payload
      return mapNotebook(vault, id, (notebook) => ({ ...notebook, ...patch }))
    }
    case 'notebook.delete': {
      const { id } = mutation.payload
      findNotebook(vault, id)
      return {
        ...vault,
        notebooks: vault.notebooks.filter((notebook) => notebook.id !== id),
        noteDocs: vault.noteDocs.filter((doc) => doc.notebookId !== id),
      }
    }
    case 'notebook.restore': {
      const { notebook, index, docs } = mutation.payload
      const notebooks = [...vault.notebooks]
      notebooks.splice(Math.min(index, notebooks.length), 0, notebook)
      return insertNoteDocs({ ...vault, notebooks }, docs)
    }
    case 'doc.create': {
      const { doc, index } = mutation.payload
      if (!vault.notebooks.some((notebook) => notebook.id === doc.notebookId)) {
        throw new Error(`commandBus: 笔记本不存在（${doc.notebookId}）`)
      }
      const noteDocs = [...vault.noteDocs]
      noteDocs.splice(index ?? noteDocs.length, 0, doc)
      return { ...vault, noteDocs }
    }
    case 'doc.patch': {
      const { id, patch } = mutation.payload
      // 防环：父级落在自己或自己的子树里会造出「看不见的文档」（树化时被当顶层，但仍不可接受）
      if (patch.parentId !== undefined && patch.parentId !== null) {
        if (docSubtreeIds(vault.noteDocs, id).includes(patch.parentId)) {
          throw new Error('commandBus: 文档不能移动到自己的子树里')
        }
      }
      return mapNoteDoc(vault, id, (doc) => ({ ...doc, ...patch }))
    }
    case 'doc.delete': {
      const { id } = mutation.payload
      findNoteDoc(vault, id)
      const doomed = new Set(docSubtreeIds(vault.noteDocs, id))
      return { ...vault, noteDocs: vault.noteDocs.filter((doc) => !doomed.has(doc.id)) }
    }
    case 'doc.restore':
      return insertNoteDocs(vault, mutation.payload.docs)
    case 'trash.add': {
      const { entry, index } = mutation.payload
      const trash = [...vault.trash]
      trash.splice(Math.min(index ?? trash.length, trash.length), 0, entry)
      if (entry.kind === 'task') {
        // 与 task.delete 同一级联口径：两端指向它的依赖一起摘掉（条目里已冻结了这些依赖）
        return {
          ...vault,
          tasks: vault.tasks.filter((task) => task.id !== entry.task.id),
          links: vault.links.filter(
            (link) => link.from !== entry.task.id && link.to !== entry.task.id,
          ),
          trash,
        }
      }
      const doomed = new Set(entry.docs.map((item) => item.doc.id))
      return { ...vault, noteDocs: vault.noteDocs.filter((doc) => !doomed.has(doc.id)), trash }
    }
    case 'trash.restore': {
      const entry = mutation.payload.entry
      if (!vault.trash.some((candidate) => candidate.id === entry.id)) {
        throw new Error(`commandBus: 回收站条目不存在（${entry.id}）`)
      }
      const trash = vault.trash.filter((candidate) => candidate.id !== entry.id)
      if (entry.kind === 'task') {
        const tasks = [...vault.tasks]
        tasks.splice(Math.min(entry.index, tasks.length), 0, entry.task)
        const alive = new Set(tasks.map((task) => task.id))
        const links = [...vault.links]
        // 只在两个端点都还在时才插回：另一端可能在这期间被单独删掉了，
        // 插回一条悬空依赖会让甘特图指向不存在的任务。
        const back = entry.links
          .filter((item) => alive.has(item.link.from) && alive.has(item.link.to))
          .sort((a, b) => a.index - b.index)
        for (const item of back) links.splice(Math.min(item.index, links.length), 0, item.link)
        return { ...vault, tasks, links, trash }
      }
      return insertNoteDocs({ ...vault, trash }, entry.docs)
    }
    case 'trash.purge': {
      const { entry } = mutation.payload
      return { ...vault, trash: vault.trash.filter((candidate) => candidate.id !== entry.id) }
    }
    case 'trash.reinsert': {
      const { entry, index } = mutation.payload
      const trash = [...vault.trash]
      trash.splice(Math.min(index, trash.length), 0, entry)
      return { ...vault, trash }
    }
  }
}

/** 追加一个新任务；逆元是按 id 删除。 */
export function createTaskCommand(task: Task): Command {
  return {
    type: 'task.create',
    payload: { task, index: null },
    inverse: { type: 'task.delete', payload: { id: task.id } },
  }
}

/**
 * 删除任务；逆元带完整任务体、原下标，以及两端指向它的依赖（各带原下标）。
 * undo 后任务回到数组原位置、被摘掉的依赖也回到各自原位置——不是简单地追加到尾部。
 */
export function deleteTaskCommand(vault: Vault, id: string): Command {
  const task = findTask(vault, id)
  const index = vault.tasks.findIndex((candidate) => candidate.id === id)
  const links = vault.links
    .map((link, position) => ({ link, index: position }))
    .filter((entry) => entry.link.from === id || entry.link.to === id)
  return {
    type: 'task.delete',
    payload: { id },
    inverse: { type: 'task.restore', payload: { task, index, links } },
  }
}

export function patchTaskCommand(vault: Vault, id: string, patch: TaskPatch): Command {
  const task = findTask(vault, id)
  if (Object.keys(patch).length === 0) throw new Error('commandBus: 空 patch 不构成变更')
  const effective = normalizePatch(task, patch)
  return {
    type: 'task.patch',
    payload: { id, patch: effective },
    inverse: { type: 'task.patch', payload: { id, patch: invertPatch(task, effective) } },
  }
}

/**
 * 换列 / 同列换序。逆元用 patch 而不是另一个 move：目标列是 done 时 progress 会被抬到 100，
 * 只把 status/order 换回去会残留 100 的进度，所以逆元必须连进度一起还原。
 */
export function moveTaskCommand(
  vault: Vault,
  id: string,
  target: { status: Status; order: string },
): Command {
  const task = findTask(vault, id)
  return {
    type: 'task.move',
    payload: { id, status: target.status, order: target.order },
    inverse: {
      type: 'task.patch',
      payload: {
        id,
        patch: { status: task.status, order: task.order, progress: task.progress },
      },
    },
  }
}

/**
 * T62 · 标签批量改写：`to = null` 即删除，`to` 指向已存在的标签即合并。
 * 没有任何任务用到这个标签时抛错——空命令不该进撤销栈。
 * 上一次筛选若挂着这个标签，逆元一并带走它改写前的 tags（一次撤销整体回退）。
 */
export function rewriteTagCommand(vault: Vault, from: string, to: string | null): Command {
  const affected = vault.tasks
    .filter((task) => task.tags.includes(from))
    .map((task) => ({ id: task.id, tags: [...task.tags] }))
  if (affected.length === 0) throw new Error(`commandBus: 没有任务使用标签（${from}）`)
  const filter = vault.settings.lastFilter
  const filterTags = filter !== null && filter.tags.includes(from) ? [...filter.tags] : undefined
  return {
    type: 'tag.rewrite',
    payload: { from, to },
    inverse: {
      type: 'tag.restore',
      payload: filterTags === undefined ? { tasks: affected } : { tasks: affected, filterTags },
    },
  }
}

export function patchSettingsCommand(vault: Vault, patch: SettingsPatch): Command {
  if (Object.keys(patch).length === 0) throw new Error('commandBus: 空 patch 不构成变更')
  const source = vault.settings as unknown as Record<string, unknown>
  const inverse: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) inverse[key] = source[key]
  return {
    type: 'settings.patch',
    payload: { patch },
    inverse: { type: 'settings.patch', payload: { patch: inverse as SettingsPatch } },
  }
}

// ── T17 · link 命令（依赖编辑写入口；task.* / settings.patch 行为不变） ──────────

/** 新建一条依赖链；逆元是按 id 删除。index 省略即追加到数组尾部。 */
export function createLinkCommand(link: Dependency, index: number | null = null): Command {
  return {
    type: 'link.create',
    payload: { link, index },
    inverse: { type: 'link.delete', payload: { id: link.id } },
  }
}

/** 删除依赖；逆元带完整 link 体与原下标，undo 后连数组位置一起还原（参照 deleteTaskCommand）。 */
export function deleteLinkCommand(vault: Vault, id: string): Command {
  const link = findLink(vault, id)
  const index = vault.links.findIndex((candidate) => candidate.id === id)
  return {
    type: 'link.delete',
    payload: { id },
    inverse: { type: 'link.create', payload: { link, index } },
  }
}

/** 改依赖类型 / lag / 备注；逆元走字段级还原（参照 patchTaskCommand / invertPatch）。 */
export function patchLinkCommand(vault: Vault, id: string, patch: LinkPatch): Command {
  const link = findLink(vault, id)
  if (Object.keys(patch).length === 0) throw new Error('commandBus: 空 patch 不构成变更')
  return {
    type: 'link.patch',
    payload: { id, patch },
    inverse: { type: 'link.patch', payload: { id, patch: invertLinkPatch(link, patch) } },
  }
}

// ── T41 · 思维导图命令（图与节点树写入口；task.* / link.* / settings.patch 行为不变） ──

/** 新建一张图（追加到列表尾部）；逆元按 id 删。 */
export function createMapCommand(map: MindMap): Command {
  return {
    type: 'mindmap.create',
    payload: { map, index: null },
    inverse: { type: 'mindmap.delete', payload: { id: map.id } },
  }
}

/** 删除一张图；逆元带完整图体与原下标，undo 后连列表位置一起还原（参照 deleteTaskCommand）。 */
export function deleteMapCommand(vault: Vault, id: string): Command {
  const map = findMap(vault, id)
  const index = vault.mindmaps.findIndex((candidate) => candidate.id === id)
  return {
    type: 'mindmap.delete',
    payload: { id },
    inverse: { type: 'mindmap.create', payload: { map, index } },
  }
}

/** 改图名 / 时间戳；逆元走字段级还原（参照 patchLinkCommand）。 */
export function patchMapCommand(vault: Vault, id: string, patch: MapPatch): Command {
  const map = findMap(vault, id)
  if (Object.keys(patch).length === 0) throw new Error('commandBus: 空 patch 不构成变更')
  return {
    type: 'mindmap.patch',
    payload: { id, patch },
    inverse: { type: 'mindmap.patch', payload: { id, patch: invertMapPatch(map, patch) } },
  }
}

/** 给 parentId 节点追加子树；index=null 落尾部。逆元按 id 删节点。 */
export function addNodeCommand(
  mapId: string,
  parentId: string,
  node: MindNode,
  index: number | null,
): Command {
  return {
    type: 'mindmap.node.add',
    payload: { mapId, parentId, node, index },
    inverse: { type: 'mindmap.node.delete', payload: { mapId, nodeId: node.id } },
  }
}

/**
 * 删节点（连子树）；根不可删——构造期即抛错，非法命令不进 undo 栈。
 * 逆元现场取 parent/index，携完整子树走 node.add 复原位置（参照 deleteTaskCommand）。
 */
export function deleteNodeCommand(vault: Vault, mapId: string, nodeId: string): Command {
  const map = findMap(vault, mapId)
  if (map.root.id === nodeId) throw new Error('commandBus: 思维导图根节点不可删除')
  const node = findMapNode(map, nodeId)
  const located = findParent(map.root, nodeId)
  if (located === null) throw new Error(`commandBus: 思维导图节点不存在（${nodeId}）`)
  const { parent, index } = located
  return {
    type: 'mindmap.node.delete',
    payload: { mapId, nodeId },
    inverse: { type: 'mindmap.node.add', payload: { mapId, parentId: parent.id, node, index } },
  }
}

/** 改 text / 切 folded；逆元走字段级还原（参照 patchMapCommand）。 */
export function patchNodeCommand(
  vault: Vault,
  mapId: string,
  nodeId: string,
  patch: NodePatch,
): Command {
  const map = findMap(vault, mapId)
  const node = findMapNode(map, nodeId)
  if (Object.keys(patch).length === 0) throw new Error('commandBus: 空 patch 不构成变更')
  return {
    type: 'mindmap.node.patch',
    payload: { mapId, nodeId, patch },
    inverse: {
      type: 'mindmap.node.patch',
      payload: { mapId, nodeId, patch: invertNodePatch(node, patch) },
    },
  }
}

/**
 * 跨父移动（含同父换序）。构造期对着 vault 现状拦截三种非法：移根、移入自身、移入自身子树
 * ——抛错发生在命令入栈之前，undo 栈不会被非法命令污染。
 * 逆元是携原 parent/index 的 node.move；index 与 forward 同义（remove 后解释）。
 */
export function moveNodeCommand(
  vault: Vault,
  mapId: string,
  nodeId: string,
  newParentId: string,
  index: number,
): Command {
  const map = findMap(vault, mapId)
  if (map.root.id === nodeId) throw new Error('commandBus: 思维导图根节点不可移动')
  if (newParentId === nodeId) throw new Error('commandBus: 节点不能移入自身')
  findMapNode(map, nodeId)
  findMapNode(map, newParentId)
  if (isDescendant(map.root, nodeId, newParentId)) {
    throw new Error('commandBus: 节点不能移入自己的子树（布局会出现环）')
  }
  const located = findParent(map.root, nodeId)
  if (located === null) throw new Error(`commandBus: 思维导图节点不存在（${nodeId}）`)
  return {
    type: 'mindmap.node.move',
    payload: { mapId, nodeId, newParentId, index },
    inverse: {
      type: 'mindmap.node.move',
      payload: { mapId, nodeId, newParentId: located.parent.id, index: located.index },
    },
  }
}

// ── T49 · 知识库命令（笔记本与文档树的写入口；既有命令行为不变） ─────────────

/** 新建笔记本（追加到列表尾部）；逆元按 id 删。 */
export function createNotebookCommand(notebook: Notebook): Command {
  return {
    type: 'notebook.create',
    payload: { notebook, index: null },
    inverse: { type: 'notebook.delete', payload: { id: notebook.id } },
  }
}

/** 改笔记本名 / 时间戳；逆元走字段级还原。 */
export function patchNotebookCommand(vault: Vault, id: string, patch: NotebookPatch): Command {
  const notebook = findNotebook(vault, id)
  if (Object.keys(patch).length === 0) throw new Error('commandBus: 空 patch 不构成变更')
  return {
    type: 'notebook.patch',
    payload: { id, patch },
    inverse: { type: 'notebook.patch', payload: { id, patch: invertNotebookPatch(notebook, patch) } },
  }
}

/**
 * 删除笔记本（连同其全部文档）。逆元带完整笔记本体、原下标与**全部**文档，
 * undo 后文档树原样回来——这条命令是「一次删除可能抹掉几十篇文档」的唯一入口。
 */
export function deleteNotebookCommand(vault: Vault, id: string): Command {
  const notebook = findNotebook(vault, id)
  const index = vault.notebooks.findIndex((candidate) => candidate.id === id)
  const docs = vault.noteDocs
    .map((doc, position) => ({ doc, index: position }))
    .filter((entry) => entry.doc.notebookId === id)
  return {
    type: 'notebook.delete',
    payload: { id },
    inverse: { type: 'notebook.restore', payload: { notebook, index, docs } },
  }
}

/** 新建文档；逆元按 id 删除（级联删除在逆元方向不适用：新建的文档没有子文档）。 */
export function createNoteDocCommand(doc: NoteDoc): Command {
  return {
    type: 'doc.create',
    payload: { doc, index: null },
    inverse: { type: 'doc.delete', payload: { id: doc.id } },
  }
}

/**
 * 改标题 / 正文 / 父级 / 归属 / 排序。构造期拦截三种非法：父文档不存在、父级跨笔记本、
 * 父级落在自己子树里——抛错发生在入栈之前，undo 栈不会被非法命令污染。
 */
export function patchNoteDocCommand(vault: Vault, id: string, patch: NoteDocPatch): Command {
  const doc = findNoteDoc(vault, id)
  if (Object.keys(patch).length === 0) throw new Error('commandBus: 空 patch 不构成变更')
  const targetNotebook = patch.notebookId ?? doc.notebookId
  if (patch.notebookId !== undefined && !vault.notebooks.some((notebook) => notebook.id === patch.notebookId)) {
    throw new Error(`commandBus: 笔记本不存在（${patch.notebookId}）`)
  }
  if (patch.parentId !== undefined && patch.parentId !== null) {
    const parent = vault.noteDocs.find((candidate) => candidate.id === patch.parentId)
    if (parent === undefined) throw new Error(`commandBus: 父文档不存在（${patch.parentId}）`)
    if (parent.notebookId !== targetNotebook) throw new Error('commandBus: 父文档不在同一个笔记本')
    if (docSubtreeIds(vault.noteDocs, id).includes(parent.id)) {
      throw new Error('commandBus: 文档不能移动到自己的子树里')
    }
  }
  return {
    type: 'doc.patch',
    payload: { id, patch },
    inverse: { type: 'doc.patch', payload: { id, patch: invertNoteDocPatch(doc, patch) } },
  }
}

/**
 * 删除文档（连同子树）；逆元携整棵子树与原下标，undo 后连位置一起还原。
 * ——这是「撤销新建」与其他程序化删除用的**物理**删除；用户在界面上删文档走
 * `trashNoteDocCommand`（进回收站）。两者不可互换：新建命令的逆元若进回收站，
 * 每建一篇再撤销一次就会在回收站里堆一条垃圾。
 */
export function deleteNoteDocCommand(vault: Vault, id: string): Command {
  findNoteDoc(vault, id)
  const doomed = new Set(docSubtreeIds(vault.noteDocs, id))
  const docs = vault.noteDocs
    .map((doc, index) => ({ doc, index }))
    .filter((entry) => doomed.has(entry.doc.id))
  return {
    type: 'doc.delete',
    payload: { id },
    inverse: { type: 'doc.restore', payload: { docs } },
  }
}

// ── T64 · 回收站命令（界面删除的写入口；物理 delete 仍留给 create 的逆元） ─────────

/** 条目 id 与删除时刻由调用方给（控制器注入时钟/id，便于测试确定化）。 */
export interface TrashMeta {
  entryId: string
  deletedAt: string
}

/**
 * 删除任务 → 进回收站。条目里冻结任务体、原下标与两端指向它的依赖，
 * 于是恢复不需要任何外部快照：一次 `trash.restore` 就能把三者放回原位。
 */
export function trashTaskCommand(vault: Vault, id: string, meta: TrashMeta): Command {
  const task = findTask(vault, id)
  const index = vault.tasks.findIndex((candidate) => candidate.id === id)
  const links = vault.links
    .map((link, position) => ({ link, index: position }))
    .filter((entry) => entry.link.from === id || entry.link.to === id)
  const entry: TrashTaskEntry = {
    id: meta.entryId,
    kind: 'task',
    deletedAt: meta.deletedAt,
    index,
    task,
    links,
  }
  return {
    type: 'trash.add',
    payload: { entry, index: null },
    inverse: { type: 'trash.restore', payload: { entry } },
  }
}

/** 删除文档 → 整棵子树进回收站（一篇一张条目，恢复时子树整体回来）。 */
export function trashNoteDocCommand(vault: Vault, id: string, meta: TrashMeta): Command {
  findNoteDoc(vault, id)
  const doomed = new Set(docSubtreeIds(vault.noteDocs, id))
  const docs = vault.noteDocs
    .map((doc, index) => ({ doc, index }))
    .filter((entry) => doomed.has(entry.doc.id))
  const entry: TrashDocEntry = {
    id: meta.entryId,
    kind: 'doc',
    deletedAt: meta.deletedAt,
    rootId: id,
    docs,
  }
  return {
    type: 'trash.add',
    payload: { entry, index: null },
    inverse: { type: 'trash.restore', payload: { entry } },
  }
}

/**
 * 从回收站恢复。
 *
 * 构造期拦三种「恢复了也看不见 / 会撞键」的情况，抛错发生在入栈之前：
 *   ① 任务所属话题已不在 → 恢复出来也不属于任何一列
 *   ② 文档所属笔记本已不在 → 文档树里无处安放
 *   ③ 同 id 的对象已存在（例如先恢复过一次） → 数组里会出现重复 id
 *
 * 唯一自动降级：根文档的**外部父级**没了 → 降为顶层（子树内部关系原样不动）。
 * 这条降级写进条目本身，因此 undo 后再次删除时也是这个形状——父级已不存在，保留旧
 * parentId 只会让文档永远落在一个空引用下。
 */
export function restoreTrashCommand(vault: Vault, entryId: string): Command {
  const index = vault.trash.findIndex((entry) => entry.id === entryId)
  const entry = vault.trash[index]
  if (entry === undefined) throw new Error(`commandBus: 回收站条目不存在（${entryId}）`)

  if (entry.kind === 'task') {
    if (!vault.topics.some((topic) => topic.id === entry.task.topicId)) {
      throw new Error('commandBus: 任务所属话题已不存在，无法恢复')
    }
    if (vault.tasks.some((task) => task.id === entry.task.id)) {
      throw new Error(`commandBus: 同 id 的任务已存在（${entry.task.id}）`)
    }
  } else {
    for (const item of entry.docs) {
      if (!vault.notebooks.some((notebook) => notebook.id === item.doc.notebookId)) {
        throw new Error('commandBus: 文档所属笔记本已不存在，无法恢复')
      }
      if (vault.noteDocs.some((doc) => doc.id === item.doc.id)) {
        throw new Error(`commandBus: 同 id 的文档已存在（${item.doc.id}）`)
      }
    }
  }

  const normalized = normalizeRestoredEntry(vault, entry)
  return {
    type: 'trash.restore',
    // 正反两个方向用**同一个**条目：否则「降为顶层」只在逆元里生效，
    // 正向恢复出来的文档仍然指着那个已不存在的父级。
    payload: { entry: normalized },
    inverse: { type: 'trash.add', payload: { entry: normalized, index } },
  }
}

/** 恢复前的降级：根文档的外部父级若已消失，降为顶层。其余原样。 */
function normalizeRestoredEntry(vault: Vault, entry: TrashEntry): TrashEntry {
  if (entry.kind === 'task') return entry
  const inside = new Set(entry.docs.map((item) => item.doc.id))
  const parentAlive = (parentId: string | null): boolean =>
    parentId === null || inside.has(parentId) || vault.noteDocs.some((doc) => doc.id === parentId)
  const docs = entry.docs.map((item) =>
    item.doc.id === entry.rootId && !parentAlive(item.doc.parentId)
      ? { ...item, doc: { ...item.doc, parentId: null } }
      : item,
  )
  return { ...entry, docs }
}

/** 彻底删除：只摘条目本身（内容在删除那一刻就已离开 vault）。两步确认在视图里。 */
export function purgeTrashCommand(vault: Vault, entryId: string): Command {
  const index = vault.trash.findIndex((entry) => entry.id === entryId)
  const entry = vault.trash[index]
  if (entry === undefined) throw new Error(`commandBus: 回收站条目不存在（${entryId}）`)
  return {
    type: 'trash.purge',
    payload: { entry, index },
    inverse: { type: 'trash.reinsert', payload: { entry, index } },
  }
}

export function createCommandBus(store: VaultStore): CommandBus {
  const undoStack: Command[] = []
  const redoStack: Command[] = []
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  /**
   * T53 · 栈深上限（T52 遗留 3：长会话里每次拖拽 / 每段笔记正文都进栈，理论上一直涨）。
   *
   * 超出后丢**最旧**的一条，而不是干脆不入栈：丢的只是「还能撤多深」，
   * 一致性不受影响——被丢的命令早已无 redo 归路，磁盘上也早就是它的结果。
   * 正常会话远远到不了 200，只有长时间不刷新才可能触及。
   */
  function trim(stack: Command[]): void {
    if (stack.length > COMMAND_STACK_LIMIT) {
      stack.splice(0, stack.length - COMMAND_STACK_LIMIT)
    }
  }

  function run(mutation: Mutation): void {
    // 先算再写：reducer 抛错时 Store 原样不动，也不会半途改一半
    const next = reduce(store.getVault(), mutation)
    store.setVault(next)
  }

  return {
    apply(command) {
      run(command)
      undoStack.push(command)
      trim(undoStack)
      redoStack.length = 0
      notify()
    },
    undo() {
      const command = undoStack.pop()
      if (command === undefined) return false
      run(command.inverse)
      redoStack.push(command)
      trim(redoStack)
      notify()
      return true
    },
    redo() {
      const command = redoStack.pop()
      if (command === undefined) return false
      run(command)
      undoStack.push(command)
      trim(undoStack)
      notify()
      return true
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undoDepth: () => undoStack.length,
    redoDepth: () => redoStack.length,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    clear() {
      undoStack.length = 0
      redoStack.length = 0
      notify()
    },
  }
}
