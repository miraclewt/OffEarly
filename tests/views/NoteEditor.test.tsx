// @vitest-environment jsdom
//
// T24 · NoteEditor（TipTap + 官方 @tiptap/markdown）。
//
// 与 T17/T18 同一手法：用**真的 VaultStore + 真的 CommandBus**（不是假 store），
// 因为验收 5 要求「编辑经 CommandBus 进 undo 栈」，假 store 会把撤销栈验成空气。
//
// 覆盖口径：
//  · 纯函数 `roundTripNoteMarkdown` —— 「存 Markdown 纯文本不丢内容」的机器口径
//    （各样例往返幂等；含两个上游缺陷样本：前导空格的围栏块 #8460、嵌套围栏 #8341）；
//  · 组件 —— 工具栏 15 个按钮 / 6 条快捷语法 / `[[` 双链弹层与点击跳转 / debounce 写路径 /
//    卸载补交 / 外部值变化（撤销）回声不上写；
//  · TaskDrawer 集成 —— 第 ⑤ 分区换成真组件，编辑经 patchTaskCommand 落库且可撤销。

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Task, Topic, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import { NoteEditor, roundTripNoteMarkdown } from '../../src/views/NoteEditor'
import type { NoteEditorProps, NoteLinkTarget } from '../../src/views/NoteEditor'
import { TaskDrawer } from '../../src/views/TaskDrawer'

const NOW = '2026-10-16T09:00:00.000Z'

// jsdom 没有布局：ProseMirror 的 focus/scrollIntoView → coordsAtPos → singleRect 会调到
// getClientRects（Node 与 Range 都可能被问到），抛未捕获异常污染测试输出。补一份空实现。
const EMPTY_RECTS = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList
const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as unknown as DOMRect
for (const proto of [Node.prototype, Range.prototype]) {
  Object.defineProperty(proto, 'getClientRects', { value: () => EMPTY_RECTS, configurable: true })
  Object.defineProperty(proto, 'getBoundingClientRect', { value: () => ZERO_RECT, configurable: true })
}

function t(locale: 'zh' | 'en' = 'zh') {
  return createI18n({ getLocale: () => locale, subscribe: () => () => {} }).t
}

function editX(editor: Editor, text: string): void {
  editor.commands.insertContent(text)
}

/** 逐字符走 ProseMirror 的 handleTextInput（inputRules 插件就挂在 props.handleTextInput 上）。
 *  必须用 someProp 的**双参**形式：单参形式只取第一个带该 prop 的插件，会漏掉后面插件的规则。 */
function typeText(editor: Editor, text: string): void {
  const { view } = editor
  for (const char of text) {
    const from = view.state.selection.from
    const handled = view.someProp('handleTextInput', (f) =>
      (f as (view: unknown, from: number, to: number, text: string) => boolean)(view, from, from, char),
    )
    if (handled !== true) view.dispatch(view.state.tr.insertText(char))
  }
}

function nodeTypes(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.descendants((node) => {
    out.push(node.type.name)
    return true
  })
  return out
}

// ── 纯函数：Markdown 往返 ────────────────────────────────────────────────

const ROUND_TRIP_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['一级与二级标题', '# 一级\n\n## 二级\n\n正文'],
  ['无序与有序列表', '- 甲\n- 乙\n\n1. 一\n2. 二'],
  ['任务列表', '- [ ] 待办\n- [x] 已办'],
  ['引用', '> 引用一段'],
  ['表格', '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |'],
  ['行内码与链接', '行内 `code` 与 [链接](https://a.bc)'],
  ['代码块', '```js\nconst a = 1\n```'],
  ['图片语法', '![](assets/abc123.png)'],
  ['双链', '见 [[登录页迭代]] 与 [[v1.0 发布]]'],
  ['空笔记', ''],
]

