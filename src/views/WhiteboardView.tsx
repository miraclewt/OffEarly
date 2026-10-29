// T69 · WhiteboardView：白板视图宿主（自由画布 + 图元 + 连线 + 模板 + 导出）。
//
// 命名说明：项目里的 `board` 已经指「看板（Kanban）」（BoardView.tsx / BoardColumn.tsx /
// settings.boardColumns）。Miro 那类自由画布在这里叫 **whiteboard**，两者互不占用标识符。
//
// 与 MindMapView 的关系：导图是「数据决定位置」，白板是「用户决定位置」。所以这个文件里
// 没有布局函数——节点坐标直接来自 vault，拖动就是改坐标。几何只剩连线（domain/whiteboardModel）。
//
// 交互口径（Miro 的肌肉记忆）：
//   · 空白拖 = 框选；滚轮 = 平移；Ctrl/⌘+滚轮 = 缩放（与导图/甘特同一套档位）；
//   · 点图元 = 选中，拖动 = 移动（按 8px 网格吸附，松手才落库，一条撤销项）；
//   · 点图元四角 = 缩放，四边小圆 = 拖出连线，双击 = 就地改文字；
//   · Delete 删、Ctrl+C/V 复制粘贴、方向键微调、Ctrl+A 全选；
//   · 拖 frame（分层框）会带上框里的图元一起走 —— 不然「层」这个概念在这里就不成立。
//
// 状态边界：选中 / 编辑 / 拖动预览全部是本地 state，不进 vault、不进 App；
// 写入一律经 controllers/whiteboardActions（一次动作一条命令）。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

import { createMindmapViewport, mindmapZoomFactorAt } from '../controllers/mindmapViewport'
import type { MindMapViewportController } from '../controllers/mindmapViewport'
import {
  applyAddDrafts,
  applyAddGraphic,
  applyAddTemplate,
  applyCreateWhiteboard,
  applyDeleteGraphic,
  applyDeleteWhiteboard,
  applyPatchNodes,
  applyRenameWhiteboard,
  buildEdge,
} from '../controllers/whiteboardActions'
import {
  WHITEBOARD_DEFAULT_SIZE,
  WHITEBOARD_MIN_HEIGHT,
  WHITEBOARD_MIN_WIDTH,
  rectsIntersect,
  snapToGrid,
  whiteboardBounds,
} from '../domain/whiteboardModel'
import type { WhiteboardPoint, WhiteboardRect } from '../domain/whiteboardModel'
import { WHITEBOARD_TEMPLATE_ORDER, buildWhiteboardTemplate } from '../domain/whiteboardTemplates'
import type { WhiteboardTemplateId, WhiteboardTemplateText } from '../domain/whiteboardTemplates'
import type { CommandBus } from '../domain/commandBus'
import type { Vault, Whiteboard, WhiteboardNodePatch, WhiteboardShape, WhiteboardTone } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { WhiteboardCanvas } from './WhiteboardCanvas'
import type { WhiteboardCorner, WhiteboardSide } from './WhiteboardCanvas'
import { exportWhiteboard } from './WhiteboardExporter'
import { fs, px, sp } from '../styles/scale'

type Translate = (key: MsgKey, params?: TranslateParams) => string

const TEXT = 'var(--oe-text)'
const TEXT_MUTED = 'var(--oe-text-muted)'
const TOOLBAR_HEIGHT = 36
/** 拖动阈值：越过它才算「拖」（否则只是一次点击选中）。 */
const DRAG_THRESHOLD = 3
/** 两段确认的复位时长（与导图 / 回收站同口径）。 */
const ARM_MS = 3000
/** 复制粘贴的位移：一眼能看出是新的一份。 */
const PASTE_OFFSET = 24

/** 工具栏里的图元顺序：从最常用到最不常用，框（容器）放最后。 */
const SHAPE_ORDER: WhiteboardShape[] = ['rect', 'round', 'ellipse', 'diamond', 'note', 'text', 'frame']
const SHAPE_LABEL: Record<WhiteboardShape, MsgKey> = {
  rect: 'whiteboard.shapeRect',
  round: 'whiteboard.shapeRound',
  ellipse: 'whiteboard.shapeEllipse',
  diamond: 'whiteboard.shapeDiamond',
  note: 'whiteboard.shapeNote',
  text: 'whiteboard.shapeText',
  frame: 'whiteboard.shapeFrame',
}
const SHAPE_TONE: Record<WhiteboardShape, WhiteboardTone> = {
  rect: 'plain',
  round: 'plain',
  ellipse: 'plain',
  diamond: 'warn',
  note: 'accent',
  text: 'plain',
  frame: 'muted',
}

const TEMPLATE_LABEL: Record<WhiteboardTemplateId, MsgKey> = {
  architecture: 'whiteboard.tplArchitecture',
  flow: 'whiteboard.tplFlow',
  quadrant: 'whiteboard.tplQuadrant',
  radial: 'whiteboard.tplRadial',
}

