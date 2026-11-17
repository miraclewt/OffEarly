// T73 · 文档属性（标签 / 关联任务）的写入层。
//
// 这一层是「属性行」唯一碰数据的地方，所以断言落在 store 里到底有什么：
//  · 规格化（去空白、去重、限量）在写入之前完成；
//  · 与现值相同 → 零写入（不进撤销栈，不刷 revision）；
//  · 删空 → 键消失（老库形状），undo 能把键按原顺序加回来。

import { describe, expect, it } from 'vitest'

import {
  NOTE_TAG_LIMIT,
  NOTE_TAG_MAX_LENGTH,
  applySetDocTags,
  applyToggleDocTask,
  normalizeNoteTags,
} from '../../src/controllers/notebookActions'
import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { NoteDoc, Task, Vault } from '../../src/domain/types'

const NOW = '2026-10-31T02:00:00.000Z'

/**
 * 「键消失」的判定口径是**序列化之后**：内存里 `{...doc, ...patch}` 会留下一个值为 undefined 的
 * 键（JS 里 `in` 仍然为真），而真正要守的是写进 vault.json 的那份文本——JSON.stringify 会丢掉它。
 */
function serialized(doc: NoteDoc): string {
  return JSON.stringify(doc)
}

function task(id: string, title: string): Task {
  return {
    id,
    topicId: 't1',
    title,
    status: 'todo',
    kind: 'feature',
    priority: 'P2',
    progress: 0,
    tags: [],
    note: '',
    order: 'U',
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
  }
}

function doc(id: string, overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    id,
    notebookId: 'nb1',
    parentId: null,
    title: '周会纪要',
    content: '正文',
    order: 'U',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function setup(overrides: Partial<Vault> = {}) {
  const vault: Vault = {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: 'OffEarly 0.6.0',
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
    tasks: [task('k1', '对账接口'), task('k2', '支付回调')],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [{ id: 'nb1', name: '研发手册', order: 'U', createdAt: NOW, updatedAt: NOW }],
    noteDocs: [doc('d1')],
    trash: [],
    whiteboards: [],
    ...overrides,
  }
  const store = createVaultStore(vault)
  const bus = createCommandBus(store)
  const deps = { now: () => new Date(NOW) }
  const current = (): NoteDoc => {
    const found = store.getVault().noteDocs.find((item) => item.id === 'd1')
    if (found === undefined) throw new Error('文档不见了')
    return found
  }
  return { store, bus, deps, current }
}

describe('T73 · normalizeNoteTags', () => {
  it('去首尾空白、丢空串、按大小写不敏感去重', () => {
    expect(normalizeNoteTags([' 支付 ', '', 'pay', 'PAY', '支付'])).toEqual(['支付', 'pay'])
  })

  it('超长截断到上限长度，数量截断到上限条数', () => {
    const long = 'x'.repeat(NOTE_TAG_MAX_LENGTH + 10)
    expect(normalizeNoteTags([long])[0]).toHaveLength(NOTE_TAG_MAX_LENGTH)
    const many = Array.from({ length: NOTE_TAG_LIMIT + 3 }, (_, index) => `t${index}`)
    expect(normalizeNoteTags(many)).toHaveLength(NOTE_TAG_LIMIT)
  })

  it('保留输入顺序（用户打的第一个标签应该排第一）', () => {
    expect(normalizeNoteTags(['b', 'a', 'c'])).toEqual(['b', 'a', 'c'])
  })
})

describe('T73 · applySetDocTags', () => {
  it('写入标签并进撤销栈；undo 回到没有这个键的样子', () => {
    const { store, bus, deps, current } = setup()
    expect(serialized(current())).not.toContain('"tags"')

    expect(applySetDocTags(bus, store.getVault(), 'd1', [' 周会 ', '支付'], deps)).toBe(true)
    expect(current().tags).toEqual(['周会', '支付'])
    expect(current().updatedAt).toBe(NOW)

    bus.undo()
    expect(serialized(current())).not.toContain('"tags"')
  })

  it('规格化后与现值相同 → 零写入（不刷 revision，不进撤销栈）', () => {
    const { store, bus, deps, current } = setup({ noteDocs: [doc('d1', { tags: ['支付'] })] })
    const before = store.getVault().revision
    expect(applySetDocTags(bus, store.getVault(), 'd1', [' 支付 '], deps)).toBe(false)
    expect(store.getVault().revision).toBe(before)
    expect(current().tags).toEqual(['支付'])
    expect(bus.canUndo()).toBe(false)
  })

  it('删空标签 → 键消失（库文件回到老形状），undo 把整组按原顺序放回', () => {
    const { store, bus, deps, current } = setup({
      noteDocs: [doc('d1', { tags: ['周会', '支付'] })],
    })
    expect(applySetDocTags(bus, store.getVault(), 'd1', [], deps)).toBe(true)
    expect(serialized(current())).not.toContain('"tags"')

    bus.undo()
    expect(current().tags).toEqual(['周会', '支付'])
  })

  it('文档不存在时静默不动（不发命令，不抛错）', () => {
    const { store, bus, deps } = setup()
    expect(applySetDocTags(bus, store.getVault(), 'nope', ['x'], deps)).toBe(false)
    expect(bus.canUndo()).toBe(false)
  })
})

describe('T73 · applyToggleDocTask', () => {
  it('关联一个任务；再点一次取消关联，键随之消失', () => {
    const { store, bus, deps, current } = setup()

    expect(applyToggleDocTask(bus, store.getVault(), 'd1', 'k1', deps)).toBe(true)
    expect(current().taskIds).toEqual(['k1'])

    // 换一次快照：命令层读的是「当前库」，这里取最新的
    expect(applyToggleDocTask(bus, store.getVault(), 'd1', 'k2', deps)).toBe(true)
    expect(current().taskIds).toEqual(['k1', 'k2'])

    expect(applyToggleDocTask(bus, store.getVault(), 'd1', 'k1', deps)).toBe(true)
    expect(current().taskIds).toEqual(['k2'])

    expect(applyToggleDocTask(bus, store.getVault(), 'd1', 'k2', deps)).toBe(true)
    expect(serialized(current())).not.toContain('"taskIds"')

    // 四次动作 = 四条撤销项；撤到底回到没有 taskIds 的状态
    bus.undo()
    bus.undo()
    bus.undo()
    bus.undo()
    expect(serialized(current())).not.toContain('"taskIds"')
    expect(bus.canUndo()).toBe(false)
  })

  it('任务不存在时拒绝关联（避免留下解析不到的悬空 id）', () => {
    const { store, bus, deps, current } = setup()
    expect(applyToggleDocTask(bus, store.getVault(), 'd1', 'ghost', deps)).toBe(false)
    expect(serialized(current())).not.toContain('"taskIds"')
  })

  it('撤销恢复的是「关联」这个动作，不是整篇文档', () => {
    const { store, bus, deps, current } = setup()
    applyToggleDocTask(bus, store.getVault(), 'd1', 'k1', deps)
    expect(current().taskIds).toEqual(['k1'])
    bus.undo()
    expect(serialized(current())).not.toContain('"taskIds"')
    // 正文与标题没被这次撤销碰到
    expect(current().content).toBe('正文')
    expect(current().title).toBe('周会纪要')
  })
})
