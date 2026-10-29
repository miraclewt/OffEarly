// @vitest-environment jsdom
// T70 · 导出的配色必须与屏幕上**同一套判断**。
//
// T69 留下的隐患是「屏幕用 CSS 令牌、导出用字面量表」两套表并存；自定义色若不接到同一处，
// 用户会得到「屏幕上是我挑的蓝、导出里还是语义色」。这里钉的就是这条：导出读 resolveNodePaint。

import { describe, expect, it } from 'vitest'

import type { Whiteboard, WhiteboardNode } from '../../src/domain/types'
import { buildWhiteboardSvgMarkup } from '../../src/views/WhiteboardExporter'

const NOW = '2026-10-29T10:00:00.000Z'

function node(over: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return { id: 'n1', shape: 'rect', x: 0, y: 0, width: 120, height: 60, text: '服务', tone: 'plain', ...over }
}

function board(nodes: WhiteboardNode[]): Whiteboard {
  return { id: 'b1', name: '板', order: 'U', nodes, edges: [], createdAt: NOW, updatedAt: NOW }
}

function markup(nodes: WhiteboardNode[]): string {
  return buildWhiteboardSvgMarkup(board(nodes), { range: 'full' }).markup
}

describe('白板导出的配色', () => {
  it('没有自定义色：仍走语义色（这里是 plain 的白底）', () => {
    const svg = markup([node()])
    expect(svg).toContain('fill="#FFFFFF"')
    expect(svg).toContain('fill="#1D1D1F"')
  })

  it('有自定义色：底、描边、字色全部按 resolveNodePaint 落成字面量', () => {
    const svg = markup([node({ fill: '#fef3c7' })])
    expect(svg).toContain('fill="#fef3c7"')
    expect(svg).toContain('fill-opacity="1"')
    // 浅底 → 字是近黑
    expect(svg).toContain('fill="#1D1D1F"')
    // 浅底 → 描边比底色深（推出来的一档，不是同一个值）
    expect(svg).not.toContain('stroke="#fef3c7"')
  })

  it('深底：导出的字色换白（与屏幕一致）', () => {
    const svg = markup([node({ fill: '#3b82f6' })])
    expect(svg).toContain('fill="#3b82f6"')
    expect(svg).toContain('fill="#FFFFFF"')
  })

  it('文本图元：自定义色落在字上，不铺底也不描边', () => {
    const svg = markup([node({ shape: 'text', fill: '#ef4444' })])
    expect(svg).toContain('fill="#ef4444"')
    expect(svg).toContain('fill="none"')
  })

  it('分组框：14% 透明度 + 虚线，里面的框不会被糊掉', () => {
    const svg = markup([node({ shape: 'frame', fill: '#dceefe' })])
    expect(svg).toContain('fill-opacity="0.14"')
    expect(svg).toContain('stroke-dasharray="6 4"')
  })
})
