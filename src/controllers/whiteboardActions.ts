// T69 · 白板构造层：把「画布上的一次动作」翻译成一条可 apply 的命令。
//
// 与 controllers/mindmapActions、trashActions 同款分层：视图只转发事件，id 与时间戳在这里生成，
// 领域写入一律经 CommandBus。因此画布上的每一步（加图元、拖完一个框、连一条线、贴模板）
// 都可撤销，撤销栈里也不会有「只撤了半个动作」的中间态。
//
// 三条口径：
//   ① **一次动作一条命令**。拖动十个框、贴一个模板、删一个框（连带它的线）都只进一条，
//      用户按一次 Ctrl+Z 看到的是「整件事回去了」，而不是「回去了一点点」。
//   ② 下标一律取**动作发生时**的数组长度：节点与边都只往尾部追加，reducer 按升序落位之后
//      数组序 = 创建序，渲染序（frame 沉底）与导出序都稳定。
//   ③ 模板的文案由调用方传入（译文）；domain 不 import i18n（与 mindmapActions 同一约定）。

import { nanoid } from 'nanoid'

import {
  addGraphicCommand,
  createWhiteboardCommand,
  deleteWhiteboardCommand,
  deleteGraphicCommand,
  patchWhiteboardCommand,
  patchWhiteboardEdgesCommand,
  patchWhiteboardNodesCommand,
} from '../domain/commandBus'
import type { CommandBus } from '../domain/commandBus'
import { WHITEBOARD_DEFAULT_SIZE } from '../domain/whiteboardModel'
import { buildWhiteboardTemplate } from '../domain/whiteboardTemplates'
import type { WhiteboardTemplateId, WhiteboardTemplateText } from '../domain/whiteboardTemplates'
import { mid } from '../domain/lexorank'
import type {
  Whiteboard,
  WhiteboardAnchor,
  WhiteboardArrow,
  WhiteboardEdge,
  WhiteboardEdgePatch,
  WhiteboardNode,
  WhiteboardNodePatch,
  WhiteboardRoute,
  WhiteboardShape,
  WhiteboardTone,
  Vault,
} from '../domain/types'

/** 注入 id 生成与时钟，便于测试确定化（与 trashActions 同签名）。 */
export interface WhiteboardActionDeps {
  newId?: () => string
  now?: () => Date
}

export interface NewWhiteboardInput {
  name?: string
  fallbackName: string
}

/** 新节点的描述：坐标与尺寸由视图给（用户摆的、拖出来的），其余给默认值。 */
export interface WhiteboardNodeDraft {
  shape: WhiteboardShape
  x: number
  y: number
  width?: number
  height?: number
  text?: string
  tone?: WhiteboardTone
}

/** 新连线的描述：两端是**已存在**的节点 id。 */
export interface WhiteboardEdgeDraft {
  from: string
  to: string
  route?: WhiteboardRoute
  arrow?: WhiteboardArrow
  dashed?: boolean
  fromAnchor?: WhiteboardAnchor
  toAnchor?: WhiteboardAnchor
  label?: string
}

function genId(deps: WhiteboardActionDeps): string {
  return (deps.newId ?? (() => nanoid()))()
}

function stamp(deps: WhiteboardActionDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString()
}

function normalizeName(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim() ?? ''
  return trimmed === '' ? fallback : trimmed
}

function findWhiteboard(vault: Vault, id: string): Whiteboard | undefined {
  return vault.whiteboards.find((candidate) => candidate.id === id)
}

/** 新板落列表尾部；空列表取 LexoRank 中点初值（与 buildNewMap 同一手法）。 */
function nextWhiteboardOrder(vault: Vault): string {
  const last = vault.whiteboards[vault.whiteboards.length - 1]
  return mid(last?.order, undefined)
}

