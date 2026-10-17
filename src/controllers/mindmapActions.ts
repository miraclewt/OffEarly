// 思维导图构造层：把「视图的一次交互」（建图 / 加子 / 改名 / 折叠 / 删除 / 拖拽落点）翻译成
// 一条（或两条）可 apply 的命令（纯编排层，与 taskCreate.ts 同款 plan→apply 手法）。
//
// 分层边界（spec 第 3 节）：views 只渲染 + 转发事件；领域写入一律经 T10 CommandBus。
// 本模块不碰 DOM、不读全局、不改入参 vault 快照，可脱离 React 单测（与 taskCreate.ts 同一手法）。
// plan 函数（buildNewMap / planCreateMap）只算不写；apply* = 算命令 + bus.apply，视图层只调 apply*。
//
// 三条口径：
//   ① 兜底文案注入：控制器不 import i18n——fallbackName / fallbackText / rootText 一律由调用方
//      （视图把译文传进来）。与 taskCreate「空标题抛错」口径不同：导图节点允许空文本占位
//      （xmind 新建分支即空待编辑），所以 text/name trim 后为空走 fallback，而不是报错；
//      但 trim 只去首尾，内部空白与大小写原样保留（同 taskCreate）。
//   ② 排序键：新图追加到 mindmaps 列表尾部、新节点追加到兄弟序列尾部，
//      都取 LexoRank `mid(最后一个的 order, undefined)`（与 taskCreate 的 nextOrderFor 一致；
//      「尾部」按数组末位取——reducer 的 index=null 也是数组尾插，两边对齐）。
//   ③ updatedAt 纪律（T41 handoff）：命令层不碰 map.updatedAt；只有 applyCreateMap（创建快照）
//      与 applyRenameMap（payload 注入 deps.now）盖时间戳。节点级编辑**不**刷新图级时间戳——
//      plan 决策已锁定：node.patch 保持字段级逆简单，图级时间戳视图不需要逐次精确。
//
// 失败语义速查（T45/T47 按此调用）：
//   - id 不存在（图 / 父 / 节点）→ apply* 返回 false / null，零写入、零 undo 记录；
//   - 删根 → false 且 bus 零写入（根恒在，不抛错不压栈）；
//   - applyMoveNode：负 index 直接 TypeError（T41 留了 splice 负索引陷阱，构造层先拦）；
//     移根 / 移入自身或子树 → 命令层抛错**原样上抛**（T47 拖拽层先做命中过滤），
//     但抛错发生在 bus.apply 之前，undo 栈必然干净；
//   - 折叠父上加子 → 展开 + 加子两条命令、两条 undo 记录（裁决：xmind 折叠父上直接建子本就
//     两步，保持命令简单，不造组合命令类型）。

import { nanoid } from 'nanoid'

import {
  addNodeCommand,
  createMapCommand,
  deleteMapCommand,
  deleteNodeCommand,
  moveNodeCommand,
  patchMapCommand,
  patchNodeCommand,
} from '../domain/commandBus'
import type { Command, CommandBus } from '../domain/commandBus'
import { mid } from '../domain/lexorank'
import { findNode } from '../domain/mindmapTree'
import type { MindMap, MindNode, Vault } from '../domain/types'

/** 新建图的输入；name 空白/缺省走 fallbackName，rootText 原样作为根节点文案（视图传译文）。 */
export interface NewMapInput {
  name?: string
  fallbackName: string
  rootText: string
}

/** 新建节点的输入；text trim 后为空走 fallbackText（空文本占位合法，不抛错）。 */
export interface NewNodeInput {
  text?: string
  fallbackText: string
}

/** 注入 id 生成与时钟，便于测试确定化。applyCreateMap 连取两个 id：先 map、后 root。 */
export interface MapActionDeps {
  newId?: () => string
  now?: () => Date
}

/** 新建计划：导图创建没有「不可用前提」，恒成功——plan 即「命令 + 实体」一对（taskCreate 的 create 分支同款）。 */
export type CreateMapPlan = { command: Command; map: MindMap }

function genId(deps: MapActionDeps): string {
  return (deps.newId ?? (() => nanoid()))()
}

function stamp(deps: MapActionDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString()
}

/** trim 只去首尾；空/纯空白 → 注入的兜底文案（口径 ①）。 */
function normalizeText(text: string | undefined, fallback: string): string {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' ? fallback : trimmed
}

function locateMap(vault: Vault, mapId: string): MindMap | undefined {
  return vault.mindmaps.find((candidate) => candidate.id === mapId)
}

/** 新图落列表尾部；空列表取 LexoRank 中点初值（口径 ②，数组末位即 reducer 的尾插位）。 */
function nextMapOrder(vault: Vault): string {
  const last = vault.mindmaps[vault.mindmaps.length - 1]
  return mid(last?.order, undefined)
}

/** 只算不写：构造新图实体（先消耗 map id、再消耗 root id——测试用 seq 固定顺序）。 */
export function buildNewMap(vault: Vault, input: NewMapInput, deps: MapActionDeps = {}): MindMap {
  const now = stamp(deps)
  const mapId = genId(deps)
  const root: MindNode = {
    id: genId(deps),
    text: input.rootText,
    order: mid(undefined, undefined),
    folded: false,
    children: [],
  }
  return {
    id: mapId,
    name: normalizeText(input.name, input.fallbackName),
    root,
    order: nextMapOrder(vault),
    createdAt: now,
    updatedAt: now,
  }
}

