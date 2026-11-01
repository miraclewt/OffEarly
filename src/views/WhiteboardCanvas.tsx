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
// 颜色默认走 theme.css 令牌（语义色跟着主题走）；**用户自己挑的自定义色**是数据，
// 必须是字面量 hex，不能跟着主题变——所以图元的 paint 先问 resolveNodePaint。
// tone 只在四档语义色里换底色，不引入第二套配色语言。

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

import {
  WHITEBOARD_MIN_HEIGHT,
  WHITEBOARD_TEXT_PADDING,
  buildEdgeView,
  hexToCss,
  resolveNodeFontSize,
  resolveNodePaint,
  whiteboardRenderOrder,
  nodeTextWidth,
} from '../domain/whiteboardModel'
import type { WhiteboardEdgeView, WhiteboardPoint, WhiteboardRect } from '../domain/whiteboardModel'
import type { Whiteboard, WhiteboardNode, WhiteboardShape } from '../domain/types'
import { tonePaint } from './whiteboardPaint'
import type { WhiteboardTonePaint } from './whiteboardPaint'

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
  /**
   * T76：**空文本图元**在非编辑态显示的提示。
   *
   * 文本图元没有边框、没有底色，`text === ''` 时在画布上是一块真正的空白——新建之后用户
   * 既看不到它、也点不准它（「点了文本，什么都没出现」就是从这里来的）。占位文字是它唯一的
   * 可见形态；文案由宿主给（双语），画布不自己写死中文。
   */
  textPlaceholder?: string
  /**
   * T77：编辑中的**实时高度**（只对文本图元有意义）。
   *
   * 文本图元的高度就是文字外廓，可它现在只在提交时才重算——多打两行，框不长高，
   * textarea 自己内部滚动，用户看不到刚写的那一行。这里由视图按 draftText 算一个高度，
   * 画布**只用来画**（不落盘、不进撤销栈），提交时再由视图一次性写进节点。
   */
  editingHeight?: number | null
  /**
   * T74：`assets/<id>.<ext>` → blob URL（未读出时 null）。
   * 画布不碰文件系统：端口由宿主注入，这里只负责「有地址就画、没有就占位」。
   */
  resolveImage?: (ref: string) => string | null

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
/**
 * 图元当前的绘制信息：自定义色优先，没有自定义色才回落到语义色。
 * 屏幕与导出必须走同一个判断，否则会出现「屏幕上自定义、导出里语义」。
 */
