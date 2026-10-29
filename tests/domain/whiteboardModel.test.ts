// T69 · whiteboardModel 单测：锚点、走线、箭头、渲染序、文本分行、命中检测。
//
// 这些断言钉的是**几何口径**（不是像素）：视图与导出器读同一份结果，所以这里改一处
// 就等于同时改屏幕与导出——测试在这里失败比在截图里发现要好。

import { describe, expect, it } from 'vitest'

import {
  WHITEBOARD_ARROW_LENGTH,
  WHITEBOARD_SWATCHES,
  anchorPoint,
  arrowPoints,
  whiteboardBounds,
  whiteboardRenderOrder,
  buildEdgeView,
  hexLuminance,
  hexToCss,
  measureText,
  mixHex,
  normalizeHex,
  readableInk,
  rectContains,
  rectsIntersect,
  resolveAnchor,
  resolveNodePaint,
  shadeHex,
  snapToGrid,
  wrapText,
} from '../../src/domain/whiteboardModel'
import type { WhiteboardEdge, WhiteboardNode } from '../../src/domain/types'

const left = { x: 0, y: 0, width: 100, height: 60 }
const right = { x: 300, y: 0, width: 100, height: 60 }
const below = { x: 0, y: 200, width: 100, height: 60 }

function edge(overrides: Partial<WhiteboardEdge> = {}): WhiteboardEdge {
  return {
    id: 'e1',
    from: 'a',
    to: 'b',
    fromAnchor: 'auto',
    toAnchor: 'auto',
    route: 'ortho',
    arrow: 'end',
    dashed: false,
    label: '',
    ...overrides,
  }
}

function node(overrides: Partial<WhiteboardNode> = {}): WhiteboardNode {
  return {
    id: 'n',
    shape: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    text: '',
    tone: 'plain',
    ...overrides,
  }
}

describe('resolveAnchor', () => {
  it('横向距离更大时走左右，纵向更大时走上下', () => {
    expect(resolveAnchor(left, 'auto', right)).toBe('right')
    expect(resolveAnchor(right, 'auto', left)).toBe('left')
    expect(resolveAnchor(left, 'auto', below)).toBe('bottom')
    expect(resolveAnchor(below, 'auto', left)).toBe('top')
  })

  it('相等时优先左右（宽扁的架构图不该出现斜向折线）', () => {
    const square = { x: 100, y: 100, width: 60, height: 60 }
    expect(resolveAnchor({ x: 0, y: 0, width: 60, height: 60 }, 'auto', square)).toBe('right')
  })

  it('显式锚点原样返回，不参与方位判断', () => {
    expect(resolveAnchor(left, 'top', right)).toBe('top')
    expect(resolveAnchor(left, 'left', right)).toBe('left')
  })
})

describe('anchorPoint', () => {
  it('四个边中点', () => {
    expect(anchorPoint(left, 'top')).toEqual({ x: 50, y: 0 })
    expect(anchorPoint(left, 'bottom')).toEqual({ x: 50, y: 60 })
    expect(anchorPoint(left, 'left')).toEqual({ x: 0, y: 30 })
    expect(anchorPoint(left, 'right')).toEqual({ x: 100, y: 30 })
  })
})

describe('buildEdgeView · 直线', () => {
  it('中点对中点，末端箭头在终点', () => {
    const view = buildEdgeView(edge({ route: 'straight' }), left, right)
    expect(view.path).toBe('M 100 30 L 300 30')
    expect(view.endArrow).not.toBeNull()
    expect(view.startArrow).toBeNull()
  })

  it('arrow=both 两端都有箭头，arrow=none 一个都没有', () => {
    expect(buildEdgeView(edge({ route: 'straight', arrow: 'both' }), left, right).startArrow).not.toBeNull()
    expect(buildEdgeView(edge({ route: 'straight', arrow: 'none' }), left, right).endArrow).toBeNull()
  })
})