/** 模板内的文案槽位 → i18n 键（domain 不 import i18n，译文在这里注入）。 */
const TEMPLATE_TEXT_KEY: Record<WhiteboardTemplateText, MsgKey> = {
  archClient: 'whiteboard.tplTextArchClient',
  archService: 'whiteboard.tplTextArchService',
  archData: 'whiteboard.tplTextArchData',
  archWeb: 'whiteboard.tplTextArchWeb',
  archMobile: 'whiteboard.tplTextArchMobile',
  archOpenApi: 'whiteboard.tplTextArchOpenApi',
  archTask: 'whiteboard.tplTextArchTask',
  archSchedule: 'whiteboard.tplTextArchSchedule',
  archNotify: 'whiteboard.tplTextArchNotify',
  archDb: 'whiteboard.tplTextArchDb',
  archBlob: 'whiteboard.tplTextArchBlob',
  flowStart: 'whiteboard.tplTextFlowStart',
  flowCollect: 'whiteboard.tplTextFlowCollect',
  flowReview: 'whiteboard.tplTextFlowReview',
  flowBuild: 'whiteboard.tplTextFlowBuild',
  flowEnd: 'whiteboard.tplTextFlowEnd',
  flowFix: 'whiteboard.tplTextFlowFix',
  flowYes: 'whiteboard.tplTextFlowYes',
  flowNo: 'whiteboard.tplTextFlowNo',
  flowAgain: 'whiteboard.tplTextFlowAgain',
  quadUrgent: 'whiteboard.tplTextQuadUrgent',
  quadPlan: 'whiteboard.tplTextQuadPlan',
  quadDelegate: 'whiteboard.tplTextQuadDelegate',
  quadDrop: 'whiteboard.tplTextQuadDrop',
  radialCenter: 'whiteboard.tplTextRadialCenter',
  radialGoal: 'whiteboard.tplTextRadialGoal',
  radialUser: 'whiteboard.tplTextRadialUser',
  radialData: 'whiteboard.tplTextRadialData',
  radialRisk: 'whiteboard.tplTextRadialRisk',
  radialTech: 'whiteboard.tplTextRadialTech',
  radialTeam: 'whiteboard.tplTextRadialTeam',
}

/** 一次指针交互的临时态（用 ref 存，避免每帧 setState 触发的引用比较开销）。 */
type Interaction =
  | { kind: 'pan'; originX: number; originY: number; panX: number; panY: number }
  | { kind: 'move'; start: WhiteboardPoint; ids: string[]; origins: Map<string, WhiteboardPoint>; moved: boolean }
  | { kind: 'resize'; id: string; corner: WhiteboardCorner; start: WhiteboardPoint; rect: WhiteboardRect }
  | { kind: 'link'; fromId: string; side: WhiteboardSide; from: WhiteboardPoint }
  | { kind: 'marquee'; start: WhiteboardPoint; additive: boolean }

/** 渲染用的预览集合：拖动位移 / 缩放矩形 / 连线 / 框选 / 落点高亮。 */
interface Preview {
  delta: WhiteboardPoint | null
  dragIds: string[]
  resize: (WhiteboardRect & { id: string }) | null
  link: { from: WhiteboardPoint; to: WhiteboardPoint } | null
  marquee: WhiteboardRect | null
  linkTargetId: string | null
}

const EMPTY_PREVIEW: Preview = {
  delta: null,
  dragIds: [],
  resize: null,
  link: null,
  marquee: null,
  linkTargetId: null,
}

export interface WhiteboardViewProps {
  /** 渲染快照（父组件订阅 store 后传下来）；写入时同导图口径——用事件时刻的这份 vault。 */
  vault: Vault
  bus: CommandBus
  t: Translate
}

