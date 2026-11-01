// @vitest-environment jsdom
// T76 · 白板编辑态的**可见性**。
//
// 单测钉的不是「点了会进编辑」（那是视图 + 事件的事，e2e 里钉），而是三件渲染层面的承诺：
//  1. 进编辑时容器有实描边、文本图元有实底色——否则一个透明的 textarea 在画布上
//     等于「没有输入框」，空的文本图元更是完全看不见；
//  2. 空文本图元在非编辑态显示淡色占位（它是这种图元唯一的可见形态）；
//  3. 占位只属于文本图元：空便签、空矩形不该长出一行提示。

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Whiteboard, WhiteboardNode } from '../../src/domain/types'
import { WhiteboardCanvas } from '../../src/views/WhiteboardCanvas'
import type { WhiteboardCanvasProps } from '../../src/views/WhiteboardCanvas'

afterEach(cleanup)

function node(over: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return { id: 'n1', shape: 'text', x: 0, y: 0, width: 168, height: 32, text: '', tone: 'plain', ...over }
}

function board(nodes: WhiteboardNode[]): Whiteboard {
  return {
    id: 'w1',
    name: '板',
    order: 'U',
    nodes,
    edges: [],
    createdAt: '2026-10-31T04:00:00.000Z',
    updatedAt: '2026-10-31T04:00:00.000Z',
  }
}

function renderCanvas(over: Partial<WhiteboardCanvasProps> = {}): void {
  const props: WhiteboardCanvasProps = {
    whiteboard: board([node()]),
    panX: 0,
    panY: 0,
    zoom: 1,
    selectedIds: [],
    selectedEdgeId: null,
    editingId: null,
    draftText: '',
    dragDelta: null,
    dragIds: [],
    resizeRect: null,
    linkPreview: null,
    marquee: null,
    linkTargetId: null,
    textPlaceholder: '输入文字…',
    onNodePointerDown: vi.fn(),
    onNodeDoubleClick: vi.fn(),
    onResizePointerDown: vi.fn(),
    onAnchorPointerDown: vi.fn(),
    onEdgePointerDown: vi.fn(),
    onEditChange: vi.fn(),
    onEditCommit: vi.fn(),
    onEditCancel: vi.fn(),
    ...over,
  }
  render(<WhiteboardCanvas {...props} />)
}

describe('T76 · 白板编辑态可见', () => {
  it('编辑中的文本图元：有 textarea、有实描边、有实底色（不是透明输入框）', () => {
    renderCanvas({ editingId: 'n1', draftText: '' })
    const area = screen.getByTestId('whiteboard-text-input')
    expect(area).toBeTruthy()

    const host = screen.getByTestId('whiteboard-node-n1')
    expect(host.style.outline).toContain('var(--oe-accent)')
    expect(host.style.outlineStyle).not.toBe('none')
    // 透明底 + 无边框 = 用户看不到输入框；这里必须落一个不透明的底
    expect(host.style.background).toBe('var(--oe-surface)')
  })

  it('编辑中的便签保留自己的底色（不能把便签染成白纸）', () => {
    // 用自定义色：便签的语义色正好就是 --oe-surface，拿它断言分辨不出「被覆盖」
    renderCanvas({
      whiteboard: board([node({ shape: 'note', text: '缓存', fill: '#fef3c7' })]),
      editingId: 'n1',
      draftText: '缓存',
    })
    const host = screen.getByTestId('whiteboard-node-n1')
    expect(host.style.outline).toContain('var(--oe-accent)')
    expect(host.style.background).toContain('254, 243, 199')
  })

  it('空文本图元：非编辑态显示淡色占位', () => {
    renderCanvas()
    const placeholder = screen.getByTestId('whiteboard-placeholder-n1')
    expect(placeholder.textContent).toBe('输入文字…')
    expect(placeholder.style.color).toBe('var(--oe-text-faint)')
  })

  it('有文字的文本图元不显示占位', () => {
    renderCanvas({ whiteboard: board([node({ text: '订单服务' })]) })
    expect(screen.queryByTestId('whiteboard-placeholder-n1')).toBeNull()
    expect(screen.getByTestId('whiteboard-label-n1').textContent).toBe('订单服务')
  })

  it('占位只属于文本图元：空便签与空矩形不长提示', () => {
    renderCanvas({
      whiteboard: board([
        node({ id: 'a', shape: 'note' }),
        node({ id: 'b', shape: 'rect' }),
      ]),
    })
    expect(screen.queryByTestId('whiteboard-placeholder-a')).toBeNull()
    expect(screen.queryByTestId('whiteboard-placeholder-b')).toBeNull()
  })

  it('编辑时不渲染占位（否则占位文字会和输入内容一起出现）', () => {
    renderCanvas({ editingId: 'n1' })
    expect(screen.queryByTestId('whiteboard-placeholder-n1')).toBeNull()
    expect(screen.getByTestId('whiteboard-text-input')).toBeTruthy()
  })

  it('图片图元永远不进编辑态：即使 editingId 指向它也不渲染 textarea', () => {
    renderCanvas({
      whiteboard: board([node({ shape: 'image', text: 'shot.png', image: 'assets/a.png' })]),
      editingId: 'n1',
      resolveImage: () => 'blob:x',
    })
    expect(screen.queryByTestId('whiteboard-text-input')).toBeNull()
  })
})