describe('buildEdgeView · 正交', () => {
  it('先从锚点沿法线出线 WHITEBOARD_STUB，再折', () => {
    const view = buildEdgeView(edge(), left, right)
    // 起点收在 (100,30) 的右缘，沿 +x 出线到 (118,30)——圆角把拐点切成 110 起、126 止
    expect(view.path.startsWith('M 100 30 L 110 30')).toBe(true)
    expect(view.path).toContain(`Q 118 30 126 30`)
    // 终点也沿法线入线：最后一段落在 (300,30)
    expect(view.path.endsWith('L 300 30')).toBe(true)
  })

  it('上下排布时走竖线，出线是竖直的', () => {
    const view = buildEdgeView(edge(), left, below)
    expect(view.path.startsWith('M 50 60 L 50 70')).toBe(true)
    expect(view.path.endsWith('L 50 200')).toBe(true)
  })

  it('两端同侧且同高时绕出一条 U 形，不叠成一条线', () => {
    const near = { x: 100, y: 0, width: 100, height: 60 }
    const view = buildEdgeView(edge({ fromAnchor: 'right', toAnchor: 'right' }), near, left)
    // 出线 218、目标出线 118，正向会折回——绕行通道在 y=30+2*STUB=66
    expect(view.path).toContain('66')
  })

  it('标签落点取折线中点，两端直连时取两点中间', () => {
    const ortho = buildEdgeView(edge(), left, right)
    expect(ortho.labelX).toBe(200)
    expect(ortho.labelY).toBe(30)
  })
})

describe('arrowPoints', () => {
  it('尖端在给定点，底边在中点后方一个箭头长', () => {
    const points = arrowPoints({ x: 100, y: 0 }, 0)
    const [tip, a, b] = points.split(' ').map((pair) => pair.split(',').map(Number))
    expect(tip).toEqual([100, 0])
    expect(a?.[0]).toBeCloseTo(100 - WHITEBOARD_ARROW_LENGTH)
    expect(b?.[0]).toBeCloseTo(100 - WHITEBOARD_ARROW_LENGTH)
    expect(a?.[1]).not.toBeCloseTo(b?.[1] ?? 0)
  })
})

describe('whiteboardBounds', () => {
  it('空画布给默认框，不返回 Infinity', () => {
    const bounds = whiteboardBounds([])
    expect(Number.isFinite(bounds.minX)).toBe(true)
    expect(bounds.maxX).toBeGreaterThan(bounds.minX)
  })

  it('多节点取并集', () => {
    expect(whiteboardBounds([left, right, below])).toEqual({ minX: 0, minY: 0, maxX: 400, maxY: 260 })
  })
})

describe('whiteboardRenderOrder', () => {
  it('frame 沉底、其余保持原序（后加的盖在上面）', () => {
    const nodes = [
      node({ id: 'a' }),
      node({ id: 'frame', shape: 'frame' }),
      node({ id: 'b' }),
      node({ id: 'frame2', shape: 'frame' }),
    ]
    expect(whiteboardRenderOrder(nodes).map((item) => item.id)).toEqual(['frame', 'frame2', 'a', 'b'])
  })

  it('不改入参数组', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'f', shape: 'frame' })]
    whiteboardRenderOrder(nodes)
    expect(nodes.map((item) => item.id)).toEqual(['a', 'f'])
  })
})

describe('snapToGrid', () => {
  it('按 8px 归整，负数同样归整', () => {
    expect(snapToGrid(3)).toBe(0)
    expect(snapToGrid(5)).toBe(8)
    expect(snapToGrid(-5)).toBe(-8)
  })
})

describe('measureText / wrapText', () => {
  it('中文按整字、拉丁按半角估算', () => {
    expect(measureText('中文', 10)).toBeCloseTo(20)
    expect(measureText('abcd', 10)).toBeCloseTo(22)
  })

  it('超宽折行，显式换行保留', () => {
    // 10 号字拉丁字符 5.5px/字 → 30px 宽只放得下 5 个
    expect(wrapText('abcdefgh', 10 * 3, 10)).toEqual(['abcde', 'fgh'])
    expect(wrapText('ab\ncd', 100, 10)).toEqual(['ab', 'cd'])
    expect(wrapText('', 100, 10)).toEqual([''])
  })

  it('单个字符比行宽还宽时不丢字', () => {
    expect(wrapText('中文测试', 6, 10)).toEqual(['中', '文', '测', '试'])
  })
})