function nodePaint(node: WhiteboardNode): WhiteboardTonePaint {
  const custom = resolveNodePaint(node)
  if (custom === null) return tonePaint(node.tone)
  return {
    background: custom.fill === 'none' ? 'transparent' : hexToCss(custom.fill, custom.fillOpacity),
    border: custom.stroke === 'none' ? 'transparent' : hexToCss(custom.stroke, custom.strokeOpacity),
    color: custom.ink,
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
    case 'text':
      // 文本图元平时没有底与边，圆角看不出来；只有进编辑态（T76 起有实底与描边）才露出来。
      // 用 8px 会让 32 高的文本框看成一个胶囊按钮，4px 才像「可以写字的框」。
      return '4px'
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
        const isEditing = editingId === node.id
        const measured = displayRect(node, props)
        // T77：编辑中的文本图元按 draftText 实时长高（只影响这一次渲染，不落盘）
        const liveHeight = props.editingHeight
        const rect =
          isEditing && liveHeight !== null && liveHeight !== undefined
            ? { ...measured, height: Math.max(liveHeight, WHITEBOARD_MIN_HEIGHT) }
            : measured
        // 自定义色优先：有 fill 就只认它（与导出同一个 resolveNodePaint），
        // 没有才回落到语义色（语义色走 CSS 令牌，好跟着深浅主题走）
        const custom = resolveNodePaint(node)
        const paint = nodePaint(node)
        const isSelected = selected.has(node.id)
        const isFrame = node.shape === 'frame'
        const isLinkTarget = props.linkTargetId === node.id
        const isText = node.shape === 'text'
        // 图片：铺满节点、等比留白（objectFit: contain），既不变形也不裁掉边角
        const isImage = node.shape === 'image'
        const imageUrl = isImage && node.image !== undefined ? (props.resolveImage?.(node.image) ?? null) : null
        // 菱形的底与边由内嵌 SVG 画；外层 div 必须透明无边框，否则会看到「矩形套菱形」
        const isDiamond = node.shape === 'diamond'
        // T75：字号是用户数据（节点上可选），统一走 resolveNodeFontSize，导出器读同一处
        const fontSize = resolveNodeFontSize(node)

        const base: CSSProperties = {
          position: 'absolute',
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          boxSizing: 'border-box',
          background: isFrame
            ? custom === null
              ? 'var(--oe-fill-subtle)'
              : hexToCss(custom.fill, custom.fillOpacity)
            : isText
              ? // T76：进编辑态时给一块实底——文本图元平时是透明的，一个透明的 textarea
                // 在画布上等于「没有输入框」，尤其空的文本图元（T76 之前就是这样）
                isEditing
                ? 'var(--oe-surface)'
                : 'transparent'
              : isDiamond || isImage
                ? 'transparent'
                : paint.background,
          border: isFrame
            ? `1.5px dashed ${paint.border}`
            : isText || isDiamond
              ? 'none'
              : isImage
                ? '1px solid var(--oe-border)'
                : `1px solid ${paint.border}`,
          borderRadius: isFrame ? 'var(--oe-radius-card)' : shapeRadius(node.shape, rect.height),
          color: paint.color,
          fontSize,
          // T77：加粗 / 斜体是节点数据（可选），分组框标题本来就有 600 的强调
          fontWeight: node.bold === true ? 700 : isFrame ? 600 : undefined,
          fontStyle: node.italic === true ? 'italic' : undefined,
          lineHeight: 1.5,
          // 文本节点靠内边距定位；其余居中（便签靠上，像真的便签）
          display: 'flex',
          alignItems: isFrame ? 'flex-start' : node.shape === 'note' ? 'flex-start' : 'center',
          justifyContent: isFrame ? 'flex-start' : 'center',
          padding: isFrame ? '8px 10px' : isText ? `0 ${WHITEBOARD_TEXT_PADDING}px` : isImage ? 0 : '8px 10px',
          textAlign: isFrame ? 'left' : 'center',
          // T80：非编辑态一律「可拖动」光标。之前是 `default`，而文本图元没有边框、没有底色，
          // 屏幕上唯一像「实体」的就是那圈选中环——光标不给暗示，用户不会想到按下去能拖。
          cursor: isEditing ? 'text' : 'move',
          userSelect: 'none',
          ...selectionStyle(isSelected),
          ...(isLinkTarget ? { outline: '2px solid var(--oe-accent)', outlineOffset: 2 } : {}),
          // T76：编辑态画成**看得见的输入框**（实描边，不是只有选中环）。选中环是
          // 「0 0 0 2px」的 box-shadow，编辑时要在它外面再叠一圈，两者不能互相覆盖。
          ...(isEditing
            ? {
                outline: '2px solid var(--oe-accent)',
                outlineOffset: 1,
                boxShadow: '0 0 0 4px var(--oe-accent-tint)',
                zIndex: 3,
              }
            : {}),
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

            {isImage ? (
              imageUrl === null ? (
                // 还没从 assets/ 读出来（或文件被外部删了）：留一块灰占位，不画碎图。
                // 文字是文件名——用户一眼能认出「这张图应该在这儿」。
                <span
                  data-testid={`whiteboard-image-missing-${node.id}`}
                  style={{ fontSize: 11, color: 'var(--oe-text-faint)', padding: '0 8px', wordBreak: 'break-all' }}
                >
                  {node.text}
                </span>
              ) : (
                <img
                  data-testid={`whiteboard-image-${node.id}`}
                  data-whiteboard-image={node.image}
                  src={imageUrl}
                  alt={node.text}
                  draggable={false}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    // T77：`cover` 等比铺满并裁掉溢出部分（截图当底图时常要这样），缺省 `contain` 留白
                    objectFit: node.imageFit === 'cover' ? 'cover' : 'contain',
                    borderRadius: 'inherit',
                    display: 'block',
                    pointerEvents: 'none',
                  }}
                />
              )
            ) : isEditing ? (
              <textarea
                data-testid="whiteboard-text-input"
                aria-label="节点文本"
                autoFocus
                // T77：便签 / 矩形 / 框进了编辑态也有提示字（它们有底色，看不到「该写字了」），
                // 文本图元平时就显示同一个占位，编辑时再显示一次也不冲突（一次只露一个）
                placeholder={props.textPlaceholder}
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
                  // T79：必须显式 border-box。全站没有全局 box-sizing，默认的 content-box 会让
                  // 「100% + 8/10px 内边距」从节点右下角溢出去 20×16——那圈溢出的框还会被
                  // 焦点的光晕勾出轮廓，看着像图元外面多套了一个矩形。
                  boxSizing: 'border-box',
                  resize: 'none',
                  border: 'none',
                  outline: 'none',
                  // T79：theme.css 里 `textarea:focus` 会给输入框加一圈光晕。这里不需要——
                  // 编辑态的「我在这里」由节点自己的 outline + 光晕表达，两圈叠起来就是双层框。
                  boxShadow: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  // T76：光标用强调色——空的文本图元进编辑态时，这是唯一的「我在这里」信号
                  caretColor: 'var(--oe-accent-deep)',
                  font: 'inherit',
                  // 与渲染态同一套内边距，进入编辑时文字不跳（文本图元两侧只有 4px）
                  padding: isText ? `0 ${WHITEBOARD_TEXT_PADDING}px` : '8px 10px',
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
                {node.text !== '' ? (
                  node.text
                ) : isText ? (
                  // T76：空文本图元平时在画布上是一片真正的空白（无边框、无底色），
                  // 占位文字是它唯一的可见形态，也是「这里可以写字」的唯一线索
                  <span data-testid={`whiteboard-placeholder-${node.id}`} style={{ color: 'var(--oe-text-faint)' }}>
                    {props.textPlaceholder ?? ''}
                  </span>
                ) : (
                  ' '
                )}
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