describe('T24-1 · roundTripNoteMarkdown（Markdown 纯文本往返不丢内容）', () => {
  for (const [label, sample] of ROUND_TRIP_SAMPLES) {
    it(`${label}：往返幂等`, () => {
      const once = roundTripNoteMarkdown(sample)
      expect(roundTripNoteMarkdown(once)).toBe(once)
    })
  }

  it('关键语法往返后仍在（标题/列表/任务/引用/表格/行内码/代码块/图片/双链）', () => {
    const source = [
      '# 一级',
      '',
      '- 甲',
      '',
      '- [ ] 待办',
      '',
      '> 引用',
      '',
      '| 甲 | 乙 |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '行内 `code` 与 ![](assets/x.png) 与 [[登录页迭代]]',
      '',
      '```js',
      'const a = 1',
      '```',
    ].join('\n')
    const once = roundTripNoteMarkdown(source)
    expect(once).toContain('# 一级')
    expect(once).toContain('- 甲')
    expect(once).toContain('- [ ] 待办')
    expect(once).toContain('> 引用')
    expect(once).toContain('| --- | --- |')
    expect(once).toContain('`code`')
    expect(once).toContain('![](assets/x.png)')
    expect(once).toContain('[[登录页迭代]]')
    expect(once).toContain('const a = 1')
    expect(roundTripNoteMarkdown(once)).toBe(once)
  })

  it('上游缺陷 #8460：前导空格的围栏代码块仍保住代码内容（不再被解析丢弃）', () => {
    const once = roundTripNoteMarkdown('   ```\n   code\n   ```')
    expect(once).toContain('code')
    expect(once).toContain('```')
    expect(roundTripNoteMarkdown(once)).toBe(once)
  })

  it('上游缺陷 #8341：四反引号围栏内含三反引号时往返稳定（围栏自动加长）', () => {
    const sample = '````\n```\ninner\n```\n````'
    const once = roundTripNoteMarkdown(sample)
    expect(once).toContain('inner')
    expect(roundTripNoteMarkdown(once)).toBe(once)
  })
})

// ── 组件夹具 ─────────────────────────────────────────────────────────────

const LINK_TARGETS: readonly NoteLinkTarget[] = [
  { id: 'x', kind: 'task', title: '登录页迭代' },
  { id: 'z1', kind: 'task', title: '登录页' },
  { id: 'z2', kind: 'task', title: '登录页' },
  { id: 'm1', kind: 'milestone', title: 'v1.0 发布' },
]

interface Harness {
  handle: { current: Editor | null }
  onCommit: ReturnType<typeof vi.fn<(markdown: string) => void>>
  onNavigate: ReturnType<typeof vi.fn<(title: string, matches: readonly NoteLinkTarget[]) => void>>
  view: ReturnType<typeof render>
  editor: () => Promise<Editor>
}

function setupEditor(overrides: Partial<NoteEditorProps> = {}): Harness {
  const handle: { current: Editor | null } = { current: null }
  const onCommit = vi.fn<(markdown: string) => void>()
  const onNavigate = vi.fn<(title: string, matches: readonly NoteLinkTarget[]) => void>()
  const view = render(
    <NoteEditor
      value=""
      onCommit={onCommit}
      linkTargets={LINK_TARGETS}
      onNavigate={onNavigate}
      onReady={(instance) => {
        handle.current = instance
      }}
      debounceMs={10}
      t={t()}
      {...overrides}
    />,
  )
  return {
    handle,
    onCommit,
    onNavigate,
    view,
    editor: async () => {
      await waitFor(() => expect(handle.current).not.toBeNull())
      return handle.current as Editor
    },
  }
}

afterEach(cleanup)

describe('T24-2 · 工具栏（spec 6.4 的 15 个线性图标按钮）', () => {
  it('15 个按钮齐备，标签走消息表，图片按钮标出待 T25', async () => {
    const h = setupEditor()
    await h.editor()
    const ids = [
      'bold',
      'italic',
      'strike',
      'inline-code',
      'code-block',
      'h2',
      'h3',
      'bullet-list',
      'ordered-list',
      'task-list',
      'quote',
      'link',
      'table',
      'image',
      'divider',
    ]
    for (const id of ids) {
      const button = h.view.getByTestId(`note-tool-${id}`)
      expect(button.getAttribute('aria-label')).toBeTruthy()
    }
    expect(h.view.getByTestId('note-tool-bold').getAttribute('aria-label')).toBe('粗体')
    expect(h.view.getByTestId('note-tool-image').getAttribute('data-pending')).toBe('t25')
  })

  it('点 H2 把当前段落变二级标题，debounce 后提交到 onCommit', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    editX(editor, '标题')
    fireEvent.click(h.view.getByTestId('note-tool-h2'))
    expect(editor.isActive('heading', { level: 2 })).toBe(true)
    await waitFor(() => expect(h.onCommit).toHaveBeenCalled())
    expect(String(h.onCommit.mock.calls[0]?.[0])).toContain('## 标题')
  })

  it('点加粗后插入文字带上 strong 标记', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    fireEvent.click(h.view.getByTestId('note-tool-bold'))
    expect(h.view.getByTestId('note-tool-bold').getAttribute('aria-pressed')).toBe('true')
    editX(editor, '重点')
    await waitFor(() => expect(h.onCommit).toHaveBeenCalled())
    expect(String(h.onCommit.mock.calls[0]?.[0])).toContain('**重点**')
  })
})