describe('命中检测', () => {
  it('矩形包含与相交', () => {
    expect(rectContains(left, { x: 10, y: 10 })).toBe(true)
    expect(rectContains(left, { x: 101, y: 10 })).toBe(false)
    expect(rectsIntersect(left, { x: 90, y: 50, width: 40, height: 40 })).toBe(true)
    expect(rectsIntersect(left, { x: 200, y: 0, width: 10, height: 10 })).toBe(false)
  })
})

describe('自定义色（T70）', () => {
  it('收颜色：三种写法都归一成小写 #rrggbb，收不了就 null', () => {
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc')
    expect(normalizeHex('aabbcc')).toBe('#aabbcc')
    expect(normalizeHex('  #ABC ')).toBe('#aabbcc')
    expect(normalizeHex('#12345')).toBeNull()
    expect(normalizeHex('rgb(1,2,3)')).toBeNull()
    expect(normalizeHex('')).toBeNull()
  })

  it('预设色板里每一格都是合法颜色（手写常量防打错）', () => {
    expect(WHITEBOARD_SWATCHES.length).toBeGreaterThanOrEqual(12)
    for (const hex of WHITEBOARD_SWATCHES) expect(normalizeHex(hex)).toBe(hex)
  })

  it('字色按底色算：浅底近黑、深底纯白', () => {
    expect(readableInk('#FFFFFF')).toBe('#1D1D1F')
    expect(readableInk('#FEF3C7')).toBe('#1D1D1F')
    expect(readableInk('#1D1D1F')).toBe('#FFFFFF')
    expect(readableInk('#3B82F6')).toBe('#FFFFFF')
    // 亮度是 WCAG 相对亮度，不是简单平均：纯绿比纯蓝亮得多
    expect(hexLuminance('#10B981')).toBeGreaterThan(hexLuminance('#3B82F6'))
  })

  it('shade 往黑/往白推，混合取中间值', () => {
    expect(shadeHex('#808080', -0.5)).toBe('#404040')
    expect(shadeHex('#808080', 0.5)).toBe('#c0c0c0')
    expect(shadeHex('#FFFFFF', -1)).toBe('#000000')
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#FFFFFF', 0)).toBe('#000000')
  })

  it('alpha 为 1 时给 hex，其余给 rgba', () => {
    expect(hexToCss('#3b82f6', 1)).toBe('#3b82f6')
    expect(hexToCss('#3b82f6', 0.14)).toBe('rgba(59, 130, 246, 0.140)')
  })

  it('没有 fill 就不接管配色（回落到语义色）', () => {
    expect(resolveNodePaint({ shape: 'rect' })).toBeNull()
  })

  it('矩形：实底 + 推出来的深一档描边 + 对比字色', () => {
    const paint = resolveNodePaint({ shape: 'rect', fill: '#FEF3C7' })!
    expect(paint.fill).toBe('#FEF3C7')
    expect(paint.fillOpacity).toBe(1)
    expect(paint.ink).toBe('#1D1D1F')
    // 浅底 → 描边压深
    expect(hexLuminance(paint.stroke)).toBeLessThan(hexLuminance('#FEF3C7'))
    expect(paint.dashed).toBe(false)
  })

  it('深底：描边反而提亮，字换白', () => {
    const paint = resolveNodePaint({ shape: 'note', fill: '#1D1D1F' })!
    expect(paint.ink).toBe('#FFFFFF')
    expect(hexLuminance(paint.stroke)).toBeGreaterThan(hexLuminance('#1D1D1F'))
  })

  it('文本图元：自定义色就是字色，不铺底也不描边', () => {
    const paint = resolveNodePaint({ shape: 'text', fill: '#EF4444' })!
    expect(paint.ink).toBe('#EF4444')
    expect(paint.fill).toBe('none')
    expect(paint.stroke).toBe('none')
  })

  it('分组框：底色压低透明度（不糊住里面的框），虚线，字色按混出来的底算', () => {
    const paint = resolveNodePaint({ shape: 'frame', fill: '#3B82F6' })!
    expect(paint.fillOpacity).toBeLessThan(0.3)
    expect(paint.dashed).toBe(true)
    expect(paint.ink).toBe('#1D1D1F')
  })
})
