// T69 · whiteboardModel 单测：锚点、走线、箭头、渲染序、文本分行、命中检测。
//
// 这些断言钉的是**几何口径**（不是像素）：视图与导出器读同一份结果，所以这里改一处
// 就等于同时改屏幕与导出——测试在这里失败比在截图里发现要好。

import { describe, expect, it } from 'vitest'

import {
  WHITEBOARD_ARROW_LENGTH,
  WHITEBOARD_FONT_MAX,
  WHITEBOARD_FONT_SIZES,
  WHITEBOARD_IMAGE_MAX_HEIGHT,
  WHITEBOARD_IMAGE_MAX_WIDTH,
  WHITEBOARD_MIN_HEIGHT,
  WHITEBOARD_MIN_WIDTH,
  WHITEBOARD_SWATCHES,
  alignNodes,
  anchorPoint,
  arrowPoints,
  whiteboardBounds,
  whiteboardRenderOrder,
  buildEdgeView,
  centerNodesOn,
  distributeNodes,
  fitImageSize,
  fitTextHeight,
  hexLuminance,
  hexToCss,
  measureText,
  mixHex,
  normalizeHex,
  placeNewNode,
  readableInk,
  rectContains,
  rectsIntersect,
  resolveAnchor,
  resolveNodeFontSize,
  resolveNodePaint,
  shadeHex,
  snapToGrid,
  stepFontSize,
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

// T74 · 贴图尺寸：一张 4K 截图不能原样铺进画布（占满整块视口、还卡），
// 一张 32px 的小图标也不该被放大（只会变糊）。
describe('fitImageSize', () => {
  it('大图等比缩进最大框', () => {
    const size = fitImageSize({ width: 3840, height: 2160 })
    expect(size.width).toBeLessThanOrEqual(WHITEBOARD_IMAGE_MAX_WIDTH)
    expect(size.height).toBeLessThanOrEqual(WHITEBOARD_IMAGE_MAX_HEIGHT)
    // 16:9 的比例保持（网格取整后允许一个网格的误差）
    expect(Math.abs(size.width / size.height - 3840 / 2160)).toBeLessThan(0.05)
  })

  it('小图不放大', () => {
    const size = fitImageSize({ width: 64, height: 64 })
    expect(size.width).toBe(64)
    expect(size.height).toBe(64)
  })

  it('比最小尺寸还小的图抬到可点中的大小', () => {
    const size = fitImageSize({ width: 16, height: 16 })
    expect(size.width).toBeGreaterThanOrEqual(WHITEBOARD_MIN_WIDTH)
    expect(size.height).toBeGreaterThanOrEqual(WHITEBOARD_MIN_HEIGHT)
  })

  it('竖图按高度卡住，而不是按宽度', () => {
    const size = fitImageSize({ width: 600, height: 2400 })
    expect(size.height).toBeLessThanOrEqual(WHITEBOARD_IMAGE_MAX_HEIGHT)
    expect(size.width).toBeLessThan(160)
  })

  it('尺寸读不出来（0×0）走默认值，不返回 0 宽高', () => {
    const size = fitImageSize({ width: 0, height: 0 })
    expect(size.width).toBeGreaterThanOrEqual(WHITEBOARD_MIN_WIDTH)
    expect(size.height).toBeGreaterThanOrEqual(WHITEBOARD_MIN_HEIGHT)
  })

  it('结果按 8px 网格落位（与拖动吸附同一把尺子）', () => {
    const size = fitImageSize({ width: 1000, height: 640 })
    expect(size.width % 8).toBe(0)
    expect(size.height % 8).toBe(0)
  })
})

// T75 · 可调字号。这里钉四条：默认值只由形状决定、档位是离散的、把手不在档位上时不惊跳、
// 文本图元的高度跟着字号走（否则字会溢到选中环外面）。
describe('T75 · 字号', () => {
  it('没调过就用形状默认：便签 14，其余 13（frame 与 text 也是 13）', () => {
    expect(resolveNodeFontSize({ shape: 'note' })).toBe(14)
    for (const shape of ['rect', 'round', 'ellipse', 'diamond', 'text', 'frame'] as const) {
      expect(resolveNodeFontSize({ shape })).toBe(13)
    }
  })

  it('节点上存了值就只认它（即使与形状默认相同）', () => {
    expect(resolveNodeFontSize({ shape: 'note', fontSize: 32 })).toBe(32)
    expect(resolveNodeFontSize({ shape: 'rect', fontSize: 10 })).toBe(10)
  })

  it('A+ / A− 在档位表上走一格，不是 ±1', () => {
    expect(stepFontSize(13, 1)).toBe(14)
    expect(stepFontSize(14, 1)).toBe(16)
    expect(stepFontSize(13, -1)).toBe(12)
    expect(stepFontSize(12, -1)).toBe(11)
  })

  it('到头就停在头，不循环也不越界', () => {
    expect(stepFontSize(WHITEBOARD_FONT_MAX, 1)).toBe(WHITEBOARD_FONT_MAX)
    expect(stepFontSize(WHITEBOARD_FONT_SIZES[0]!, -1)).toBe(WHITEBOARD_FONT_SIZES[0])
  })

  it('当前值不在档位表（手工改过库）：往相邻方向取最近的档，不出现「有时跳一格有时跳两格」', () => {
    expect(stepFontSize(17, 1)).toBe(18)
    expect(stepFontSize(17, -1)).toBe(16)
    expect(stepFontSize(21, 1)).toBe(24)
  })

  it('文本图元的高度按行数算：字号越大行数越多，框跟着长', () => {
    const text = '这条需求要先确认边界条件'
    const small = fitTextHeight(text, 13, 168)
    const large = fitTextHeight(text, 32, 168)
    expect(large).toBeGreaterThan(small)

    // 单行也至少 min-height（新建的空文本图元就是 32 高，不该塌成一条）
    expect(fitTextHeight('', 13, 168)).toBe(WHITEBOARD_MIN_HEIGHT)
    expect(fitTextHeight('hi', 10, 168)).toBe(WHITEBOARD_MIN_HEIGHT)
  })

  it('高度一定装得下所有行（不靠 CSS 溢出兜底）', () => {
    for (const size of [13, 20, 32, 48]) {
      const height = fitTextHeight('架构评审：先对齐数据模型\n再拆接口', size, 200)
      const lines = wrapText('架构评审：先对齐数据模型\n再拆接口', 200 - 8, size).length
      expect(height).toBeGreaterThanOrEqual(lines * size * 1.5 - 1)
    }
  })

  it('宽度不参与重算高度之外的事：同一段文字拉宽只会更矮或持平', () => {
    const text = '把「谁在什么时候改了什么」记下来'
    expect(fitTextHeight(text, 13, 320)).toBeLessThanOrEqual(fitTextHeight(text, 13, 120))
  })
})

// T76 · 新图元落点：连点两次「文本」不该在同一处叠成一张。
// 现在的图元新建后会自动选中并进编辑态，完全重叠时用户看到的是一个占位文字 + 一个输入框，
// 会以为「只加了一个」；而轻微压边是正常排布，不该被推开。
describe('placeNewNode', () => {
  const SIZE = { width: 168, height: 32 }
  const CENTER = { x: 500, y: 400 }

  it('空地：落在视口中心（左上角 = 中心减一半，按 8px 网格）', () => {
    const spot = placeNewNode([], CENTER, SIZE)
    expect(spot).toEqual({ x: snapToGrid(500 - 84), y: snapToGrid(400 - 16) })
  })

  it('同一个位置已有同样大小的图元：挪开、不再完全重叠', () => {
    const first = placeNewNode([], CENTER, SIZE)
    const second = placeNewNode([{ shape: 'text', x: first.x, y: first.y, ...SIZE }], CENTER, SIZE)
    expect(second).not.toEqual(first)
    // 至少错开一格，否则还是会叠成一张
    expect(Math.abs(second.x - first.x) + Math.abs(second.y - first.y)).toBeGreaterThan(0)
  })

  it('只压住一点点边：不挪（排布常态，别把图元推得到处跑）', () => {
    const first = placeNewNode([], CENTER, SIZE)
    const offset = { shape: 'rect' as const, x: first.x + SIZE.width - 8, y: first.y, ...SIZE }
    expect(placeNewNode([offset], CENTER, SIZE)).toEqual(first)
  })

  it('分组框不参与避让：把图放进框里是最常见的用法', () => {
    const frame = { shape: 'frame' as const, x: 0, y: 0, width: 1600, height: 1200 }
    expect(placeNewNode([frame], CENTER, SIZE)).toEqual(placeNewNode([], CENTER, SIZE))
  })

  it('周围挤满时退化为原位，不会算出天外坐标', () => {
    const filled = []
    for (let i = 0; i < 20; i += 1) {
      filled.push({ shape: 'text' as const, x: snapToGrid(500 - 84 + i * 24), y: snapToGrid(400 - 16 + i * 24), ...SIZE })
    }
    const spot = placeNewNode(filled, CENTER, SIZE)
    expect(Number.isFinite(spot.x)).toBe(true)
    expect(Number.isFinite(spot.y)).toBe(true)
  })
})

// T77 · 落点从「对角斜线」改成「网格一圈」。
// 沿对角逐格挪的话，连点五次的图元会排成一条 45° 斜线、每两个只错开 24px，仍然大面积互压；
// 现在一格 = 自身宽高 + 间距，第二个落到右边、第三个落到下边、第四个落到左边、第五个落到上边。
describe('placeNewNode 网格落点（T77）', () => {
  const SIZE = { width: 168, height: 32 }
  const CENTER = { x: 500, y: 400 }

  function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    return width > 0 && height > 0
  }

  it('第二个落在正右方（同一行），不是斜下方', () => {
    const first = placeNewNode([], CENTER, SIZE)
    const second = placeNewNode([{ shape: 'text', ...first, ...SIZE }], CENTER, SIZE)
    expect(second.y).toBe(first.y)
    expect(second.x).toBeGreaterThan(first.x)
    expect(overlaps({ ...first, ...SIZE }, { ...second, ...SIZE })).toBe(false)
  })

  it('连点五次：五个位置互不相同且两两不重叠（而不是排成一条斜线）', () => {
    const placed: { shape: 'text'; x: number; y: number; width: number; height: number }[] = []
    for (let index = 0; index < 5; index += 1) {
      const spot = placeNewNode(placed, CENTER, SIZE)
      placed.push({ shape: 'text', ...spot, ...SIZE })
    }
    expect(new Set(placed.map((item) => `${item.x},${item.y}`)).size).toBe(5)
    for (let left = 0; left < placed.length; left += 1) {
      for (let right = left + 1; right < placed.length; right += 1) {
        expect(overlaps(placed[left]!, placed[right]!)).toBe(false)
      }
    }
  })

  it('相邻两格的距离 = 自身宽度 + 间距（按 8px 网格取整）', () => {
    const first = placeNewNode([], CENTER, SIZE)
    const second = placeNewNode([{ shape: 'text', ...first, ...SIZE }], CENTER, SIZE)
    expect(second.x - first.x).toBe(snapToGrid(SIZE.width + 24))
  })
})

