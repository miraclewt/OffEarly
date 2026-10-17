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

import type { Dependency, MindMap, MindNode, Settings, Status, Task, Vault } from './types'
import {
  findNode,
  findParent,
  insertChild,
  isDescendant,
  mapTree,
  removeNode,
} from './mindmapTree'
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

export interface MutationPayloads {
  'task.create': { task: Task; index: number | null }
  'task.delete': { id: string }
  'task.patch': { id: string; patch: TaskPatch }
  'task.move': { id: string; status: Status; order: string }
  'settings.patch': { patch: SettingsPatch }
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
}

export type MutationType = keyof MutationPayloads

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
      return { ...vault, tasks: vault.tasks.filter((task) => task.id !== id) }
    }
    case 'task.patch': {
      const { id, patch } = mutation.payload
      return mapTask(vault, id, (task) => patchedTask(task, patch))
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

/** 删除任务；逆元带完整任务体与原下标，undo 后连数组位置一起还原。 */
export function deleteTaskCommand(vault: Vault, id: string): Command {
  const task = findTask(vault, id)
  const index = vault.tasks.findIndex((candidate) => candidate.id === id)
  return {
    type: 'task.delete',
    payload: { id },
    inverse: { type: 'task.create', payload: { task, index } },
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

export function createCommandBus(store: VaultStore): CommandBus {
  const undoStack: Command[] = []
  const redoStack: Command[] = []
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of [...listeners]) listener()
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
      redoStack.length = 0
      notify()
    },
    undo() {
      const command = undoStack.pop()
      if (command === undefined) return false
      run(command.inverse)
      redoStack.push(command)
      notify()
      return true
    },
    redo() {
      const command = redoStack.pop()
      if (command === undefined) return false
      run(command)
      undoStack.push(command)
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
