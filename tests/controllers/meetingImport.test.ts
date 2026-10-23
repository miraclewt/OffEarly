// T62 · 会议导入：正文模板、去重令牌与批量建篇。

import { describe, expect, it } from 'vitest'

import {
  buildMeetingNote,
  collectMeetingKeys,
  importMeetingNotes,
  meetingKey,
} from '../../src/controllers/meetingImport'
import type { MeetingLabels } from '../../src/controllers/meetingImport'
import { createCommandBus } from '../../src/domain/commandBus'
import type { IcsEvent } from '../../src/domain/ics'
import { createVaultStore } from '../../src/domain/store'
import type { Notebook, NoteDoc, Vault } from '../../src/domain/types'

const NOW = '2026-10-23T12:00:00.000Z'

const LABELS: MeetingLabels = {
  info: '会议信息',
  time: '时间',
  location: '地点',
  organizer: '组织者',
  attendees: '参与人',
  recurring: '重复',
  recurringValue: '重复会议，本次只导入这一场',
  link: '会议链接',
  linkText: '加入会议',
  source: '导入源',
  invite: '原始邀请',
  decisions: '决议',
  todos: '待办',
  allDay: '全天',
  untitled: '未命名会议',
}

function event(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: 'uid-1',
    summary: '支付对账文件解析方案评审',
    start: '2026-10-23T14:00',
    end: '2026-10-23T15:00',
    dateKey: '2026-10-23',
    allDay: false,
    location: '3 楼会议室',
    organizer: '张三 (zhangsan@example.com)',
    attendees: [{ name: '李四', email: 'lisi@example.com', role: 'REQ-PARTICIPANT', status: 'ACCEPTED' }],
    description: '',
    url: '',
    recurring: false,
    ...overrides,
  }
}

function notebook(id = 'nb1'): Notebook {
  return { id, name: '会议纪要', order: 'a', createdAt: NOW, updatedAt: NOW }
}

function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: 'OffEarly 0.3.0',
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
    ...overrides,
  }
}

