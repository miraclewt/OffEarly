// @vitest-environment jsdom
//
// T50 · 笔记本导出的口径：
//  · 产物是**单个自包含 HTML**：没有外链 CSS/JS/图片，发给别人双击就能看；
//  · 图片宽度要从 `width="62%"` 改写成 `style="width:62%"`（HTML 的 width 属性只认像素）；
//  · 整本导出按文档树前序排列，并生成目录；
//  · mermaid 代码块渲染成内联 SVG；渲染失败时保留代码块（不静默吞掉）。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const render = vi.fn(async (id: string, text: string) => ({
    svg: `<svg id="${id}" aria-label="diagram"><text>${text}</text></svg>`,
  }))
  return { render, initialize: vi.fn() }
})

vi.mock('mermaid', () => ({
  default: { initialize: mocks.initialize, render: mocks.render },
}))

import {
  buildExportHtml,
  flattenWikiLinks,
  inlineAssetImages,
  markdownToExportHtml,
  renderMermaidInHtml,
  restoreImageWidths,
  sanitizeExportFilename,
  stripLeadingHeading,
  transformDocHtml,
  unescapeHtmlText,
} from '../../src/views/notebookExport'
import { resetMermaidCache } from '../../src/views/mermaid'

const META = {
  appName: 'OffEarly',
  exportedAt: '2026-10-22 21:30',
  kind: 'doc' as const,
  locale: 'zh' as const,
}

beforeEach(() => {
  resetMermaidCache()
  mocks.render.mockClear()
})

describe('sanitizeExportFilename', () => {
  it('去掉各平台非法字符，保留中文', () => {
    expect(sanitizeExportFilename('设计/方案: 第一版?')).toBe('设计 方案 第一版')
  })

  it('空标题退回兜底名', () => {
    expect(sanitizeExportFilename('   ', 'doc')).toBe('doc')
    expect(sanitizeExportFilename('///')).toBe('note')
  })

  it('超长标题截断', () => {
    expect(sanitizeExportFilename('长'.repeat(200)).length).toBeLessThanOrEqual(80)
  })
})

describe('unescapeHtmlText', () => {
  it('还原箭头与引号（mermaid 的 --> 会被序列化成 --&gt;）', () => {
    expect(unescapeHtmlText('A --&gt; B')).toBe('A --> B')
    expect(unescapeHtmlText('&quot;x&quot; &amp; &lt;y&gt;')).toBe('"x" & <y>')
  })
})

describe('restoreImageWidths', () => {
  it('把百分比宽度从属性搬进 style（属性会被浏览器丢弃）', () => {
    const out = restoreImageWidths('<p><img src="assets/a.png" alt="shot" width="62%"></p>')
    expect(out).toContain('style="width:62%;max-width:100%;height:auto"')
    expect(out).not.toContain('width="62%"')
    expect(out).toContain('src="assets/a.png"')
  })

  it('没有宽度属性的图片原样保留', () => {
    const tag = '<img src="assets/a.png" alt="">'
    expect(restoreImageWidths(tag)).toBe(tag)
  })
})

describe('flattenWikiLinks', () => {
  it('双链在导出文件里退化成普通文字', () => {
    const out = flattenWikiLinks(
      '<p>见 <span data-wiki-target="方案 A" style="color: red">[[方案 A]]</span></p>',
    )
    expect(out).toContain('<span class="wiki">方案 A</span>')
    expect(out).not.toContain('data-wiki-target')
  })
})

describe('stripLeadingHeading', () => {
  it('正文首个 H1 与文档标题相同时剥掉（页头已经在说这件事了）', () => {
    expect(stripLeadingHeading('<h1>发布流程</h1><p>正文</p>', '发布流程')).toContain('<p>正文</p>')
    expect(stripLeadingHeading('<h1>发布流程</h1><p>正文</p>', '发布流程')).not.toContain('<h1>')
  })

  it('不同名时保留——那是用户写的正文，不是元数据', () => {
    const html = '<h1>另一件事</h1><p>正文</p>'
    expect(stripLeadingHeading(html, '发布流程')).toBe(html)
  })

  it('只剥第一处；中间的同名 H1 是章节分隔', () => {
    const out = stripLeadingHeading('<h1>发布</h1><p>a</p><h1>发布</h1><p>b</p>', '发布')
    expect(out).toBe('<p>a</p><h1>发布</h1><p>b</p>')
  })
})

describe('markdownToExportHtml', () => {
  it('表格 / 任务列表 / 代码块都走编辑器同一套 schema', () => {
    const html = markdownToExportHtml(
      '# 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [x] 已完成\n- [ ] 未完成\n\n```js\nconst a = 1\n```\n',
    )
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<table')
    expect(html).toContain('data-type="taskList"')
    expect(html).toContain('language-js')
  })

  it('空内容返回空串', () => {
    expect(markdownToExportHtml('   ')).toBe('')
  })
})

