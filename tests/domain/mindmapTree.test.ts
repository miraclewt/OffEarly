import { describe, expect, it } from 'vitest'

import {
  countHidden,
  findNode,
  findParent,
  insertChild,
  isDescendant,
  mapTree,
  removeNode,
} from '../../src/domain/mindmapTree'
import type { MindNode } from '../../src/domain/types'

// 种子树：r ── [ a(折叠, 子 a1), b ]
const tree: MindNode = {
  id: 'r',
  text: 'R',
  order: 'V',
  folded: false,
  children: [
    {
      id: 'a',
      text: 'A',
      order: 'V',
      folded: true,
      children: [{ id: 'a1', text: 'A1', order: 'V', folded: false, children: [] }],
    },
    { id: 'b', text: 'B', order: 'V', folded: false, children: [] },
  ],
}

function node(id: string, children: MindNode[] = [], folded = false): MindNode {
  return { id, text: id, order: 'V', folded, children }
}

describe('findNode / findParent / isDescendant / countHidden', () => {
  it('findParent / isDescendant / countHidden', () => {
    expect(findParent(tree, 'a1')!.parent.id).toBe('a')
    expect(isDescendant(tree, 'a', 'r')).toBe(false)
    expect(isDescendant(tree, 'a', 'a1')).toBe(true)
    expect(countHidden(tree)).toBe(1) // a 折叠藏了 a1
  })

  it('findNode 命中返回原对象、未命中返回 null', () => {
    expect(findNode(tree, 'a1')).toBe(tree.children[0]!.children[0]!)
    expect(findNode(tree, 'r')).toBe(tree)
    expect(findNode(tree, 'nope')).toBeNull()
  })

  it('findParent 对根与不存在的 id 返回 null', () => {
    expect(findParent(tree, 'r')).toBeNull()
    expect(findParent(tree, 'nope')).toBeNull()
    expect(findParent(tree, 'b')).toEqual({ parent: tree, index: 1 })
  })

  it('isDescendant：自身与不存在的 id 都不算后代', () => {
    expect(isDescendant(tree, 'a', 'a')).toBe(false)
    expect(isDescendant(tree, 'a', 'b')).toBe(false)
    expect(isDescendant(tree, 'nope', 'a1')).toBe(false)
  })

  it('countHidden 折叠子树整体只计一次，嵌套折叠不重复计数', () => {
    // deep：r ── [ a(折叠) ── [ a1(折叠) ── [ a11 ] ] ]
    const deep: MindNode = node('r', [node('a', [node('a1', [node('a11')], true)], true)])
    expect(countHidden(deep)).toBe(2) // a1（被 a 藏）+ a11（被 a1 藏），各计一次
    expect(countHidden(node('r', [node('a', [node('a1')])]))).toBe(0) // 无折叠
  })
})

describe('mapTree', () => {
  it('按 recipe 重建路径且不改原树', () => {
    const next = mapTree(tree, 'a1', (n) => ({ ...n, text: '改过' }))

    expect(next).not.toBe(tree)
    expect(next.children[0]).not.toBe(tree.children[0])
    expect(next.children[0]!.children[0]!.text).toBe('改过')
    expect(findNode(next, 'b')).toBe(tree.children[1]) // 未触及分支共享引用
    expect(tree.children[0]!.children[0]!.text).toBe('A1')
  })

  it('找不到 id 抛错', () => {
    expect(() => mapTree(tree, 'nope', (n) => n)).toThrow(/nope/)
  })

  it('根自身也可被 recipe 命中', () => {
    const next = mapTree(tree, 'r', (n) => ({ ...n, folded: true }))
    expect(next.folded).toBe(true)
    expect(tree.folded).toBe(false)
  })
})

describe('insertChild / removeNode', () => {
  it('insertChild：index=null 追加尾部，给定 index 定点插入', () => {
    const appended = insertChild(tree, 'r', node('c'), null)
    expect(appended.children.map((c) => c.id)).toEqual(['a', 'b', 'c'])

    const at0 = insertChild(tree, 'r', node('c'), 0)
    expect(at0.children.map((c) => c.id)).toEqual(['c', 'a', 'b'])

    expect(tree.children.map((c) => c.id)).toEqual(['a', 'b']) // 原树不动
  })

  it('insertChild：父节点不存在抛错', () => {
    expect(() => insertChild(tree, 'nope', node('c'), null)).toThrow(/nope/)
  })

  it('removeNode 根抛错、返回复原三件套', () => {
    expect(() => removeNode(tree, 'r')).toThrow()
    const { next, removed, parentId, index } = removeNode(tree, 'a')
    expect(next.children.map((c) => c.id)).toEqual(['b'])
    expect(removed.id).toBe('a')
    expect({ parentId, index }).toEqual({ parentId: 'r', index: 0 })
  })

  it('removeNode：不存在的 id 抛错；原树不被改动', () => {
    expect(() => removeNode(tree, 'nope')).toThrow(/nope/)
    const { next } = removeNode(tree, 'a1')
    expect(next.children[0]!.children).toEqual([])
    expect(tree.children[0]!.children.map((c) => c.id)).toEqual(['a1'])
  })

  it('insertChild + removeNode 往返还原结构', () => {
    const { next, removed, parentId, index } = removeNode(tree, 'a1')
    const restored = insertChild(next, parentId, removed, index)
    expect(restored).toEqual(tree)
  })
})
