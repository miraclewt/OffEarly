// T82 · Markdown 导入：标题判定、front matter 解析、跳过规则、批量落库。

import { describe, expect, it } from 'vitest'

import {
  MD_IMPORT_MAX_BYTES,
  buildMarkdownEntries,
  buildMarkdownEntry,
  importMarkdownDocs,
  isMarkdownName,
  leadingHeading,
  parseFrontMatter,
  titleFromFilename,
} from '../../src/controllers/markdownImport'
import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Notebook, Vault } from '../../src/domain/types'

const NOW = '2026-11-02T09:00:00.000Z'

function notebook(id = 'nb1'): Notebook {
  return { id, name: 'AI 笔记', order: 'a', createdAt: NOW, updatedAt: NOW }
}

function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: 'OffEarly 0.7.0',
    revision: 1,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
      noteFontSize: 13,
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [notebook()],
    noteDocs: [],
    trash: [],
    whiteboards: [],
    ...overrides,
  }
}

function deps(start = 0): { newId: () => string; now: () => Date } {
  let n = start
  return {
    newId: () => {
      n += 1
      return `doc-${n}`
    },
    now: () => new Date(NOW),
  }
}

function entry(name: string, text: string) {
  return buildMarkdownEntry({ name, text })
}

function docOf(name: string, text: string) {
  const built = entry(name, text)
  if (built.doc === null) throw new Error(`预期可导入，实际被跳过：${built.skip ?? ''}`)
  return built.doc
}

describe('T82 · 标题判定', () => {
  it('正文开头的 H1 就是文档标题，且从正文里被提走', () => {
    const doc = docOf('note.md', '# 季度复盘\n\n## 数据\n\n- 一条\n')
    expect(doc.title).toBe('季度复盘')
    expect(doc.titleSource).toBe('heading')
    expect(doc.content).toBe('## 数据\n\n- 一条\n')
  })

  it('H1 不在开头（前面还有内容）时不算标题，改用文件名', () => {
    const doc = docOf('note.md', '## 数据\n\n# 小结\n')
    expect(doc.title).toBe('note')
    expect(doc.titleSource).toBe('filename')
    expect(doc.content).toBe('## 数据\n\n# 小结\n')
  })

  it('没有 H1 时取 front matter 的 title，front matter 一律剥掉', () => {
    const doc = docOf('note.md', '---\ntitle: 周报\n---\n正文\n')
    expect(doc.title).toBe('周报')
    expect(doc.titleSource).toBe('frontmatter')
    expect(doc.hadFrontMatter).toBe(true)
    expect(doc.content).toBe('正文\n')
  })

  it('front matter 与 H1 不一致时以正文里的 H1 为准', () => {
    const doc = docOf('note.md', '---\ntitle: 元数据标题\n---\n# 正文标题\n\n正文\n')
    expect(doc.title).toBe('正文标题')
    expect(doc.content).toBe('正文\n')
  })

  it('都没有时取文件名（去扩展名）', () => {
    const doc = docOf('季度复盘.markdown', '只是正文\n')
    expect(doc.title).toBe('季度复盘')
    expect(doc.titleSource).toBe('filename')
  })

  it('只有标题没有正文时也能导入（留下空正文）', () => {
    const doc = docOf('note.md', '# 只有标题\n')
    expect(doc.title).toBe('只有标题')
    expect(doc.content).toBe('')
  })

  it('`#标题` 没有空格不算标题（CommonMark 也不认）', () => {
    const doc = docOf('note.md', '#标题\n')
    expect(doc.titleSource).toBe('filename')
    expect(doc.content).toBe('#标题\n')
  })
})

describe('T82 · front matter 解析', () => {
  it('取 title 与行内数组的 tags', () => {
    const parsed = parseFrontMatter('---\ntitle: 周报\ntags: [工作, 周报]\n---\n正文\n')
    expect(parsed.title).toBe('周报')
    expect(parsed.tags).toEqual(['工作', '周报'])
    expect(parsed.body).toBe('正文\n')
  })

  it('支持列表式 tags 与引号值', () => {
    const parsed = parseFrontMatter('---\ntitle: "周报"\ntags:\n  - 工作\n  - 周报\n---\n正文\n')
    expect(parsed.title).toBe('周报')
    expect(parsed.tags).toEqual(['工作', '周报'])
  })

  it('没有闭合行时认定不是 front matter（正文里本来就有 --- 分隔线）', () => {
    const parsed = parseFrontMatter('---\ntitle: 周报\n\n正文\n---\n后半\n')
    expect(parsed.had).toBe(false)
    expect(parsed.body).toBe('---\ntitle: 周报\n\n正文\n---\n后半\n')
  })

  it('不认识的键一律忽略，不影响正文', () => {
    const parsed = parseFrontMatter('---\ndate: 2026-11-02\nauthor: 张三\nabc: xyz\n---\n正文\n')
    expect(parsed.title).toBe('')
    expect(parsed.tags).toEqual([])
    expect(parsed.had).toBe(true)
    expect(parsed.body).toBe('正文\n')
  })

  it('tags 落库前经过规格化（去重、限量）', () => {
    const doc = docOf('note.md', '---\ntags: [工作, 工作, 周报]\n---\n正文\n')
    expect(doc.tags).toEqual(['工作', '周报'])
  })
})

