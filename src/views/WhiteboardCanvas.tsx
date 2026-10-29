// T69 · WhiteboardCanvas：白板的呈现层（HTML 图元 + SVG 连线叠加）。
//
// 为什么节点是 HTML 而不是 SVG：白板上最重要的内容是文字——多行、自动换行、光标、选区、
// 输入法。这些在 HTML 里是浏览器送的，在 SVG 里要自己造（foreignObject 导出时又不可靠）。
// 因此分工是：**图元用 div，连线用 path**，两层放在同一个 `translate(pan) scale(zoom)` 的
// 世界层里，坐标系统一为内容坐标，缩放对两者完全一致。
//
// 与 MindMapCanvas 同一条红线：这里**不排版**。位置与尺寸全部来自数据（用户摆的），
// 连线几何来自 domain/whiteboardModel。本文件只决定「怎么画」。
//
// 颜色一律走 theme.css 令牌（零新增 hex），方形图元的圆角 / 边框 / 阴影与全站控件同一套 token；
// tone 只在四档语义色里换底色，不引入第二套配色语言。

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

import {
  WHITEBOARD_FONT_SIZE,
  WHITEBOARD_NOTE_FONT_SIZE,
  buildEdgeView,
  whiteboardRenderOrder,
  nodeTextWidth,
} from '../domain/whiteboardModel'
import type { WhiteboardEdgeView, WhiteboardPoint, WhiteboardRect } from '../domain/whiteboardModel'
import type { Whiteboard, WhiteboardNode, WhiteboardShape, WhiteboardTone } from '../domain/types'

/** 四角把手的边长与四边锚点的半径（屏幕像素，随 uiScale 走）。 */
const HANDLE = 9
const ANCHOR_RADIUS = 5

export type WhiteboardCorner = 'nw' | 'ne' | 'sw' | 'se'
export type WhiteboardSide = 'top' | 'right' | 'bottom' | 'left'

export interface WhiteboardCanvasProps {
  whiteboard: Whiteboard
  panX: number
  panY: number
  zoom: number
  /** 选中集合（节点 id） */
  selectedIds: readonly string[]
  selectedEdgeId: string | null
  /** 就地编辑中的节点 id；非空时该节点渲染成 textarea */
  editingId: string | null
  draftText: string
  /** 拖动中的位移（内容坐标）；只作用于 dragIds 里的节点 */
  dragDelta: WhiteboardPoint | null
  dragIds: readonly string[]
  /** 缩放中的临时矩形（内容坐标），盖在节点原位置之上 */
  resizeRect: (WhiteboardRect & { id: string }) | null
  /** 连线中的预览（内容坐标）：起点已定，终点跟随指针 */
  linkPreview: { from: WhiteboardPoint; to: WhiteboardPoint } | null
  /** 框选矩形（内容坐标） */
  marquee: WhiteboardRect | null
  /** 当前连线会落到的节点（高亮用） */
  linkTargetId: string | null

  onNodePointerDown(event: ReactPointerEvent<HTMLElement>, id: string): void
  onNodeDoubleClick(id: string): void
  onResizePointerDown(event: ReactPointerEvent<HTMLElement>, id: string, corner: WhiteboardCorner): void
  onAnchorPointerDown(event: ReactPointerEvent<HTMLElement>, id: string, side: WhiteboardSide): void
  onEdgePointerDown(event: ReactPointerEvent<SVGElement>, id: string): void
  onEditChange(text: string): void
  onEditCommit(): void
  onEditCancel(): void
}

/** tone → 底色 / 描边 / 文字。四档语义色全部映射到既有令牌，未定义令牌会静默失效。 */
function tonePaint(tone: WhiteboardTone): { background: string; border: string; color: string } {
  switch (tone) {
    case 'accent':
      return { background: 'var(--oe-accent-tint)', border: 'var(--oe-accent)', color: 'var(--oe-accent-deep)' }
    case 'ok':
      return { background: 'var(--oe-whiteboard-ok-bg)', border: 'var(--oe-done)', color: 'var(--oe-text)' }
    case 'warn':
      return { background: 'var(--oe-whiteboard-warn-bg)', border: 'var(--oe-blocked-border)', color: 'var(--oe-blocked)' }
    case 'danger':
      return { background: 'var(--oe-whiteboard-danger-bg)', border: 'var(--oe-overdue)', color: 'var(--oe-overdue)' }
    case 'muted':
      return { background: 'var(--oe-fill-subtle)', border: 'var(--oe-border)', color: 'var(--oe-text-muted)' }
    default:
      return { background: 'var(--oe-surface)', border: 'var(--oe-border)', color: 'var(--oe-text)' }
  }
}

