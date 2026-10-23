// T58 · 大纲与反向链接的纯函数：不碰编辑器、不碰 store，直接对 Markdown 断言。

import { describe, expect, it } from 'vitest'

import { extractOutline, findBacklinks } from '../../src/domain/noteOutline'

describe('extractOutline', () => {
  it('按层级抽出标题，并记录顺序下标', () => {
    const md = '# 一级\n\n正文\n\n## 二级\n\n### 三级\n'
    expect(extractOutline(md)).toEqual([
      { level: 1, text: '一级', index: 0 },
      { level: 2, text: '二级', index: 1 },
      { level: 3, text: '三级', index: 2 },
    ])
  })

  it('代码围栏里的 # 注释不是标题', () => {
    const md = '# 标题\n\n```bash\n# 这是注释\n## 也不是标题\n```\n\n## 真标题\n'
    expect(extractOutline(md).map((item) => item.text)).toEqual(['标题', '真标题'])
  })

  it('去掉行内标记，只留可读文字；空标题丢弃', () => {
    const md = '## **粗** 与 `代码` 与 [链接](https://example.com)\n\n###   \n'
    expect(extractOutline(md)).toEqual([{ level: 2, text: '粗 与 代码 与 链接', index: 0 }])
  })

  it('七个 # 不算标题（Markdown 最多六级）', () => {
    expect(extractOutline('####### 不是标题\n')).toEqual([])
  })
})

describe('findBacklinks', () => {
  const docs = [
    { id: 'a', title: '甲', content: '提到 [[乙]] 一次' },
    { id: 'b', title: '乙', content: '自己引用自己 [[乙]]' },
    { id: 'c', title: '丙', content: '没有链接' },
  ]

  it('命中正文里的 [[标题]]，排除自己', () => {
    expect(findBacklinks(docs, '乙', 'b')).toEqual([{ id: 'a', title: '甲' }])
  })

  it('标题为空时不做全库匹配', () => {
    expect(findBacklinks(docs, '   ', 'b')).toEqual([])
  })

  it('大小写不敏感，且按标题精确匹配', () => {
    const mixed = [{ id: 'x', title: 'X', content: 'see [[api 设计]]' }]
    expect(findBacklinks(mixed, 'API 设计', 'y')).toEqual([{ id: 'x', title: 'X' }])
    expect(findBacklinks(mixed, 'API', 'y')).toEqual([])
  })
})
