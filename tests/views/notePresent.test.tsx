// @vitest-environment jsdom
//
// T64 · 标准 Markdown 链接 `[文本](URL)` 与按二级标题分页的展示模式。
//
// 链接这一半验的是**写**路径：此前只有 parseMarkdown 认得 `[]()`，手打或粘贴进来仍是
// 普通文字（StarterKit 的 Link 默认 `markdownLinks: false`）。所以这里不看「渲染出来的
// 链接长什么样」，而是「敲完最后一个字符之后，文档里到底有没有 link mark」。
//
// 分页这一半验的是**只读**：展示浮层不写库、不产生命令，翻页只换内容。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createI18n } from '../../src/locales/i18n'
import { NoteEditor, createNoteExtensions, roundTripNoteMarkdown } from '../../src/views/NoteEditor'
import { NotePresenter } from '../../src/views/NotePresenter'

function t(locale: 'zh' | 'en' = 'zh') {
  return createI18n({ getLocale: () => locale, subscribe: () => () => {} }).t
}

/** 逐字符走 ProseMirror 的 handleTextInput —— inputRules 插件就挂在 props.handleTextInput 上。 */
function typeText(editor: Editor, text: string): void {
  const { view } = editor
  for (const char of text) {
    const from = view.state.selection.from
    const handled = view.someProp('handleTextInput', (f) =>
      (f as (view: unknown, from: number, to: number, text: string) => boolean)(view, from, from, char),
    )
    if (handled !== true) view.dispatch(view.state.tr.insertText(char))
  }
}

function mountEditor(markdown = ''): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: createNoteExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
}

/** 把文档摊平成一串 `文本 → marks`，便于断言「这一段是不是链到某处」。 */
function linkMarks(editor: Editor): { text: string; href: unknown }[] {
  const out: { text: string; href: unknown }[] = []
  editor.state.doc.descendants((node) => {
    if (typeof node.text !== 'string') return true
    const mark = node.marks.find((candidate) => candidate.type.name === 'link')
    if (mark !== undefined) out.push({ text: node.text, href: mark.attrs.href })
    return true
  })
  return out
}

afterEach(cleanup)

describe('T64-11 · 手打 `[]()` 立即成链', () => {
  it('敲完右括号就变成链接，文本里只剩链接文字', () => {
    const editor = mountEditor()
    typeText(editor, '见 [文档](https://example.com) 一节')
    const marks = linkMarks(editor)
    expect(marks).toEqual([{ text: '文档', href: 'https://example.com' }])
    // 落盘的仍是标准 Markdown —— 不是 HTML 标签
    expect(editor.getMarkdown()).toContain('[文档](https://example.com)')
    editor.destroy()
  })

  it('带标题的写法 `[文](url "标题")` 标题进 title 属性', () => {
    const editor = mountEditor()
    typeText(editor, '[文](https://example.com "说明")')
    let title: unknown = null
    editor.state.doc.descendants((node) => {
      const mark = node.marks.find((candidate) => candidate.type.name === 'link')
      if (mark !== undefined) title = mark.attrs.title
      return true
    })
    expect(title).toBe('说明')
    editor.destroy()
  })

  it('围栏里的 `[]()` 不算链接（不是「看见方括号就转」）', () => {
    const editor = mountEditor('```\n[文档](https://example.com)\n```')
    expect(linkMarks(editor)).toEqual([])
    editor.destroy()
  })

  it('往返之后链接仍是 `[文本](href)`', () => {
    const once = roundTripNoteMarkdown('见 [文档](https://example.com)')
    expect(once).toContain('[文档](https://example.com)')
    expect(roundTripNoteMarkdown(once)).toBe(once)
  })
})

describe('T64-12 · 粘贴 Markdown 链接', () => {
  it('粘贴文本里的每一条 `[]()` 都成链，普通文字不动', () => {
    const editor = mountEditor()
    const payload = '甲 [一](https://a.example) 乙 [二](https://b.example/c?d=1) 丙'
    const dom = editor.view.dom
    fireEvent.paste(dom, {
      clipboardData: {
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? payload : ''),
      },
    })
    const marks = linkMarks(editor)
    expect(marks.map((mark) => mark.text)).toEqual(['一', '二'])
    expect(marks.map((mark) => mark.href)).toEqual(['https://a.example', 'https://b.example/c?d=1'])
    editor.destroy()
  })
})