// T77 · 字效、编辑态长高、图片铺满。
//
// 这三条都是「数据在节点上，渲染要读它」的同一类问题：漏一处就是「屏幕上看起来改了、
// 重开就没了」或「编辑时框不长高、文字滚出视野」。
describe('T77 · 字效、实时长高与图片铺满', () => {
  it('加粗 / 斜体落到容器的 font-weight / font-style 上', () => {
    renderCanvas({ whiteboard: board([node({ id: 'a', text: '标题', bold: true, italic: true })]) })
    const container = screen.getByTestId('whiteboard-node-a')
    expect(container.style.fontWeight).toBe('700')
    expect(container.style.fontStyle).toBe('italic')
  })

  it('没加粗没斜体：两个属性都不设（继承默认）', () => {
    renderCanvas({ whiteboard: board([node({ id: 'a', text: '正文' })]) })
    const container = screen.getByTestId('whiteboard-node-a')
    expect(container.style.fontWeight).toBe('')
    expect(container.style.fontStyle).toBe('')
  })

  it('编辑中给了 editingHeight：容器按它长高（打字过程中框跟着长）', () => {
    renderCanvas({ editingId: 'n1', draftText: '第一行\n第二行\n第三行', editingHeight: 96 })
    expect(screen.getByTestId('whiteboard-node-n1').style.height).toBe('96px')
  })

  it('editingHeight 只在编辑时生效：非编辑态仍按节点的 height 画', () => {
    renderCanvas({ whiteboard: board([node({ height: 32 })]), editingHeight: 96 })
    expect(screen.getByTestId('whiteboard-node-n1').style.height).toBe('32px')
  })

  it('editingHeight 比最小高度还小时夹到 32（不会把框压成一条线）', () => {
    renderCanvas({ editingId: 'n1', editingHeight: 8 })
    expect(screen.getByTestId('whiteboard-node-n1').style.height).toBe('32px')
  })

  it('便签进编辑态也有占位提示（否则只看得到一个空的有色块）', () => {
    renderCanvas({ whiteboard: board([node({ shape: 'note' })]), editingId: 'n1' })
    expect(screen.getByTestId('whiteboard-text-input').getAttribute('placeholder')).toBe('输入文字…')
  })

  it('图片 cover：object-fit 是 cover；缺省是 contain', () => {
    const image = (over: Partial<WhiteboardNode>): WhiteboardNode =>
      node({ id: 'img', shape: 'image', text: 'a.png', image: 'assets/a.png', ...over })

    renderCanvas({ whiteboard: board([image({ imageFit: 'cover' })]), resolveImage: () => 'blob:x' })
    expect(screen.getByTestId('whiteboard-image-img').style.objectFit).toBe('cover')

    cleanup()
    renderCanvas({ whiteboard: board([image({})]), resolveImage: () => 'blob:x' })
    expect(screen.getByTestId('whiteboard-image-img').style.objectFit).toBe('contain')
  })
})
