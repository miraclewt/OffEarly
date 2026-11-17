// T43 · MindMapModel：思维导图（xmind 逻辑图·向右）布局模型纯函数。
// 零 React / 零 DOM / 零 I/O；坐标（节点矩形、贝塞尔边、bounds）全部在这里算完。
// 渲染（T45）、导出（T48）、单测共用同一模型：视图与导出器都只读 MindMapModel，不再各自排布。
// 文本宽度沿用 controllers/ganttViewport 的 DOM-free 估算（import 复用，不复制实现），
// 因此导出器拿到同一份 text 即可复算出同一组数字（domain/ganttModel.ts 同构手法）。
//
// 布局两趟：① measure(node) 递归求子树像素高（叶子/折叠 = 单节点高；展开父 = max(自身高, Σ子高 + 间距)）；
//   ② place(node, left, top) 先排子树、父在自己的子树里垂直居中，子列 left = 父右缘 + H_GAP。
// 口径三条（T45/T48 按此依赖）：
//   ① 兄弟顺序一律按 children 数组下标，**不**按 node.order 排序（v1 领域口径：数组位即视觉序）。
//   ② 可见性由「渲染折叠」决定：node.folded 或 opts.foldAll 命中即按叶子排布，子树留在数据里
//      （opts 只做显示态，视图层的「全部折叠」因此无需写命令）；命中节点的 hiddenCount =
//      这次折叠真正藏掉的后代数（见 hiddenUnder）。
//   ③ 节点的 text 已是截断后的文本，视图直接渲染，不再自行截断。

import { estimateGanttLabelWidth, truncateGanttLabel } from '../controllers/ganttViewport'
import { countHidden } from './mindmapTree'
import type { MindMap, MindNode } from './types'

/** 节点行高（与甘特行高同值，两套视图观感一致）。 */
export const MINDMAP_NODE_HEIGHT = 32
/** 父子列间距（父右缘 → 子左缘）。 */
export const MINDMAP_H_GAP = 48
/** 兄弟纵向间距。 */
export const MINDMAP_V_GAP = 14
/** 空/极短文本也要能点得中，节点宽度有下限。 */
export const MINDMAP_MIN_NODE_WIDTH = 56
/** 节点宽度封顶，同时也是标签的截断预算上限（留 PADDING 给内边距）。 */
export const MINDMAP_MAX_TEXT_WIDTH = 320
/** 标签字号：估算、截断、渲染三处共用同一个字号，宽度才复算得回来。 */
export const MINDMAP_FONT_SIZE = 13
/** 节点左右内边距合计：截断预算 = 封顶宽 - PADDING，节点宽 = 文本估算 + PADDING。 */
const MINDMAP_NODE_PADDING = 24

export interface MindMapNodeView {
  id: string
  /** 截断后的文本，视图原样渲染 */
  text: string
  depth: number
  parentId: string | null
  /** 内容坐标，x/y 为左上角 */
  x: number
  y: number
  width: number
  height: number
  /** 渲染折叠态：node.folded 或 opts.foldAll 命中 */
  folded: boolean
  /** 被本次折叠藏起来的后代数（未折叠 = 0） */
  hiddenCount: number
  /** 数据上有子节点（折叠时仍为 true，视图据此画折叠标记） */
  hasChildren: boolean
  /** depth % 4，视图按档取色 */
  colorTier: number
}

export interface MindMapEdge {
  parentId: string
  childId: string
  /** 父右缘中点 → 子左缘中点的三次贝塞尔 */
  path: string
}