// ---------------------------------------------------------------------------
// T81 · 对齐 / 等距分布 / 移到视野中心
//
// 这一节钉的是「参照物」与「首尾不动」两条口径——它们是最容易被后续改动悄悄改坏的部分：
// 对齐若改成「以先点中的那枚为准」，结果就随点击顺序漂；分布若改成「中心等距」，
// 宽度不一时看起来就是歪的。
// ---------------------------------------------------------------------------

type Box = { id: string; x: number; y: number; width: number; height: number }

function box(id: string, x: number, y: number, width: number, height: number): Box {
  return { id, x, y, width, height }
}

/** 把一批 move 落回节点，方便断言「落完之后长什么样」。 */
function applyMoves(nodes: readonly Box[], moves: readonly { id: string; patch: { x?: number; y?: number } }[]): Box[] {
  return nodes.map((node) => {
    const move = moves.find((item) => item.id === node.id)
    return move === undefined ? node : { ...node, ...move.patch }
  })
}

describe('alignNodes 对齐到选区包围盒（T81）', () => {
  const nodes = [box('a', 100, 100, 80, 40), box('b', 300, 260, 120, 60), box('c', 520, 180, 60, 30)]

  it('左对齐：全部贴到 minX，且只改 x（patch 里没有 y 键）', () => {
    const moves = alignNodes(nodes, 'left')
    const moved = applyMoves(nodes, moves)
    expect(moved.map((node) => node.x)).toEqual([100, 100, 100])
    // 纵向原样
    expect(moved.map((node) => node.y)).toEqual([100, 260, 180])
    for (const move of moves) expect(Object.keys(move.patch)).toEqual(['x'])
  })

  it('右对齐：右缘全部贴到 maxX（不是右缘对齐到某一枚的右缘）', () => {
    const moved = applyMoves(nodes, alignNodes(nodes, 'right'))
    expect(moved.map((node) => node.x + node.width)).toEqual([580, 580, 580])
  })

  it('水平居中 / 垂直居中：中线全部重合', () => {
    const horizontal = applyMoves(nodes, alignNodes(nodes, 'center'))
    expect(new Set(horizontal.map((node) => node.x + node.width / 2)).size).toBe(1)
    const vertical = applyMoves(nodes, alignNodes(nodes, 'middle'))
    expect(new Set(vertical.map((node) => node.y + node.height / 2)).size).toBe(1)
  })

  it('顶对齐 / 底对齐', () => {
    expect(applyMoves(nodes, alignNodes(nodes, 'top')).map((node) => node.y)).toEqual([100, 100, 100])
    expect(applyMoves(nodes, alignNodes(nodes, 'bottom')).map((node) => node.y + node.height)).toEqual([320, 320, 320])
  })

  it('少于两枚没有「互相」可言：返回空（工具栏也不该给按钮）', () => {
    expect(alignNodes([], 'left')).toEqual([])
    expect(alignNodes([box('a', 10, 10, 40, 40)], 'left')).toEqual([])
  })

  it('已经对齐时返回空数组：再点一次不该攒出一条空撤销项', () => {
    const aligned = [box('a', 100, 100, 80, 40), box('b', 100, 300, 60, 40)]
    expect(alignNodes(aligned, 'left')).toEqual([])
  })

  it('结果取整：半像素的边也对齐到整数坐标', () => {
    const odd = [box('a', 100.4, 100, 80, 40), box('b', 300.7, 200, 77, 40)]
    for (const move of alignNodes(odd, 'left')) expect(Number.isInteger(move.patch.x)).toBe(true)
  })
})