export function WhiteboardView(props: WhiteboardViewProps) {
  const { vault, bus, t } = props
  const whiteboards = vault.whiteboards

  // 选中板：悬空时回退第一块（与导图同一兜底）
  const [whiteboardId, setWhiteboardId] = useState<string | null>(null)
  const whiteboard: Whiteboard | undefined =
    whiteboards.find((candidate) => candidate.id === whiteboardId) ?? whiteboards[0]

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [preview, setPreview] = useState<Preview>(EMPTY_PREVIEW)
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const viewportRef = useRef<MindMapViewportController | null>(null)
  if (viewportRef.current === null) viewportRef.current = createMindmapViewport()
  const viewport = viewportRef.current
  const viewState = useSyncExternalStore(viewport.subscribe, viewport.getState)
  const zoom = mindmapZoomFactorAt(viewState.zoomIndex)

  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const clipboardRef = useRef<Whiteboard | null>(null)
  const fittedRef = useRef<string | null>(null)

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  /** 屏幕坐标 → 内容坐标（screen = content * zoom + pan 的逆变换）。 */
  const toContent = useCallback(
    (clientX: number, clientY: number): WhiteboardPoint => {
      const surface = surfaceRef.current
      const rect = surface?.getBoundingClientRect()
      const state = viewport.getState()
      const z = mindmapZoomFactorAt(state.zoomIndex)
      return { x: (clientX - (rect?.left ?? 0) - state.panX) / z, y: (clientY - (rect?.top ?? 0) - state.panY) / z }
    },
    [viewport],
  )

  /** 视口中心的内容坐标（新建图元 / 贴模板的落点）。 */
  const centerOfViewport = useCallback((): WhiteboardPoint => {
    const state = viewport.getState()
    const z = mindmapZoomFactorAt(state.zoomIndex)
    return { x: (state.width / 2 - state.panX) / z, y: (state.height / 2 - state.panY) / z }
  }, [viewport])

  // 空态时 surface 根本不在 DOM 里（surfaceRef 为 null）→ 这两个 effect 必须把「surface 出现了」
  // 也写进依赖，否则它们只在挂载那一次跑（那一跑全部早退），视口尺寸永远停在 960×600 默认值、
  // 滚轮监听也从没挂上。表现是：模板贴出来靠左（不是视口居中）、滚轮平移与缩放全无反应。
  const whiteboardIdForFit = whiteboard?.id

  // 视口尺寸跟随容器（ResizeObserver 与三个视图同一手法）
  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null) return
    const update = (): void => {
      const rect = surface.getBoundingClientRect()
      viewport.setViewportSize({ width: rect.width, height: rect.height })
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [viewport, whiteboardIdForFit])

  // 进入视图 / 切板时 fit 一次（之后用户自己调好的 pan/zoom 不被重渲染抹掉）
  useEffect(() => {
    if (whiteboardIdForFit === undefined) return
    if (fittedRef.current === whiteboardIdForFit) return
    fittedRef.current = whiteboardIdForFit
    const target = whiteboards.find((candidate) => candidate.id === whiteboardIdForFit)
    if (target === undefined || target.nodes.length === 0) return
    viewport.fitToContent(whiteboardBounds(target.nodes))
  }, [whiteboardIdForFit, whiteboards, viewport])

  // 滚轮：React 的 onWheel 是 passive 的，preventDefault 必须走非 passive 监听
  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null) return
    const onWheel = (event: WheelEvent): void => {
      const consumed = viewport.applyWheel({
        ctrlKey: event.ctrlKey || event.metaKey,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      })
      if (consumed) event.preventDefault()
    }
    surface.addEventListener('wheel', onWheel, { passive: false })
    return () => surface.removeEventListener('wheel', onWheel)
  }, [viewport, whiteboardIdForFit])

  // 两段确认 / 提示的自动复位
  useEffect(() => {
    if (armedDelete === null) return
    const timer = window.setTimeout(() => setArmedDelete(null), ARM_MS)
    return () => window.clearTimeout(timer)
  }, [armedDelete])

  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 切板：选中与编辑态整体复位（别把上一张板的选中带到新板上）
  useEffect(() => {
    setSelectedIds([])
    setSelectedEdgeId(null)
    setEditingId(null)
    setPreview(EMPTY_PREVIEW)
  }, [whiteboard?.id])

  /** 提交一条节点 patch（唯一写入口）。 */
  const commitNodes = useCallback(
    (patches: { id: string; patch: WhiteboardNodePatch }[]) => {
      if (whiteboard === undefined) return
      applyPatchNodes(bus, vault, whiteboard.id, patches)
    },
    [whiteboard, bus, vault],
  )

  /** 拖动时被一起带走的节点：选中集合 + 若含 frame，则框内的其它图元。 */
  const collectMoveIds = useCallback((target: Whiteboard, ids: string[]): string[] => {
    const result = new Set(ids)
    for (const id of ids) {
      const node = target.nodes.find((candidate) => candidate.id === id)
      if (node === undefined || node.shape !== 'frame') continue
      for (const other of target.nodes) {
        if (other.shape === 'frame' || result.has(other.id)) continue
        const cx = other.x + other.width / 2
        const cy = other.y + other.height / 2
        if (cx >= node.x && cx <= node.x + node.width && cy >= node.y && cy <= node.y + node.height) {
          result.add(other.id)
        }
      }
    }
    return [...result]
  }, [])

  // ── 指针交互 ────────────────────────────────────────────────────────────

  const handlePointerMove = useCallback(
    (event: PointerEvent): void => {
      const interaction = interactionRef.current
      if (interaction === null) return
      if (interaction.kind === 'pan') {
        viewport.setPan(
          interaction.panX + (event.clientX - interaction.originX),
          interaction.panY + (event.clientY - interaction.originY),
        )
        return
      }
      const point = toContent(event.clientX, event.clientY)
      if (interaction.kind === 'move') {
        const dx = snapToGrid(point.x - interaction.start.x)
        const dy = snapToGrid(point.y - interaction.start.y)
        if (!interaction.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        interaction.moved = true
        setPreview({ ...EMPTY_PREVIEW, delta: { x: dx, y: dy }, dragIds: interaction.ids })
        return
      }
      if (interaction.kind === 'resize') {
        setPreview({
          ...EMPTY_PREVIEW,
          resize: { id: interaction.id, ...resizeBy(interaction.rect, interaction.corner, point, interaction.start) },
        })
        return
      }
      if (interaction.kind === 'link') {
        if (whiteboard === undefined) return
        const target = findNodeAt(whiteboard, point, interaction.fromId)
        setPreview({
          ...EMPTY_PREVIEW,
          link: { from: interaction.from, to: point },
          linkTargetId: target?.id ?? null,
        })
        return
      }
      if (interaction.kind === 'marquee') {
        setPreview({ ...EMPTY_PREVIEW, marquee: rectBetween(interaction.start, point) })
      }
    },
    [toContent, viewport, whiteboard],
  )

  const handlePointerUp = useCallback(
    (event: PointerEvent): void => {
      const interaction = interactionRef.current
      interactionRef.current = null
      if (interaction === null) return
      const point = toContent(event.clientX, event.clientY)

      if (interaction.kind === 'move') {
        if (interaction.moved) {
          const dx = snapToGrid(point.x - interaction.start.x)
          const dy = snapToGrid(point.y - interaction.start.y)
          if (dx !== 0 || dy !== 0) {
            commitNodes(
              interaction.ids.map((id) => {
                const origin = interaction.origins.get(id)
                return { id, patch: { x: Math.round((origin?.x ?? 0) + dx), y: Math.round((origin?.y ?? 0) + dy) } }
              }),
            )
          }
        }
        setPreview(EMPTY_PREVIEW)
        return
      }

      if (interaction.kind === 'resize') {
        const rect = resizeBy(interaction.rect, interaction.corner, point, interaction.start)
        commitNodes([{ id: interaction.id, patch: rect }])
        setPreview(EMPTY_PREVIEW)
        return
      }

      if (interaction.kind === 'link') {
        if (whiteboard !== undefined) {
          const target = findNodeAt(whiteboard, point, interaction.fromId)
          if (target !== null) {
            const edge = buildEdge({ from: interaction.fromId, to: target.id, fromAnchor: interaction.side })
            applyAddGraphic(bus, vault, whiteboard.id, [], [edge])
          }
        }
        setPreview(EMPTY_PREVIEW)
        return
      }

      if (interaction.kind === 'marquee' && whiteboard !== undefined) {
        const rect = rectBetween(interaction.start, point)
        // frame 不参与框选：它是容器，选中它会把里面的图元一起拖走，很容易误伤
        const hits = whiteboard.nodes
          .filter((node) => node.shape !== 'frame')
          .filter((node) => rectsIntersect(rect, node))
          .map((node) => node.id)
        setSelectedIds((current) => (interaction.additive ? [...new Set([...current, ...hits])] : hits))
        setSelectedEdgeId(null)
        setPreview(EMPTY_PREVIEW)
      }
    },
    [bus, commitNodes, vault, toContent, whiteboard],
  )

  // 指针事件的登记/注销：拖动越过画布边界也要继续跟手，所以监听挂在 document 上
  useEffect(() => {
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  const handleSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button === 2) return
    rootRef.current?.focus()
    if (event.button === 1) {
      // 中键：平移（不改变选中）
      event.preventDefault()
      const state = viewport.getState()
      interactionRef.current = {
        kind: 'pan',
        originX: event.clientX,
        originY: event.clientY,
        panX: state.panX,
        panY: state.panY,
      }
      return
    }
    const point = toContent(event.clientX, event.clientY)
    setSelectedEdgeId(null)
    interactionRef.current = { kind: 'marquee', start: point, additive: event.shiftKey }
    if (!event.shiftKey) setSelectedIds([])
  }

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLElement>, id: string): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    rootRef.current?.focus()
    if (event.shiftKey) {
      setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
      return
    }
    const nextSelected = selectedSet.has(id) ? selectedIds : [id]
    setSelectedIds(nextSelected)
    setSelectedEdgeId(null)
    if (whiteboard === undefined) return
    const ids = collectMoveIds(whiteboard, nextSelected)
    const origins = new Map<string, WhiteboardPoint>()
    for (const nodeId of ids) {
      const node = whiteboard.nodes.find((candidate) => candidate.id === nodeId)
      if (node !== undefined) origins.set(nodeId, { x: node.x, y: node.y })
    }
    interactionRef.current = {
      kind: 'move',
      start: toContent(event.clientX, event.clientY),
      ids,
      origins,
      moved: false,
    }
  }

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
    corner: WhiteboardCorner,
  ): void => {
    if (event.button !== 0 || whiteboard === undefined) return
    event.stopPropagation()
    const node = whiteboard.nodes.find((candidate) => candidate.id === id)
    if (node === undefined) return
    interactionRef.current = {
      kind: 'resize',
      id,
      corner,
      start: toContent(event.clientX, event.clientY),
      rect: { x: node.x, y: node.y, width: node.width, height: node.height },
    }
    setPreview(EMPTY_PREVIEW)
  }

  const handleAnchorPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
    side: WhiteboardSide,
  ): void => {
    if (event.button !== 0 || whiteboard === undefined) return
    event.stopPropagation()
    const node = whiteboard.nodes.find((candidate) => candidate.id === id)
    if (node === undefined) return
    const from: WhiteboardPoint =
      side === 'top'
        ? { x: node.x + node.width / 2, y: node.y }
        : side === 'bottom'
          ? { x: node.x + node.width / 2, y: node.y + node.height }
          : side === 'left'
            ? { x: node.x, y: node.y + node.height / 2 }
            : { x: node.x + node.width, y: node.y + node.height / 2 }
    interactionRef.current = { kind: 'link', fromId: id, side, from }
    setPreview({ ...EMPTY_PREVIEW, link: { from, to: from } })
  }

  const handleEdgePointerDown = (event: ReactPointerEvent<SVGElement>, id: string): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    rootRef.current?.focus()
    setSelectedIds([])
    setSelectedEdgeId(id)
  }

  // ── 编辑文本 ────────────────────────────────────────────────────────────

  const startEditing = (id: string): void => {
    if (whiteboard === undefined) return
    const node = whiteboard.nodes.find((candidate) => candidate.id === id)
    if (node === undefined) return
    setSelectedIds([id])
    setEditingId(id)
    setDraftText(node.text)
  }

  const commitEditing = (): void => {
    if (editingId === null) return
    const node = whiteboard?.nodes.find((candidate) => candidate.id === editingId)
    if (node !== undefined && node.text !== draftText) {
      commitNodes([{ id: editingId, patch: { text: draftText } }])
    }
    setEditingId(null)
  }

  // ── 键盘 ────────────────────────────────────────────────────────────────

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target !== null && target.closest('input, textarea, select, [contenteditable="true"]') !== null) return
    if (whiteboard === undefined) return
    const meta = event.metaKey || event.ctrlKey

    if (event.key === 'Escape') {
      if (editingId !== null) {
        setEditingId(null)
      } else if (interactionRef.current !== null) {
        interactionRef.current = null
        setPreview(EMPTY_PREVIEW)
      } else {
        setSelectedIds([])
        setSelectedEdgeId(null)
      }
      return
    }

    if (meta && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setSelectedIds(whiteboard.nodes.filter((node) => node.shape !== 'frame').map((node) => node.id))
      return
    }

    if (meta && event.key.toLowerCase() === 'c') {
      if (selectedIds.length === 0) return
      event.preventDefault()
      const nodes = whiteboard.nodes.filter((node) => selectedSet.has(node.id))
      const ids = new Set(nodes.map((node) => node.id))
      clipboardRef.current = {
        ...whiteboard,
        nodes,
        edges: whiteboard.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
      }
      return
    }

    if (meta && event.key.toLowerCase() === 'v') {
      const clip = clipboardRef.current
      if (clip === null || clip.nodes.length === 0) return
      event.preventDefault()
      const drafts = clip.nodes.map((node) => ({
        shape: node.shape,
        x: node.x + PASTE_OFFSET,
        y: node.y + PASTE_OFFSET,
        width: node.width,
        height: node.height,
        text: node.text,
        tone: node.tone,
      }))
      // 连线按下标引用：粘贴出来的是新 id，只能按「被复制节点在原数组里的位置」换算
      const position = new Map(clip.nodes.map((node, index) => [node.id, index]))
      const edgeDrafts = clip.edges
        .map((edge) => ({ ...edge, from: position.get(edge.from) ?? -1, to: position.get(edge.to) ?? -1 }))
        .filter((edge) => edge.from >= 0 && edge.to >= 0)
      applyAddDrafts(bus, vault, whiteboard.id, drafts, edgeDrafts)
      return
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedIds.length === 0 && selectedEdgeId === null) return
      event.preventDefault()
      applyDeleteGraphic(
        bus,
        vault,
        whiteboard.id,
        selectedIds,
        selectedEdgeId === null ? [] : [selectedEdgeId],
      )
      setSelectedIds([])
      setSelectedEdgeId(null)
      return
    }

    if (event.key === 'Enter' && selectedIds.length === 1) {
      event.preventDefault()
      startEditing(selectedIds[0]!)
      return
    }

    const step = event.shiftKey ? 10 : 1
    const moves: Record<string, WhiteboardPoint> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }
    const move = moves[event.key]
    if (move !== undefined && selectedIds.length > 0) {
      event.preventDefault()
      commitNodes(
        selectedIds.map((id) => {
          const node = whiteboard.nodes.find((candidate) => candidate.id === id)
          return { id, patch: { x: (node?.x ?? 0) + move.x, y: (node?.y ?? 0) + move.y } }
        }),
      )
    }
  }

  // ── 工具条动作 ──────────────────────────────────────────────────────────

  const templateLabels = useMemo(() => {
    const labels: Partial<Record<WhiteboardTemplateText, string>> = {}
    for (const [slot, key] of Object.entries(TEMPLATE_TEXT_KEY) as [WhiteboardTemplateText, MsgKey][]) {
      labels[slot] = t(key)
    }
    return labels
  }, [t])

  const addShape = (shape: WhiteboardShape): void => {
    if (whiteboard === undefined) return
    const size = WHITEBOARD_DEFAULT_SIZE[shape]
    const center = centerOfViewport()
    applyAddDrafts(bus, vault, whiteboard.id, [
      {
        shape,
        x: snapToGrid(center.x - size.width / 2),
        y: snapToGrid(center.y - size.height / 2),
        text: shape === 'frame' ? t('whiteboard.newFrameText') : '',
        tone: SHAPE_TONE[shape],
      },
    ])
  }

  const addTemplate = (templateId: WhiteboardTemplateId): void => {
    if (whiteboard === undefined) return
    // 用模板真实尺寸把**中心**对齐视口中心：硬编码偏移在宽屏上会把整张图推到右下角
    const size = buildWhiteboardTemplate(templateId, templateLabels)
    const center = centerOfViewport()
    applyAddTemplate(
      bus,
      vault,
      whiteboard.id,
      templateId,
      { x: snapToGrid(center.x - size.width / 2), y: snapToGrid(center.y - size.height / 2) },
      templateLabels,
    )
  }

  const handleCreate = (): void => {
    const created = applyCreateWhiteboard(bus, vault, { fallbackName: t('whiteboard.untitled') })
    setWhiteboardId(created.id)
    fittedRef.current = null
  }

  const handleDeleteWhiteboard = (): void => {
    if (whiteboard === undefined) return
    if (armedDelete !== whiteboard.id) {
      setArmedDelete(whiteboard.id)
      return
    }
    setArmedDelete(null)
    applyDeleteWhiteboard(bus, vault, whiteboard.id)
    setWhiteboardId(null)
    fittedRef.current = null
  }

  const handleRename = (): void => {
    if (whiteboard === undefined) return
    applyRenameWhiteboard(bus, vault, whiteboard.id, renameDraft, t('whiteboard.untitled'))
    setRenaming(false)
  }

  const align = (mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void => {
    if (whiteboard === undefined || selectedIds.length < 2) return
    const nodes = whiteboard.nodes.filter((node) => selectedSet.has(node.id))
    const minX = Math.min(...nodes.map((node) => node.x))
    const maxX = Math.max(...nodes.map((node) => node.x + node.width))
    const minY = Math.min(...nodes.map((node) => node.y))
    const maxY = Math.max(...nodes.map((node) => node.y + node.height))
    commitNodes(
      nodes.map((node) => {
        switch (mode) {
          case 'left':
            return { id: node.id, patch: { x: minX } }
          case 'right':
            return { id: node.id, patch: { x: maxX - node.width } }
          case 'center':
            return { id: node.id, patch: { x: Math.round((minX + maxX) / 2 - node.width / 2) } }
          case 'top':
            return { id: node.id, patch: { y: minY } }
          case 'bottom':
            return { id: node.id, patch: { y: maxY - node.height } }
          default:
            return { id: node.id, patch: { y: Math.round((minY + maxY) / 2 - node.height / 2) } }
        }
      }),
    )
  }

  const handleExport = async (format: 'png' | 'svg'): Promise<void> => {
    if (whiteboard === undefined) return
    if (whiteboard.nodes.length === 0) {
      setNotice(t('whiteboard.exportEmpty'))
      return
    }
    try {
      await exportWhiteboard({
        whiteboard,
        format,
        range: 'full',
        fileName: whiteboard.name,
        viewport: {
          panX: viewState.panX,
          panY: viewState.panY,
          zoom,
          width: viewState.width,
          height: viewState.height,
        },
      })
      setNotice(t('whiteboard.exported', { name: whiteboard.name }))
    } catch {
      setNotice(t('whiteboard.exportFailed'))
    }
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────

  if (whiteboard === undefined) {
    return (
      <div
        data-testid="whiteboard-empty"
        style={{ height: '100%', display: 'grid', placeItems: 'center', padding: sp(24) }}
      >
        <div style={{ textAlign: 'center', display: 'grid', gap: sp(10), justifyItems: 'center' }}>
          <div style={{ fontSize: fs(15), fontWeight: 600, color: TEXT }}>{t('whiteboard.emptyTitle')}</div>
          <div style={{ fontSize: fs(12), color: TEXT_MUTED, maxWidth: 380, lineHeight: 1.6 }}>
            {t('whiteboard.emptyHint')}
          </div>
          <button type="button" data-testid="whiteboard-create" onClick={handleCreate} style={chipStyle}>
            {t('whiteboard.new')}
          </button>
        </div>
      </div>
    )
  }

  const zoomPercent = Math.round(zoom * 100)

  return (
    <div
      ref={rootRef}
      data-testid="whiteboard"
      tabIndex={0}
      role="application"
      aria-label={t('whiteboard.canvasLabel')}
      // 父级 <main> 是 flex 项而不是 flex 容器：这里必须用 height:100%（flex:1 会得到 0 高度，
      // 画布整块被 overflow:hidden 裁掉，屏幕上只剩一条工具栏——T69 真机踩到过）
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, outline: 'none' }}
      onKeyDown={handleKeyDown}
    >
      <div
        data-testid="whiteboard-toolbar"
        style={{
          height: TOOLBAR_HEIGHT,
          flex: `0 0 ${TOOLBAR_HEIGHT}px`,
          display: 'flex',
          alignItems: 'center',
          gap: sp(6),
          padding: `0 ${sp(10)}`,
          borderBottom: '1px solid var(--oe-separator)',
          background: 'var(--oe-material-bar)',
          overflowX: 'auto',
        }}
      >
        {renaming ? (
          <input
            data-testid="whiteboard-rename-input"
            autoFocus
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={handleRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleRename()
              if (event.key === 'Escape') setRenaming(false)
            }}
            style={{ ...chipStyle, width: sp(160) }}
          />
        ) : (
          <select
            data-testid="whiteboard-select"
            aria-label={t('whiteboard.selectLabel')}
            value={whiteboard.id}
            onChange={(event) => setWhiteboardId(event.target.value)}
            style={{ ...chipStyle, maxWidth: sp(200), paddingRight: sp(4) }}
          >
            {whiteboards.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <ToolButton testId="whiteboard-create" label={t('whiteboard.new')} onClick={handleCreate} />
        <ToolButton
          testId="whiteboard-rename"
          label={t('whiteboard.rename')}
          onClick={() => {
            setRenameDraft(whiteboard.name)
            setRenaming(true)
          }}
        />
        <ToolButton
          testId="whiteboard-delete"
          label={armedDelete === whiteboard.id ? t('whiteboard.deleteConfirm') : t('whiteboard.delete')}
          danger={armedDelete === whiteboard.id}
          onClick={handleDeleteWhiteboard}
        />

        <Divider />

        {SHAPE_ORDER.map((shape) => (
          <ToolButton
            key={shape}
            testId={`whiteboard-add-${shape}`}
            label={t(SHAPE_LABEL[shape])}
            onClick={() => addShape(shape)}
          />
        ))}

        <Divider />

        <select
          data-testid="whiteboard-templates"
          aria-label={t('whiteboard.templates')}
          value=""
          onChange={(event) => {
            const value = event.target.value as WhiteboardTemplateId | ''
            if (value === '') return
            addTemplate(value)
            event.target.value = ''
          }}
          style={chipStyle}
        >
          <option value="">{t('whiteboard.templates')}</option>
          {WHITEBOARD_TEMPLATE_ORDER.map((templateId) => (
            <option key={templateId} value={templateId}>
              {t(TEMPLATE_LABEL[templateId])}
            </option>
          ))}
        </select>

        {selectedIds.length > 1 ? (
          <>
            <Divider />
            <ToolButton testId="whiteboard-align-left" label={t('whiteboard.alignLeft')} onClick={() => align('left')} />
            <ToolButton testId="whiteboard-align-center" label={t('whiteboard.alignCenter')} onClick={() => align('center')} />
            <ToolButton testId="whiteboard-align-right" label={t('whiteboard.alignRight')} onClick={() => align('right')} />
            <ToolButton testId="whiteboard-align-top" label={t('whiteboard.alignTop')} onClick={() => align('top')} />
            <ToolButton
              testId="whiteboard-align-middle"
              label={t('whiteboard.alignMiddle')}
              onClick={() => align('middle')}
            />
            <ToolButton
              testId="whiteboard-align-bottom"
              label={t('whiteboard.alignBottom')}
              onClick={() => align('bottom')}
            />
          </>
        ) : null}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: sp(6) }}>
          {notice === null ? null : (
            <span data-testid="whiteboard-notice" style={{ fontSize: fs(11), color: TEXT_MUTED }}>
              {notice}
            </span>
          )}
          <ToolButton testId="whiteboard-zoom-out" label="−" onClick={() => viewport.zoomOut()} />
          <span
            data-testid="whiteboard-zoom"
            style={{ fontSize: fs(11), color: TEXT_MUTED, minWidth: sp(38), textAlign: 'center' }}
          >
            {`${zoomPercent}%`}
          </span>
          <ToolButton testId="whiteboard-zoom-in" label="+" onClick={() => viewport.zoomIn()} />
          <ToolButton
            testId="whiteboard-fit"
            label={t('whiteboard.fit')}
            onClick={() => {
              if (whiteboard.nodes.length === 0) viewport.resetView()
              else viewport.fitToContent(whiteboardBounds(whiteboard.nodes))
            }}
          />
          <ToolButton testId="whiteboard-export-svg" label="SVG" onClick={() => void handleExport('svg')} />
          <ToolButton testId="whiteboard-export-png" label="PNG" onClick={() => void handleExport('png')} />
        </div>
      </div>

      <div
        ref={surfaceRef}
        data-testid="whiteboard-surface"
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
          background: 'var(--oe-surface)',
          // 点阵网格：随 pan/zoom 走，让人一眼看出「画布是可以拖的」
          backgroundImage: 'radial-gradient(circle, var(--oe-border) 1px, transparent 1px)',
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          backgroundPosition: `${viewState.panX}px ${viewState.panY}px`,
          cursor: 'default',
          touchAction: 'none',
        }}
        onPointerDown={handleSurfacePointerDown}
      >
        <WhiteboardCanvas
          whiteboard={whiteboard}
          panX={viewState.panX}
          panY={viewState.panY}
          zoom={zoom}
          selectedIds={selectedIds}
          selectedEdgeId={selectedEdgeId}
          editingId={editingId}
          draftText={draftText}
          dragDelta={preview.delta}
          dragIds={preview.dragIds}
          resizeRect={preview.resize}
          linkPreview={preview.link}
          marquee={preview.marquee}
          linkTargetId={preview.linkTargetId}
          onNodePointerDown={handleNodePointerDown}
          onNodeDoubleClick={startEditing}
          onResizePointerDown={handleResizePointerDown}
          onAnchorPointerDown={handleAnchorPointerDown}
          onEdgePointerDown={handleEdgePointerDown}
          onEditChange={setDraftText}
          onEditCommit={commitEditing}
          onEditCancel={() => setEditingId(null)}
        />

        <div
          style={{
            position: 'absolute',
            left: sp(12),
            bottom: sp(10),
            fontSize: fs(11),
            color: 'var(--oe-text-faint)',
            pointerEvents: 'none',
          }}
        >
          {t('whiteboard.hint')}
        </div>
      </div>
    </div>
  )
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 框选 / 缩放用的规则矩形（起点可能在终点的右下方）。 */
function rectBetween(a: WhiteboardPoint, b: WhiteboardPoint): WhiteboardRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

