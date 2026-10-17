// T45 · MindMapCanvas：MindMapModel 的 SVG 投影（只渲染，零几何计算）。
//
// 与 GanttCanvas 同一条红线：这里**不排布**——节点矩形 / 贝塞尔 path / bounds 一律来自
// domain/mindmapModel.buildMindMapModel，视图只做「看哪一段」的变换：外层 <svg> 铺满容器，
// 内层 <g transform="translate(pan) scale(zoom)"> 承载内容坐标（screen = content*zoom + pan，
// 与 controllers/mindmapViewport 的契约一一对应；pan/zoom 全部由视图层经 props 传入）。
//
// 颜色口径（T45 裁决）：GanttCanvas 把 hex 字面量绑在**呈现属性**上是因为导出器要逐字比对
// （那批常量属 T48 的导出对等层）；T45 不涉导出，一律走内联 style 的 CSS 变量——
// style 是 CSS，浏览器里能解析 var()，只有呈现属性（fill= / stroke=）不能。故本文件零新增 hex。
//
// 只读边界（T45）：badge 只渲染不响应——onToggleFold 是 T46 的缝，本任务视图不传，
// 传了才挂点击；editingId 同样是为 T46 预留的投影分支（编辑中的节点隐掉 <text>，
// 输入框是视图层的 HTML overlay，Canvas 不管）。

import type { MouseEvent as ReactMouseEvent } from 'react'

import { MINDMAP_FONT_SIZE } from '../domain/mindmapModel'
import type { MindMapModel, MindMapNodeView } from '../domain/mindmapModel'

/** 节点圆角（与 --oe-radius-control 同值；SVG rx 只收数字，取现量 8）。 */
const NODE_RADIUS = 8
/** 折叠徽标：贴节点右缘的小圆，半径 7、字号 10，克制不抢文本。 */
const BADGE_RADIUS = 7
const BADGE_FONT_SIZE = 10

export interface MindMapCanvasProps {
  /** buildMindMapModel 的投影结果；nodes 的 text 已截断，直接渲染 */
  model: MindMapModel
  /** 视口平移（screen = content * zoom + pan 中的加项），屏幕像素 */
  panX: number
  panY: number
  /** 视口缩放倍数（mindmapZoomFactorAt(zoomIndex)） */
  zoom: number
  /** 选中节点 id（只读投影：描边高亮，T45 的选中态留在视图本地 state） */
  selectedId: string | null
  /** 就地编辑中的节点 id：编辑时隐掉该节点的 <text>（输入框由 T46 的 overlay 承接） */
  editingId: string | null
  /** 点选节点外送 id；T45 视图用它记本地选中态。省略则节点不带指针样式。 */
  onSelect?(id: string): void
  /** 折叠徽标点击（T46 接线）：T45 不传——badge 渲染但无处理器，视图保持严格只读。 */
  onToggleFold?(id: string): void
}

/**
 * colorTier → 配色（四档，全部取自 theme.css 既有令牌，无新 hex）：
 * 档 0 / 深度 0（根）：accent 实底 + on-accent 白字；
 * 档 1/2：surface 底 + accent 描边按档降透明度（.45 / .25，「同 accent 递减」）；
 * 档 3 与深度 4+ 回落到 3 的情形：surface 底 + separator 描边。
 * 标签一律 --oe-text（根除外）。深度 4 的 colorTier 也是 0，所以根判定用 depth 不用 tier。
 */
function nodePaint(node: MindMapNodeView): {
  fill: string
  stroke: string
  strokeOpacity?: number
  label: string
} {
  if (node.depth === 0) {
    return { fill: 'var(--oe-accent)', stroke: 'var(--oe-accent)', label: 'var(--oe-on-accent)' }
  }
  const surface = { fill: 'var(--oe-surface)', stroke: 'var(--oe-border)', label: 'var(--oe-text)' }
  switch (node.colorTier) {
    case 1:
      return { fill: surface.fill, stroke: 'var(--oe-accent)', strokeOpacity: 0.45, label: surface.label }
    case 2:
      return { fill: surface.fill, stroke: 'var(--oe-accent)', strokeOpacity: 0.25, label: surface.label }
    default:
      return surface
  }
}

