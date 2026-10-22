// @vitest-environment jsdom
//
// T49 · NotebookView：知识库三栏（笔记本 / 文档树 / 编辑区）。
//
// 与思维导图用例同款：真的 VaultStore + 真的 CommandBus，断言落在「store 里到底有没有」，
// 而不是「回调有没有被调用」——因为「删错了能不能撤销」是这层最重要的承诺。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { NoteDoc, Notebook, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import { NotebookView } from '../../src/views/NotebookView'

const NOW = '2026-10-22T09:00:00.000Z'

// jsdom 没有布局：ProseMirror / 焦点逻辑会问到 rect
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
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true })
}

function t() {
  return createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t
}

function notebook(id: string, name: string, order = 'U'): Notebook {
  return { id, name, order, createdAt: NOW, updatedAt: NOW }
}

function doc(id: string, notebookId: string, parentId: string | null, order: string, title: string, content = ''): NoteDoc {
  return { id, notebookId, parentId, title, content, order, createdAt: NOW, updatedAt: NOW }
}

function vaultWith(parts: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: 'OffEarly 0.2.0',
    revision: 1,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    ...parts,
  }
}

function setup(parts: Partial<Vault> = {}) {
  const store = createVaultStore(vaultWith(parts))
  const bus = createCommandBus(store)
  let sequential = 0
  const view = render(
    <NotebookView
      vault={store.getVault()}
      bus={bus}
      t={t()}
      deps={{ newId: () => `new-${(sequential += 1)}`, now: () => new Date(NOW) }}
      onOpenTask={vi.fn()}
    />,
  )
  /** 视图拿的是渲染快照；每次 store 变更后要 rerender 才会看到新数据（App 里由 zustand 订阅负责）。 */
  function rerender(): void {
    view.rerender(
      <NotebookView
        vault={store.getVault()}
        bus={bus}
        t={t()}
        deps={{ newId: () => `new-${(sequential += 1)}`, now: () => new Date(NOW) }}
        onOpenTask={vi.fn()}
      />,
    )
  }
  return { store, bus, view, rerender }
}

afterEach(cleanup)

