// T41 · mindmapTree：思维导图树的纯工具模块（commandBus 的 mindmap.* reducer 与命令工厂共用）。
// 零 React / 零 DOM / 零 I/O；全部递归不可变——更新即逐层 { ...node, children: ... } 重建，
// 未触及的分支保持共享引用（dependencyGraph.ts 同构的纯函数层）。
// 非法输入（找不到 id、动根）直接抛错，不静默兜底：命令工厂据此在构造期拦截，
// reducer 据此保证 apply 抛错时 Store 原样不动（commandBus 既有语义）。
// 只依赖 T40 的类型定义（MindNode），不引用 VaultStore / 视图层。

import type { MindNode } from './types'

/** 深度优先找节点；未命中返回 null。 */
export function findNode(root: MindNode, id: string): MindNode | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const found = findNode(child, id)
    if (found !== null) return found
  }
  return null
}

/** 找节点的父节点及在该父下的下标；根或未命中返回 null。 */
export function findParent(
  root: MindNode,
  id: string,
): { parent: MindNode; index: number } | null {
  for (const [index, child] of root.children.entries()) {
    if (child.id === id) return { parent: root, index }
    const found = findParent(child, id)
    if (found !== null) return found
  }
  return null
}

/** id 是否为 ancestorId 的严格后代（自身不算）；任一 id 不存在返回 false。 */
export function isDescendant(root: MindNode, ancestorId: string, id: string): boolean {
  const ancestor = findNode(root, ancestorId)
  if (ancestor === null) return false
  return ancestor.id !== id && findNode(ancestor, id) !== null
}

/** 对 id 命中的节点套 recipe，自根逐层重建路径、未触及分支共享引用；找不到 id 抛错。 */
export function mapTree(
  root: MindNode,
  id: string,
  recipe: (node: MindNode) => MindNode,
): MindNode {
  // walk 返回 null 即「整棵树不含该 id」——等价于先 findNode 校验存在，单趟完成
  const next = walk(root)
  if (next === null) throw new Error(`mindmapTree: 节点不存在（${id}）`)
  return next

  function walk(node: MindNode): MindNode | null {
    if (node.id === id) return recipe(node)
    let changed = false
    const children = node.children.map((child) => {
      const mapped = walk(child)
      if (mapped === null) return child
      changed = true
      return mapped
    })
    return changed ? { ...node, children } : null
  }
}

/** 在 parentId 下插入 node；index 为 null 追加尾部，否则按「当前兄弟序列」的下标插入；父不存在抛错。 */
export function insertChild(
  root: MindNode,
  parentId: string,
  node: MindNode,
  index: number | null,
): MindNode {
  return mapTree(root, parentId, (parent) => {
    const children = [...parent.children]
    children.splice(index ?? children.length, 0, node)
    return { ...parent, children }
  })
}

/**
 * 从树上摘掉 id（连同其子树）；返回复原三件套：next（新树）、removed（原节点引用）、父与下标。
 * 根不可移除、未命中抛错——delete 命令的逆元（node.add 携完整子树回原父原下标）靠这两个值。
 */
export function removeNode(
  root: MindNode,
  id: string,
): { next: MindNode; removed: MindNode; parentId: string; index: number } {
  if (root.id === id) throw new Error('mindmapTree: 根节点不可移除')
  const located = findParent(root, id)
  if (located === null) throw new Error(`mindmapTree: 节点不存在（${id}）`)
  const { parent, index } = located
  const removed = parent.children[index]
  if (removed === undefined) throw new Error(`mindmapTree: 节点不存在（${id}）`) // 不可达：index 来自 findParent
  const next = mapTree(root, parent.id, (node) => ({
    ...node,
    children: node.children.filter((child) => child.id !== id),
  }))
  return { next, removed, parentId: parent.id, index }
}

/** 自身之外被折叠祖先隐藏的后代数：被藏的子树只计一次，嵌套折叠不重复计数。 */
export function countHidden(root: MindNode): number {
  return walk(root, false)

  function walk(node: MindNode, hiddenByAncestor: boolean): number {
    let total = hiddenByAncestor ? 1 : 0
    for (const child of node.children) total += walk(child, hiddenByAncestor || node.folded)
    return total
  }
}