export function MindMapCanvas(props: MindMapCanvasProps) {
  const { model, panX, panY, zoom, selectedId, editingId, onSelect, onToggleFold } = props
  const centerY = (node: MindMapNodeView): number => node.y + node.height / 2

  const handleNodeClick = (nodeId: string): void => {
    onSelect?.(nodeId)
  }

  const handleBadgeClick = (event: ReactMouseEvent<SVGGElement>, nodeId: string): void => {
    if (onToggleFold === undefined) return
    // 徽标先于节点吞掉点击，避免点折叠圈顺带把节点选中（T46 的口径，这里把缝留好）
    event.stopPropagation()
    onToggleFold(nodeId)
  }

  return (
    <svg
      data-testid="mindmap-canvas"
      data-zoom={zoom}
      data-selected-node={selectedId ?? undefined}
      width="100%"
      height="100%"
      style={{ display: 'block', fontFamily: 'inherit', touchAction: 'none' }}
    >
      <g data-mindmap-world="true" transform={`translate(${panX} ${panY}) scale(${zoom})`}>
        {/* 边先画、节点盖在上面：贝塞尔由模型算好（父右缘中点 → 子左缘中点），这里零计算。 */}
        {model.edges.map((edge) => (
          <path
            key={`${edge.parentId}->${edge.childId}`}
            data-mindmap-edge={edge.childId}
            d={edge.path}
            fill="none"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            style={{ stroke: 'var(--oe-border)' }}
          />
        ))}

        {model.nodes.map((node) => {
          const paint = nodePaint(node)
          const selected = node.id === selectedId
          return (
            <g
              key={node.id}
              data-mindmap-node={node.id}
              onClick={() => handleNodeClick(node.id)}
              style={{ cursor: onSelect === undefined ? undefined : 'pointer' }}
            >
              <rect
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx={NODE_RADIUS}
                strokeWidth={selected ? 2 : 1}
                style={{
                  fill: paint.fill,
                  // 选中环：accent-deep 描边（根节点 accent 底上仍可见），宽度 2
                  stroke: selected ? 'var(--oe-accent-deep)' : paint.stroke,
                  strokeOpacity: selected ? undefined : paint.strokeOpacity,
                }}
              >
                <title>{node.text}</title>
              </rect>
              {node.id === editingId ? null : (
                <text
                  data-mindmap-label={node.id}
                  x={node.x + node.width / 2}
                  y={centerY(node)}
                  fontSize={MINDMAP_FONT_SIZE}
                  textAnchor="middle"
                  dominantBaseline="central"
                  pointerEvents="none"
                  style={{ fill: paint.label }}
                >
                  {node.text}
                </text>
              )}
              {node.folded && node.hasChildren ? (
                <g
                  data-mindmap-fold={node.id}
                  onClick={(event) => handleBadgeClick(event, node.id)}
                  style={{ cursor: onToggleFold === undefined ? undefined : 'pointer' }}
                >
                  <circle
                    cx={node.x + node.width}
                    cy={centerY(node)}
                    r={BADGE_RADIUS}
                    strokeWidth={1}
                    style={{ fill: 'var(--oe-fill)', stroke: 'var(--oe-border)' }}
                  />
                  <text
                    x={node.x + node.width}
                    y={centerY(node)}
                    fontSize={BADGE_FONT_SIZE}
                    textAnchor="middle"
                    dominantBaseline="central"
                    pointerEvents="none"
                    style={{ fill: 'var(--oe-text-muted)' }}
                  >
                    {`+${node.hiddenCount}`}
                  </text>
                </g>
              ) : null}
            </g>
          )
        })}
      </g>
    </svg>
  )
}

export default MindMapCanvas
