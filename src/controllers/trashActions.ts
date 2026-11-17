// T64 · 回收站构造层：把「回收站面板的一次点击」翻译成一条可 apply 的命令。
//
// 与 controllers/notebookActions.ts 同款：视图只转发事件，id 与时间戳在这里生成，
// 领域写入一律经 CommandBus（删除 / 恢复 / 彻底删除都天然可撤销）。
//
// 两条口径：
//   ① 恢复失败的原因要能说清。命令层抛错是最后一道闸，这里先判一遍并返回**原因**，
//      面板据此给一条具体提示（「话题已不存在」比「恢复失败」有用得多）。
//   ② 删除/恢复的幂等性由调用方保证：条目 id 每次删除现生成，恢复只认条目 id。

import { nanoid } from 'nanoid'

import {
  purgeTrashCommand,
  restoreTrashCommand,
  trashNoteDocCommand,
  trashTaskCommand,
} from '../domain/commandBus'
import type { CommandBus } from '../domain/commandBus'
import type { Vault } from '../domain/types'

/** 注入 id 生成与时钟，便于测试确定化。 */
export interface TrashActionDeps {
  newId?: () => string
  now?: () => Date
}

function genId(deps: TrashActionDeps): string {
  return (deps.newId ?? (() => nanoid()))()
}

function stamp(deps: TrashActionDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString()
}

/** 删除任务（进回收站）；任务不存在返回 false。 */
export function applyTrashTask(
  bus: CommandBus,
  vault: Vault,
  id: string,
  deps: TrashActionDeps = {},
): boolean {
  if (!vault.tasks.some((task) => task.id === id)) return false
  bus.apply(trashTaskCommand(vault, id, { entryId: genId(deps), deletedAt: stamp(deps) }))
  return true
}

/** 删除文档（整棵子树进回收站）；文档不存在返回 false。 */
export function applyTrashDoc(
  bus: CommandBus,
  vault: Vault,
  id: string,
  deps: TrashActionDeps = {},
): boolean {
  if (!vault.noteDocs.some((doc) => doc.id === id)) return false
  bus.apply(trashNoteDocCommand(vault, id, { entryId: genId(deps), deletedAt: stamp(deps) }))
  return true
}

/** 恢复失败的原因：条目没了 / 归属没了 / 同 id 已存在。 */
export type RestoreFailure = 'missing' | 'topic' | 'notebook' | 'conflict'

/**
 * 从回收站恢复一条；成功返回 null，失败返回原因（且**不入栈**）。
 * 预判口径与 restoreTrashCommand 的构造期校验一一对应，改一处必须改两处。
 */
export function applyRestoreEntry(bus: CommandBus, vault: Vault, entryId: string): RestoreFailure | null {
  const entry = vault.trash.find((candidate) => candidate.id === entryId)
  if (entry === undefined) return 'missing'
  if (entry.kind === 'task') {
    if (!vault.topics.some((topic) => topic.id === entry.task.topicId)) return 'topic'
    if (vault.tasks.some((task) => task.id === entry.task.id)) return 'conflict'
  } else {
    for (const item of entry.docs) {
      if (!vault.notebooks.some((notebook) => notebook.id === item.doc.notebookId)) return 'notebook'
      if (vault.noteDocs.some((doc) => doc.id === item.doc.id)) return 'conflict'
    }
  }
  bus.apply(restoreTrashCommand(vault, entryId))
  return null
}

/** 彻底删除一条；条目不存在返回 false。 */
export function applyPurgeEntry(bus: CommandBus, vault: Vault, entryId: string): boolean {
  if (!vault.trash.some((entry) => entry.id === entryId)) return false
  bus.apply(purgeTrashCommand(vault, entryId))
  return true
}
