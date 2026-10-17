// @vitest-environment jsdom
//
// T24 附：TaskDrawer ↔ NoteEditor 的**接线**测试（与 NoteEditor.test.tsx 分开的文件，
// 因为这里要把 NoteEditor 换成桩组件以捕获 TaskDrawer 传下去的 props；vi.mock 是文件级作用域）。
//
// 为什么值得单测这一层：T24 对 TaskDrawer 的改动就是「把第 ⑤ 分区的占位换成真组件 + 接上写路径」，
// 而 NoteEditor 自身的行为已由 NoteEditor.test.tsx 覆盖。这里只验接线三件事：
//   ① value 取 task.note；② linkTargets 含全库任务 + 里程碑；
//   ③ onCommit 确实经 patchTaskCommand 落库（store 更新 + CommandBus 撤销栈可回退）。

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Task, Topic, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import type { NoteEditorProps } from '../../src/views/NoteEditor'
import { TaskDrawer } from '../../src/views/TaskDrawer'

let captured: NoteEditorProps | null = null

vi.mock('../../src/views/NoteEditor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/views/NoteEditor')>()
  return {
    ...actual,
    NoteEditor: (props: NoteEditorProps) => {
      captured = props
      return <div data-testid="note-editor-stub" data-value={props.value} />
    },
  }
})

const NOW = '2026-10-16T09:00:00.000Z'

function topic(id: string, name: string): Topic {
  return { id, name, color: '#4F46E5', parentId: null, order: 'a', archived: false }
}

function task(id: string, note: string): Task {
  return {
    id,
    topicId: 't1',
    title: `任务 ${id}`,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note,
    order: 'm',
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
  }
}

function makeVault(): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v-note-wiring',
    appVersion: '0.1.0',
    revision: 0,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
    },
    topics: [topic('t1', '前端')],
    tasks: [task('x', '原笔记'), task('y', '别的笔记')],
    milestones: [{ id: 'm1', topicId: 't1', title: 'v1.0 发布', date: '2026-10-30', done: false }],
    links: [],
    assets: [],
    mindmaps: [],
  }
}

afterEach(() => {
  captured = null
  cleanup()
})

const t = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t

describe('T24-7 · TaskDrawer → NoteEditor 接线', () => {
  it('value 取当前任务笔记；linkTargets 含全库任务 + 里程碑', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    render(<TaskDrawer store={store} bus={bus} t={t} open taskId="x" />)

    expect(captured).not.toBeNull()
    const props = captured as unknown as NoteEditorProps
    expect(props.value).toBe('原笔记')
    expect(props.linkTargets).toEqual([
      { id: 'x', kind: 'task', title: '任务 x' },
      { id: 'y', kind: 'task', title: '任务 y' },
      { id: 'm1', kind: 'milestone', title: 'v1.0 发布' },
    ])
  })

  it('onCommit → patchTaskCommand：store 更新、进撤销栈、undo 可回退', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    render(<TaskDrawer store={store} bus={bus} t={t} open taskId="x" />)

    const props = captured as unknown as NoteEditorProps
    expect(bus.canUndo()).toBe(false)

    props.onCommit('## 新笔记\n')

    expect(store.getVault().tasks.find((item) => item.id === 'x')?.note).toBe('## 新笔记\n')
    expect(bus.canUndo()).toBe(true)
    expect(bus.undoDepth()).toBe(1)

    // 撤销回到编辑前的笔记，重做再回来——证明走的是 CommandBus 的撤销栈而非野写
    bus.undo()
    expect(store.getVault().tasks.find((item) => item.id === 'x')?.note).toBe('原笔记')
    bus.redo()
    expect(store.getVault().tasks.find((item) => item.id === 'x')?.note).toBe('## 新笔记\n')
  })

  it('换任务即重挂：value 跟随选中任务（防 debounce 串写）', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const view = render(<TaskDrawer store={store} bus={bus} t={t} open taskId="x" />)
    expect((captured as unknown as NoteEditorProps).value).toBe('原笔记')

    view.rerender(<TaskDrawer store={store} bus={bus} t={t} open taskId="y" />)
    expect((captured as unknown as NoteEditorProps).value).toBe('别的笔记')
  })

  it('onNavigateNoteLink 透传给组件的 onNavigate（接线归集成窗口，此处只验透传位）', () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const onNavigateNoteLink = vi.fn()
    render(
      <TaskDrawer store={store} bus={bus} t={t} open taskId="x" onNavigateNoteLink={onNavigateNoteLink} />,
    )
    const props = captured as unknown as NoteEditorProps
    props.onNavigate?.('任务 y', [{ id: 'y', kind: 'task', title: '任务 y' }])
    expect(onNavigateNoteLink).toHaveBeenCalledWith('任务 y', [{ id: 'y', kind: 'task', title: '任务 y' }])
  })
})