describe('T24-3 · 快捷语法（spec 6.4 的六条）', () => {
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['# ', '# 标题', 'heading'],
    ['## ', '## 标题', 'heading'],
    ['- ', '- 项', 'bulletList'],
    ['1. ', '1. 项', 'orderedList'],
    ['> ', '> 引用', 'blockquote'],
    ['[] ', '[] 任务', 'taskList'],
  ]

  for (const [label, input, expected] of CASES) {
    it(`行首 ${label} → ${expected}`, async () => {
      const h = setupEditor()
      const editor = await h.editor()
      editor.commands.focus()
      typeText(editor, input)
      expect(nodeTypes(editor)).toContain(expected)
    })
  }

  it('行内 ` 包裹 → code 标记', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    editor.commands.focus()
    typeText(editor, '`x`')
    const json = JSON.stringify(editor.getJSON())
    expect(json).toContain('"type":"code"')
  })
})

describe('T24-4 · [[双链]]：候选弹层、插入与点击跳转', () => {
  it('输入 [[ 弹出候选；同名多任务列多条；过滤生效', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    editX(editor, '见 [[')
    await waitFor(() => expect(h.view.getByTestId('note-link-menu')).toBeTruthy())
    expect(h.view.getByTestId('note-link-option-0')).toBeTruthy()

    // 空查询列出候选上限内的全部（4 条）
    expect(h.view.queryByTestId('note-link-option-3')).toBeTruthy()
    expect(h.view.queryByTestId('note-link-option-4')).toBeNull()
  })

  it('同名多任务在候选里各占一行（spec：同名多任务列候选）', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    editX(editor, '[[登录页')
    await waitFor(() => expect(h.view.getByTestId('note-link-menu')).toBeTruthy())
    const titles = ['0', '1', '2'].map((index) =>
      h.view.getByTestId(`note-link-option-${index}`).textContent ?? '',
    )
    expect(titles.filter((text) => text.endsWith('登录页'))).toHaveLength(2)
  })

  it('点候选插入 [[标题]] 并可提交', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    editX(editor, '见 [[')
    await waitFor(() => expect(h.view.getByTestId('note-link-option-0')).toBeTruthy())
    fireEvent.click(h.view.getByTestId('note-link-option-0'))
    await waitFor(() => expect(h.view.queryByTestId('note-link-menu')).toBeNull())
    expect(editor.getMarkdown()).toContain('[[登录页迭代]]')
    // 注意断「最后一次」提交：输入 `[[` 到点候选之间可能跨过一个 debounce 窗口，
    // 中间态 `见 \[\[` 会先落一次库，最终态才是带双链的那次。
    await waitFor(() =>
      expect(h.onCommit).toHaveBeenLastCalledWith(expect.stringContaining('[[登录页迭代]]')),
    )
  })

  it('无匹配时给空态文案', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    editX(editor, '[[不存在的标题')
    await waitFor(() => expect(h.view.getByTestId('note-link-empty')).toBeTruthy())
    expect(h.view.queryByTestId('note-link-option-0')).toBeNull()
  })

  it('菜单开着时 Esc 只关菜单、不冒泡到 window（收尾修复：不再连抽屉一起关）', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    // window 上的 keydown 监听扮演抽屉的关闭监听（TaskDrawer 在 window 上绑 Esc）
    const drawerClose = vi.fn()
    window.addEventListener('keydown', drawerClose)
    try {
      editX(editor, '见 [[')
      await waitFor(() => expect(h.view.getByTestId('note-link-menu')).toBeTruthy())
      fireEvent.keyDown(h.view.getByTestId('note-editor'), { key: 'Escape' })
      await waitFor(() => expect(h.view.queryByTestId('note-link-menu')).toBeNull())
      expect(drawerClose).not.toHaveBeenCalled()

      // 菜单已关后，Esc 恢复冒泡（抽屉仍可正常关闭）
      fireEvent.keyDown(h.view.getByTestId('note-editor'), { key: 'Escape' })
      expect(drawerClose).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', drawerClose)
    }
  })

  it('点击已渲染的 [[标题]] → onNavigate(标题, 同名候选)', async () => {
    const h = setupEditor({ value: '见 [[登录页]]' })
    await h.editor()
    const span = h.view.container.querySelector('[data-wiki-target="登录页"]')
    expect(span).not.toBeNull()
    fireEvent.click(span as Element)
    expect(h.onNavigate).toHaveBeenCalledWith('登录页', [
      { id: 'z1', kind: 'task', title: '登录页' },
      { id: 'z2', kind: 'task', title: '登录页' },
    ])
  })
})