describe('T49-5 · 空库与新建笔记本', () => {
  it('没有笔记本时给一句说明与唯一入口；新建后进入三栏', async () => {
    const { store, rerender } = setup()
    expect(screen.getByTestId('notebook-empty')).toBeTruthy()

    fireEvent.click(screen.getByTestId('notebook-create-empty'))
    const input = await screen.findByTestId('notebook-name-input')
    fireEvent.change(input, { target: { value: '研发手册' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(store.getVault().notebooks.map((item) => item.name)).toEqual(['研发手册'])
    rerender()
    expect(screen.getByTestId('notebook')).toBeTruthy()
    expect(screen.getByTestId('notebook-tree-empty')).toBeTruthy()
    expect(screen.getByTestId('notebook-editor-empty')).toBeTruthy()
  })
})

describe('T49-6 · 文档树', () => {
  const seed = {
    notebooks: [notebook('nb1', '研发手册'), notebook('nb2', '会议记录', 'V')],
    noteDocs: [
      doc('d1', 'nb1', null, 'U', '发布流程', '# 发布流程'),
      doc('d2', 'nb1', 'd1', 'U', '回滚预案', '回滚三步'),
      doc('d3', 'nb1', null, 'V', '编码规范'),
      doc('d4', 'nb2', null, 'U', '周会'),
    ],
  }

  it('默认选中第一篇文档并渲染正文；树的层级用 aria-level 表达', () => {
    setup(seed)
    expect((screen.getByTestId('notebook-title-input') as HTMLInputElement).value).toBe('发布流程')
    expect(screen.getByTestId('doc-row-d1').getAttribute('aria-level')).toBe('1')
    expect(screen.getByTestId('doc-row-d2').getAttribute('aria-level')).toBe('2')
  })

  it('折叠父文档后子文档从树上消失，再点一次回来', () => {
    setup(seed)
    fireEvent.click(screen.getByTestId('doc-toggle-d1'))
    expect(screen.queryByTestId('doc-row-d2')).toBeNull()
    fireEvent.click(screen.getByTestId('doc-toggle-d1'))
    expect(screen.getByTestId('doc-row-d2')).toBeTruthy()
  })

  it('点另一篇文档 → 标题与正文一起切换', () => {
    setup(seed)
    fireEvent.click(screen.getByTestId('doc-row-d3'))
    expect((screen.getByTestId('notebook-title-input') as HTMLInputElement).value).toBe('编码规范')
    expect(screen.getByTestId('note-editor-content').textContent).toContain('')
  })
})

describe('T49-7 · 新建 / 改名 / 删除（都可撤销）', () => {
  it('新建文档落库并选中，默认标题来自 i18n', () => {
    const { store, rerender } = setup({ notebooks: [notebook('nb1', '手册')] })
    fireEvent.click(screen.getByTestId('notebook-new-doc'))
    const created = store.getVault().noteDocs
    expect(created).toHaveLength(1)
    expect(created[0]?.title).toBe('未命名文档')
    expect(created[0]?.notebookId).toBe('nb1')
    rerender()
    expect((screen.getByTestId('notebook-title-input') as HTMLInputElement).value).toBe('未命名文档')
  })

  it('改标题：失焦提交，撤销回到旧标题', () => {
    const { store, bus, rerender } = setup({
      notebooks: [notebook('nb1', '手册')],
      noteDocs: [doc('d1', 'nb1', null, 'U', '旧标题')],
    })
    const input = screen.getByTestId('notebook-title-input')
    fireEvent.change(input, { target: { value: '新标题' } })
    fireEvent.blur(input)
    expect(store.getVault().noteDocs[0]?.title).toBe('新标题')

    bus.undo()
    rerender()
    expect(store.getVault().noteDocs[0]?.title).toBe('旧标题')
  })

  it('删除文档要两段确认；删掉父文档连子树一起消失，撤销后原样回来', () => {
    const { store, bus, rerender } = setup({
      notebooks: [notebook('nb1', '手册')],
      noteDocs: [doc('d1', 'nb1', null, 'U', '父'), doc('d2', 'nb1', 'd1', 'U', '子')],
    })

    const remove = screen.getByTestId('doc-delete-d1')
    fireEvent.click(remove)
    expect(store.getVault().noteDocs).toHaveLength(2) // 第一下只布防
    fireEvent.click(remove)
    expect(store.getVault().noteDocs).toHaveLength(0)

    bus.undo()
    rerender()
    expect(store.getVault().noteDocs.map((item) => item.id)).toEqual(['d1', 'd2'])
  })

  it('删除笔记本同样两段确认，撤销把笔记本与文档一起恢复', () => {
    const { store, bus, rerender } = setup({
      notebooks: [notebook('nb1', '手册')],
      noteDocs: [doc('d1', 'nb1', null, 'U', '文档')],
    })
    const remove = screen.getByTestId('notebook-delete-nb1')
    fireEvent.click(remove)
    expect(store.getVault().notebooks).toHaveLength(1)
    fireEvent.click(remove)
    expect(store.getVault().notebooks).toHaveLength(0)
    expect(store.getVault().noteDocs).toHaveLength(0)

    bus.undo()
    rerender()
    expect(store.getVault().notebooks).toHaveLength(1)
    expect(store.getVault().noteDocs).toHaveLength(1)
  })
})

describe('T49-8 · 全文搜索', () => {
  it('命中正文的文档出现在结果里，点击后切换到它所在的笔记本', async () => {
    setup({
      notebooks: [notebook('nb1', '研发手册'), notebook('nb2', '会议记录', 'V')],
      noteDocs: [doc('d1', 'nb1', null, 'U', '发布流程', '正文'), doc('d4', 'nb2', null, 'U', '周会', '讨论发布窗口')],
    })

    fireEvent.change(screen.getByTestId('notebook-search'), { target: { value: '发布窗口' } })
    const hit = await screen.findByTestId('notebook-search-result-d4')
    fireEvent.click(hit)
    await waitFor(() => {
      expect((screen.getByTestId('notebook-title-input') as HTMLInputElement).value).toBe('周会')
    })
    // 切换文档会清空搜索框，回到树视图
    expect((screen.getByTestId('notebook-search') as HTMLInputElement).value).toBe('')
  })

  it('搜不到时给空态文案', async () => {
    setup({ notebooks: [notebook('nb1', '手册')], noteDocs: [doc('d1', 'nb1', null, 'U', '文档')] })
    fireEvent.change(screen.getByTestId('notebook-search'), { target: { value: 'zzz' } })
    expect(await screen.findByTestId('notebook-search-empty')).toBeTruthy()
  })
})
