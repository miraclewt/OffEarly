// T59 · 全局搜索的匹配规则：只测纯函数（渲染与键盘在 e2e 里验）。
import { describe, expect, it } from 'vitest'

import { PALETTE_LIMIT, matchDocs, matchTasks } from '../../src/views/CommandPalette'
import type { NoteDoc, Task } from '../../src/domain/types'

const NOW = '2026-10-23T09:00:00.000Z'

function task(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    topicId: 't1',
    title,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note: '',
    order: 'm',
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
    ...overrides,
  }
}

function doc(id: string, title: string, content = ''): NoteDoc {
  return { id, notebookId: 'nb', parentId: null, title, content, order: 'a', createdAt: NOW, updatedAt: NOW }
}

describe('matchTasks', () => {
  const tasks = [
    task('a', '支付对账文件解析', { note: '与财务确认口径' }),
    task('b', '风控规则评审', { tags: ['合规', '风控'] }),
    task('c', '已归档的支付任务', { archived: true }),
  ]

  it('命中标题、备注与标签', () => {
    expect(matchTasks(tasks, '对账').map((item) => item.id)).toEqual(['a'])
    expect(matchTasks(tasks, '财务').map((item) => item.id)).toEqual(['a'])
    expect(matchTasks(tasks, '合规').map((item) => item.id)).toEqual(['b'])
  })

  it('归档任务不出现在搜索里', () => {
    expect(matchTasks(tasks, '支付').map((item) => item.id)).toEqual(['a'])
  })

  it('空查询返回前若干条，且不超过上限', () => {
    const many = Array.from({ length: PALETTE_LIMIT + 4 }, (_, index) => task(`t${index}`, `任务 ${index}`))
    expect(matchTasks(many, '')).toHaveLength(PALETTE_LIMIT)
  })
})

describe('matchDocs', () => {
  const docs = [doc('d1', '发布流程', '回滚要先打快照'), doc('d2', '会议纪要', '讨论了发布窗口')]

  it('标题与正文都参与匹配', () => {
    expect(matchDocs(docs, '发布').map((item) => item.id)).toEqual(['d1', 'd2'])
    expect(matchDocs(docs, '快照').map((item) => item.id)).toEqual(['d1'])
  })

  it('大小写不敏感', () => {
    expect(matchDocs([doc('d3', 'API 设计', '')], 'api').map((item) => item.id)).toEqual(['d3'])
  })
})
