// @vitest-environment jsdom
//
// T82 · Markdown 导入面板：多选文件 → 列出篇目 → 勾选 → 交回调用方。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { MarkdownImportPanel } from '../../src/views/MarkdownImportPanel'
import type { MarkdownImportDoc } from '../../src/controllers/markdownImport'
import { createI18n } from '../../src/locales/i18n'

const i18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })
const t = i18n.t

// 面板 createPortal 到 body：不手动 cleanup 会跨用例残留，getByTestId 直接撞「多个元素」
afterEach(cleanup)

const A = ['---', 'title: YAML 标题', 'tags: [工作]', '---', '正文 A', ''].join('\n')
const B = ['# 季度复盘', '', '## 数据', '', '- 一条', ''].join('\n')
const C = ['没有标题的正文。', ''].join('\n')

function setup(overrides: Partial<Parameters<typeof MarkdownImportPanel>[0]> = {}) {
  const onImport = vi.fn<(docs: MarkdownImportDoc[]) => void>()
  const onOpenChange = vi.fn<(open: boolean) => void>()
  const view = render(
    <MarkdownImportPanel
      open
      onOpenChange={onOpenChange}
      notebookName="AI 笔记"
      t={t}
      existingTitles={new Set<string>()}
      onImport={onImport}
      {...overrides}
    />,
  )
  return { onImport, onOpenChange, view }
}

function choose(...files: { name: string; text: string }[]): void {
  const list = files.map((file) => new File([file.text], file.name, { type: 'text/markdown' }))
  fireEvent.change(screen.getByTestId('markdown-import-file-input'), { target: { files: list } })
}

describe('T82 · 面板骨架', () => {
  it('open=false 时不渲染任何东西', () => {
    setup({ open: false })
    expect(screen.queryByTestId('markdown-import')).toBeNull()
  })

  it('打开即显示标题与「落在哪一本」的提示', () => {
    setup()
    expect(screen.getByTestId('markdown-import').textContent).toContain('导入 Markdown')
    expect(screen.getByTestId('markdown-import').textContent).toContain('AI 笔记')
  })

  it('Esc 关闭', () => {
    const { onOpenChange } = setup()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('点遮罩关闭；点在面板内部不关闭', () => {
    const { onOpenChange } = setup()
    fireEvent.mouseDown(screen.getByTestId('markdown-import'))
    fireEvent.click(screen.getByTestId('markdown-import'))
    expect(onOpenChange).not.toHaveBeenCalled()

    const backdrop = screen.getByTestId('markdown-import-backdrop')
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('一个文件都没选时确认按钮是禁用的', () => {
    setup()
    expect((screen.getByTestId('markdown-import-confirm') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('T82 · 列出篇目', () => {
  it('多选三个文件：逐篇列出标题与来源文件', async () => {
    setup()
    choose({ name: 'a.md', text: A }, { name: 'b.md', text: B }, { name: 'c.md', text: C })
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(3))
    const list = screen.getByTestId('markdown-import-list').textContent ?? ''
    expect(list).toContain('YAML 标题')
    expect(list).toContain('季度复盘')
    expect(list).toContain('c')
    expect(list).toContain('a.md')
  })

  it('默认全选，底部按钮跟着数量走', async () => {
    setup()
    choose({ name: 'a.md', text: A }, { name: 'b.md', text: B })
    await waitFor(() => expect(screen.getByTestId('markdown-import-count').textContent).toContain('已选 2 / 2 篇'))
    expect(screen.getByTestId('markdown-import-confirm').textContent).toContain('导入 2 篇')
  })

  it('标题来源标在行上（YAML 头 / 首个 # / 文件名）', async () => {
    setup()
    choose({ name: 'a.md', text: A }, { name: 'b.md', text: B }, { name: 'c.md', text: C })
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(3))
    const rows = screen.getAllByTestId('markdown-import-row')
    expect(rows[0]?.dataset.source).toBe('frontmatter')
    expect(rows[1]?.dataset.source).toBe('heading')
    expect(rows[2]?.dataset.source).toBe('filename')
  })

  it('笔记本里已有同名文档时打「同名已存在」标', async () => {
    setup({ existingTitles: new Set(['季度复盘']) })
    choose({ name: 'b.md', text: B })
    await waitFor(() => expect(screen.getByTestId('markdown-import-badge-exists').textContent).toBe('同名已存在'))
  })
})

describe('T82 · 跳过与勾选', () => {
  it('不是 md 的文件单独成行并写明原因，不计入可导入数量', async () => {
    setup()
    choose({ name: 'a.md', text: A }, { name: 'report.pdf', text: 'x' })
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(2))
    expect(screen.getByTestId('markdown-import-badge-skip').textContent).toBe('不是 Markdown 文件')
    expect(screen.getByTestId('markdown-import-count').textContent).toContain('已选 1 / 1 篇')
    expect(screen.getByTestId('markdown-import-skipped').textContent).toContain('跳过 1 个')
  })

  it('空文件被跳过', async () => {
    setup()
    choose({ name: 'empty.md', text: '   \n' })
    await waitFor(() => expect(screen.getByTestId('markdown-import-badge-skip').textContent).toBe('空文件'))
  })

  it('取消勾选一篇后只导入另一篇，并按顺序交回', async () => {
    const { onImport, onOpenChange } = setup()
    choose({ name: 'a.md', text: A }, { name: 'b.md', text: B })
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(2))
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[0] as HTMLInputElement)
    fireEvent.click(screen.getByTestId('markdown-import-confirm'))
    expect(onImport).toHaveBeenCalledTimes(1)
    const docs = onImport.mock.calls[0]?.[0] ?? []
    expect(docs.map((doc) => doc.title)).toEqual(['季度复盘'])
    expect(docs[0]?.content).toBe('## 数据\n\n- 一条\n')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('标签随文档一起交回，导入后由控制器落 NoteDoc.tags', async () => {
    const { onImport } = setup()
    choose({ name: 'a.md', text: A })
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('markdown-import-confirm'))
    const docs = onImport.mock.calls[0]?.[0] ?? []
    expect(docs[0]?.tags).toEqual(['工作'])
  })

  it('全不选后确认按钮禁用，点不动也不回调', async () => {
    const { onImport } = setup()
    choose({ name: 'a.md', text: A })
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('markdown-import-select-none'))
    const confirm = screen.getByTestId('markdown-import-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onImport).not.toHaveBeenCalled()
  })

  it('被跳过的文件不产生复选框（勾不了也导不进）', async () => {
    setup()
    choose({ name: 'a.md', text: A }, { name: 'report.docx', text: 'x' })
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(2))
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  })

  it('关掉再打开，上一批文件不留痕', async () => {
    const { view, onImport } = setup()
    choose({ name: 'a.md', text: A })
    await waitFor(() => expect(screen.getAllByTestId('markdown-import-row')).toHaveLength(1))
    // 面板是受控的：收起由接线方把 open 改成 false，那个时候才清空
    view.rerender(
      <MarkdownImportPanel
        open={false}
        onOpenChange={() => {}}
        notebookName="AI 笔记"
        t={t}
        existingTitles={new Set<string>()}
        onImport={onImport}
      />,
    )
    view.rerender(
      <MarkdownImportPanel
        open
        onOpenChange={() => {}}
        notebookName="AI 笔记"
        t={t}
        existingTitles={new Set<string>()}
        onImport={onImport}
      />,
    )
    expect(screen.queryByTestId('markdown-import-row')).toBeNull()
    expect((screen.getByTestId('markdown-import-confirm') as HTMLButtonElement).disabled).toBe(true)
  })
})
