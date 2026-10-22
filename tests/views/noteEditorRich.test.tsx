// @vitest-environment jsdom
//
// T49 · NoteEditor 的三处增强：正文排版 / Markdown 源码模式 / 图片缩放。
//
// 断言口径都是「用户能看见或能存下来的东西」：
//  · 图片宽度必须落进 Markdown（`<img width="62%">`），并且能原样读回来；
//  · 源码模式必须展示**当前** markdown，改完切回富文本仍然生效；
//  · 空文档要有占位提示（装饰节点，不写进内容）；字数统计随内容更新。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createI18n } from '../../src/locales/i18n'
import {
  NoteEditor,
  countNoteChars,
  imageMarkdown,
  parseImageWidth,
  roundTripNoteMarkdown,
  widthPercentFromPixels,
} from '../../src/views/NoteEditor'
import type { NoteAssetsPort } from '../../src/views/NoteEditor'

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
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true })
}

function t() {
  return createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t
}

const port: NoteAssetsPort = {
  insert: async () => ({ ok: true, src: 'assets/a1.png' }),
  resolve: (src) => (src === 'assets/a1.png' ? 'blob:offearly/a1' : null),
}

function setup(value: string, extra: { onReady?: (editor: Editor | null) => void } = {}) {
  const onCommit = vi.fn()
  const view = render(
    <NoteEditor
      value={value}
      onCommit={onCommit}
      assets={port}
      debounceMs={0}
      t={t()}
      onReady={extra.onReady}
    />,
  )
  return { onCommit, view }
}

afterEach(cleanup)

describe('T49-1 · 宽度归一与 Markdown 写法（纯函数）', () => {
  it('parseImageWidth 把各写法夹到 15–100', () => {
    expect(parseImageWidth('62%')).toBe(62)
    expect(parseImageWidth('62')).toBe(62)
    expect(parseImageWidth(48)).toBe(48)
    expect(parseImageWidth('5%')).toBe(15)
    expect(parseImageWidth(160)).toBe(100)
    expect(parseImageWidth('')).toBeNull()
    expect(parseImageWidth('abc')).toBeNull()
    expect(parseImageWidth(null)).toBeNull()
  })

  it('imageMarkdown：没有宽度写常规语法；有宽度写 HTML img 并转义引号', () => {
    expect(imageMarkdown({ src: 'assets/a.png', alt: '图' })).toBe('![图](assets/a.png)')
    expect(imageMarkdown({ src: 'assets/a.png', alt: '图', width: '62%' })).toBe(
      '<img src="assets/a.png" alt="图" width="62%">',
    )
    expect(imageMarkdown({ src: 'assets/a.png', alt: 'a"b', width: 50 })).toBe(
      '<img src="assets/a.png" alt="a&quot;b" width="50%">',
    )
  })

  it('像素位移换百分比：内容宽度未知时退回 100%，绝不产出 NaN', () => {
    expect(widthPercentFromPixels(310, 620)).toBe(50)
    expect(widthPercentFromPixels(310, 0)).toBe(100)
    expect(widthPercentFromPixels(Number.NaN, 620)).toBe(100)
    expect(widthPercentFromPixels(9999, 620)).toBe(100)
  })

  it('带宽度的图片往返 markdown 不丢尺寸', () => {
    const markdown = '<img src="assets/a1.png" alt="截图" width="62%">'
    expect(roundTripNoteMarkdown(markdown)).toBe(markdown)
  })

  it('countNoteChars 不计图片语法与空白', () => {
    expect(countNoteChars(' ## 标题\n\n![图](assets/a.png) 正文 ')).toBe(4)
    expect(countNoteChars('<img src="assets/a.png" width="50%">')).toBe(0)
  })
})

