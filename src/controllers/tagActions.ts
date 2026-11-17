// T62 · 标签管理：标签是任务上的自由文本，没有独立的标签表。
//
// 因此「改名 / 合并 / 删除」本质都是**一次批量改写**：遍历所有任务，把命中的那个标签
// 换掉或摘掉。逐条 patch 会刷出 N 条撤销项（改 12 个任务的标签要按 12 次撤销），
// 所以这里走 rewriteTagCommand：一条命令、一次撤销、逆元携全部原始 tags。
//
// 三条口径：
//   ① 改名到已存在的名字 = 合并（不做二次询问，界面上写清楚）；
//   ② 单独一个任务里的重复标签会被去掉（合并后 `['风控','风控']` 不该存在）；
//   ③ 空名字、同名改写都是 no-op，不产生命令。

import { rewriteTagCommand } from '../domain/commandBus'
import type { CommandBus } from '../domain/commandBus'
import type { Vault } from '../domain/types'

export interface TagCount {
  tag: string
  count: number
}

/** 全库标签 + 使用次数，按名字排序（中文按本地顺序）。 */
export function listTags(vault: Vault): TagCount[] {
  const counts = new Map<string, number>()
  for (const task of vault.tasks) {
    for (const tag of task.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag, 'zh'))
}

/** 改名；新名字已经存在时等同于合并。返回是否真的产生了写入。 */
export function applyRenameTag(bus: CommandBus, vault: Vault, from: string, to: string): boolean {
  const next = to.trim()
  if (next === '' || next === from) return false
  if (!vault.tasks.some((task) => task.tags.includes(from))) return false
  bus.apply(rewriteTagCommand(vault, from, next))
  return true
}

export function applyDeleteTag(bus: CommandBus, vault: Vault, tag: string): boolean {
  if (!vault.tasks.some((task) => task.tags.includes(tag))) return false
  bus.apply(rewriteTagCommand(vault, tag, null))
  return true
}
