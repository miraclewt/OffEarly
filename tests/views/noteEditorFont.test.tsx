// @vitest-environment jsdom
//
// T50 · 字号调节：控件在编辑器自己的底栏里，值经 props 进出（组件不读 store）。
// 断言三件事：能上能下、到边界置灰、字号真的注入到 CSS 变量（.oe-prose 由它决定大小）。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NoteEditor } from '../../src/views/NoteEditor'

// jsdom 没有布局：ProseMirror 的 focus / coordsAtPos 会问到 getClientRects，缺实现会抛。
const EMPTY_RECTS = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList
const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as unknown as DOMRect
for (const proto of [Node.prototype, Range.prototype]) {
  Object.defineProperty(proto, 'getClientRects', { value: () => EMPTY_RECTS, configurable: true })
  Object.defineProperty(proto, 'getBoundingClientRect', { value: () => ZERO_RECT, configurable: true })
}

afterEach(cleanup)

describe('笔记正文字号', () => {
  it('底栏显示当前字号，A+/A- 外送相邻档位', () => {
    const onChange = vi.fn()
    render(
      <NoteEditor value="" onCommit={() => undefined} fontSize={14} onFontSizeChange={onChange} />,
    )
    expect(screen.getByTestId('note-font-size').textContent).toBe('14')

    fireEvent.click(screen.getByTestId('note-font-larger'))
    expect(onChange).toHaveBeenLastCalledWith(15)

    fireEvent.click(screen.getByTestId('note-font-smaller'))
    expect(onChange).toHaveBeenLastCalledWith(13)
  })

  it('到 12 / 20 两端置灰', () => {
    const { rerender } = render(
      <NoteEditor value="" onCommit={() => undefined} fontSize={12} onFontSizeChange={() => undefined} />,
    )
    expect((screen.getByTestId('note-font-smaller') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('note-font-larger') as HTMLButtonElement).disabled).toBe(false)

    rerender(
      <NoteEditor value="" onCommit={() => undefined} fontSize={20} onFontSizeChange={() => undefined} />,
    )
    expect((screen.getByTestId('note-font-larger') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('note-font-smaller') as HTMLButtonElement).disabled).toBe(false)
  })

  it('字号以 CSS 变量注入，且跟随界面尺度换算', () => {
    render(<NoteEditor value="" onCommit={() => undefined} fontSize={18} />)
    const root = screen.getByTestId('note-editor')
    expect(root.style.getPropertyValue('--oe-note-font-size')).toBe(
      'calc(18px * var(--oe-ui-scale, 1))',
    )
  })

  it('不传 onFontSizeChange 时控件只读（纯展示场景不该能点）', () => {
    render(<NoteEditor value="" onCommit={() => undefined} fontSize={16} />)
    expect((screen.getByTestId('note-font-smaller') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('note-font-larger') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('note-font-size').textContent).toBe('16')
  })
})
