// @vitest-environment jsdom
// T70 · 色块面板：点一下交出去的 patch 必须**恰好**是那一条。
//
// 面板是纯视图（改色由调用方经 CommandBus 落库），所以这里只钉「点了什么 → 交了哪条 patch」，
// 撤销与落盘在 whiteboardCommands.test.ts 与 e2e/14-whiteboard.spec.ts 里钉。
// 另外钉住两件容易退化的细节：非法 hex 不提交（只在原地报错）、面板挂在 body 上（不受工具栏裁切）。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WhiteboardNode, WhiteboardNodePatch } from '../../src/domain/types'
import { WhiteboardColorPanel } from '../../src/views/WhiteboardColorPanel'

// 每个用例之后清 DOM：面板是 portal 到 body 的，不清就会在下一个用例里查出两份
afterEach(cleanup)

function node(over: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return { id: 'n1', shape: 'rect', x: 0, y: 0, width: 100, height: 60, text: '框', tone: 'plain', ...over }
}

const t = (key: string): string => key

/** 打开面板；`patches()` 每次现读，别在点击之前把调用记录快照下来。 */
function open(nodes: WhiteboardNode[]): { patches: () => WhiteboardNodePatch[] } {
  const onPatch = vi.fn()
  render(<WhiteboardColorPanel nodes={nodes} onPatch={onPatch} t={t} />)
  fireEvent.click(screen.getByTestId('whiteboard-color'))
  return { patches: () => onPatch.mock.calls.map((call) => call[0] as WhiteboardNodePatch) }
}

describe('白板色块面板', () => {
  it('点预设色块交 fill，点语义色交 tone + fill:null', async () => {
    const { patches } = open([node()])
    const panel = await screen.findByTestId('whiteboard-color-panel')
    // 面板挂在 body 上：工具栏是横向滚动容器，挂里面会被裁成一条
    expect(panel.parentElement).toBe(document.body)

    fireEvent.click(screen.getByTestId('whiteboard-swatch-fef3c7'))
    expect(patches()[0]).toEqual({ fill: '#fef3c7' })

    fireEvent.click(screen.getByTestId('whiteboard-tone-warn'))
    expect(patches()[1]).toEqual({ tone: 'warn', fill: null })
  })

  it('手填 hex：合法才提交，非法只报错不落库', async () => {
    const { patches } = open([node()])
    await screen.findByTestId('whiteboard-color-panel')
    const input = screen.getByTestId('whiteboard-color-hex')

    fireEvent.change(input, { target: { value: '12345' } })
    fireEvent.click(screen.getByTestId('whiteboard-color-apply'))
    expect(patches()).toHaveLength(0)
    expect(screen.getByTestId('whiteboard-color-error')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'A1B2C3' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(patches()[0]).toEqual({ fill: '#a1b2c3' })
    expect(screen.queryByTestId('whiteboard-color-error')).toBeNull()
  })

  it('清除交回 plain，并清掉手填的草稿', async () => {
    const { patches } = open([node({ fill: '#3b82f6' })])
    await screen.findByTestId('whiteboard-color-panel')
    fireEvent.change(screen.getByTestId('whiteboard-color-hex'), { target: { value: '#3b82f6' } })
    fireEvent.click(screen.getByTestId('whiteboard-color-clear'))
    expect(patches()[0]).toEqual({ tone: 'plain', fill: null })
    expect((screen.getByTestId('whiteboard-color-hex') as HTMLInputElement).value).toBe('')
  })

  it('当前颜色对上时该色块是按下态（多选颜色不一致就都不按）', async () => {
    open([node({ id: 'a', fill: '#fef3c7' }), node({ id: 'b', fill: '#fef3c7' })])
    await screen.findByTestId('whiteboard-color-panel')
    expect(screen.getByTestId('whiteboard-swatch-fef3c7').getAttribute('aria-pressed')).toBe('true')

    cleanup()
    open([node({ id: 'a', fill: '#fef3c7' }), node({ id: 'b', fill: '#ef4444' })])
    await screen.findByTestId('whiteboard-color-panel')
    expect(screen.getByTestId('whiteboard-swatch-fef3c7').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('whiteboard-swatch-ef4444').getAttribute('aria-pressed')).toBe('false')
  })

  it('Esc 关面板；点面板外也关', async () => {
    open([node()])
    await screen.findByTestId('whiteboard-color-panel')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('whiteboard-color-panel')).toBeNull())

    fireEvent.click(screen.getByTestId('whiteboard-color'))
    await screen.findByTestId('whiteboard-color-panel')
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('whiteboard-color-panel')).toBeNull())
  })
})