/** 按角拖拽的新矩形：最小尺寸从对角夹住，别让框翻面。 */
function resizeBy(rect: WhiteboardRect, corner: WhiteboardCorner, point: WhiteboardPoint, start: WhiteboardPoint): WhiteboardRect {
  const dx = snapToGrid(point.x - start.x)
  const dy = snapToGrid(point.y - start.y)
  let x = rect.x
  let y = rect.y
  let width = rect.width
  let height = rect.height
  if (corner === 'ne' || corner === 'se') width = Math.max(WHITEBOARD_MIN_WIDTH, snapToGrid(rect.width + dx))
  if (corner === 'nw' || corner === 'sw') {
    width = Math.max(WHITEBOARD_MIN_WIDTH, snapToGrid(rect.width - dx))
    x = rect.x + rect.width - width
  }
  if (corner === 'sw' || corner === 'se') height = Math.max(WHITEBOARD_MIN_HEIGHT, snapToGrid(rect.height + dy))
  if (corner === 'nw' || corner === 'ne') {
    height = Math.max(WHITEBOARD_MIN_HEIGHT, snapToGrid(rect.height - dy))
    y = rect.y + rect.height - height
  }
  return { x, y, width, height }
}

/** 连线落点命中的节点：从渲染序末尾往前找（最上面的那个优先）。 */
function findNodeAt(whiteboard: Whiteboard, point: WhiteboardPoint, excludeId: string): { id: string } | null {
  for (let index = whiteboard.nodes.length - 1; index >= 0; index -= 1) {
    const node = whiteboard.nodes[index]!
    if (node.id === excludeId) continue
    if (
      point.x >= node.x &&
      point.x <= node.x + node.width &&
      point.y >= node.y &&
      point.y <= node.y + node.height
    ) {
      return { id: node.id }
    }
  }
  return null
}

const chipStyle: CSSProperties = {
  padding: px('2px 10px'),
  fontSize: fs(12),
  lineHeight: px('20px'),
  color: TEXT,
  background: 'var(--oe-fill)',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
}

function ToolButton(props: { testId: string; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      onClick={props.onClick}
      style={{
        ...chipStyle,
        ...(props.danger === true ? { color: 'var(--oe-overdue)', background: 'var(--oe-whiteboard-danger-bg)' } : {}),
      }}
    >
      {props.label}
    </button>
  )
}

function Divider() {
  return (
    <div aria-hidden="true" style={{ width: 1, height: sp(16), background: 'var(--oe-separator)', flex: '0 0 1px' }} />
  )
}

export default WhiteboardView