describe('transformDocHtml · 代码着色', () => {
  it('导出的代码块带上的确是同一套 oe-hl-* 类名', async () => {
    const html = await transformDocHtml('```js\nconst n = 1 // 说明\n```\n')
    expect(html).toContain('class="oe-hl oe-hl-kw"')
    expect(html).toContain('class="oe-hl oe-hl-num"')
    expect(html).toContain('class="oe-hl oe-hl-com"')
    // 内容本身一个字都不能少（着色是插 span，不是替换文字）
    expect(html.replace(/<[^>]+>/g, '')).toContain('const n = 1 // 说明')
  })

  it('不认识的语言原样输出，不插 span', async () => {
    const html = await transformDocHtml('```mermaid\nflowchart TD\n  A --> B\n```\n')
    expect(html).not.toContain('oe-hl-')
  })

  it('代码里的尖括号被转义，不会被当成标签', async () => {
    const html = await transformDocHtml('```html\n<div class="a">x</div>\n```\n')
    expect(html).toContain('&lt;')
    expect(html).toContain('oe-hl-kw')
  })
})

describe('inlineAssetImages', () => {
  it('把 assets/ 图片换成 data URI，读不到的保留相对路径', async () => {
    const html = '<p><img src="assets/a.png"><img src="assets/b.png"></p>'
    const resolve = vi.fn(async (src: string) =>
      src === 'assets/a.png' ? 'data:image/png;base64,AAA' : null,
    )
    const out = await inlineAssetImages(html, resolve)
    expect(out).toContain('src="data:image/png;base64,AAA"')
    expect(out).toContain('src="assets/b.png"')
  })
})

describe('renderMermaidInHtml', () => {
  it('mermaid 围栏 → 内联 SVG，并作用域化 id', async () => {
    const out = await renderMermaidInHtml(
      '<pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>',
    )
    expect(out).toContain('<figure class="diagram">')
    expect(out).toContain('<svg')
    expect(out).not.toContain('<pre>')
    // 传给引擎的必须是**还原过实体**的源码，否则箭头会让 mermaid 解析失败
    expect(mocks.render).toHaveBeenCalledWith(expect.any(String), 'graph TD\nA-->B')
  })

  it('渲染失败时保留原始代码块', async () => {
    mocks.render.mockRejectedValueOnce(new Error('boom'))
    const out = await renderMermaidInHtml(
      '<pre><code class="language-mermaid">graph TD\nA--&gt;</code></pre>',
    )
    expect(out).toContain('language-mermaid')
    expect(out).not.toContain('<figure')
  })
})

describe('buildExportHtml', () => {
  it('单篇：自包含、标题与正文都在，没有外链资源', async () => {
    const { html, filename } = await buildExportHtml({
      docs: [{ title: '会议记录', content: '## 结论\n\n- 先做导出', depth: 0 }],
      meta: META,
    })
    expect(filename).toBe('会议记录.html')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>会议记录</title>')
    expect(html).toContain('<h2>结论</h2>')
    expect(html).toContain('<li><p>先做导出</p></li>')
    // 自包含：无外链样式表 / 脚本 / 图片
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/<script\b[^>]*src=/i)
    expect(html).not.toMatch(/\ssrc="https?:/i)
  })

  it('整本：按传入顺序成节，带目录与深度缩进', async () => {
    const { html, filename } = await buildExportHtml({
      docs: [
        { title: '根文档', content: '根正文', depth: 0 },
        { title: '子文档', content: '子正文', depth: 1 },
      ],
      meta: { ...META, kind: 'notebook', notebookName: '产品笔记' },
    })
    expect(filename).toBe('产品笔记.html')
    expect(html).toContain('<title>产品笔记</title>')
    expect(html).toContain('class="toc"')
    expect(html).toContain('href="#doc-1"')
    expect(html).toContain('href="#doc-2"')
    expect(html).toContain('padding-left:16px')
    // 顺序：根在前、子在后（目录与正文都要这个次序）
    expect(html.indexOf('<h1 class="doc-section-title">根文档</h1>')).toBeLessThan(
      html.indexOf('<h1 class="doc-section-title">子文档</h1>'),
    )
  })

  it('空文档给出可读提示而不是空白页', async () => {
    const { html } = await buildExportHtml({
      docs: [{ title: '空文档', content: '', depth: 0 }],
      meta: META,
    })
    expect(html).toContain('class="empty"')
    expect(html).toContain('这一篇还没有内容')
  })

  it('英文界面导出英文按钮文案', async () => {
    const { html } = await buildExportHtml({
      docs: [{ title: 'Notes', content: 'hi', depth: 0 }],
      meta: { ...META, locale: 'en' },
    })
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('Print / Save as PDF')
  })
})
