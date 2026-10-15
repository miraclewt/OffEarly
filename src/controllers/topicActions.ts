// T14 · topicActions：把侧栏的话题交互翻译成对「唯一状态源」的写操作（spec 3 三条硬规则）。
//
// 为什么话题的写落在 Store 上而不是 CommandBus：
// 现有 CommandBus 的 MutationType 只有 `task.*` 与 `settings.patch`（见 domain/commandBus.ts），
// 话题没有对应的 Mutation；补一套 `topic.*` 命令要动 lane A 的文件域（本任务产出清单之外），
// 故本轮把话题写操作收敛在本控制器里（组件不许私藏话题状态），**筛选**仍走 CommandBus 的
// settings.patch。将来补齐 topic.* 命令后，只需把这里的 store.update 换成 bus.apply，视图无感。
//
// 归档语义（验收 3「归档 topic 其任务从看板/甘特图消失」）：
// 归档一个话题 = 把它与整棵子树置 archived，并把子树内任务的 archived 一并置位。
// 看板与甘特图的数据入口都是 QueryEngine，而它默认排除 archived 任务（T13 既定口径），
// 于是「消失」不需要下游各自再写一遍过滤。取消归档按同一规则对称还原。

import { nanoid } from 'nanoid'

import { patchSettingsCommand } from '../domain/commandBus'
import type { CommandBus } from '../domain/commandBus'
import { mid } from '../domain/lexorank'
import { createEmptyFilter } from '../domain/queryEngine'
import type { VaultStore } from '../domain/store'
import { createTopicTree } from '../domain/topicTree'
import type { Topic } from '../domain/types'

/**
 * 固定 12 色调色板（spec 6.5）：全部取 600 附近档位，保证浅色主题（背景 #FAFAFA / 卡片 #FFFFFF）
 * 下色块与文字都有足够对比度，且 12 色互不相同、灰度打印时仍可区分。
 * 与 T15 卡片色点共用这一套话题色——卡片色点直接读 `topic.color`。
 */
export const TOPIC_PALETTE: readonly string[] = Object.freeze([
  '#4F46E5',
  '#2563EB',
  '#0891B2',
  '#059669',
  '#65A30D',
  '#CA8A04',
  '#EA580C',
  '#DC2626',
  '#DB2777',
  '#C026D3',
  '#7C3AED',
  '#64748B',
])

/** 调色板为空时的兜底（正常情况下取不到），等于主强调色。 */
export const FALLBACK_TOPIC_COLOR = '#4F46E5'

/** 取调色板第 index 个颜色，越界或负数按环绕处理。 */
export function paletteColorAt(index: number): string {
  const size = TOPIC_PALETTE.length
  if (size === 0) return FALLBACK_TOPIC_COLOR
  const wrapped = ((index % size) + size) % size
  return TOPIC_PALETTE[wrapped] ?? FALLBACK_TOPIC_COLOR
}

export function isPaletteColor(color: string): boolean {
  return TOPIC_PALETTE.includes(color)
}

/** 新话题默认配色：按已有话题数轮转，新建若干话题时相邻不同色。 */
export function nextTopicColor(topics: readonly Topic[]): string {
  return paletteColorAt(topics.length)
}

export interface TopicActionsDeps {
  store: VaultStore
  bus: CommandBus
  /** 注入 id 生成，便于测试确定化。 */
  newId?: () => string
}

export interface TopicActions {
  /** 在 parentId 下追加话题（parentId === null 即根话题），返回新 id。 */
  createTopic(parentId: string | null, name: string): string
  /** 重命名为空白的调用被忽略（视图层已回落为占位文案）。 */
  renameTopic(id: string, name: string): void
  /** 只接受 12 色调色板内的颜色，越界抛错——颜色语言不允许被旁路。 */
  setTopicColor(id: string, color: string): void
  archiveTopic(id: string): void
  unarchiveTopic(id: string): void
  /** topicId === null 表示清空话题筛选。 */
  setTopicFilter(topicId: string | null): void
  /** 点击话题行：已是唯一选中则取消，否则设为该话题。 */
  toggleTopicFilter(topicId: string): void
}