/** 只算不写：构造新白板。 */
export function buildWhiteboard(vault: Vault, input: NewWhiteboardInput, deps: WhiteboardActionDeps = {}): Whiteboard {
  const now = stamp(deps)
  return {
    id: genId(deps),
    name: normalizeName(input.name, input.fallbackName),
    order: nextWhiteboardOrder(vault),
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** 新建白板并返回实体（视图拿 id 直接切过去）。 */
export function applyCreateWhiteboard(
  bus: CommandBus,
  vault: Vault,
  input: NewWhiteboardInput,
  deps: WhiteboardActionDeps = {},
): Whiteboard {
  const whiteboard = buildWhiteboard(vault, input, deps)
  bus.apply(createWhiteboardCommand(whiteboard))
  return whiteboard
}

export function applyDeleteWhiteboard(bus: CommandBus, vault: Vault, id: string): boolean {
  if (findWhiteboard(vault, id) === undefined) return false
  bus.apply(deleteWhiteboardCommand(vault, id))
  return true
}

/** 改名（顺带刷 updatedAt）；空名走兜底文案，不报错。 */
export function applyRenameWhiteboard(
  bus: CommandBus,
  vault: Vault,
  id: string,
  name: string,
  fallback: string,
  deps: WhiteboardActionDeps = {},
): boolean {
  const whiteboard = findWhiteboard(vault, id)
  if (whiteboard === undefined) return false
  const next = normalizeName(name, fallback)
  if (next === whiteboard.name) return false
  bus.apply(patchWhiteboardCommand(vault, id, { name: next, updatedAt: stamp(deps) }))
  return true
}

/** 只算不写：把 draft 变成带 id 与默认尺寸的节点。 */
export function buildNode(draft: WhiteboardNodeDraft, deps: WhiteboardActionDeps = {}): WhiteboardNode {
  const size = WHITEBOARD_DEFAULT_SIZE[draft.shape]
  return {
    id: genId(deps),
    shape: draft.shape,
    x: draft.x,
    y: draft.y,
    width: draft.width ?? size.width,
    height: draft.height ?? size.height,
    text: draft.text ?? '',
    tone: draft.tone ?? 'plain',
  }
}

/** 只算不写：把 draft 变成带 id 的连线。 */
export function buildEdge(draft: WhiteboardEdgeDraft, deps: WhiteboardActionDeps = {}): WhiteboardEdge {
  return {
    id: genId(deps),
    from: draft.from,
    to: draft.to,
    fromAnchor: draft.fromAnchor ?? 'auto',
    toAnchor: draft.toAnchor ?? 'auto',
    route: draft.route ?? 'ortho',
    arrow: draft.arrow ?? 'end',
    dashed: draft.dashed ?? false,
    label: draft.label ?? '',
  }
}

/**
 * 图元只能连到这条边「看得见」的节点：已有的，或者**同一批里刚加的**。
 * 模板与粘贴都属于后者（整张图的框和线一次提交），所以只查库里已有的节点会把它们全拦掉。
 */
function edgesAreConnectable(whiteboard: Whiteboard, nodes: readonly WhiteboardNode[], edges: readonly WhiteboardEdge[]): boolean {
  const ids = new Set(whiteboard.nodes.map((node) => node.id))
  for (const node of nodes) ids.add(node.id)
  return edges.every((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
}

/** 追加图元（一批算一条命令）；板不存在或连线端点不合法返回 false、零写入。 */
export function applyAddGraphic(
  bus: CommandBus,
  vault: Vault,
  whiteboardId: string,
  nodes: readonly WhiteboardNode[],
  edges: readonly WhiteboardEdge[] = [],
): boolean {
  const whiteboard = findWhiteboard(vault, whiteboardId)
  if (whiteboard === undefined) return false
  if (nodes.length === 0 && edges.length === 0) return false
  if (!edgesAreConnectable(whiteboard, nodes, edges)) return false
  const nodeEntries = nodes.map((node, offset) => ({ node, index: whiteboard.nodes.length + offset }))
  const edgeEntries = edges.map((edge, offset) => ({ edge, index: whiteboard.edges.length + offset }))
  bus.apply(addGraphicCommand(whiteboardId, nodeEntries, edgeEntries))
  return true
}

/** 一次性造好节点与连线并提交（连线用节点**下标**引用两端，这里换成真 id）。 */
export function applyAddDrafts(
  bus: CommandBus,
  vault: Vault,
  whiteboardId: string,
  nodeDrafts: readonly WhiteboardNodeDraft[],
  edgeDrafts: readonly (Omit<WhiteboardEdgeDraft, 'from' | 'to'> & { from: number; to: number })[] = [],
  deps: WhiteboardActionDeps = {},
): boolean {
  const nodes = nodeDrafts.map((draft) => buildNode(draft, deps))
  const edges: WhiteboardEdge[] = []
  for (const draft of edgeDrafts) {
    const from = nodes[draft.from]
    const to = nodes[draft.to]
    if (from === undefined || to === undefined) continue
    edges.push(buildEdge({ ...draft, from: from.id, to: to.id }, deps))
  }
  return applyAddGraphic(bus, vault, whiteboardId, nodes, edges)
}

/**
 * 贴模板：模板坐标是相对左上角的，`origin` 是画布上的落点（通常是视口中心减去模板一半），
 * 因此模板落到哪儿由视图决定，这里只做平移与 id 化。
 */
export function applyAddTemplate(
  bus: CommandBus,
  vault: Vault,
  whiteboardId: string,
  templateId: WhiteboardTemplateId,
  origin: { x: number; y: number },
  labels: Partial<Record<WhiteboardTemplateText, string>> = {},
  deps: WhiteboardActionDeps = {},
): boolean {
  const template = buildWhiteboardTemplate(templateId, labels)
  const drafts: WhiteboardNodeDraft[] = template.nodes.map((item) => ({
    shape: item.shape,
    x: origin.x + item.x,
    y: origin.y + item.y,
    width: item.width,
    height: item.height,
    text: item.text,
    tone: item.tone,
  }))
  return applyAddDrafts(bus, vault, whiteboardId, drafts, template.edges, deps)
}

/** 删除图元（连带挂在被删节点上的连线）；一次一条撤销项。 */
export function applyDeleteGraphic(
  bus: CommandBus,
  vault: Vault,
  whiteboardId: string,
  nodeIds: readonly string[],
  edgeIds: readonly string[] = [],
): boolean {
  if (findWhiteboard(vault, whiteboardId) === undefined) return false
  if (nodeIds.length === 0 && edgeIds.length === 0) return false
  bus.apply(deleteGraphicCommand(vault, whiteboardId, nodeIds, edgeIds))
  return true
}

/** 批量改节点（拖动、改尺寸、改文本、对齐）：空 patch 的项被过滤，全空返回 false。 */
export function applyPatchNodes(
  bus: CommandBus,
  vault: Vault,
  whiteboardId: string,
  patches: readonly { id: string; patch: WhiteboardNodePatch }[],
): boolean {
  const live = patches.filter((item) => Object.keys(item.patch).length > 0)
  if (live.length === 0) return false
  if (findWhiteboard(vault, whiteboardId) === undefined) return false
  bus.apply(patchWhiteboardNodesCommand(vault, whiteboardId, live))
  return true
}

export function applyPatchEdges(
  bus: CommandBus,
  vault: Vault,
  whiteboardId: string,
  patches: readonly { id: string; patch: WhiteboardEdgePatch }[],
): boolean {
  const live = patches.filter((item) => Object.keys(item.patch).length > 0)
  if (live.length === 0) return false
  if (findWhiteboard(vault, whiteboardId) === undefined) return false
  bus.apply(patchWhiteboardEdgesCommand(vault, whiteboardId, live))
  return true
}