describe('distributeNodes 等距分布（T81）', () => {
  it('水平：首尾不动，空隙相等', () => {
    // span = 660-100 = 560，总宽 180，空隙 = (560-180)/2 = 190
    const nodes = [box('a', 100, 500, 80, 40), box('b', 300, 520, 40, 40), box('c', 600, 540, 60, 40)]
    const moved = applyMoves(nodes, distributeNodes(nodes, 'horizontal'))
    const sorted = [...moved].sort((left, right) => left.x - right.x)
    expect(sorted.map((node) => node.x)).toEqual([100, 370, 600])
    const first = sorted[0]!
    const gaps = sorted
      .slice(1)
      .map((node, index) => node.x - (sorted[index]!.x + sorted[index]!.width))
    expect(gaps[0]).toBe(gaps[1])
    // 首尾原位
    expect(sorted[0]!.x).toBe(100)
    expect(sorted[2]!.x + sorted[2]!.width).toBe(660)
    expect(first.x).toBe(100)
  })

  it('宽度不同也按「空隙相等」排（等中心距会让它们看起来歪）', () => {
    // 三枚宽度 20 / 100 / 60 且左侧起点不均：空隙相等时，两组中心距必然不等
    const nodes = [box('a', 0, 0, 20, 40), box('b', 200, 0, 100, 40), box('c', 500, 0, 60, 40)]
    const moved = applyMoves(nodes, distributeNodes(nodes, 'horizontal'))
    const sorted = [...moved].sort((left, right) => left.x - right.x)
    const gaps = sorted.slice(1).map((node, index) => node.x - (sorted[index]!.x + sorted[index]!.width))
    expect(gaps[0]).toBe(gaps[1])
    // 中心距反而不等——这正是选择「空隙相等」的证据
    const centers = sorted.map((node) => node.x + node.width / 2)
    expect(centers[1]! - centers[0]!).not.toBe(centers[2]! - centers[1]!)
  })

  it('纵向：同上，只改 y', () => {
    const nodes = [box('a', 0, 0, 60, 40), box('b', 0, 90, 60, 20), box('c', 0, 300, 60, 40)]
    const moves = distributeNodes(nodes, 'vertical')
    for (const move of moves) expect(Object.keys(move.patch)).toEqual(['y'])
    const moved = applyMoves(nodes, moves)
    const sorted = [...moved].sort((left, right) => left.y - right.y)
    const gaps = sorted.slice(1).map((node, index) => node.y - (sorted[index]!.y + sorted[index]!.height))
    expect(gaps[0]).toBe(gaps[1])
  })

  it('少于三枚没有「中间」可排：返回空', () => {
    expect(distributeNodes([], 'horizontal')).toEqual([])
    expect(distributeNodes([box('a', 0, 0, 40, 40)], 'horizontal')).toEqual([])
    expect(distributeNodes([box('a', 0, 0, 40, 40), box('b', 100, 0, 40, 40)], 'horizontal')).toEqual([])
  })

  it('本来就等距时返回空数组（幂等，不会每点一次抖一格）', () => {
    const even = [box('a', 0, 0, 40, 40), box('b', 80, 0, 40, 40), box('c', 160, 0, 40, 40)]
    expect(distributeNodes(even, 'horizontal')).toEqual([])
  })

  it('输入顺序不影响结果（内部先按起点排序）', () => {
    const nodes = [box('a', 100, 0, 80, 40), box('b', 300, 0, 40, 40), box('c', 600, 0, 60, 40)]
    const shuffled = [nodes[2]!, nodes[0]!, nodes[1]!]
    expect(distributeNodes(shuffled, 'horizontal')).toEqual(distributeNodes(nodes, 'horizontal'))
  })
})

