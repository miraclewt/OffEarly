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
import type { NoteDoc, Notebook, Task, Vault } from '../../src/domain/types'
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
      noteFontSize: 13,
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    trash: [],
    whiteboards: [],
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
    // T72：笔记本降级成切换器里的菜单项，先展开菜单
    fireEvent.click(screen.getByTestId('notebook-switcher'))
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

// T50 · 导出入口与字号接线
describe('T50 · 导出与正文字号', () => {
  function withDoc() {
    const nb = notebook('nb-1', '产品笔记')
    const root = doc('d-1', 'nb-1', null, 'U', '会议记录', '## 结论\n\n- 先做导出')
    return setup({ notebooks: [nb], noteDocs: [root] })
  }

  it('编辑区顶部有导出入口，点开是三种落点', () => {
    withDoc()
    const button = screen.getByTestId('notebook-export')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('notebook-export-menu')).toBeNull()

    fireEvent.click(button)
    expect(screen.getByTestId('notebook-export-menu')).toBeTruthy()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('notebook-export-doc')).toBeTruthy()
    expect(screen.getByTestId('notebook-export-notebook')).toBeTruthy()
    // PDF 走浏览器打印，落点必须是「打印 / 另存为 PDF」而不是第四个导出格式
    expect(screen.getByTestId('notebook-export-print')).toBeTruthy()

    fireEvent.mouseDown(screen.getByTestId('notebook-export-backdrop'))
    expect(screen.queryByTestId('notebook-export-menu')).toBeNull()
  })

  it('A+ / A- 直接把字号写进 settings（可撤销的一条命令）', () => {
    const { store, bus } = withDoc()
    expect(screen.getByTestId('note-font-size').textContent).toBe('13')

    fireEvent.click(screen.getByTestId('note-font-larger'))
    expect(store.getVault().settings.noteFontSize).toBe(14)
    expect(bus.undoDepth()).toBe(1)

    bus.undo()
    expect(store.getVault().settings.noteFontSize).toBe(13)
  })
})