function doc(id: string, content: string, title = '旧笔记'): NoteDoc {
  return {
    id,
    notebookId: 'nb1',
    parentId: null,
    title,
    content,
    order: 'a',
    createdAt: NOW,
    updatedAt: NOW,
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

describe('T62 · 正文模板', () => {
  it('标题取会议主题，正文含时间 / 地点 / 参与人 / 三节结构', () => {
    const note = buildMeetingNote(event(), LABELS)
    expect(note.title).toBe('支付对账文件解析方案评审')
    expect(note.content).toContain('## 会议信息')
    expect(note.content).toContain('- 时间：2026-10-23 14:00–15:00')
    expect(note.content).toContain('- 地点：3 楼会议室')
    expect(note.content).toContain('- 组织者：张三 (zhangsan@example.com)')
    expect(note.content).toContain('- 参与人：@李四')
    expect(note.content).toContain('## 决议')
    expect(note.content).toContain('## 待办')
    expect(note.content.trimEnd().endsWith('- [ ]')).toBe(true)
  })

  it('主题为空时回落「未命名会议」', () => {
    expect(buildMeetingNote(event({ summary: '' }), LABELS).title).toBe('未命名会议')
  })

  it('全天事件只显示日期，末尾补「全天」', () => {
    const content = buildMeetingNote(
      event({ allDay: true, start: '2026-10-23T00:00', end: '2026-10-24T00:00' }),
      LABELS,
    ).content
    expect(content).toContain('- 时间：2026-10-23 · 全天')
  })

  it('跨天会议把两端日期都写出来', () => {
    const content = buildMeetingNote(
      event({ start: '2026-10-23T22:00', end: '2026-10-24T01:30' }),
      LABELS,
    ).content
    expect(content).toContain('2026-10-23 22:00 – 2026-10-24 01:30')
  })

  it('没有结束时间时只写起点', () => {
    const content = buildMeetingNote(event({ end: null }), LABELS).content
    expect(content).toContain('- 时间：2026-10-23 14:00')
  })

  it('重复会议注明「本次只导入这一场」', () => {
    expect(buildMeetingNote(event({ recurring: true }), LABELS).content).toContain(
      '- 重复：重复会议，本次只导入这一场',
    )
  })

  it('有会议链接时写成 Markdown 链接', () => {
    const content = buildMeetingNote(event({ url: 'https://example.com/join' }), LABELS).content
    expect(content).toContain('[加入会议](https://example.com/join)')
  })

  it('邀请正文整体进引用块，里面的 # 不会变成大纲标题', () => {
    const content = buildMeetingNote(
      event({ description: '# 议程\n1. 对账口径\n2. 文件格式' }),
      LABELS,
    ).content
    expect(content).toContain('> # 议程')
    expect(content).toContain('> 1. 对账口径')
    expect(content.split('\n').some((line) => line.startsWith('# 议程'))).toBe(false)
  })

  it('没有邀请正文时不出现「原始邀请」这一节', () => {
    expect(buildMeetingNote(event(), LABELS).content).not.toContain('## 原始邀请')
  })
})

describe('T62 · 去重令牌', () => {
  it('由 uid 与日期组成，同场会议稳定不变', () => {
    expect(meetingKey(event())).toBe('ics:uid-1@2026-10-23')
    expect(meetingKey(event())).toBe(meetingKey(event()))
  })

  it('uid 缺失时退化为「日期 + 主题」，不会退化成同一个键', () => {
    expect(meetingKey(event({ uid: '' }))).toBe('ics:~2026-10-23|支付对账文件解析方案评审@2026-10-23')
    expect(meetingKey(event({ uid: '', summary: '另一个会' }))).not.toBe(meetingKey(event({ uid: '' })))
  })

  it('令牌写进正文，可被反向扫出来', () => {
    const content = buildMeetingNote(event(), LABELS).content
    expect(content).toContain('ics:uid-1@2026-10-23')
    expect(collectMeetingKeys([doc('d1', content)]).has('ics:uid-1@2026-10-23')).toBe(true)
  })

  it('扫全库时也只认 ics: 令牌，不误伤普通正文', () => {
    const keys = collectMeetingKeys([
      doc('d1', '随便写的 ics 教程'),
      doc('d2', 'ics:uid-9@2026-10-20'),
      doc('d3', ''),
    ])
    expect([...keys]).toEqual(['ics:uid-9@2026-10-20'])
  })
})

describe('T62 · 批量建篇', () => {
  it('每场会议一篇，标题与顺序都跟着导入顺序', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    const events = [
      event({ uid: 'a', summary: '早会', start: '2026-10-23T09:00', end: '2026-10-23T09:30' }),
      event({ uid: 'b', summary: '晚会', start: '2026-10-23T16:00', end: '2026-10-23T17:00' }),
    ]
    const ids = importMeetingNotes(
      bus,
      store.getVault(),
      { notebookId: 'nb1', events, labels: LABELS },
      deps(),
    )
    expect(ids).toEqual(['doc-1', 'doc-2'])
    const docs = store.getVault().noteDocs
    expect(docs.map((item) => item.title)).toEqual(['早会', '晚会'])
    expect(docs.every((item) => item.notebookId === 'nb1')).toBe(true)
    expect(docs.every((item) => item.parentId === null)).toBe(true)
  })

  it('一次导入多篇也不撞排序键（旧快照会把 nextDocOrder 算成同一个键）', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    const events = [event({ uid: 'a' }), event({ uid: 'b' }), event({ uid: 'c' })]
    importMeetingNotes(bus, store.getVault(), { notebookId: 'nb1', events, labels: LABELS }, deps())
    const orders = store.getVault().noteDocs.map((item) => item.order)
    expect(new Set(orders).size).toBe(3)
  })

  it('同一批会议导入第二次：全部跳过，库不变', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    const events = [event({ uid: 'a' }), event({ uid: 'b' })]
    importMeetingNotes(bus, store.getVault(), { notebookId: 'nb1', events, labels: LABELS }, deps())
    const before = store.getVault().noteDocs
    const ids = importMeetingNotes(
      bus,
      store.getVault(),
      { notebookId: 'nb1', events, labels: LABELS },
      deps(10),
    )
    expect(ids).toEqual([null, null])
    expect(store.getVault().noteDocs).toBe(before)
  })

  it('传入已存在的令牌时跳过对应事件（面板侧的预判）', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    const events = [event({ uid: 'a' }), event({ uid: 'b' })]
    const ids = importMeetingNotes(
      bus,
      store.getVault(),
      { notebookId: 'nb1', events, labels: LABELS, existing: new Set(['ics:a@2026-10-23']) },
      deps(),
    )
    expect(ids).toEqual([null, 'doc-1'])
  })

  it('目标笔记本不存在时一篇也不建', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    const ids = importMeetingNotes(
      bus,
      store.getVault(),
      { notebookId: '不存在', events: [event()], labels: LABELS },
      deps(),
    )
    expect(ids).toEqual([null])
    expect(store.getVault().noteDocs).toHaveLength(0)
  })

  it('指定父级时导入成子文档', () => {
    const store = createVaultStore(vault({ noteDocs: [doc('parent', '')] }))
    const bus = createCommandBus(store)
    importMeetingNotes(
      bus,
      store.getVault(),
      { notebookId: 'nb1', events: [event()], labels: LABELS, parentId: 'parent' },
      deps(),
    )
    expect(store.getVault().noteDocs[1]?.parentId).toBe('parent')
  })

  it('每篇是一条独立命令：撤销一次只回退最后一篇', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    const events = [event({ uid: 'a' }), event({ uid: 'b' })]
    importMeetingNotes(bus, store.getVault(), { notebookId: 'nb1', events, labels: LABELS }, deps())
    expect(store.getVault().noteDocs).toHaveLength(2)
    bus.undo()
    expect(store.getVault().noteDocs.map((item) => item.title)).toEqual(['支付对账文件解析方案评审'])
  })
})