describe('T82 · 清洗与跳过', () => {
  it('CRLF 与 BOM 都被抹平', () => {
    const doc = docOf('note.md', '﻿# 标题\r\n\r\n正文\r\n')
    expect(doc.title).toBe('标题')
    expect(doc.content).toBe('正文\n')
  })

  it('行数与字节数供面板展示', () => {
    const doc = docOf('note.md', '# 标题\n\n一行\n两行\n')
    expect(doc.lines).toBe(2)
    expect(doc.bytes).toBeGreaterThan(0)
  })

  it('非 md 扩展名被跳过并说明原因', () => {
    const built = entry('report.docx', '# 标题\n')
    expect(built.doc).toBeNull()
    expect(built.skip).toBe('unsupported')
  })

  it('超过 2MB 的文件被跳过', () => {
    const big = `# 标题\n\n${'a'.repeat(MD_IMPORT_MAX_BYTES)}`
    const built = entry('big.md', big)
    expect(built.doc).toBeNull()
    expect(built.skip).toBe('tooLarge')
  })

  it('空文件被跳过（连标题都没有，导入只会得到一篇空笔记）', () => {
    const built = entry('empty.md', '   \n\n')
    expect(built.doc).toBeNull()
    expect(built.skip).toBe('empty')
  })

  it('.txt 也认（AI 常吐 txt，语法上是 md 的子集）', () => {
    expect(isMarkdownName('a.txt')).toBe(true)
    expect(isMarkdownName('a.MD')).toBe(true)
    expect(isMarkdownName('a.pdf')).toBe(false)
  })

  it('批量读文件保持入参顺序', () => {
    const entries = buildMarkdownEntries([
      { name: 'a.md', text: '# A\n' },
      { name: 'b.md', text: '# B\n' },
      { name: 'c.png', text: '' },
    ])
    expect(entries.map((item) => item.file)).toEqual(['a.md', 'b.md', 'c.png'])
    expect(entries[2]?.skip).toBe('unsupported')
  })
})

describe('T82 · 批量落库', () => {
  it('一次导入多篇：各成一条命令，排序键不撞', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    const docs = [
      docOf('a.md', '# A\n\n正文 A\n'),
      docOf('b.md', '# B\n\n正文 B\n'),
      docOf('c.md', '# C\n\n正文 C\n'),
    ]
    const ids = importMarkdownDocs(
      bus,
      store.getState().vault,
      { notebookId: 'nb1', docs, fallbackTitle: '未命名文档' },
      deps(),
    )
    expect(ids).toEqual(['doc-1', 'doc-2', 'doc-3'])
    const created = store.getState().vault.noteDocs
    expect(created.map((doc) => doc.title)).toEqual(['A', 'B', 'C'])
    expect(new Set(created.map((doc) => doc.order)).size).toBe(3)
    expect(created[0]!.content).toBe('正文 A\n')
  })

  it('front matter 的 tags 落成 NoteDoc.tags，没有标签时不落这个键', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    importMarkdownDocs(
      bus,
      store.getState().vault,
      {
        notebookId: 'nb1',
        docs: [docOf('a.md', '---\ntags: [工作]\n---\n正文\n'), docOf('b.md', '正文\n')],
        fallbackTitle: '未命名文档',
      },
      deps(),
    )
    const created = store.getState().vault.noteDocs
    expect(created[0]!.tags).toEqual(['工作'])
    expect(created[1]!.tags).toBeUndefined()
    expect('tags' in (created[1] as unknown as Record<string, unknown>)).toBe(false)
    expect(JSON.stringify(created[1])).not.toContain('tags')
  })

  it('撤销一次只回退一篇', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    importMarkdownDocs(
      bus,
      store.getState().vault,
      { notebookId: 'nb1', docs: [docOf('a.md', '# A\n'), docOf('b.md', '# B\n')], fallbackTitle: '未命名文档' },
      deps(),
    )
    expect(store.getState().vault.noteDocs).toHaveLength(2)
    bus.undo()
    expect(store.getState().vault.noteDocs.map((doc) => doc.title)).toEqual(['A'])
  })

  it('笔记本不存在时逐篇返回 null（不抛错、不落半成品）', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    const ids = importMarkdownDocs(
      bus,
      store.getState().vault,
      { notebookId: 'nope', docs: [docOf('a.md', '# A\n')], fallbackTitle: '未命名文档' },
      deps(),
    )
    expect(ids).toEqual([null])
    expect(store.getState().vault.noteDocs).toHaveLength(0)
  })
})

describe('T82 · 两个小工具', () => {
  it('leadingHeading 只认开头的一级标题', () => {
    expect(leadingHeading('# A\n\n正文')).toEqual({ title: 'A', rest: '正文' })
    expect(leadingHeading('正文\n\n# A')).toBeNull()
    expect(leadingHeading('## A')).toBeNull()
  })

  it('titleFromFilename 隐藏文件与多段扩展名', () => {
    expect(titleFromFilename('a.b.md')).toBe('a.b')
    expect(titleFromFilename('.md')).toBe('.md')
    expect(titleFromFilename('无扩展名')).toBe('无扩展名')
  })
})
