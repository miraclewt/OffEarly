// T64 · 分页纯函数：切分判据必须与编辑器同源（同一套 @tiptap/markdown 解析）。
//
// 这里刻意用「真的解析器」而不是断言正则结果：围栏内 `##`、Setext 标题这些边界，
// 只有走主解析器才不会与编辑/导出产生两套口径。

import { describe, expect, it } from 'vitest'

import { splitNotePages } from '../../src/views/notePages'

const byTitle = (markdown: string) => splitNotePages(markdown).map((page) => page.title)

describe('T64-6 · 按二级标题分页', () => {
  it('首个 H2 前的内容是导言页，之后每个 H2 一页', () => {
    const pages = splitNotePages(
      ['开场白', '', '## 第一节', '', '甲', '', '## 第二节', '', '乙'].join('\n'),
    )
    expect(pages.map((page) => page.title)).toEqual(['', '第一节', '第二节'])
    expect(pages[0]?.markdown).toContain('开场白')
    expect(pages[1]?.markdown).toContain('第一节')
    expect(pages[1]?.markdown).toContain('甲')
    expect(pages[1]?.markdown).not.toContain('乙')
    expect(pages[2]?.markdown).toContain('乙')
  })

  it('没有 H2 → 只有一页，内容仍是全文', () => {
    const pages = splitNotePages('# 标题\n\n正文\n\n### 三级\n\n细节')
    expect(pages).toHaveLength(1)
    expect(pages[0]?.title).toBe('')
    expect(pages[0]?.markdown).toContain('# 标题')
    expect(pages[0]?.markdown).toContain('### 三级')
  })

  it('开头直接是 H2 → 没有空白导言页', () => {
    expect(byTitle('## 唯一一节\n\n内容')).toEqual(['唯一一节'])
  })

  it('连续两个 H2 → 各自成页（中间没有内容也不合并）', () => {
    const pages = splitNotePages('## 甲\n\n## 乙\n\n乙的内容')
    expect(pages.map((page) => page.title)).toEqual(['甲', '乙'])
    expect(pages[0]?.markdown.trim()).toBe('## 甲')
  })

  it('围栏代码块里的 ## 不分页', () => {
    const pages = splitNotePages(
      ['## 代码', '', '```bash', '## 这不是标题', '```', '', '## 下一节'].join('\n'),
    )
    expect(pages.map((page) => page.title)).toEqual(['代码', '下一节'])
    expect(pages[0]?.markdown).toContain('## 这不是标题')
  })

  it('Setext 下划线写法的二级标题同样分页（正则版会漏）', () => {
    expect(byTitle('第一节\n---\n\n内容')).toEqual(['第一节'])
  })

  it('空文档 → 一页空内容（展示模式不出现「零页」）', () => {
    const pages = splitNotePages('')
    expect(pages).toHaveLength(1)
    expect(pages[0]).toEqual({ title: '', markdown: '' })
  })

  it('只有空白 → 同样一页，且不产生多余空白导言页', () => {
    expect(splitNotePages('\n\n   \n')).toHaveLength(1)
  })

  it('页内保留图片与任务列表（不是把 Markdown 拆碎了了事）', () => {
    const pages = splitNotePages(
      ['## 图', '', '![示意](assets/pic1.png)', '', '- [ ] 待办', '- [x] 已完成'].join('\n'),
    )
    expect(pages[0]?.markdown).toContain('assets/pic1.png')
    expect(pages[0]?.markdown).toContain('- [ ]')
    expect(pages[0]?.markdown).toContain('- [x]')
  })
})