export function createTopicActions(deps: TopicActionsDeps): TopicActions {
  const { store, bus } = deps
  const newId = deps.newId ?? (() => nanoid())

  function readTopic(id: string): Topic {
    const topic = store.getVault().topics.find((candidate) => candidate.id === id)
    if (topic === undefined) throw new Error(`topicActions: 话题不存在（${id}）`)
    return topic
  }

  function patchTopic(id: string, recipe: (topic: Topic) => Topic): void {
    readTopic(id)
    store.update((vault) => ({
      ...vault,
      topics: vault.topics.map((topic) => (topic.id === id ? recipe(topic) : topic)),
    }))
  }

  /** 归档 / 取消归档：话题整棵子树 + 子树内任务一并置位，二者必须同进同出。 */
  function setSubtreeArchived(id: string, archived: boolean): void {
    readTopic(id)
    store.update((vault) => {
      const ids = new Set(createTopicTree(vault.topics).subtreeIds(id))
      const lastFilter = vault.settings.lastFilter
      // 归档掉「正被筛选的话题」会把看板清空且该行已从树上消失、点不回来，
      // 故同步把失效的 topicIds 摘掉，避免留下一个点不掉的死筛选。
      const nextFilter =
        archived && lastFilter
          ? { ...lastFilter, topicIds: lastFilter.topicIds.filter((topicId) => !ids.has(topicId)) }
          : lastFilter
      return {
        ...vault,
        settings: { ...vault.settings, lastFilter: nextFilter },
        topics: vault.topics.map((topic) => (ids.has(topic.id) ? { ...topic, archived } : topic)),
        tasks: vault.tasks.map((task) => (ids.has(task.topicId) ? { ...task, archived } : task)),
      }
    })
  }

  function setTopicFilter(topicId: string | null): void {
    const vault = store.getVault()
    const base = vault.settings.lastFilter ?? createEmptyFilter()
    const topicIds = topicId === null ? [] : [topicId]
    // 无变化的点击不产生命令：撤销栈里不该出现空操作
    const unchanged = base.topicIds.length === topicIds.length && base.topicIds.every((id, index) => id === topicIds[index])
    if (unchanged) return
    bus.apply(patchSettingsCommand(vault, { lastFilter: { ...base, topicIds } }))
  }

  return {
    createTopic(parentId, name) {
      const vault = store.getVault()
      if (parentId !== null) readTopic(parentId)
      const siblings = vault.topics.filter((topic) => topic.parentId === parentId)
      const lastOrder = siblings.reduce<string | undefined>(
        (acc, topic) => (acc === undefined || topic.order > acc ? topic.order : acc),
        undefined,
      )
      const created: Topic = {
        id: newId(),
        name: name.trim(),
        color: nextTopicColor(vault.topics),
        parentId,
        order: mid(lastOrder),
        archived: false,
      }
      store.update((current) => ({ ...current, topics: [...current.topics, created] }))
      return created.id
    },

    renameTopic(id, name) {
      const trimmed = name.trim()
      if (trimmed === '') return
      patchTopic(id, (topic) => ({ ...topic, name: trimmed }))
    },

    setTopicColor(id, color) {
      if (!isPaletteColor(color)) throw new Error(`topicActions: 颜色不在 12 色调色板内（${color}）`)
      patchTopic(id, (topic) => ({ ...topic, color }))
    },

    archiveTopic(id) {
      setSubtreeArchived(id, true)
    },

    unarchiveTopic(id) {
      setSubtreeArchived(id, false)
    },

    setTopicFilter,

    toggleTopicFilter(topicId) {
      const current = store.getVault().settings.lastFilter?.topicIds ?? []
      const soleSelection = current.length === 1 && current[0] === topicId
      setTopicFilter(soleSelection ? null : topicId)
    },
  }
}