export interface MindMapModel {
  /** 可见节点，前序遍历（父先于子，子按 children 数组序） */
  nodes: MindMapNodeView[]
  edges: MindMapEdge[]
  /** 可见节点矩形（不含边的控制点）的 min/max */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export interface MindMapLayoutOptions {
  /**
   * 全部折叠：仅显示态，不改数据（T47 工具条用）。
   * 口径：**含根**——凡「有子节点」的节点一律按折叠排布，整图收成中心主题一枚
   * （与 xmind「全部收起」同形）。T47 若要「根展开、depth≥1 全折叠」的中间档，
   * 需另加 opts 维度，不要改这里的行为（模型测试已锁定）。
   */
  foldAll?: boolean
  /** 界面尺度（T40）：行高 / 间距 / 节点宽上下限 / 字号一起放大，默认 1。 */
  uiScale?: number
}

/** 布局中间态：一个节点及其可见子节点，带最终矩形。 */
interface PlacedNode {
  view: MindMapNodeView
  children: PlacedNode[]
}

export function buildMindMapModel(map: MindMap, opts?: MindMapLayoutOptions): MindMapModel {
  const foldAll = opts?.foldAll === true
  // T40：布局常量全部乘这一个系数，视图只读模型，不会出现「字大了框没大」
  const s = opts?.uiScale && opts.uiScale > 0 ? opts.uiScale : 1
  const rowHeight = MINDMAP_NODE_HEIGHT * s
  const vGap = MINDMAP_V_GAP * s
  const hGap = MINDMAP_H_GAP * s
  const nodes: MindMapNodeView[] = []
  const edges: MindMapEdge[] = []

  // 折叠（含 foldAll）与叶子一样按单节点排布：折叠的子树不进模型，入边也不进
  function visibleChildren(node: MindNode): MindNode[] {
    return isFoldedForLayout(node) ? [] : node.children
  }

  function isFoldedForLayout(node: MindNode): boolean {
    return node.folded || (foldAll && node.children.length > 0)
  }

  /** 趟 1：子树像素高。折叠/叶子 = 行高；展开父 = max(行高, Σ子树高 + 间距)。 */
  function measure(node: MindNode): number {
    const children = visibleChildren(node)
    if (children.length === 0) return rowHeight
    let height = vGap * (children.length - 1)
    for (const child of children) height += measure(child)
    return Math.max(rowHeight, height)
  }

  /** 趟 2：深度优先落子。先按 left 起排可见子列，再让自身在子列的垂直中心上居中。 */
  function place(
    node: MindNode,
    left: number,
    top: number,
    depth: number,
    parentId: string | null,
  ): PlacedNode {
    const width = nodeWidth(node.text, s)
    const childLeft = left + width + hGap
    const children: PlacedNode[] = []
    let cursorTop = top
    for (const child of visibleChildren(node)) {
      // 子树占位高 = measure(child)：place 只会在其中居中，不会越出这段高度。
      // 这里会重走一遍子树（O(n·depth)）：导图规模下够用，且不加可变缓存以保持纯函数可复算。
      const childHeight = measure(child)
      children.push(place(child, childLeft, cursorTop, depth + 1, node.id))
      cursorTop += childHeight + vGap
    }
    const folded = isFoldedForLayout(node)
    // 折叠与叶子一样只占一行（落在 top 上）；展开父取子列中心
    const occupiedHeight =
      children.length === 0 ? rowHeight : cursorTop - top - vGap
    const y = top + (occupiedHeight - rowHeight) / 2

    return {
      view: {
        id: node.id,
        text: truncatedText(node.text, s),
        depth,
        parentId,
        x: left,
        y,
        width,
        height: rowHeight,
        folded,
        hiddenCount: folded ? hiddenUnder(node) : 0,
        hasChildren: node.children.length > 0,
        colorTier: depth % 4,
      },
      children,
    }
  }

  // 前序摊平：nodes 父先于子、edges 按「父 → 其 children 序」逐条产出
  function flatten(placed: PlacedNode): void {
    nodes.push(placed.view)
    for (const child of placed.children) {
      edges.push({
        parentId: placed.view.id,
        childId: child.view.id,
        path: edgePath(placed.view, child.view),
      })
      flatten(child)
    }
  }

  flatten(place(map.root, 0, 0, 0, null))

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }

  return { nodes, edges, bounds: { minX, minY, maxX, maxY } }
}

/**
 * 折叠真正藏掉的后代数：整棵子树不进模型，所以按「此处即折叠」向 countHidden 求值。
 * 数据已折叠的节点两者等价（countHidden 对 folded 根返回的正是全部后代数，嵌套折叠不重复计），
 * 而 opts.foldAll 命中的节点数据上 folded=false——浅拷贝一个 folded:true 再读同一个 helper
 * （只读、不改入参树：children 仍是原引用）。
 */
function hiddenUnder(node: MindNode): number {
  return countHidden(node.folded ? node : { ...node, folded: true })
}

/** 标签截断 + 节点宽：clamp(估算(截断文本) + 内边距, 下限, 封顶)。text 即模型里渲染的那份。 */
function truncatedText(text: string, s = 1): string {
  return truncateGanttLabel(
    text,
    (MINDMAP_MAX_TEXT_WIDTH - MINDMAP_NODE_PADDING) * s,
    MINDMAP_FONT_SIZE * s,
  )
}

function nodeWidth(text: string, s = 1): number {
  const estimate =
    estimateGanttLabelWidth(truncatedText(text, s), MINDMAP_FONT_SIZE * s) + MINDMAP_NODE_PADDING * s
  return Math.min(MINDMAP_MAX_TEXT_WIDTH * s, Math.max(MINDMAP_MIN_NODE_WIDTH * s, estimate))
}

/** 父右缘中点 → 子左缘中点，控制点取两端 x 中线的水平方向（xmind 曲线手感）。 */
function edgePath(parent: MindMapNodeView, child: MindMapNodeView): string {
  const x0 = parent.x + parent.width
  const y0 = parent.y + parent.height / 2
  const x1 = child.x
  const y1 = child.y + child.height / 2
  const midX = (x0 + x1) / 2
  return `M ${x0} ${y0} C ${midX} ${y0}, ${midX} ${y1}, ${x1} ${y1}`
}