describe('centerNodesOn 移到视野中心（T81）', () => {
  it('单选：中心落到给定点', () => {
    const nodes = [box('a', 0, 0, 100, 40)]
    const moved = applyMoves(nodes, centerNodesOn(nodes, 'horizontal', { x: 800, y: 600 }))
    expect(moved[0]!.x + moved[0]!.width / 2).toBe(800)
    // 另一个轴不动
    expect(moved[0]!.y).toBe(0)
  })

  it('多选：包围盒中心落到给定点，图元之间的相对位置不变', () => {
    const nodes = [box('a', 0, 0, 100, 40), box('b', 200, 100, 60, 40)]
    const moved = applyMoves(nodes, centerNodesOn(nodes, 'vertical', { x: 0, y: 500 }))
    const top = Math.min(...moved.map((node) => node.y))
    const bottom = Math.max(...moved.map((node) => node.y + node.height))
    expect((top + bottom) / 2).toBe(500)
    expect(moved[1]!.x - moved[0]!.x).toBe(200)
  })

  it('已经在中心：返回空（按钮点了没反应是正确行为）', () => {
    const nodes = [box('a', 750, 0, 100, 40)]
    expect(centerNodesOn(nodes, 'horizontal', { x: 800, y: 600 })).toEqual([])
  })

  it('空选区：返回空', () => {
    expect(centerNodesOn([], 'horizontal', { x: 0, y: 0 })).toEqual([])
  })
})