describe('T49-2 · 图片缩放（组件）', () => {
  it('选中图片后给出 25/50/75/100% 与原始尺寸；点击后写进 Markdown', async () => {
    let editor: Editor | null = null
    const { onCommit } = setup('![截图](assets/a1.png)', {
      onReady: (instance) => {
        editor = instance
      },
    })

    // 图片用 blob URL 渲染出来（port.resolve 同步命中）
    const image = await screen.findByTestId('note-image')
    expect(image.getAttribute('src')).toBe('blob:offearly/a1')

    // 选中图片节点（真实交互里是点击图片；jsdom 没有布局，直接走命令更确定）
    act(() => {
      let pos: number | null = null
      editor?.state.doc.descendants((node, position) => {
        if (node.type.name === 'image') pos = position
        return true
      })
      if (pos !== null) editor?.commands.setNodeSelection(pos)
    })

    const tools = await screen.findByTestId('note-image-tools')
    expect(tools).toBeTruthy()

    fireEvent.click(screen.getByTestId('note-image-width-50'))
    await waitFor(() => {
      expect(onCommit.mock.lastCall?.[0]).toContain('width="50%"')
    })

    // 「原始」清掉宽度，回到常规 Markdown 图片语法
    fireEvent.click(screen.getByTestId('note-image-width-reset'))
    await waitFor(() => {
      expect(onCommit.mock.lastCall?.[0]).toContain('![截图](assets/a1.png)')
    })
  })

  it('已带宽度的图片：百分比落在包装层（基准是编辑区宽度），图片自身填满包装层', async () => {
    setup('<img src="assets/a1.png" alt="截图" width="40%">')
    const image = await screen.findByTestId('note-image')
    // 百分比若直接给 <img>，包含块是 shrink-to-fit 的包装层 → 算出来是「原图宽度的 40%」而非编辑区
    const wrap = image.parentElement as HTMLElement
    expect(wrap.style.width).toBe('40%')
    expect(image.style.width).toBe('100%')
    // 手动缩放过就不再加高度上限，否则宽度被定死、高度被压 → 变形
    expect(image.style.maxHeight).toBe('')

    const handle = screen.getByTestId('note-image-resize')
    expect(handle.getAttribute('role')).toBe('slider')
    expect(handle.getAttribute('aria-valuenow')).toBe('40')
  })

  it('没缩放过的图片走自适应：只给高度上限，不写宽度', async () => {
    setup('![截图](assets/a1.png)')
    const image = await screen.findByTestId('note-image')
    expect(image.style.width).toBe('')
    expect(image.style.maxHeight).toBe('62vh')
    const wrap = image.parentElement as HTMLElement
    expect(wrap.style.width).toBe('')

    const handle = screen.getByTestId('note-image-resize')
    // 自适应档不假装是 100%：valuetext 明确说「自适应高度」
    expect(handle.getAttribute('aria-valuetext')).toContain('自适应')
  })
})

describe('T49-3 · Markdown 源码模式', () => {
  it('切到源码显示当前 Markdown；改完切回富文本仍然生效并提交', async () => {
    const { onCommit } = setup('## 已有标题\n\n正文一句')

    fireEvent.click(screen.getByTestId('note-mode-toggle'))
    const source = (await screen.findByTestId('note-source')) as HTMLTextAreaElement
    expect(source.value).toContain('## 已有标题')

    fireEvent.change(source, { target: { value: '# 新标题\n\n改写后的正文' } })
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalled()
    })

    fireEvent.click(screen.getByTestId('note-mode-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('note-editor').getAttribute('data-mode')).toBe('rich')
    })
    expect(screen.getByTestId('note-editor-content').textContent).toContain('改写后的正文')
  })

  it('源码模式里的图片写法保持原样（md 用户看的到尺寸）', async () => {
    setup('<img src="assets/a1.png" alt="截图" width="62%">')
    fireEvent.click(screen.getByTestId('note-mode-toggle'))
    const source = (await screen.findByTestId('note-source')) as HTMLTextAreaElement
    expect(source.value).toContain('width="62%"')
  })
})

describe('T49-4 · 排版、占位与字数', () => {
  it('空文档挂占位装饰（提示语来自 props / i18n），不写进内容', async () => {
    const onCommit = vi.fn()
    render(<NoteEditor value="" onCommit={onCommit} debounceMs={0} t={t()} placeholder="写点什么" />)
    await waitFor(() => {
      const empty = document.querySelector('.oe-note-empty')
      expect(empty?.getAttribute('data-placeholder')).toBe('写点什么')
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('字数随内容更新；关掉统计时不渲染', async () => {
    const { view } = setup('正文四个字')
    await waitFor(() => {
      expect(screen.getByTestId('note-char-count').textContent).toBe('5 字')
    })

    view.unmount()
    render(<NoteEditor value="x" onCommit={() => {}} showStats={false} t={t()} />)
    expect(screen.queryByTestId('note-char-count')).toBeNull()
  })
})