function shapeRadius(shape: WhiteboardShape, height: number): string {
  switch (shape) {
    case 'round':
      return `${height / 2}px`
    case 'ellipse':
      return '50%'
    case 'note':
      return '3px'
    default:
      return 'var(--oe-radius-control)'
  }
}

/** 节点当前的绘制矩形（拖动 / 缩放时用临时值覆盖，松手才落库）。 */
function displayRect(
  node: WhiteboardNode,
  props: Pick<WhiteboardCanvasProps, 'dragDelta' | 'dragIds' | 'resizeRect'>,
): WhiteboardRect {
  if (props.resizeRect !== null && props.resizeRect.id === node.id) {
    const { x, y, width, height } = props.resizeRect
    return { x, y, width, height }
  }
  const moving = props.dragDelta !== null && props.dragIds.includes(node.id)
  return {
    x: node.x + (moving ? props.dragDelta!.x : 0),
    y: node.y + (moving ? props.dragDelta!.y : 0),
    width: node.width,
    height: node.height,
  }
}

/** 连线投影：两端节点都在才画（悬空边留给数据层处理，画布只回答「画不了」）。 */
function edgeViews(whiteboard: Whiteboard, nodes: readonly WhiteboardNode[], props: Pick<WhiteboardCanvasProps, 'dragDelta' | 'dragIds' | 'resizeRect'>): WhiteboardEdgeView[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const views: WhiteboardEdgeView[] = []
  for (const edge of whiteboard.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) continue
    views.push(buildEdgeView(edge, displayRect(from, props), displayRect(to, props)))
  }
  return views
}

/** 选中环：2px accent-deep 外描边 + 一圈淡底，深浅色下都看得见。 */
function selectionStyle(selected: boolean): CSSProperties {
  if (!selected) return {}
  return {
    boxShadow: '0 0 0 2px var(--oe-accent-deep), 0 0 0 6px var(--oe-accent-tint)',
    zIndex: 2,
  }
}

