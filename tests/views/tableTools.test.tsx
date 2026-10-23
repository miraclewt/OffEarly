// @vitest-environment jsdom
//
// T63 · 表格的行列增删。
//
// 起因是一个「功能其实都在、就是没有入口」的投诉：`TableKit` 早就注册了
// `addRowAfter` / `deleteColumn` / `mergeCells` 等命令，但工具栏只有一个「建表」，
// Tab 只会在末行追加一行，Backspace 只在全选单元格时删整张表 —— 建成之后想加一列，
// 除了切到源码模式手写竖线没有别的办法。
//
// 这里钉三件事：
//  ① 工具条**只在光标位于表格内时**出现（悬浮在正文里会挡字，不能常驻）；
//  ② 每个按钮真的改到文档结构，而且结构能写进 Markdown（笔记正文只存 md）；
//  ③ 合并 / 拆分按当前选区自动置灰，不会点了没反应。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'

import { NoteEditor } from '../../src/views/NoteEditor'

// jsdom 没有布局：编辑器 focus / 取尺都会问到 getClientRects。
// 表格工具条的定位正是靠 rect 算的，这里一律返回 0，验证的是「有没有渲染、点了有没有效」。
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
for (const proto of [Node.prototype, Range.prototype, Element.prototype]) {
  Object.defineProperty(proto, 'getClientRects', { value: () => EMPTY_RECTS, configurable: true })
  Object.defineProperty(proto, 'getBoundingClientRect', { value: () => ZERO_RECT, configurable: true })
}
for (const key of ['clientWidth', 'clientHeight', 'scrollTop', 'scrollLeft', 'scrollWidth', 'scrollHeight']) {
  Object.defineProperty(HTMLElement.prototype, key, { get: () => 0, configurable: true })
}
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true })
}

const TABLE = '| 项目 | 状态 |\n| --- | --- |\n| 支付 | 进行中 |\n| 数仓 | 待开始 |\n'

let editor: Editor | null = null

async function mount(markdown = TABLE): Promise<Editor> {
  render(
    <NoteEditor
      value={markdown}
      onCommit={() => undefined}
      debounceMs={0}
      onReady={(instance) => {
        editor = instance
      }}
    />,
  )
  // useEditor 在挂载后的 effect 里才建实例，onCreate 也就晚一拍
  await waitFor(() => {
    if (editor === null) throw new Error('编辑器未就绪')
  })
  return editor as Editor
}

/** 第 n 个单元格内部的位置（0 = 左上角表头）。 */
function cellPos(instance: Editor, index: number): number {
  const found: number[] = []
  instance.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      found.push(pos + 1)
      return false
    }
    return true
  })
  const pos = found[index]
  if (pos === undefined) throw new Error(`没有第 ${index} 个单元格`)
  return pos
}

/**
 * 第 n 个单元格**节点**的位置。
 * `setCellSelection` 要的是这个（不是单元格内部的文字位置）——
 * 传 `pos + 1` 会报 `Not a table node: tableRow`，因为解析出来的父节点是行。
 */
function cellNodePos(instance: Editor, index: number): number {
  const found: number[] = []
  instance.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      found.push(pos)
      return false
    }
    return true
  })
  const pos = found[index]
  if (pos === undefined) throw new Error(`没有第 ${index} 个单元格`)
  return pos
}

/** 光标放进第 n 个单元格，等 React 把工具条渲染出来。 */
async function selectCell(instance: Editor, index = 0): Promise<void> {
  act(() => {
    // 真浏览器里是「点进格子」；jsdom 没有真实焦点，用 focus() 走同一条 isFocused 判断
    instance.chain().focus().setTextSelection(cellPos(instance, index)).run()
  })
  await waitFor(() => expect(screen.getByTestId('note-table-bar')).toBeTruthy())
}

function rows(instance: Editor): number {
  return instance.getHTML().split('<tr').length - 1
}

function firstRowCols(instance: Editor): number {
  const match = /<tr[^>]*>([\s\S]*?)<\/tr>/.exec(instance.getHTML())
  const inner = match?.[1] ?? ''
  return inner.split('<td').length + inner.split('<th').length - 2
}

afterEach(() => {
  cleanup()
  editor = null
})