/** 只算不写：返回要 apply 的命令与图实体。 */
export function planCreateMap(vault: Vault, input: NewMapInput, deps: MapActionDeps = {}): CreateMapPlan {
  const map = buildNewMap(vault, input, deps)
  return { command: createMapCommand(map), map }
}

/** 计划 + 应用；返回 plan（含 map 实体，视图可拿 id 直接跳转选中）。 */
export function applyCreateMap(
  bus: CommandBus,
  vault: Vault,
  input: NewMapInput,
  deps: MapActionDeps = {},
): CreateMapPlan {
  const plan = planCreateMap(vault, input, deps)
  bus.apply(plan.command)
  return plan
}

/**
 * 在 parentId 下加子节点（尾部追加）；返回新节点供视图聚焦/进入编辑。
 * 图或父不存在 → null，零写入。父折叠 → 先 patch 展开再 add（两条命令、两条 undo，见头注）。
 */
export function applyAddNode(
  bus: CommandBus,
  vault: Vault,
  mapId: string,
  parentId: string,
  input: NewNodeInput,
  deps: MapActionDeps = {},
): MindNode | null {
  const map = locateMap(vault, mapId)
  if (map === undefined) return null
  const parent = findNode(map.root, parentId)
  if (parent === null) return null
  const lastSibling = parent.children[parent.children.length - 1]
  const node: MindNode = {
    id: genId(deps),
    text: normalizeText(input.text, input.fallbackText),
    order: mid(lastSibling?.order, undefined),
    folded: false,
    children: [],
  }
  if (parent.folded) {
    bus.apply(patchNodeCommand(vault, mapId, parentId, { folded: false }))
  }
  bus.apply(addNodeCommand(mapId, parentId, node, null))
  return node
}

/** 改节点文案（trim 空 → fallbackText）；图或节点不存在 → false，零写入。 */
export function applyRenameNode(
  bus: CommandBus,
  vault: Vault,
  mapId: string,
  nodeId: string,
  text: string,
  fallbackText: string,
): boolean {
  const map = locateMap(vault, mapId)
  if (map === undefined || findNode(map.root, nodeId) === null) return false
  bus.apply(patchNodeCommand(vault, mapId, nodeId, { text: normalizeText(text, fallbackText) }))
  return true
}

/** 翻转 folded（根也可折叠）；图或节点不存在 → false，零写入。 */
export function applyToggleFold(
  bus: CommandBus,
  vault: Vault,
  mapId: string,
  nodeId: string,
): boolean {
  const map = locateMap(vault, mapId)
  const node = map === undefined ? null : findNode(map.root, nodeId)
  if (node === null) return false
  bus.apply(patchNodeCommand(vault, mapId, nodeId, { folded: !node.folded }))
  return true
}

/** 删节点（连子树）；根 → false 且 bus 零写入（不抛错不压栈）；不存在 → false。 */
export function applyDeleteNode(
  bus: CommandBus,
  vault: Vault,
  mapId: string,
  nodeId: string,
): boolean {
  const map = locateMap(vault, mapId)
  if (map === undefined || map.root.id === nodeId) return false
  if (findNode(map.root, nodeId) === null) return false
  bus.apply(deleteNodeCommand(vault, mapId, nodeId))
  return true
}

/**
 * 跨父移动（含同父换序）；index 按「remove 之后」的兄弟序列解释（T41 语义）。
 * 负 index → TypeError（splice 负索引陷阱在构造层拦截，零写入）。
 * 非法结构（移根 / 自父 / 后代目标 / id 不存在）由 moveNodeCommand 工厂抛错并原样上抛——
 * T47 拖拽层先做命中过滤；抛错发生在 bus.apply 之前，undo 栈不落脏。成功返回 true。
 */
export function applyMoveNode(
  bus: CommandBus,
  vault: Vault,
  mapId: string,
  nodeId: string,
  newParentId: string,
  index: number,
): boolean {
  if (index < 0) throw new TypeError(`mindmapActions: 移动下标不能为负（${index}）`)
  bus.apply(moveNodeCommand(vault, mapId, nodeId, newParentId, index))
  return true
}

/** 改图名并经 payload 刷新 updatedAt = deps.now；trim 后为空 → false；图不存在 → false。 */
export function applyRenameMap(
  bus: CommandBus,
  vault: Vault,
  mapId: string,
  name: string,
  deps: MapActionDeps = {},
): boolean {
  const trimmed = name.trim()
  if (trimmed === '') return false
  if (locateMap(vault, mapId) === undefined) return false
  bus.apply(patchMapCommand(vault, mapId, { name: trimmed, updatedAt: stamp(deps) }))
  return true
}

/** 删图；唯一一张也允许删（空库态由 T45 引导卡承接）。图不存在 → false，零写入。 */
export function applyDeleteMap(
  bus: CommandBus,
  vault: Vault,
  mapId: string,
): boolean {
  if (locateMap(vault, mapId) === undefined) return false
  bus.apply(deleteMapCommand(vault, mapId))
  return true
}