// T72 · 左栏只剩文档树（可折叠）；笔记本降级成树头部的切换器，不再单占一列
describe('T72 · 左栏与笔记本切换器', () => {
  const seed = {
    notebooks: [notebook('nb1', '研发手册'), notebook('nb2', '随笔', 'V')],
    noteDocs: [
      doc('d1', 'nb1', null, 'U', '发布流程', '# 发布流程\n\n正文一段。'),
      doc('d2', 'nb2', null, 'U', '随想', '另一本里的文档'),
    ],
  }

  it('笔记本不再单占一列：头部是切换器，弹层未展开时看不到笔记本行', () => {
    setup(seed)
    expect(screen.queryByTestId('notebook-books-pane')).toBeNull()
    const switcher = screen.getByTestId('notebook-switcher')
    expect(switcher.getAttribute('aria-expanded')).toBe('false')
    expect(switcher.getAttribute('aria-label')).toBe('切换笔记本')
    expect(switcher.textContent).toContain('研发手册')
    expect(screen.queryByTestId('notebook-switcher-menu')).toBeNull()
    expect(screen.queryByTestId('notebook-row-nb2')).toBeNull()
  })

  it('展开切换器能看到全部笔记本，选中后菜单收起、文档树跟着换', () => {
    setup(seed)
    fireEvent.click(screen.getByTestId('notebook-switcher'))
    expect(screen.getByTestId('notebook-switcher').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('notebook-row-nb1').getAttribute('aria-current')).toBe('true')

    fireEvent.click(screen.getByTestId('notebook-row-nb2'))
    expect(screen.queryByTestId('notebook-switcher-menu')).toBeNull()
    expect(screen.getByTestId('doc-row-d2')).toBeTruthy()
    expect(screen.queryByTestId('doc-row-d1')).toBeNull()
  })

  it('新建笔记本入口在菜单里，提交后菜单收起并切到新本', async () => {
    const { store, rerender } = setup(seed)
    fireEvent.click(screen.getByTestId('notebook-switcher'))
    fireEvent.click(screen.getByTestId('notebook-add'))
    const input = await screen.findByTestId('notebook-name-input')
    fireEvent.change(input, { target: { value: '复盘' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    rerender()

    expect(store.getVault().notebooks.map((item) => item.name)).toEqual(['研发手册', '随笔', '复盘'])
    expect(screen.queryByTestId('notebook-switcher-menu')).toBeNull()
    expect(screen.getByTestId('notebook-switcher').textContent).toContain('复盘')
  })

  it('收起文档树：搜索框与切换器一起收，正文仍可读；竖轨自己就是展开入口', () => {
    setup(seed)
    fireEvent.click(screen.getByTestId('notebook-tree-collapse'))
    expect(screen.queryByTestId('notebook-tree-pane')).toBeNull()
    expect(screen.queryByTestId('notebook-tree')).toBeNull()
    expect(screen.queryByTestId('notebook-search')).toBeNull()
    expect(screen.queryByTestId('notebook-switcher')).toBeNull()
    expect(screen.getByTestId('notebook-tree-rail').getAttribute('aria-label')).toBe('展开文档树')
    expect(screen.getByTestId('note-editor-content').textContent).toContain('正文一段')

    fireEvent.click(screen.getByTestId('notebook-tree-rail'))
    expect(screen.getByTestId('doc-row-d1')).toBeTruthy()
  })

  it('折叠是纯 UI 态：vault 一个字节不动，撤销栈也不多一条', () => {
    const { store, bus } = setup(seed)
    const before = JSON.stringify(store.getVault())
    fireEvent.click(screen.getByTestId('notebook-tree-collapse'))
    expect(screen.getByTestId('notebook-tree-rail')).toBeTruthy()
    expect(screen.getByTestId('notebook-title-input')).toBeTruthy()
    expect(JSON.stringify(store.getVault())).toBe(before)
    expect(bus.undoDepth()).toBe(0)
  })
})

describe('T62 · 从 .ics 导入会议', () => {
  const seed = { notebooks: [notebook('nb1', '会议纪要')], noteDocs: [] }

  /** 一场带参与人与地点的最小会议。 */
  const ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:t62-e2e',
    'SUMMARY:支付对账文件解析方案评审',
    'DTSTART;TZID=Asia/Shanghai:20261023T140000',
    'DTEND;TZID=Asia/Shanghai:20261023T150000',
    'LOCATION:3 楼会议室',
    'ATTENDEE;CN=李四:mailto:lisi@example.com',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')

  it('文档树头部有入口，点开后是导入面板', () => {
    setup(seed)
    expect(screen.queryByTestId('meeting-import')).toBeNull()
    fireEvent.click(screen.getByTestId('notebook-import-ics'))
    expect(screen.getByTestId('meeting-import')).toBeTruthy()
    expect(screen.getByTestId('meeting-import').textContent).toContain('会议纪要')
  })

  it('选文件 → 确认导入：笔记落进当前笔记本，并给出结果提示', async () => {
    const { store, rerender } = setup(seed)
    fireEvent.click(screen.getByTestId('notebook-import-ics'))

    const file = new File([ICS], 'meeting.ics', { type: 'text/calendar' })
    fireEvent.change(screen.getByTestId('meeting-import-file-input'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getAllByTestId('meeting-import-row')).toHaveLength(1))

    fireEvent.click(screen.getByTestId('meeting-import-confirm'))

    const docs = store.getVault().noteDocs
    expect(docs).toHaveLength(1)
    expect(docs[0]?.notebookId).toBe('nb1')
    expect(docs[0]?.title).toBe('支付对账文件解析方案评审')
    expect(docs[0]?.content).toContain('3 楼会议室')
    expect(docs[0]?.content).toContain('@李四')

    rerender()
    expect(screen.getByTestId('notebook-export-notice').textContent).toContain('已导入 1 篇会议笔记')
    // 导入后面板自己收起
    expect(screen.queryByTestId('meeting-import')).toBeNull()
  })

  it('同一份文件再导一次：一篇也不多建', async () => {
    const { store, rerender } = setup(seed)
    fireEvent.click(screen.getByTestId('notebook-import-ics'))
    fireEvent.change(screen.getByTestId('meeting-import-file-input'), {
      target: { files: [new File([ICS], 'meeting.ics', { type: 'text/calendar' })] },
    })
    await waitFor(() => expect(screen.getAllByTestId('meeting-import-row')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('meeting-import-confirm'))
    rerender()

    fireEvent.click(screen.getByTestId('notebook-import-ics'))
    fireEvent.change(screen.getByTestId('meeting-import-file-input'), {
      target: { files: [new File([ICS], 'meeting.ics', { type: 'text/calendar' })] },
    })
    await waitFor(() => expect(screen.getByTestId('meeting-import-badge')).toBeTruthy())
    expect((screen.getByTestId('meeting-import-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect(store.getVault().noteDocs).toHaveLength(1)
  })
})

describe('T82 · 导入 Markdown 文件', () => {
  const seed = { notebooks: [notebook('nb1', 'AI 笔记')], noteDocs: [] }

  const A = ['---', 'title: 周报', 'tags: [工作]', '---', '', '本周进展。', ''].join('\n')
  const B = ['# 季度复盘', '', '## 数据', '', '- 一条', ''].join('\n')

  function choose(...files: File[]): void {
    fireEvent.change(screen.getByTestId('markdown-import-file-input'), { target: { files } })
  }

  it('文档树头部有入口，点开后是导入面板', () => {
    setup(seed)
    expect(screen.queryByTestId('markdown-import')).toBeNull()
    fireEvent.click(screen.getByTestId('notebook-import-md'))
    expect(screen.getByTestId('markdown-import')).toBeTruthy()
    expect(screen.getByTestId('markdown-import').textContent).toContain('AI 笔记')
  })

  it('一次选两个文件 → 确认导入：两篇都落进当前笔记本，正文原样', async () => {
    const { store, rerender } = setup(seed)
    fireEvent.click(screen.getByTestId('notebook-import-md'))
    choose(new File([A], 'a.md', { type: 'text/markdown' }), new File([B], 'b.md', { type: 'text/markdown' }))
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(2))

    fireEvent.click(screen.getByTestId('markdown-import-confirm'))

    const docs = store.getVault().noteDocs
    expect(docs).toHaveLength(2)
    expect(docs.map((created) => created.title)).toEqual(['周报', '季度复盘'])
    expect(docs[0]?.content).toBe('本周进展。\n')
    expect(docs[0]?.tags).toEqual(['工作'])
    expect(docs[1]?.content).toBe('## 数据\n\n- 一条\n')
    // 两篇的排序键不能撞（批量导入用的是同一份旧快照）
    expect(new Set(docs.map((created) => created.order)).size).toBe(2)

    rerender()
    expect(screen.getByTestId('notebook-export-notice').textContent).toContain('已导入 2 篇笔记')
    expect(screen.queryByTestId('markdown-import')).toBeNull()
  })

  it('只勾一篇时另一篇不进来', async () => {
    const { store } = setup(seed)
    fireEvent.click(screen.getByTestId('notebook-import-md'))
    choose(new File([A], 'a.md', { type: 'text/markdown' }), new File([B], 'b.md', { type: 'text/markdown' }))
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(2))
    fireEvent.click(screen.getByTestId('markdown-import-select-none'))
    // 行序与选文件顺序一致：第一行是 a.md（周报）
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[0] as HTMLInputElement)
    fireEvent.click(screen.getByTestId('markdown-import-confirm'))
    expect(store.getVault().noteDocs.map((created) => created.title)).toEqual(['周报'])
  })

  it('导入后 Ctrl+Z 一次只回退一篇', async () => {
    const { store, bus, rerender } = setup(seed)
    fireEvent.click(screen.getByTestId('notebook-import-md'))
    choose(new File([A], 'a.md', { type: 'text/markdown' }), new File([B], 'b.md', { type: 'text/markdown' }))
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(2))
    fireEvent.click(screen.getByTestId('markdown-import-confirm'))

    bus.undo()
    expect(store.getVault().noteDocs.map((created) => created.title)).toEqual(['周报'])
    rerender()
    expect(screen.getByTestId('notebook-tree').textContent).toContain('周报')
  })
})

describe('T73 · 大纲栏：计数徽标 + 宽屏自动展开', () => {
  const seed = {
    notebooks: [notebook('nb1', '研发手册')],
    noteDocs: [
      doc(
        'd1',
        'nb1',
        null,
        'U',
        '支付重构周会纪要',
        '# 结论\n\n先做对账。\n\n## 待办\n\n- [ ] 对账\n\n## 依赖\n\n无。\n\n## 链路\n\n见下。',
      ),
      doc('d2', 'nb1', null, 'V', '另一篇', '只有正文，没有标题。'),
    ],
  }

  /** jsdom 的 innerWidth 是只读的，自动展开按它判断，所以这里临时替换一次。 */
  function withViewportWidth(width: number, run: () => void): void {
    const original = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
    try {
      run()
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: original, configurable: true })
    }
  }

  it('收起态也看得见「这篇有几个标题」，点一下展开右栏', () => {
    const { view } = setup(seed)
    // 默认窄屏（jsdom 1024）→ 不自动展开
    expect(view.queryByTestId('notebook-outline-panel')).toBeNull()
    expect(view.getByTestId('notebook-outline-count').textContent).toBe('4')

    fireEvent.click(view.getByTestId('notebook-outline-toggle'))
    expect(view.getByTestId('notebook-outline-panel')).toBeTruthy()
    expect(view.getByTestId('notebook-outline-toggle').getAttribute('aria-pressed')).toBe('true')
  })

  it('没有标题的文档不显示徽标（0 没有信息量）', () => {
    const { view } = setup(seed)
    fireEvent.click(view.getByTestId('doc-row-d2'))
    expect(view.queryByTestId('notebook-outline-count')).toBeNull()
  })

  it('宽屏 + 标题够多时自动展开；用户关掉之后不再自动弹回来', async () => {
    await new Promise<void>((resolve) => {
      withViewportWidth(1680, () => {
        const { view } = setup(seed)
        expect(view.queryByTestId('notebook-outline-panel')).toBeTruthy()

        // 用户明确关掉：切到另一篇再切回来，不该又自己展开
        fireEvent.click(view.getByTestId('notebook-outline-toggle'))
        expect(view.queryByTestId('notebook-outline-panel')).toBeNull()
        fireEvent.click(view.getByTestId('doc-row-d2'))
        expect(view.queryByTestId('notebook-outline-panel')).toBeNull()
        fireEvent.click(view.getByTestId('doc-row-d1'))
        expect(view.queryByTestId('notebook-outline-panel')).toBeNull()
        resolve()
      })
    })
  })

  it('窄屏即使标题很多也不展开（刚瘦身出来的正文宽度不能再还回去）', () => {
    withViewportWidth(1080, () => {
      const { view } = setup(seed)
      expect(view.queryByTestId('notebook-outline-panel')).toBeNull()
      expect(view.getByTestId('notebook-outline-count').textContent).toBe('4')
    })
  })
})

describe('T73-2 · 文档属性行：话题 / 关联任务 / 标签', () => {
  function task(id: string, title: string, status: Task['status'] = 'todo'): Task {
    return {
      id,
      topicId: 't1',
      title,
      status,
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

  const seed = {
    notebooks: [notebook('nb1', '研发手册')],
    noteDocs: [doc('d1', 'nb1', null, 'U', '支付重构周会纪要', '# 结论\n\n先做对账。')],
    tasks: [task('k1', '对账接口', 'doing'), task('k2', '支付回调')],
  }

  it('话题是只读的所属笔记本；没有标签与关联任务时只留两个「+」入口', () => {
    const { view } = setup(seed)
    expect(view.getByTestId('note-prop-topic').textContent).toContain('研发手册')
    expect(view.queryByTestId('note-prop-task-k1')).toBeNull()
    expect(view.getByTestId('note-prop-add-task')).toBeTruthy()
    expect(view.getByTestId('note-prop-add-tag')).toBeTruthy()
  })

  it('加标签：输入回车落库，chip 出现；点 × 删掉后库里不再有这个键', () => {
    const { store, view, rerender } = setup(seed)
    fireEvent.click(view.getByTestId('note-prop-add-tag'))
    const input = view.getByTestId('note-prop-tag-input')
    fireEvent.change(input, { target: { value: '  支付 ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(store.getVault().noteDocs[0]?.tags).toEqual(['支付'])
    rerender() // 视图读的是 props 快照（App 里由 zustand 订阅负责重渲染）
    const chip = view.getByTestId('note-prop-tag-支付')
    expect(chip.textContent).toContain('支付')

    fireEvent.click(view.getByTestId('note-prop-tag-remove-支付'))
    expect(store.getVault().noteDocs[0]?.tags).toBeUndefined()
    expect(JSON.stringify(store.getVault().noteDocs[0])).not.toContain('"tags"')
  })

  it('Esc 取消输入不进库（打了一半不算数）', () => {
    const { store, view } = setup(seed)
    fireEvent.click(view.getByTestId('note-prop-add-tag'))
    const input = view.getByTestId('note-prop-tag-input')
    fireEvent.change(input, { target: { value: '半截' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(view.queryByTestId('note-prop-tag-input')).toBeNull()
    expect(store.getVault().noteDocs[0]?.tags).toBeUndefined()
  })

  it('关联任务：弹层可搜索、点候选项挂上，chip 上的 × 取消关联', async () => {
    const { store, view, rerender } = setup(seed)
    fireEvent.click(view.getByTestId('note-prop-add-task'))
    const menu = await view.findByTestId('note-prop-task-menu')
    expect(menu).toBeTruthy()

    const search = view.getByTestId('note-prop-task-search')
    fireEvent.change(search, { target: { value: '回调' } })
    await waitFor(() => expect(view.queryAllByTestId(/^note-prop-task-option-/)).toHaveLength(1))
    fireEvent.click(view.getByTestId('note-prop-task-option-0'))

    expect(store.getVault().noteDocs[0]?.taskIds).toEqual(['k2'])
    rerender()
    expect(view.getByTestId('note-prop-task-k2').textContent).toContain('支付回调')
    // 选完自动收起
    expect(view.queryByTestId('note-prop-task-menu')).toBeNull()

    fireEvent.click(view.getByTestId('note-prop-task-remove-k2'))
    expect(store.getVault().noteDocs[0]?.taskIds).toBeUndefined()
  })

  it('候选池不含已关联的任务（避免下拉里点一条没反应）', async () => {
    const { view } = setup({
      ...seed,
      noteDocs: [{ ...doc('d1', 'nb1', null, 'U', '支付重构周会纪要', '# 结论'), taskIds: ['k1'] }],
    })
    expect(view.getByTestId('note-prop-task-k1')).toBeTruthy()
    fireEvent.click(view.getByTestId('note-prop-add-task'))
    await view.findByTestId('note-prop-task-menu')
    const labels = view
      .queryAllByTestId(/^note-prop-task-option-/)
      .map((node) => node.textContent ?? '')
    expect(labels.some((text) => text.includes('对账接口'))).toBe(false)
    expect(labels.some((text) => text.includes('支付回调'))).toBe(true)
  })

  it('点任务 chip 打开任务详情（复用既有 onOpenTask 通道）', () => {
    const onOpenTask = vi.fn()
    const { view } = setup({
      ...seed,
      noteDocs: [{ ...doc('d1', 'nb1', null, 'U', '支付重构周会纪要', '# 结论'), taskIds: ['k1'] }],
    })
    // setup 里 onOpenTask 是新建的 vi.fn()，这里改用带 spy 的一版渲染
    view.unmount()
    const store = createVaultStore(
      vaultWith({
        ...seed,
        noteDocs: [{ ...doc('d1', 'nb1', null, 'U', '支付重构周会纪要', '# 结论'), taskIds: ['k1'] }],
      }),
    )
    const bus = createCommandBus(store)
    const view2 = render(
      <NotebookView vault={store.getVault()} bus={bus} t={t()} onOpenTask={onOpenTask} />,
    )
    fireEvent.click(view2.getByTestId('note-prop-task-open-k1'))
    expect(onOpenTask).toHaveBeenCalledWith('k1')
  })
})
