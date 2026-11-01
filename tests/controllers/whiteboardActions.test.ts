// T74 · 白板的「贴图」构造层：`buildNode` 必须把附件引用原样带进节点，且**只给图片图元**
// 加这个键（普通图元的对象上不该出现 `image: undefined`——那会让序列化多出脏字段）。

import { describe, expect, it } from 'vitest'

import { buildNode } from '../../src/controllers/whiteboardActions'
import { WHITEBOARD_DEFAULT_SIZE } from '../../src/domain/whiteboardModel'

const deps = { newId: () => 'n1' }

describe('buildNode · 图片图元', () => {
  it('带上 image 引用与给定尺寸', () => {
    const node = buildNode({ shape: 'image', x: 16, y: 32, width: 240, height: 160, image: 'assets/a1.png' }, deps)
    expect(node).toMatchObject({
      id: 'n1',
      shape: 'image',
      x: 16,
      y: 32,
      width: 240,
      height: 160,
      image: 'assets/a1.png',
    })
  })

  it('没给尺寸时用 image 的默认框（不是 0 宽高）', () => {
    const node = buildNode({ shape: 'image', x: 0, y: 0, image: 'assets/a1.png' }, deps)
    expect(node.width).toBe(WHITEBOARD_DEFAULT_SIZE.image.width)
    expect(node.height).toBe(WHITEBOARD_DEFAULT_SIZE.image.height)
  })

  it('普通图元不出现 image 键', () => {
    const node = buildNode({ shape: 'rect', x: 0, y: 0, text: '服务' }, deps)
    expect('image' in node).toBe(false)
    expect(JSON.stringify(node)).not.toContain('image')
  })
})

// T75 · 字号：与 image 同一条口径——没指定就不落键，指定了原样带进节点。
describe('buildNode · 字号', () => {
  it('给了 fontSize 就带进节点', () => {
    const node = buildNode({ shape: 'text', x: 0, y: 0, text: '标题', fontSize: 32 }, deps)
    expect(node.fontSize).toBe(32)
  })

  it('没给就不落这个键（渲染时回到形状默认 13 / 便签 14）', () => {
    const node = buildNode({ shape: 'note', x: 0, y: 0, text: '便签' }, deps)
    expect('fontSize' in node).toBe(false)
    expect(JSON.stringify(node)).not.toContain('fontSize')
  })
})

// T77 · 字效与图片贴合：只有「非缺省」才落键。
// 这与「用户挑了什么」是不同的两件事：false 与 contain 都是缺省表现，
// 写进文件只会让每个新图元都背上一串冗余字段，撤销也表达不了「回到原样」。
describe('buildNode · 字效与图片贴合', () => {
  it('bold / italic 只在 true 时落键', () => {
    const node = buildNode({ shape: 'text', x: 0, y: 0, text: '标题', bold: true, italic: true }, deps)
    expect(node.bold).toBe(true)
    expect(node.italic).toBe(true)
  })

  it('显式 false 等于没给：键不出现', () => {
    const node = buildNode({ shape: 'text', x: 0, y: 0, text: '标题', bold: false, italic: false }, deps)
    expect('bold' in node).toBe(false)
    expect('italic' in node).toBe(false)
    expect(JSON.stringify(node)).not.toContain('bold')
  })

  it('imageFit 只认 cover，contain 等于没给', () => {
    const cover = buildNode({ shape: 'image', x: 0, y: 0, image: 'assets/a1.png', imageFit: 'cover' }, deps)
    expect(cover.imageFit).toBe('cover')
    const contain = buildNode({ shape: 'image', x: 0, y: 0, image: 'assets/a1.png', imageFit: 'contain' }, deps)
    expect('imageFit' in contain).toBe(false)
  })
})