describe('T63 · 表格工具条的出现条件', () => {
  it('光标不在表格里时不渲染', async () => {
    const instance = await mount(`${TABLE}\n正文\n`)
    act(() => {
      instance.commands.setTextSelection(instance.state.doc.content.size - 1)
    })
    expect(screen.queryByTestId('note-table-bar')).toBeNull()
  })

  it('光标进到单元格里才浮出，离开就收起', async () => {
    const instance = await mount(`${TABLE}\n正文\n`)
    await selectCell(instance)

    const bar = screen.getByTestId('note-table-bar')
    expect(bar.getAttribute('role')).toBe('toolbar')
    // 十个动作：行 3 + 列 3 + 表头 + 合并/拆分 + 删除表格
    expect(bar.querySelectorAll('button').length).toBe(10)

    act(() => {
      instance.commands.setTextSelection(instance.state.doc.content.size - 1)
    })
    await waitFor(() => expect(screen.queryByTestId('note-table-bar')).toBeNull())
  })

  it('纯文本笔记里没有这个工具条的位置', async () => {
    const instance = await mount('只有一段话\n')
    // 同样给焦点：排除「只是没聚焦」这个更弱的解释
    act(() => {
      instance.chain().focus().setTextSelection(2).run()
    })
    // TipTap 的焦点事务比 focus() 晚一拍，等它落定再断言（否则测的是「还没聚焦」）
    await waitFor(() => expect(instance.isFocused).toBe(true))
    expect(screen.queryByTestId('note-table-bar')).toBeNull()
  })
})

describe('T63 · 行列增删', () => {
  it('下方插入行：行数 +1，且写进 markdown', async () => {
    const instance = await mount()
    await selectCell(instance, 0)
    expect(rows(instance)).toBe(3)

    fireEvent.click(screen.getByTestId('table-tool-row-below'))
    expect(rows(instance)).toBe(4)
    expect(instance.getMarkdown().split('\n').filter((line) => line.startsWith('|')).length).toBe(5)
  })

  it('上方插入行：插在当前行之前', async () => {
    const instance = await mount()
    await selectCell(instance, 3) // 第一行数据（表头之后）
    fireEvent.click(screen.getByTestId('table-tool-row-above'))

    expect(rows(instance)).toBe(4)
    // 新行是空的，落在「支付」那一行前面
    const text = instance.getHTML()
    const firstDataRow = /<tbody>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/.exec(text)?.[1] ?? ''
    expect(firstDataRow).not.toContain('支付')
  })

  it('右侧插入列 / 左侧插入列', async () => {
    const instance = await mount()
    await selectCell(instance, 0)
    expect(firstRowCols(instance)).toBe(2)

    fireEvent.click(screen.getByTestId('table-tool-col-right'))
    expect(firstRowCols(instance)).toBe(3)

    fireEvent.click(screen.getByTestId('table-tool-col-left'))
    expect(firstRowCols(instance)).toBe(4)
  })

  it('删除本行 / 删除本列', async () => {
    const instance = await mount()
    await selectCell(instance, 3)

    fireEvent.click(screen.getByTestId('table-tool-row-remove'))
    expect(rows(instance)).toBe(2)
    expect(instance.getHTML()).not.toContain('支付')

    fireEvent.click(screen.getByTestId('table-tool-col-remove'))
    expect(firstRowCols(instance)).toBe(1)
  })

  it('删除表格：整张表消失，正文其余内容还在', async () => {
    const instance = await mount(`${TABLE}\n后记\n`)
    await selectCell(instance, 0)

    fireEvent.click(screen.getByTestId('table-tool-delete'))
    expect(instance.getHTML()).not.toContain('<table')
    expect(screen.queryByTestId('note-table-bar')).toBeNull()
    expect(instance.state.doc.textContent).toContain('后记')
  })

  it('切换表头行：表头退回普通单元格，再点回来', async () => {
    const instance = await mount()
    await selectCell(instance, 0)
    expect(instance.getHTML()).toContain('<th')

    fireEvent.click(screen.getByTestId('table-tool-header'))
    expect(firstRowCols(instance)).toBe(2)
    expect(/<tr[^>]*>[\s\S]*?<th/.test(instance.getHTML().split('<tbody')[0] ?? '')).toBe(false)

    fireEvent.click(screen.getByTestId('table-tool-header'))
    expect(instance.getHTML()).toContain('<th')
  })
})

describe('T63 · 合并与拆分', () => {
  it('单选时两个按钮都置灰', async () => {
    const instance = await mount()
    await selectCell(instance, 0)

    expect(screen.getByTestId<HTMLButtonElement>('table-tool-merge').disabled).toBe(true)
    expect(screen.getByTestId<HTMLButtonElement>('table-tool-split').disabled).toBe(true)
  })

  it('框住两个单元格才能合并，合并后可拆分', async () => {
    const instance = await mount()
    await selectCell(instance, 0)

    act(() => {
      instance.commands.setCellSelection({ anchorCell: cellNodePos(instance, 0), headCell: cellNodePos(instance, 1) })
    })
    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('table-tool-merge').disabled).toBe(false)
    })

    fireEvent.click(screen.getByTestId('table-tool-merge'))
    expect(instance.getHTML()).toContain('colspan="2"')
    expect(firstRowCols(instance)).toBe(1)

    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>('table-tool-split').disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId('table-tool-split'))
    expect(instance.getHTML()).not.toContain('colspan="2"')
    expect(firstRowCols(instance)).toBe(2)
  })
})
