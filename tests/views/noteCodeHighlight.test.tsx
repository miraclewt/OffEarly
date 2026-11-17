// @vitest-environment jsdom
//
// T63 · 代码着色与 mermaid 源码收放（编辑器侧）。
//
// 两条口径值得单独钉住：
//  ① 着色是 inline decoration，**文档内容一个字都不能变**——它只往文字上叠样式类；
//  ② 收起源码只是显示状态，光标一进去必须自动展开，否则用户会在一段隐形文本里打字。

import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  return {
    render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"><g class="node"></g></svg>` })),
    initialize: vi.fn(),
  }
})

vi.mock('mermaid', () => ({
  default: { initialize: mocks.initialize, render: mocks.render },
}))

import { createNoteExtensions } from '../../src/views/NoteEditor'
import { resetMermaidCache } from '../../src/views/mermaid'

const LABELS = {
  rendering: '正在绘制图表…',
  error: '图表语法有误',
  collapse: '收起源码',
  expand: '展开源码',
}

let host: HTMLDivElement
let editor: Editor | null = null

function mount(markdown: string): Editor {
  host = document.createElement('div')
  document.body.appendChild(host)
  const instance = new Editor({
    element: host,
    extensions: createNoteExtensions(undefined, undefined, '', LABELS),
    content: markdown,
    contentType: 'markdown',
  })
  editor = instance
  return instance
}

beforeEach(() => {
  resetMermaidCache()
  mocks.render.mockClear()
})

afterEach(() => {
  editor?.destroy()
  editor = null
  host?.remove()
})

describe('代码着色', () => {
  it('js 代码块被切出关键字 / 字符串 / 数字 / 注释的装饰类', () => {
    mount('```js\nconst n = 12\n// 说明类名\nreturn "ok"\n```\n')

    const keywords = [...host.querySelectorAll('.oe-hl-kw')].map((node) => node.textContent)
    expect(keywords).toEqual(['const', 'return'])
    expect(host.querySelector('.oe-hl-num')?.textContent).toBe('12')
    expect(host.querySelector('.oe-hl-str')?.textContent).toBe('"ok"')
    expect(host.querySelector('.oe-hl-com')?.textContent).toBe('// 说明类名')
  })

  it('装饰不改文档：文本与 markdown 往返都与原文一致', () => {
    const markdown = '```js\nconst a = 1\n```\n'
    const instance = mount(markdown)

    // DOM 里已经插了 span 包裹的文字，但 ProseMirror 文档里仍是纯文本
    expect(host.querySelectorAll('.oe-hl-kw').length).toBe(1)
    expect(instance.state.doc.textContent).toBe('const a = 1')
    // 往返出来的 markdown 里不能混进装饰用的 span
    const roundTripped = instance.getMarkdown()
    expect(roundTripped).toContain('const a = 1')
    expect(roundTripped).not.toContain('oe-hl')
    expect(roundTripped).not.toContain('<span')
  })

  it('不认识的语言不着色，肉眼看上去与从前一样', () => {
    mount('```mermaid\nflowchart TD\n  A --> B\n```\n')
    expect(host.querySelectorAll('.oe-hl-kw, .oe-hl-str, .oe-hl-num, .oe-hl-com')).toHaveLength(0)
  })
})

describe('mermaid 源码收放', () => {
  const markdown = '```mermaid\nflowchart TD\n  A --> B\n```\n'

  it('默认展开：源码在、按钮写着「收起源码」', () => {
    mount(markdown)
    expect(host.querySelector('pre.oe-mermaid-src-collapsed')).toBeNull()

    const toggle = host.querySelector('[data-testid="note-mermaid-toggle"]')
    expect(toggle?.textContent).toBe('收起源码')
    expect(toggle?.getAttribute('data-collapsed')).toBe('false')
  })

  it('点按钮收起源码，再点展开', () => {
    const instance = mount(markdown)

    ;(host.querySelector('[data-testid="note-mermaid-toggle"]') as HTMLElement).click()
    expect(host.querySelector('pre.oe-mermaid-src-collapsed')).not.toBeNull()
    expect(host.querySelector('[data-testid="note-mermaid-toggle"]')?.textContent).toBe('展开源码')
    // 收起只是显示：文档内容照旧
    expect(instance.state.doc.textContent).toContain('flowchart TD')

    ;(host.querySelector('[data-testid="note-mermaid-toggle"]') as HTMLElement).click()
    expect(host.querySelector('pre.oe-mermaid-src-collapsed')).toBeNull()
  })

  it('光标进入被收起的代码块时自动展开', () => {
    // 块后面有正文：收起时能把光标挪出块外，之后再走进去就该展开
    const instance = mount('```mermaid\nflowchart TD\n  A --> B\n```\n\n后记\n')
    ;(host.querySelector('[data-testid="note-mermaid-toggle"]') as HTMLElement).click()
    expect(host.querySelector('pre.oe-mermaid-src-collapsed')).not.toBeNull()

    instance.commands.setTextSelection(3)
    expect(host.querySelector('pre.oe-mermaid-src-collapsed')).toBeNull()
  })

  it('块在文档末尾时：收起不会被立刻撤销，但一敲键盘就展开', () => {
    const instance = mount(markdown)
    ;(host.querySelector('[data-testid="note-mermaid-toggle"]') as HTMLElement).click()
    // 没有可挪的位置 → 光标留在块内，但收起状态必须站得住
    expect(host.querySelector('pre.oe-mermaid-src-collapsed')).not.toBeNull()

    instance.commands.insertContent('x')
    expect(host.querySelector('pre.oe-mermaid-src-collapsed')).toBeNull()
  })

  it('普通代码块没有收放按钮', () => {
    mount('```js\nconst a = 1\n```\n')
    expect(host.querySelector('[data-testid="note-mermaid-toggle"]')).toBeNull()
    expect(host.querySelector('[data-testid="note-mermaid-preview"]')).toBeNull()
  })
})
