// T13 · TopicTree：话题树纯函数模块。
// 零 React / 零 DOM / 零 I/O；输入 topics，输出父子关系与归属派生（spec 3 模块清单、6.5 topic 管理）。
// 同级顺序一律按 (order, id) 升序，保证结果稳定可复现。

import type { Topic } from './types'

export interface TopicTree {
  readonly byId: ReadonlyMap<string, Topic>
  /** 一级话题（parentId 为 null，或指向不存在父节点的话题） */
  roots(): readonly Topic[]
  /** 直接子话题，按 (order, id) 升序 */
  childrenOf(parentId: string | null): readonly Topic[]
  /** 从根到父节点，不含自身；未知 id 返回空 */
  ancestors(id: string): readonly Topic[]
  /** 从根到自身；未知 id 返回空 */
  pathOf(id: string): readonly Topic[]
  /** 根为 0；未知 id 为 -1 */
  depth(id: string): number
  /** 全部子孙 id（不含自身），文档顺序（同级按 order 升序，深度优先） */
  descendants(id: string): readonly string[]
  /** 含自身的子树 id 闭包，便于 Filter 的 includeDescendants */
  subtreeIds(id: string): readonly string[]
  isDescendantOf(id: string, ancestorId: string): boolean
}

function compareTopics(a: Topic, b: Topic): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function createTopicTree(topics: readonly Topic[]): TopicTree {
  const byId = new Map<string, Topic>()
  for (const topic of topics) byId.set(topic.id, topic)

  // parentId 指向不存在的话题时按根处理——树断裂不至于让整枝从视图里消失
  const childrenIndex = new Map<string | null, Topic[]>()
  for (const topic of topics) {
    const parent = topic.parentId !== null && byId.has(topic.parentId) ? topic.parentId : null
    const bucket = childrenIndex.get(parent)
    if (bucket) bucket.push(topic)
    else childrenIndex.set(parent, [topic])
  }
  for (const bucket of childrenIndex.values()) bucket.sort(compareTopics)

  const childrenOf = (parentId: string | null): readonly Topic[] => childrenIndex.get(parentId) ?? []

  const roots = (): readonly Topic[] => childrenOf(null)

  const ancestors = (id: string): readonly Topic[] => {
    const chain: Topic[] = []
    // seen 兼作环保护：脏数据下的 a→b→a 不会死循环
    const seen = new Set<string>([id])
    let current = byId.get(id)?.parentId ?? null
    while (current !== null && !seen.has(current)) {
      seen.add(current)
      const node = byId.get(current)
      if (!node) break
      chain.push(node)
      current = node.parentId
    }
    return chain.reverse()
  }

  const pathOf = (id: string): readonly Topic[] => {
    const node = byId.get(id)
    return node ? [...ancestors(id), node] : []
  }

  const depth = (id: string): number => (byId.has(id) ? ancestors(id).length : -1)

  const descendants = (id: string): readonly string[] => {
    if (!byId.has(id)) return []
    const out: string[] = []
    const seen = new Set<string>([id])
    const walk = (parentId: string): void => {
      for (const child of childrenOf(parentId)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        out.push(child.id)
        walk(child.id)
      }
    }
    walk(id)
    return out
  }

  const subtreeIds = (id: string): readonly string[] => (byId.has(id) ? [id, ...descendants(id)] : [])

  const isDescendantOf = (id: string, ancestorId: string): boolean => {
    if (id === ancestorId) return false
    const seen = new Set<string>([id])
    let current = byId.get(id)?.parentId ?? null
    while (current !== null && !seen.has(current)) {
      if (current === ancestorId) return true
      seen.add(current)
      current = byId.get(current)?.parentId ?? null
    }
    return false
  }

  return { byId, roots, childrenOf, ancestors, pathOf, depth, descendants, subtreeIds, isDescendantOf }
}