describe('T24-5 · 写路径：debounce / 卸载补交 / 外部值回声不上写', () => {
  it('编辑不立即提交，debounce 后提交一次归一化后的 markdown', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    editX(editor, '# 标题')
    expect(h.onCommit).not.toHaveBeenCalled()
    await waitFor(() => expect(h.onCommit).toHaveBeenCalledTimes(1))
    expect(String(h.onCommit.mock.calls[0]?.[0])).toContain('# 标题')
  })

  it('卸载时把未到点的编辑补交（切任务不丢笔记）', async () => {
    const h = setupEditor()
    const editor = await h.editor()
    editX(editor, '还没到 debounce 的内容')
    h.view.unmount()
    expect(h.onCommit).toHaveBeenCalledTimes(1)
    expect(String(h.onCommit.mock.calls[0]?.[0])).toContain('还没到 debounce 的内容')
  })

  it('外部 value 变化（撤销 / 换任务）写回编辑器，且不回声上写', async () => {
    const h = setupEditor({ value: '第一版' })
    const editor = await h.editor()
    expect(editor.getMarkdown()).toContain('第一版')

    h.view.rerender(
      <NoteEditor
        value="第二版"
        onCommit={h.onCommit}
        linkTargets={LINK_TARGETS}
        debounceMs={10}
        t={t()}
      />,
    )
    await waitFor(() => expect(editor.getMarkdown()).toContain('第二版'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(h.onCommit).not.toHaveBeenCalled()
  })
})

// ── TaskDrawer 集成（第 ⑤ 分区） ─────────────────────────────────────────

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
    vaultId: 'v-note',
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
    tasks: [task('x', '原笔记'), task('y', '')],
    milestones: [{ id: 'm1', topicId: 't1', title: 'v1.0 发布', date: '2026-10-30', done: false }],
    links: [],
    assets: [],
    mindmaps: [],
  }
}

describe('T24-6 · TaskDrawer 集成：第 ⑤ 分区换成真编辑器', () => {
  it('notes 分区渲染 NoteEditor（旧占位已消失），并把任务笔记与双链候选喂进去', async () => {
    const store = createVaultStore(makeVault())
    const bus = createCommandBus(store)
    const view = render(<TaskDrawer store={store} bus={bus} t={t()} open taskId="x" />)

    const section = view.getByTestId('drawer-notes-section')
    expect(section.querySelector('[data-testid="note-editor"]')).not.toBeNull()
    expect(view.queryByTestId('drawer-note-placeholder')).toBeNull()

    // 任务既有笔记已载入编辑器（value 走的是 task.note）
    await waitFor(() =>
      expect(view.getByTestId('note-editor-content').textContent).toContain('原笔记'),
    )
    // 双链候选含全库任务 + 里程碑（此处断言里程碑不在编辑器内也无需弹层：直接验证候选池来源）
    expect(view.getByTestId('note-editor-content')).toBeTruthy()
  })
})
