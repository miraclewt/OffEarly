// T15 · boardDnd：看板拖拽的判定逻辑（纯函数，编排层）。
//
// 分层边界（spec 第 3 节）：views 只渲染 + 转发事件；这里把「拖拽意味着什么」
// 翻译成领域命令。入参：vault（tasks/links）+ 被拖 id + 目标列 + 目标邻居；
// 出参：要 apply 的 Command，或「无需变更」。
//
// 为什么判定必须抽成纯函数：jsdom 下 dnd-kit 的 pointer 事件序列很难稳定模拟，
// 只有纯函数能被可靠单测。视图层只负责把 dnd-kit 事件归一化成 BoardDrop
// （见 BoardView.handleDragEnd），不在这里做任何 DOM 判断。
//
// 语义（spec 6.1）：
//   - 跨列拖拽改 status；同列拖拽改 order（LexoRank 中点插入）；
//   - 拖拽后**仅被拖任务**的 order 变化——mid() 只给被拖任务发新键，
//     列内其余卡片的 order 一个字节都不动；
//   - 原地放下（序列不变）返回 noop：不写 store、不进撤销栈、不标脏。

import type { Command, CommandBus } from '../domain/commandBus'
import { moveTaskCommand } from '../domain/commandBus'
import { mid } from '../domain/lexorank'
import type { Status, Task, Vault } from '../domain/types'

/** dnd-kit onDragEnd 归一化后的落点。不依赖 dnd-kit 类型，便于纯函数单测。 */
export interface BoardDrop {
  /** 被拖任务 id。 */
  draggedId: string
  /** 目标列（status）。 */
  targetStatus: Status
  /**
   * 落点相对目标邻居的位置：
   *   'above' 插到邻居上方 / 'below' 插到邻居下方 / 'end' 放到列尾（含空列）。
   */
  position: 'above' | 'below' | 'end'
  /** 目标邻居任务 id；position 为 'end' 时传 null。 */
  overId: string | null
}

/** 拖拽计划：要么落地成一条 Command，要么原地不动。 */
export type BoardDndPlan = { kind: 'noop' } | { kind: 'move'; command: Command }

/** 按 order 词典序排序（LexoRank 键的比较只走字符串序，T10 口径）。 */
export function sortByOrder(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
}

/**
 * 被拖卡片中心是否落在目标邻居中心线之上——视图层用它把 dnd-kit 的
 * `over`（只给邻居 id）归一成 above/below。纯几何，无 DOM 依赖。
 */
export function isAboveCenter(
  dragged: { top: number; height: number },
  over: { top: number; height: number },
): boolean {
  return dragged.top + dragged.height / 2 < over.top + over.height / 2
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * 计算一次拖拽的落地计划。不合法输入直接抛错（与 domain 各模块同一约定），
 * 不静默兜底——排序悄悄错乱比抛错难查得多。
 */
export function planBoardDrop(vault: Vault, drop: BoardDrop): BoardDndPlan {
  const dragged = vault.tasks.find((task) => task.id === drop.draggedId)
  if (dragged === undefined) throw new Error(`boardDnd: 被拖任务不存在（${drop.draggedId}）`)

  // 落在自己身上：同列内最常见的无意识误放
  if (drop.overId === drop.draggedId) return { kind: 'noop' }

  // 目标列（剔除被拖任务与归档任务）按 order 升序；插入位置在这份列表上计算，
  // 于是 mid() 的上下邻居天然不可能与被拖任务的旧键相撞。
  // 归档任务不参与：看板从不渲染它们（QueryEngine 默认排除），排序键只看可见邻居，
  // 否则一个排在可见任务之间的归档任务会让「原地放下」被误判成换序。
  const column = sortByOrder(
    vault.tasks.filter(
      (task) => !task.archived && task.status === drop.targetStatus && task.id !== drop.draggedId,
    ),
  )

  let insertIndex: number
  if (drop.position === 'end' || drop.overId === null) {
    insertIndex = column.length
  } else {
    const overIndex = column.findIndex((task) => task.id === drop.overId)
    if (overIndex < 0) throw new Error(`boardDnd: 目标邻居不在目标列（${drop.overId}）`)
    insertIndex = drop.position === 'above' ? overIndex : overIndex + 1
  }

  // 同列原地放下：算出的邻居与原来完全相同 → 最终序列不变 → noop。
  // 若此处不拦，每次误放都会把被拖任务的 order 改写成等价新键，白进一次撤销栈。
  const finalIds = [
    ...column.slice(0, insertIndex).map((task) => task.id),
    dragged.id,
    ...column.slice(insertIndex).map((task) => task.id),
  ]
  const sourceIds = sortByOrder(
    vault.tasks.filter((task) => !task.archived && task.status === dragged.status),
  ).map((task) => task.id)
  if (dragged.status === drop.targetStatus && sameSequence(finalIds, sourceIds)) {
    return { kind: 'noop' }
  }

  // LexoRank 中点插入：只影响被拖任务一个字段
  const before = insertIndex > 0 ? column[insertIndex - 1]!.order : undefined
  const after = insertIndex < column.length ? column[insertIndex]!.order : undefined
  const order = mid(before, after)

  // 复用 T10 的既有写命令，不扩 CommandBus 的命令类型（那是 lane A 的文件域）
  return { kind: 'move', command: moveTaskCommand(vault, dragged.id, { status: drop.targetStatus, order }) }
}

/**
 * 计划 + 应用。noop 时不触碰 bus——不污染撤销栈、不触发 autosave 的 dirty 态。
 * 视图层在 onDragEnd 里只调这一个函数。
 */
export function applyBoardDrop(bus: CommandBus, vault: Vault, drop: BoardDrop): BoardDndPlan {
  const plan = planBoardDrop(vault, drop)
  if (plan.kind === 'move') bus.apply(plan.command)
  return plan
}
