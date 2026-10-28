// T64 · 按二级标题分页（知识库「展示模式」的纯数据层）。
//
// 为什么不按行/正则切 Markdown：围栏里的 `## 注释`、Setext 标题（`标题` + `-----`）、
// 转义、列表里缩进的 `## ` 都是同一个问题的不同面，正则版迟早要和主解析器（@tiptap/markdown）
// 产生两套口径。这里改成**先解析成文档树、再按顶层 heading(2) 切节点**，然后让同一个
// 序列化器把每页写回 Markdown —— 切分判据与编辑/导出完全同源。
//
// 口径：
//   ① 第一个二级标题之前的非空内容单独成「导言页」（标题为空字符串）；全是空段落则不成页；
//   ② 每个顶层 H2 开一页，页内容 = 该标题 + 到下一个 H2 之间的全部节点；
//   ③ 全文没有 H2（或空文档）时只有一页，内容就是全文——「展示模式」永不出现空白页。

import { Editor } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'

import { createNoteExtensions } from './NoteEditor'

export interface NotePage {
  /** 页标题（来自二级标题的纯文本）；导言页为 ''。 */
  title: string
  /** 该页的 Markdown 正文（由同一个序列化器写回，图片/表格/Mermaid 与编辑态一致）。 */
  markdown: string
}

function isHeading2(node: JSONContent): boolean {
  return node.type === 'heading' && node.attrs?.level === 2
}

/** 标题节点的纯文本（内联节点里取 text；图片/双链等原子节点不计）。 */
function headingText(node: JSONContent): string {
  const walk = (current: JSONContent): string => {
    if (typeof current.text === 'string') return current.text
    return (current.content ?? []).map(walk).join('')
  }
  return walk(node).trim()
}

/** 空段落（解析出来的「什么都没有」）不算内容，否则每篇文档都会多出一个空白导言页。 */
function isBlank(node: JSONContent): boolean {
  if (node.type !== 'paragraph') return false
  if ((node.content ?? []).length === 0) return true
  return (node.content ?? []).every((child) => child.type === 'hardBreak')
}

export function splitNotePages(markdown: string): NotePage[] {
  // 空正文直接给出「一页空内容」：TipTap 在 `content: ''` 时会去走 HTML 解析分支
  // （`elementFromString` 需要 window），而这一档本来就没有任何东西可切。
  if (markdown.trim() === '') return [{ title: '', markdown: '' }]
  const element = typeof document === 'undefined' ? undefined : document.createElement('div')
  // 用与产品完全相同的扩展集解析：换一套最小 schema 会在图片、表格、Mermaid 上分叉
  const editor = new Editor({
    element,
    extensions: createNoteExtensions(),
    content: markdown,
    contentType: 'markdown',
  })

  try {
    const nodes = editor.getJSON().content ?? []
    const leading: JSONContent[] = []
    const sections: { title: string; nodes: JSONContent[] }[] = []
    let target = leading
    for (const node of nodes) {
      if (isHeading2(node)) {
        const section = { title: headingText(node), nodes: [node] }
        sections.push(section)
        target = section.nodes
        continue
      }
      target.push(node)
    }

    /** 同一实例反复 setContent：切页只改它的内容，序列化口径永远只有一套。 */
    const toMarkdown = (pageNodes: readonly JSONContent[]): string => {
      editor.commands.setContent({ type: 'doc', content: [...pageNodes] }, { emitUpdate: false })
      return editor.getMarkdown()
    }

    const pages: NotePage[] = []
    if (leading.some((node) => !isBlank(node))) {
      pages.push({ title: '', markdown: toMarkdown(leading) })
    }
    for (const section of sections) {
      pages.push({ title: section.title, markdown: toMarkdown(section.nodes) })
    }
    // 空文档 / 只有空白：保留一页（内容为空串），让展示模式仍然成立
    if (pages.length === 0) pages.push({ title: '', markdown: '' })
    return pages
  } finally {
    editor.destroy()
  }
}