export function WhiteboardCanvas(props: WhiteboardCanvasProps) {
  const { whiteboard, panX, panY, zoom, selectedIds, selectedEdgeId, editingId, draftText } = props
  const ordered = whiteboardRenderOrder(whiteboard.nodes)
  const edges = edgeViews(whiteboard, whiteboard.nodes, props)
  const selected = new Set(selectedIds)

  return (
    <div
      data-testid="whiteboard-world"
      data-zoom={zoom}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
        transformOrigin: '0 0',
      }}
    >
      {/* 连线层：宽高 1px + overflow visible，坐标可以是负数（不必给画布定一个虚构的尺寸） */}
      <svg
        data-testid="whiteboard-edges"
        aria-hidden="true"
        style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
      >
        {edges.map((view) => {
          const edge = whiteboard.edges.find((candidate) => candidate.id === view.id)
          const isSelected = edge !== undefined && edge.id === selectedEdgeId
          return (
            <g key={view.id} data-whiteboard-edge={view.id}>
              {/* 命中区：透明粗线，单独一层——1px 的线在触控板与高分屏上根本点不中 */}
              <path
                d={view.path}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                onPointerDown={(event) => props.onEdgePointerDown(event, view.id)}
              />
              <path
                d={view.path}
                fill="none"
                strokeWidth={isSelected ? 2.5 : 1.5}
                strokeDasharray={edge?.dashed === true ? '6 4' : undefined}
                style={{ stroke: isSelected ? 'var(--oe-accent-deep)' : 'var(--oe-text-faint)' }}
              />
              {view.endArrow === null ? null : (
                <polygon points={view.endArrow} style={{ fill: isSelected ? 'var(--oe-accent-deep)' : 'var(--oe-text-faint)' }} />
              )}
              {view.startArrow === null ? null : (
                <polygon points={view.startArrow} style={{ fill: isSelected ? 'var(--oe-accent-deep)' : 'var(--oe-text-faint)' }} />
              )}
              {edge !== undefined && edge.label !== '' ? (
                <text
                  x={view.labelX}
                  y={view.labelY - 6}
                  textAnchor="middle"
                  fontSize={11}
                  style={{ fill: 'var(--oe-text-muted)', paintOrder: 'stroke', stroke: 'var(--oe-surface)', strokeWidth: 3 }}
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          )
        })}

        {/* 连线预览：从锚点到指针的一条虚线，松手前就能看出会连到哪儿 */}
        {props.linkPreview === null ? null : (
          <line
            data-testid="whiteboard-link-preview"
            x1={props.linkPreview.from.x}
            y1={props.linkPreview.from.y}
            x2={props.linkPreview.to.x}
            y2={props.linkPreview.to.y}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            style={{ stroke: 'var(--oe-accent)' }}
          />
        )}

        {/* 框选矩形 */}
        {props.marquee === null ? null : (
          <rect
            data-testid="whiteboard-marquee"
            x={props.marquee.x}
            y={props.marquee.y}
            width={props.marquee.width}
            height={props.marquee.height}
            strokeWidth={1}
            style={{ fill: 'var(--oe-accent-tint)', stroke: 'var(--oe-accent)' }}
          />
        )}
      </svg>

      {/* 图元层 */}
      {ordered.map((node) => {
        const rect = displayRect(node, props)
        const paint = tonePaint(node.tone)
        const isSelected = selected.has(node.id)
        const isFrame = node.shape === 'frame'
        const isEditing = editingId === node.id
        const isLinkTarget = props.linkTargetId === node.id
        const isText = node.shape === 'text'
        // 菱形的底与边由内嵌 SVG 画；外层 div 必须透明无边框，否则会看到「矩形套菱形」
        const isDiamond = node.shape === 'diamond'
        const fontSize = node.shape === 'note' ? WHITEBOARD_NOTE_FONT_SIZE : WHITEBOARD_FONT_SIZE

        const base: CSSProperties = {
          position: 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          boxSizing: 'border-box',
          background: isFrame
            ? 'var(--oe-fill-subtle)'
            : isText || isDiamond
              ? 'transparent'
              : paint.background,
          border: isFrame
            ? `1.5px dashed ${paint.border}`
            : isText || isDiamond
              ? 'none'
              : `1px solid ${paint.border}`,
          borderRadius: isFrame ? 'var(--oe-radius-card)' : shapeRadius(node.shape, rect.height),
          color: paint.color,
          fontSize,
          lineHeight: 1.5,
          // 文本节点靠内边距定位；其余居中（便签靠上，像真的便签）
          display: 'flex',
          alignItems: isFrame ? 'flex-start' : node.shape === 'note' ? 'flex-start' : 'center',
          justifyContent: isFrame ? 'flex-start' : 'center',
          padding: isFrame ? '8px 10px' : isText ? '0 4px' : '8px 10px',
          textAlign: isFrame ? 'left' : 'center',
          cursor: isEditing ? 'text' : 'default',
          userSelect: 'none',
          ...selectionStyle(isSelected),
          ...(isLinkTarget ? { outline: '2px solid var(--oe-accent)', outlineOffset: 2 } : {}),
        }

        return (
          <div
            key={node.id}
            data-testid={`whiteboard-node-${node.id}`}
            data-whiteboard-shape={node.shape}
            data-whiteboard-selected={isSelected ? 'true' : undefined}
            style={base}
            onPointerDown={(event) => props.onNodePointerDown(event, node.id)}
            onDoubleClick={(event) => {
              event.stopPropagation()
              props.onNodeDoubleClick(node.id)
            }}
          >
            {/* 菱形：CSS 画不出带描边的菱形，用一块内嵌 SVG 当底；文字层盖在上面 */}
            {isDiamond ? (
              <svg
                aria-hidden="true"
                viewBox={`0 0 ${rect.width} ${rect.height}`}
                preserveAspectRatio="none"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
              >
                <polygon
                  points={`${rect.width / 2},0 ${rect.width},${rect.height / 2} ${rect.width / 2},${rect.height} 0,${rect.height / 2}`}
                  style={{ fill: paint.background, stroke: paint.border }}
                  strokeWidth={1}
                />
              </svg>
            ) : null}

            {isEditing ? (
              <textarea
                data-testid="whiteboard-text-input"
                aria-label="节点文本"
                autoFocus
                value={draftText}
                onChange={(event) => props.onEditChange(event.target.value)}
                onBlur={props.onEditCommit}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  // Enter 换行（便签与象限本来就要多行），Esc 取消，Ctrl/Cmd+Enter 提交
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    props.onEditCancel()
                  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    props.onEditCommit()
                  }
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  resize: 'none',
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  // 与渲染态同一套内边距，进入编辑时文字不跳
                  padding: '8px 10px',
                  textAlign: isFrame ? 'left' : 'center',
                  overflow: 'hidden',
                }}
              />
            ) : (
              <span
                data-testid={`whiteboard-label-${node.id}`}
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxWidth: isFrame ? '100%' : nodeTextWidth(node),
                  // 菱形里的文字要往中间收，别顶到四个尖角上
                  paddingInline: node.shape === 'diamond' ? '0 24px' : undefined,
                  color: isText ? 'var(--oe-text)' : undefined,
                  fontWeight: isFrame ? 600 : undefined,
                  opacity: isFrame ? 0.85 : undefined,
                }}
              >
                {node.text === '' && isText ? ' ' : node.text}
              </span>
            )}
          </div>
        )
      })}

      {/* 选中态装饰：单节点显示四角把手 + 四边锚点；多选只显示把手（锚点是单节点概念） */}
      {selectedIds.length === 1
        ? (() => {
            const node = whiteboard.nodes.find((candidate) => candidate.id === selectedIds[0])
            if (node === undefined || editingId === node.id) return null
            const rect = displayRect(node, props)
            // 把手与锚点按 1/zoom 缩放：它们属于**界面**而不是图，屏幕上应恒为 9px，
            // 否则缩到 50% 时既点不中也看不清（Miro / Figma 同一处理）。
            const handleSize = HANDLE / zoom
            const anchorRadius = ANCHOR_RADIUS / zoom
            const corners: { corner: WhiteboardCorner; x: number; y: number; cursor: string }[] = [
              { corner: 'nw', x: rect.x, y: rect.y, cursor: 'nwse-resize' },
              { corner: 'ne', x: rect.x + rect.width, y: rect.y, cursor: 'nesw-resize' },
              { corner: 'sw', x: rect.x, y: rect.y + rect.height, cursor: 'nesw-resize' },
              { corner: 'se', x: rect.x + rect.width, y: rect.y + rect.height, cursor: 'nwse-resize' },
            ]
            const anchors: { side: WhiteboardSide; x: number; y: number }[] = [
              { side: 'top', x: rect.x + rect.width / 2, y: rect.y },
              { side: 'right', x: rect.x + rect.width, y: rect.y + rect.height / 2 },
              { side: 'bottom', x: rect.x + rect.width / 2, y: rect.y + rect.height },
              { side: 'left', x: rect.x, y: rect.y + rect.height / 2 },
            ]
            return (
              <>
                {/* 锚点画在下层：把手压在上面时优先命中把手（缩放的意图更明确） */}
                {anchors.map((anchor) => (
                  <div
                    key={anchor.side}
                    data-testid={`whiteboard-anchor-${anchor.side}`}
                    role="button"
                    aria-label={`从${anchor.side}连线`}
                    onPointerDown={(event) => props.onAnchorPointerDown(event, node.id, anchor.side)}
                    style={{
                      position: 'absolute',
                      left: anchor.x - anchorRadius * 2,
                      top: anchor.y - anchorRadius * 2,
                      width: anchorRadius * 4,
                      height: anchorRadius * 4,
                      display: 'grid',
                      placeItems: 'center',
                      cursor: 'crosshair',
                    }}
                  >
                    <span
                      style={{
                        width: anchorRadius * 2,
                        height: anchorRadius * 2,
                        borderRadius: '50%',
                        background: 'var(--oe-surface)',
                        border: '1.5px solid var(--oe-accent)',
                        display: 'block',
                      }}
                    />
                  </div>
                ))}
                {corners.map((handle) => (
                  <div
                    key={handle.corner}
                    data-testid={`whiteboard-handle-${handle.corner}`}
                    role="button"
                    aria-label={`缩放${handle.corner}`}
                    onPointerDown={(event) => props.onResizePointerDown(event, node.id, handle.corner)}
                    style={{
                      position: 'absolute',
                      left: handle.x - handleSize / 2,
                      top: handle.y - handleSize / 2,
                      width: handleSize,
                      height: handleSize,
                      background: 'var(--oe-surface)',
                      border: '1.5px solid var(--oe-accent-deep)',
                      borderRadius: 2,
                      cursor: handle.cursor,
                      zIndex: 3,
                    }}
                  />
                ))}
              </>
            )
          })()
        : null}
    </div>
  )
}

export default WhiteboardCanvas