describe('T64-13 · 只读编辑器', () => {
  it('不渲染工具栏与底栏，testid 换成长读版（同屏还有编辑实例）', async () => {
    render(
      <NoteEditor
        value={'## 一节\n\n正文'}
        onCommit={() => undefined}
        readOnly
        t={t()}
      />,
    )
    expect(screen.getByTestId('note-editor-readonly')).toBeTruthy()
    expect(screen.queryByTestId('note-editor-content')).toBeNull()
    // 工具栏的挂载条件是 editorReady（onCreate 里才置位），jsdom 里这一拍不一定已经发生，
    // 所以先让出一轮事件循环再断言——否则「工具栏没出现」可能只是因为还没创建完。
    await waitFor(() => expect(screen.getByTestId('note-editor-readonly')).toBeTruthy())
    expect(screen.queryByTestId('note-toolbar')).toBeNull()
    expect(screen.queryByTestId('note-statusbar')).toBeNull()
    expect(screen.queryByTestId('note-mode-toggle')).toBeNull()
  })

  it('链接可点：`<a>` 带 href / target=_blank / rel=noopener', () => {
    const { container } = render(
      <NoteEditor value={'[文档](https://example.com)'} onCommit={() => undefined} readOnly t={t()} />,
    )
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com')
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toContain('noopener')
  })

  it('只读下打字不改内容（也不触发 onCommit）', () => {
    const onCommit = vi.fn()
    const { container } = render(
      <NoteEditor value={'原文'} onCommit={onCommit} debounceMs={0} readOnly t={t()} />,
    )
    const editable = container.querySelector('[data-testid="note-editor-readonly"]')
    expect(editable?.getAttribute('contenteditable')).toBe('false')
    fireEvent.keyDown(editable ?? container, { key: 'A' })
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('T64-14 · 展示模式浮层', () => {
  const markdown = ['开场白', '', '## 甲', '', '内容甲', '', '## 乙', '', '内容乙'].join('\n')

  it('按二级标题分页，页眉显示页码', async () => {
    render(
      <NotePresenter open title="发布流程" markdown={markdown} onClose={vi.fn()} t={t()} />,
    )
    expect(screen.getByTestId('note-present-title').textContent).toBe('发布流程')
    expect(screen.getByTestId('note-present-counter').textContent).toContain('1 / 3')
    await waitFor(() => expect(screen.getByTestId('note-present-body').textContent).toContain('开场白'))
  })

  it('下一页 / 上一页改页码与内容，到端点即禁用', async () => {
    render(
      <NotePresenter open title="发布流程" markdown={markdown} onClose={vi.fn()} t={t()} />,
    )
    const next = screen.getByTestId('note-present-next') as HTMLButtonElement
    const prev = screen.getByTestId('note-present-prev') as HTMLButtonElement
    expect(prev.disabled).toBe(true)

    fireEvent.click(prev)
    expect(screen.getByTestId('note-present-counter').textContent).toContain('1 / 3')

    fireEvent.click(next)
    await waitFor(() => expect(screen.getByTestId('note-present-body').textContent).toContain('内容甲'))
    expect(screen.getByTestId('note-present-section').textContent).toBe('甲')

    fireEvent.click(next)
    await waitFor(() => expect(screen.getByTestId('note-present-body').textContent).toContain('内容乙'))
    expect(next.disabled).toBe(true)
  })

  it('方向键翻页，Esc 关闭', async () => {
    const onClose = vi.fn()
    render(<NotePresenter open title="发布流程" markdown={markdown} onClose={onClose} t={t()} />)

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByTestId('note-present-counter').textContent).toContain('2 / 3'))
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await waitFor(() => expect(screen.getByTestId('note-present-counter').textContent).toContain('1 / 3'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('没有 H2 的文档只有一页，翻页键两端都禁用', () => {
    render(<NotePresenter open title="随手记" markdown={'只有一段正文'} onClose={vi.fn()} t={t()} />)
    expect(screen.getByTestId('note-present-counter').textContent).toContain('1 / 1')
    expect((screen.getByTestId('note-present-prev') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('note-present-next') as HTMLButtonElement).disabled).toBe(true)
  })

  it('关闭状态不渲染浮层（不占 body）', () => {
    render(<NotePresenter open={false} title="发布流程" markdown={markdown} onClose={vi.fn()} t={t()} />)
    expect(screen.queryByTestId('note-present')).toBeNull()
  })
})
