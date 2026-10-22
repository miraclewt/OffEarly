// @vitest-environment jsdom
//
// T50 · Mermaid 渲染的口径：
//  · 只认 ```mermaid / ```mmd 两种语言标记（其它代码块一律不管）；
//  · 归一只影响渲染，不改写用户写的字；
//  · 同一个文档里出现两段相同代码时，SVG 内部的 id 必须被作用域化（否则 marker 会串）；
//  · 引擎只初始化一次、同一段代码只渲染一次；语法错误是**返回值**而不是异常。
//
// 这里 mock 掉真正的 mermaid：断言的是我们这层的行为，不是 mermaid 的语法解析。

import { Editor } from '@tiptap/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const render = vi.fn(async (id: string, text: string) => ({
    svg: `<svg id="${id}" data-code="${text}"><marker id="${id}-arrow"></marker><path marker-end="url(#${id}-arrow)"></path></svg>`,
  }))
  return { render, initialize: vi.fn() }
})

vi.mock('mermaid', () => ({
  default: { initialize: mocks.initialize, render: mocks.render },
}))

import {
  isMermaidLanguage,
  mermaidBlockRefs,
  normalizeMermaidCode,
  renderMermaidSvg,
  resetMermaidCache,
  scopeSvgIds,
} from '../../src/views/mermaid'
import { createNoteExtensions } from '../../src/views/NoteEditor'

function docOf(markdown: string) {
  const editor = new Editor({
    extensions: createNoteExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
  const doc = editor.state.doc
  editor.destroy()
  return doc
}

beforeEach(() => {
  resetMermaidCache()
  mocks.render.mockClear()
  mocks.initialize.mockClear()
})

describe('isMermaidLanguage', () => {
  it('认 mermaid 与 mmd，大小写与空白无关', () => {
    expect(isMermaidLanguage('mermaid')).toBe(true)
    expect(isMermaidLanguage(' MMD ')).toBe(true)
    expect(isMermaidLanguage('js')).toBe(false)
    expect(isMermaidLanguage(null)).toBe(false)
    expect(isMermaidLanguage(undefined)).toBe(false)
  })
})

describe('normalizeMermaidCode', () => {
  it('去掉首尾空行与行尾空白，保留内部缩进', () => {
    expect(normalizeMermaidCode('\n\nflowchart TD\n    A --> B   \n\n')).toBe(
      'flowchart TD\n    A --> B',
    )
  })

  it('统一换行符', () => {
    expect(normalizeMermaidCode('graph TD\r\nA-->B')).toBe('graph TD\nA-->B')
  })

  it('全空白视为空', () => {
    expect(normalizeMermaidCode('   \n\n  ')).toBe('')
  })
})

describe('scopeSvgIds', () => {
  it('给 id 与引用加作用域，且长 id 先替换（短 id 不会吃掉长 id 的前缀）', () => {
    const svg =
      '<svg id="oe-mermaid-1"><marker id="oe-mermaid-1-arrow"></marker><use href="#oe-mermaid-1-arrow"/><rect fill="url(#oe-mermaid-1-grad)"/></svg>'
    const scoped = scopeSvgIds(svg, 'ab12')
    expect(scoped).toContain('id="oe-mermaid-1-ab12"')
    expect(scoped).toContain('id="oe-mermaid-1-arrow-ab12"')
    expect(scoped).toContain('href="#oe-mermaid-1-arrow-ab12"')
    expect(scoped).toContain('url(#oe-mermaid-1-grad-ab12)')
    // 不能出现「作用域加了两遍」的那种脏结果
    expect(scoped).not.toContain('ab12-ab12')
  })

  it('CSS 里的 #id 选择器也要改——只改 id 会让节点配色全部失配（实测整张图变纯黑）', () => {
    const svg =
      '<svg id="oe-mermaid-1"><style>#oe-mermaid-1 .node rect{fill:#eef0ff}#oe-mermaid-1 .edgeLabel{color:#1d1d1f}</style><g class="node"><rect/></g></svg>'
    const scoped = scopeSvgIds(svg, 'zz')
    expect(scoped).toContain('#oe-mermaid-1-zz .node rect')
    expect(scoped).toContain('#oe-mermaid-1-zz .edgeLabel')
    expect(scoped).not.toContain('#oe-mermaid-1 .node')
  })

  it('短 id 的选择器不会吃掉长 id 选择器', () => {
    const svg =
      '<svg id="a"><defs><marker id="a-arrow"></marker></defs><style>#a-arrow{stroke:red}#a{fill:blue}</style></svg>'
    const scoped = scopeSvgIds(svg, 's1')
    expect(scoped).toContain('#a-arrow-s1{stroke:red}')
    expect(scoped).toContain('#a-s1{fill:blue}')
    // 颜色值（#eef0ff 这类）绝不能被当成 id 改写
    const tinted = scopeSvgIds('<svg id="a"><style>#a{fill:#eef0ff}</style></svg>', 's2')
    expect(tinted).toContain('fill:#eef0ff')
  })
})

describe('mermaidBlockRefs', () => {
  it('只挑出 mermaid 代码块，位置在块之后', () => {
    const doc = docOf('前言\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n后记\n\n```js\nconst a = 1\n```\n')
    const refs = mermaidBlockRefs(doc)
    expect(refs).toHaveLength(1)
    expect(refs[0]?.code).toBe('flowchart TD\n  A --> B')
    expect(refs[0]?.after).toBeGreaterThan(0)
  })

  it('空代码块不产生预览', () => {
    const doc = docOf('```mermaid\n\n\n```\n')
    expect(mermaidBlockRefs(doc)).toHaveLength(0)
  })
})

describe('renderMermaidSvg', () => {
  it('成功时返回 svg，并且只初始化一次引擎', async () => {
    const first = await renderMermaidSvg('graph TD\nA-->B')
    const second = await renderMermaidSvg('graph LR\nC-->D')
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(mocks.initialize).toHaveBeenCalledTimes(1)
    expect(mocks.render).toHaveBeenCalledTimes(2)
  })

  it('同一段代码只渲染一次（编辑器每次事务都会重算装饰）', async () => {
    const code = 'graph TD\nA-->B'
    const first = await renderMermaidSvg(code)
    const second = await renderMermaidSvg(`\n\n${code}\n`)
    expect(mocks.render).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('语法错误是返回值：ok=false + 第一行原因，并且失败也缓存', async () => {
    mocks.render.mockRejectedValueOnce(new Error('Parse error on line 2\nmore detail\nmore'))
    const result = await renderMermaidSvg('graph TD\nA-->')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('Parse error on line 2')
    expect(result.detail).toContain('more detail')

    const again = await renderMermaidSvg('graph TD\nA-->')
    expect(again.ok).toBe(false)
    expect(mocks.render).toHaveBeenCalledTimes(1)
  })

  it('空代码不调引擎', async () => {
    const result = await renderMermaidSvg('   ')
    expect(result.ok).toBe(false)
    expect(mocks.render).not.toHaveBeenCalled()
  })
})
