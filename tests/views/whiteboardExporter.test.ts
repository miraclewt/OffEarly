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

// T74 · 贴图导出：导出物必须**自包含**。写 `assets/x.png` 这种相对路径的话，
// 文件一挪到下载目录就是死链——所以图片一律以 dataURL 内嵌，读不到就画灰底占位。
describe('T74 · 图片图元导出', () => {
  const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

  function imageNode(over: Partial<WhiteboardNode> = {}): WhiteboardNode {
    return node({ shape: 'image', image: 'assets/wb1.png', text: 'shot.png', ...over })
  }

  function svgOf(nodes: WhiteboardNode[], images?: ReadonlyMap<string, string>): string {
    return buildWhiteboardSvgMarkup(board(nodes), { range: 'full', images }).markup
  }

  it('拿到字节：写成内嵌 dataURL 的 <image>，且不画出灰底占位以外的形状', () => {
    const svg = svgOf([imageNode()], new Map([['assets/wb1.png', DATA_URL]]))
    expect(svg).toContain('<image')
    expect(svg).toContain('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==')
    // 旧软件只认 xlink:href，现代浏览器认 href —— 两个都给
    expect(svg).toContain('href=')
    expect(svg).toContain('xlink:href')
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"')
    // 不把文件名当标签画在图上
    expect(svg).not.toContain('shot.png')
  })

  it('没拿到字节：留浅灰占位，不写指向 assets/ 的死链', () => {
    const svg = svgOf([imageNode()])
    expect(svg).not.toContain('<image')
    expect(svg).toContain('fill="#F2F2F7"')
    expect(svg).not.toContain('assets/wb1.png')
  })

  it('普通图元不会因为带了 images map 就变成图片', () => {
    const svg = svgOf([node({ text: '服务' })], new Map([['assets/wb1.png', DATA_URL]]))
    expect(svg).not.toContain('<image')
    expect(svg).toContain('服务')
  })
})

// T75 · 字号：导出必须读节点上的值。用户把标题调到 32 号，导出却是 13 号，
// 那这份图和屏幕上看到的完全不是一回事。
describe('T75 · 字号导出', () => {
  it('节点带 fontSize：导出用这个字号，不是形状默认', () => {
    const svg = markup([node({ text: '订单服务', fontSize: 32 })])
    expect(svg).toContain('font-size="32"')
    expect(svg).not.toContain('font-size="13"')
  })

  it('没带 fontSize：便签仍按 14、其余按 13（与画布同口径）', () => {
    expect(markup([node({ shape: 'note', text: '便签' })])).toContain('font-size="14"')
    expect(markup([node({ text: '服务' })])).toContain('font-size="13"')
  })

  it('字号影响折行与基线：同一段文字在 32 号下会断成更多行', () => {
    const text = '这条需求要先确认边界条件再动手'
    const count = (svg: string): number => (svg.match(/<tspan/g) ?? []).length
    expect(count(markup([node({ text, width: 168, height: 120 })]))).toBeLessThan(
      count(markup([node({ text, width: 168, height: 240, fontSize: 32 })])),
    )
  })
})

// T77 · 字效与图片贴合：屏幕上是什么样，导出就得是什么样。
// 这两条都容易「只在屏幕上对」——画布改 CSS 属性，导出改的是 SVG 呈现属性，两处必须同时改。
describe('T77 · 字效与图片贴合导出', () => {
  const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
  const imageNode = (over: Partial<WhiteboardNode> = {}): WhiteboardNode =>
    node({ shape: 'image', image: 'assets/wb1.png', text: 'shot.png', ...over })

  it('加粗落成 font-weight="700"，斜体落成 font-style="italic"', () => {
    const svg = markup([node({ text: '标题', bold: true, italic: true })])
    expect(svg).toContain('font-weight="700"')
    expect(svg).toContain('font-style="italic"')
  })

  it('没加粗没斜体：两个属性都不出现（不是写 false / normal）', () => {
    const svg = markup([node({ text: '正文' })])
    expect(svg).not.toContain('font-weight="700"')
    expect(svg).not.toContain('font-style')
  })

  it('分组框的标题仍是 600（不去抢它的强调），加粗后才到 700', () => {
    expect(markup([node({ shape: 'frame', text: '第一层' })])).toContain('font-weight="600"')
    expect(markup([node({ shape: 'frame', text: '第一层', bold: true })])).toContain('font-weight="700"')
  })

  it('图片 cover：preserveAspectRatio 用 slice，并给一层裁到节点矩形的 clipPath', () => {
    const svg = buildWhiteboardSvgMarkup(board([imageNode({ imageFit: 'cover' })]), {
      range: 'full',
      images: new Map([['assets/wb1.png', DATA_URL]]),
    }).markup
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"')
    expect(svg).toContain('<clipPath id="wb-clip-n1">')
    expect(svg).toContain('clip-path="url(#wb-clip-n1)"')
  })

  it('图片缺省（contain）：不产生 clipPath，仍是 meet', () => {
    const svg = buildWhiteboardSvgMarkup(board([imageNode()]), {
      range: 'full',
      images: new Map([['assets/wb1.png', DATA_URL]]),
    }).markup
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"')
    expect(svg).not.toContain('clipPath')
  })
})
