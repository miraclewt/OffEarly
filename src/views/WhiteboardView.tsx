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
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'

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
import type { WhiteboardNodeDraft } from '../controllers/whiteboardActions'
import {
  WHITEBOARD_DEFAULT_SIZE,
  WHITEBOARD_FONT_LIMIT_MAX,
  WHITEBOARD_FONT_LIMIT_MIN,
  WHITEBOARD_FONT_SIZES,
  WHITEBOARD_MIN_HEIGHT,
  WHITEBOARD_MIN_WIDTH,
  alignNodes,
  centerNodesOn,
  distributeNodes,
  fitImageSize,
  fitTextHeight,
  placeNewNode,
  rectsIntersect,
  resolveNodeFontSize,
  snapToGrid,
  stepFontSize,
  whiteboardBounds,
} from '../domain/whiteboardModel'
import type { WhiteboardAlignMode, WhiteboardAxis, WhiteboardPoint, WhiteboardRect } from '../domain/whiteboardModel'
import { WHITEBOARD_TEMPLATE_ORDER, buildWhiteboardTemplate } from '../domain/whiteboardTemplates'
import type { WhiteboardTemplateId, WhiteboardTemplateText } from '../domain/whiteboardTemplates'
import type { CommandBus } from '../domain/commandBus'
import type { Vault, Whiteboard, WhiteboardNode, WhiteboardNodePatch, WhiteboardShape, WhiteboardTone } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { WhiteboardCanvas } from './WhiteboardCanvas'
import type { WhiteboardCorner, WhiteboardSide } from './WhiteboardCanvas'
import { WhiteboardColorPanel } from './WhiteboardColorPanel'
import { exportWhiteboard, blobUrlToDataUrl } from './WhiteboardExporter'
import { fs, px, sp } from '../styles/scale'

type Translate = (key: MsgKey, params?: TranslateParams) => string

const TEXT = 'var(--oe-text)'
const TEXT_MUTED = 'var(--oe-text-muted)'
/** 单行工具条的高度下限（两行共用）；放不下时行会自己长高，见 `toolbarRowStyle`。 */
const TOOLBAR_HEIGHT = 36
/**
 * 适应画布最多放大到 100%（`MINDMAP_ZOOM_STEPS` 的第 5 档，index 4）。
 * 一个 120×60 的框在 1219×818 画布上 fit 会算出 300%，一进板就顶着一张巨框——只有一张小便签时
 * 「适应」该是「摆在中间」，不是「怼到脸上」。缩小方向不设限。
 */
const WHITEBOARD_FIT_MAX_ZOOM_INDEX = 4
/** 拖动阈值：越过它才算「拖」（否则只是一次点击选中）。 */
const DRAG_THRESHOLD = 3
/** 框外多少屏幕像素内按下去仍算「按到了这个图元」（选中环画在框外，文本图元尤其需要）。 */
const GRAB_SLOP = 4
/** 两段确认的复位时长（与导图 / 回收站同口径）。 */
const ARM_MS = 3000
/** 复制粘贴的位移：一眼能看出是新的一份。 */
const PASTE_OFFSET = 24

/** 工具栏里的图元顺序：从最常用到最不常用，框（容器）放最后。 */
// 注意 `image` 不在这张表里：它不是「画一个空框」，而是走独立的贴图按钮（选文件 / 粘贴 / 拖入），
// 不能从工具栏直接凭空造一个没有 src 的图片图元。
const SHAPE_ORDER: WhiteboardShape[] = ['rect', 'round', 'ellipse', 'diamond', 'note', 'text', 'frame']
const SHAPE_LABEL: Record<WhiteboardShape, MsgKey> = {
  rect: 'whiteboard.shapeRect',
  round: 'whiteboard.shapeRound',
  ellipse: 'whiteboard.shapeEllipse',
  diamond: 'whiteboard.shapeDiamond',
  note: 'whiteboard.shapeNote',
  text: 'whiteboard.shapeText',
  frame: 'whiteboard.shapeFrame',
  image: 'whiteboard.shapeImage',
}
const SHAPE_TONE: Record<WhiteboardShape, WhiteboardTone> = {
  rect: 'plain',
  round: 'plain',
  ellipse: 'plain',
  diamond: 'warn',
  note: 'accent',
  text: 'plain',
  frame: 'muted',
  image: 'plain',
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
  | {
      kind: 'move'
      start: WhiteboardPoint
      ids: string[]
      origins: Map<string, WhiteboardPoint>
      moved: boolean
      /** T80：按下时是「已选中的文本图元」——抬起时若**没拖动**才进编辑，拖了就只是移动 */
      pendingEditId?: string
    }
  | { kind: 'resize'; id: string; corner: WhiteboardCorner; start: WhiteboardPoint; rect: WhiteboardRect; aspect: number | null }
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

/**
 * T74 · 贴图的附件端口（与笔记图片同一个 AssetStore，宿主注入）。
 *
 * 结构上等价于 NoteEditor 的 `NoteAssetsPort`——白板视图不 import 笔记模块，
 * 只声明自己真正用到的那三个方法，宿主把同一个 handle 传进来即可。
 */
export interface WhiteboardImagePort {
  /** 落盘 + 记 assets 表；返回 `assets/<id>.<ext>`。 */
  insert(file: File): Promise<{ ok: true; src: string } | { ok: false; reason?: string }>
  /** 引用 → blob URL；还没读出来时 null。 */
  resolve(ref: string): string | null
  /** blob URL 就绪通知（可选）：宿主异步读出图片后通知画布重画。 */
  subscribe?(listener: () => void): () => void
}

export interface WhiteboardViewProps {
  /** 渲染快照（父组件订阅 store 后传下来）；写入时同导图口径——用事件时刻的这份 vault。 */
  vault: Vault
  bus: CommandBus
  t: Translate
  /** T74：贴图端口。省略时工具栏不出现「图片」按钮，粘贴/拖入图片也无动作。 */
  images?: WhiteboardImagePort
}

export function WhiteboardView(props: WhiteboardViewProps) {
  const { vault, bus, t, images } = props
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
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // T74：assets/ 里的图是**异步**读出来的（getFile → blob URL）。读完通知一次，画布重画。
  const [, bumpImageTick] = useState(0)
  useEffect(() => {
    if (images?.subscribe === undefined) return
    return images.subscribe(() => bumpImageTick((tick) => tick + 1))
  }, [images])

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
    viewport.fitToContent(whiteboardBounds(target.nodes), undefined, WHITEBOARD_FIT_MAX_ZOOM_INDEX)
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

  /** 选中的图元对象（色块面板要读它们的 tone / fill 来判断「当前是什么颜色」）。 */
  const selectedNodes = useMemo(
    () => (whiteboard === undefined ? [] : whiteboard.nodes.filter((node) => selectedSet.has(node.id))),
    [whiteboard, selectedSet],
  )

  /** 把同一条 patch 落到全部选中图元上——批量也只进一条撤销项。 */
  const commitSelectionPatch = useCallback(
    (patch: WhiteboardNodePatch) => {
      if (selectedIds.length === 0) return
      commitNodes(selectedIds.map((id) => ({ id, patch })))
    },
    [selectedIds, commitNodes],
  )

  /** 图片节点不参与「改颜色」：底色被图盖住了，调了也看不见（色板按钮因此也不出现）。 */
  const colorableNodes = useMemo(() => selectedNodes.filter((node) => node.shape !== 'image'), [selectedNodes])

  // ── T75 · 字号 ──────────────────────────────────────────────────────────
  //
  // 图片不参与：它的「文字」是文件名，只用于 alt 与缺图占位，不画在画布上。
  const textualNodes = useMemo(() => selectedNodes.filter((node) => node.shape !== 'image'), [selectedNodes])

  /** 多选时字号一致才回显具体档位；不一致回显「—」（与色板的 mixed 同一取舍）。 */
  const commonFontSize = useMemo(() => {
    if (textualNodes.length === 0) return null
    const first = resolveNodeFontSize(textualNodes[0]!)
    return textualNodes.every((node) => resolveNodeFontSize(node) === first) ? first : null
  }, [textualNodes])

  /**
   * 改字号。**逐个节点各算各的**——多选 13 与 20 时点 A+ 应得到 14 与 24，而不是把两者
   * 设成同一个数（`commitSelectionPatch` 传的是「同一条 patch」，这里不能复用）。
   *
   * 文本图元连带重算高度：它没有框，高度就是文字外廓。字号 13→32 而高度还停在 32 时，
   * 文字会溢到选中环外面，用户既看不清也点不准。
   */
  const applyFontToSelection = useCallback(
    (choose: (node: WhiteboardNode) => number) => {
      if (whiteboard === undefined || textualNodes.length === 0) return
      const patches: { id: string; patch: WhiteboardNodePatch }[] = []
      for (const node of textualNodes) {
        const current = resolveNodeFontSize(node)
        const next = choose(node)
        // 已经在档位尽头：不写。否则连点「A+」会攒出一串无变化的撤销项
        if (next === current) continue
        // 调到**形状默认值**时删键而不是写死数字：这样「A+ 再 A−」之后 vault 逐字节回到原样，
        // 也不会在一堆没改过的图元里堆出 `fontSize: 13` 这种冗余字段（与 fill 的清除同一口径）
        const fallback = resolveNodeFontSize({ shape: node.shape })
        const patch: WhiteboardNodePatch = { fontSize: next === fallback ? null : next }
        if (node.shape === 'text') patch.height = fitTextHeight(node.text, next, node.width)
        patches.push({ id: node.id, patch })
      }
      if (patches.length > 0) commitNodes(patches)
    },
    [whiteboard, textualNodes, commitNodes],
  )

  const nudgeFont = (direction: 1 | -1): void =>
    applyFontToSelection((node) => stepFontSize(resolveNodeFontSize(node), direction))

  /** 下拉里的档位：当前值若不在档位表（手工改过库写了 17），临时补一格回显，不然框里是空的。 */
  const fontChoices = useMemo(() => {
    if (commonFontSize === null || WHITEBOARD_FONT_SIZES.includes(commonFontSize)) return WHITEBOARD_FONT_SIZES
    return [...WHITEBOARD_FONT_SIZES, commonFontSize].sort((left, right) => left - right)
  }, [commonFontSize])

  /**
   * T77 · 字号可以直接输数字。输入框是**本地草稿**：敲字过程中不写库，
   * Enter 或失焦时才提交一次——否则每按一个键就是一条撤销项。
   */
  const [fontDraft, setFontDraft] = useState('')
  useEffect(() => {
    setFontDraft(commonFontSize === null ? '' : String(commonFontSize))
  }, [commonFontSize])

  const commitFontDraft = useCallback((): void => {
    const raw = fontDraft.trim()
    const parsed = Number(raw)
    if (raw === '' || !Number.isFinite(parsed)) {
      // 空 / 乱输：复原成当前值，不写库
      setFontDraft(commonFontSize === null ? '' : String(commonFontSize))
      return
    }
    // 夹在 8..96（与 schema 逐字对齐）：越界输入不该整库报错，也不该悄悄写个 3 号字
    const clamped = Math.max(WHITEBOARD_FONT_LIMIT_MIN, Math.min(WHITEBOARD_FONT_LIMIT_MAX, Math.round(parsed)))
    applyFontToSelection(() => clamped)
    setFontDraft(String(clamped))
  }, [fontDraft, commonFontSize, applyFontToSelection])

  // ── T77 · 加粗 / 斜体 ──────────────────────────────────────────────────
  //
  // 多选时按「全都加粗了才显示为按下」：只要有一个没加粗，点一下就是**全都加粗**
  // （与字号的「各算各的」相反——字效是有无，不是程度）。
  const allBold = textualNodes.length > 0 && textualNodes.every((node) => node.bold === true)
  const allItalic = textualNodes.length > 0 && textualNodes.every((node) => node.italic === true)

  const toggleTextStyle = useCallback(
    (field: 'bold' | 'italic'): void => {
      if (textualNodes.length === 0) return
      const on = textualNodes.every((node) => node[field] === true)
      // 关掉写 `null`（删键）而不是 false：没加粗与「取消加粗」在文件里是同一个状态
      const patch: WhiteboardNodePatch = field === 'bold' ? { bold: on ? null : true } : { italic: on ? null : true }
      commitNodes(textualNodes.map((node) => ({ id: node.id, patch })))
    },
    [textualNodes, commitNodes],
  )

  // ── T77 · 图片：替换与铺满 ──────────────────────────────────────────────
  //
  // 换图不换尺寸：用户多半已经把它摆好、拉到合适大小，换一张图不该让位置与大小跳一下。
  // 旧附件由 GC 回收（referencedAssetIds 不再扫到它），这里不需要手动删。
  const imageNodes = useMemo(() => selectedNodes.filter((node) => node.shape === 'image'), [selectedNodes])
  const allCover = imageNodes.length > 0 && imageNodes.every((node) => node.imageFit === 'cover')

  const replaceImage = useCallback(
    async (id: string, file: File): Promise<void> => {
      if (images === undefined) return
      const result = await images.insert(file)
      if (!result.ok) {
        setNotice(t('whiteboard.imageRejected'))
        return
      }
      // 文件名进 text：导出时的 alt 与「图没读出来」的占位文案都复用它
      commitNodes([{ id, patch: { image: result.src, text: file.name } }])
    },
    [commitNodes, images, t],
  )

  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const replaceTargetRef = useRef<string | null>(null)

  const toggleImageFit = (): void => {
    if (imageNodes.length === 0) return
    // 回到缺省的 contain 就删键，与 fill / fontSize / bold 的清除口径一致
    const patch: WhiteboardNodePatch = { imageFit: allCover ? null : 'cover' }
    commitNodes(imageNodes.map((node) => ({ id: node.id, patch })))
  }

  // ── T74 · 贴图 ──────────────────────────────────────────────────────────
  //
  // 三条入口：Ctrl+V（截图）、把文件拖进画布、工具栏「图片」。三条都汇到 insertImages 一处，
  // 因为落盘、量尺寸、定位、撤销项这四件事必须一致——分开写迟早有一条忘了进撤销栈。

  /** 引用 → blob URL（画布与导出共用这唯一一处判断）。 */
  const resolveImage = useCallback(
    (ref: string): string | null => (images === undefined ? null : images.resolve(ref)),
    [images],
  )

  /**
   * 插入一批图片文件。**一次动作一条撤销项**：多选拖入也只撤一次。
   *
   * 落点默认视口中心，`origin` 给了就用它（拖入时用指针位置，符合「图掉在鼠标下」的直觉）。
   * 尺寸按自然尺寸等比缩进 360×280 —— 不读自然尺寸就只能瞎给一个框，截图会被拉变形。
   */
  const insertImages = useCallback(
    async (files: readonly File[], origin?: WhiteboardPoint): Promise<void> => {
      if (whiteboard === undefined || images === undefined) return
      const accepted = files.filter((file) => file.type.startsWith('image/'))
      if (accepted.length === 0) return
      const center = origin ?? centerOfViewport()
      const drafts: WhiteboardNodeDraft[] = []
      let rejected = 0
      for (const file of accepted) {
        const result = await images.insert(file)
        if (!result.ok) {
          rejected += 1
          continue
        }
        const url = await waitForImageUrl(images, result.src)
        const natural = url === null ? null : await measureImage(url)
        const size = natural === null ? WHITEBOARD_DEFAULT_SIZE.image : fitImageSize(natural)
        // T77：多张一起贴时按网格排开，而不是沿 45° 叠成一条斜线。
        // 把「已摆好的图元 + 前面刚算出来的草稿」一起当占用，逐个找空位。
        const occupied = [
          ...whiteboard.nodes,
          ...drafts.map((draft) => ({
            shape: draft.shape,
            x: draft.x,
            y: draft.y,
            width: draft.width ?? WHITEBOARD_DEFAULT_SIZE[draft.shape].width,
            height: draft.height ?? WHITEBOARD_DEFAULT_SIZE[draft.shape].height,
          })),
        ]
        const spot = placeNewNode(occupied, center, size)
        drafts.push({
          shape: 'image',
          x: spot.x,
          y: spot.y,
          width: size.width,
          height: size.height,
          // 文件名进 text：导出时的 alt、图没读出来时的占位文案都复用它
          text: file.name,
          image: result.src,
        })
      }
      if (drafts.length > 0) {
        // 贴进来就选中：用户下一步通常就是挪位置 / 调字号
        const created = applyAddDrafts(bus, vault, whiteboard.id, drafts)
        if (created.length > 0) {
          setSelectedIds(created)
          setSelectedEdgeId(null)
        }
      }
      if (rejected > 0) setNotice(t('whiteboard.imageRejected'))
    },
    [bus, centerOfViewport, images, t, vault, whiteboard],
  )

  /** 图元复制粘贴（与图片粘贴共用 paste 事件，谁先命中谁处理）。 */
  const pasteNodes = useCallback(
    (clip: Whiteboard): void => {
      if (whiteboard === undefined) return
      const drafts: WhiteboardNodeDraft[] = clip.nodes.map((node) => ({
        shape: node.shape,
        x: node.x + PASTE_OFFSET,
        y: node.y + PASTE_OFFSET,
        width: node.width,
        height: node.height,
        text: node.text,
        tone: node.tone,
        ...(node.image === undefined ? {} : { image: node.image }),
        // T75：粘贴是「复制一份」而不是「按形状重建」，字号得跟着走
        ...(node.fontSize === undefined ? {} : { fontSize: node.fontSize }),
      }))
      // 连线按下标引用：粘贴出来的是新 id，只能按「被复制节点在原数组里的位置」换算
      const position = new Map(clip.nodes.map((node, index) => [node.id, index]))
      const edgeDrafts = clip.edges
        .map((edge) => ({ ...edge, from: position.get(edge.from) ?? -1, to: position.get(edge.to) ?? -1 }))
        .filter((edge) => edge.from >= 0 && edge.to >= 0)
      // 粘贴后选中新的一份（原位置那份不再高亮，否则看起来像「没粘上」）
      const created = applyAddDrafts(bus, vault, whiteboard.id, drafts, edgeDrafts)
      if (created.length > 0) {
        setSelectedIds(created)
        setSelectedEdgeId(null)
      }
    },
    [bus, vault, whiteboard],
  )

  /**
   * 粘贴：剪贴板里有图片就走贴图，否则走图元粘贴。
   *
   * 为什么从 keydown 挪到这里：截图粘贴在 `paste` 事件的 clipboardData 里，keydown 时读不到；
   * 而在 keydown 里 preventDefault 会把 paste 事件整个吃掉——两条路径抢同一个 Ctrl+V，
   * 只能让「真正带数据的那条」来决定。
   */
  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target !== null && target.closest('input, textarea, [contenteditable="true"]') !== null) return
    if (images !== undefined) {
      const files = imageFilesOf(event.clipboardData)
      if (files.length > 0) {
        event.preventDefault()
        void insertImages(files)
        return
      }
    }
    const clip = clipboardRef.current
    if (clip === null || clip.nodes.length === 0) return
    event.preventDefault()
    pasteNodes(clip)
  }

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    // 只有「拖进来的是文件」才接管；否则会挡住浏览器自己的文本拖拽语义
    if (event.dataTransfer.types.includes('Files')) event.preventDefault()
  }

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    const files = imageFilesOf(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    if (whiteboard === undefined || images === undefined) return
    rootRef.current?.focus()
    void insertImages(files, toContent(event.clientX, event.clientY))
  }

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
          resize: {
            id: interaction.id,
            ...resizeBy(interaction.rect, interaction.corner, point, interaction.start, interaction.aspect),
          },
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
        } else if (interaction.pendingEditId !== undefined) {
          // T80：按下 → 没拖动 → 抬起：这才算「点了一下」，进编辑。
          // 焦点不用在这里抢：textarea 是 autoFocus，且此刻 mousedown 的默认处理早已过去，
          // 不会再出现 T76 那个「挂载 3ms 就被 blur 卸载」的问题。
          const target = whiteboard?.nodes.find((node) => node.id === interaction.pendingEditId)
          if (target !== undefined) {
            setEditingId(target.id)
            setDraftText(target.text)
          }
        }
        setPreview(EMPTY_PREVIEW)
        return
      }

      if (interaction.kind === 'resize') {
        const rect = resizeBy(interaction.rect, interaction.corner, point, interaction.start, interaction.aspect)
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
    // T80：给图元一圈「抓握余量」。文本图元没有边框、没有底色，屏幕上唯一的实体是
    // 画在框**外**的选中环（2px 描边 + 6px 光晕）；按在环上其实落在画布上，会变成框选
    // 并把选中清掉——用户的体感就是「这框怎么都抓不住」。框外 4px 内一律算按到了图元。
    const slack = GRAB_SLOP / Math.max(zoom, 0.2)
    const near = whiteboard === undefined ? null : findNodeNear(whiteboard, point, slack)
    if (near !== null) {
      handleNodePointerDown(event, near.id)
      return
    }
    setSelectedEdgeId(null)
    interactionRef.current = { kind: 'marquee', start: point, additive: event.shiftKey }
    if (!event.shiftKey) setSelectedIds([])
  }

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLElement>, id: string): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (event.shiftKey) {
      rootRef.current?.focus()
      setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
      return
    }
    if (whiteboard === undefined) return
    const hit = whiteboard.nodes.find((candidate) => candidate.id === id)
    // T76：**已选中的文本图元**再点一下直接进编辑（文本图元没有边框，单击选中在屏幕上
    // 几乎没有变化，用户会以为「点了没反应」；而对它来说「点」的本意就是改字）。
    // 只在「仅它自己被选中」时生效：多选后点其中一个应当是「收敛选择」，不是进编辑。
    //
    // T80：但**不能按下就进编辑**——那等于把「拖」这条最常用的操作吃掉：一按变输入框，
    // textarea 又把 pointerdown 吃掉，框就彻底拖不动了（用户原话「很难拖动文本框」）。
    // 改成：按下照常登记一次 move，抬起时如果**没拖动**（位移没过 DRAG_THRESHOLD）才进编辑。
    const clickToEdit =
      hit?.shape === 'text' && editingId === null && selectedIds.length === 1 && selectedIds[0] === id
    rootRef.current?.focus()
    const nextSelected = selectedSet.has(id) ? selectedIds : [id]
    setSelectedIds(nextSelected)
    setSelectedEdgeId(null)
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
      ...(clickToEdit ? { pendingEditId: id } : {}),
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
      // 图片按原比例缩放：截图被拉成另一个比例就完全不可读了
      aspect: node.shape === 'image' && node.height > 0 ? node.width / node.height : null,
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
    // 图片没有可编辑的文字：进入 textarea 只会给出一片空白，还会盖住图
    if (node.shape === 'image') return
    setSelectedIds([id])
    setEditingId(id)
    setDraftText(node.text)
  }

  /**
   * T77 · 编辑中的实时高度（只给文本图元）。
   *
   * 只在提交时重算的话，多打两行会看到 textarea 内部滚动、框还是那么高——用户没法判断
   * 「现在到底写了多少行」。这里按 draftText 每帧算一次（纯算术，很便宜），交给画布**只画**；
   * 提交时 `commitEditing` 再把最终高度写进节点，两个口径用的是同一个 fitTextHeight。
   */
  const editingHeight = useMemo(() => {
    if (editingId === null || whiteboard === undefined) return null
    const node = whiteboard.nodes.find((candidate) => candidate.id === editingId)
    if (node === undefined || node.shape !== 'text') return null
    return fitTextHeight(draftText, resolveNodeFontSize(node), node.width)
  }, [editingId, whiteboard, draftText])

  const commitEditing = (): void => {
    if (editingId === null) return
    const node = whiteboard?.nodes.find((candidate) => candidate.id === editingId)
    if (node !== undefined) {
      const patch: WhiteboardNodePatch = {}
      if (node.text !== draftText) patch.text = draftText
      // T75：文本图元的高度就是文字外廓——打完字（或字号调过）之后要重新贴合，
      // 否则新起的文本图元永远是 168×32 的窄条，第二行就掉到框外面去了。
      if (node.shape === 'text') {
        const height = fitTextHeight(draftText, resolveNodeFontSize(node), node.width)
        if (height !== node.height) patch.height = height
      }
      // 一次编辑动作一条撤销项：正文与高度一起提交，撤销时不会只退一半
      if (Object.keys(patch).length > 0) commitNodes([{ id: editingId, patch }])
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

    // Ctrl+V 不在这里处理：粘贴要走 `paste` 事件（截图只在 clipboardData 里），见 handlePaste。

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
    // 落点避开已有图元：连点两次「文本」不该在同一处叠成一张
    const spot = placeNewNode(whiteboard.nodes, center, size)
    const [createdId] = applyAddDrafts(bus, vault, whiteboard.id, [
      {
        shape,
        x: spot.x,
        y: spot.y,
        text: shape === 'frame' ? t('whiteboard.newFrameText') : '',
        tone: SHAPE_TONE[shape],
      },
    ])
    if (createdId === undefined) return
    // T76：新建出来的图元必须**选中**（否则用户不知道刚加了什么、也拖不动它）
    setSelectedIds([createdId])
    setSelectedEdgeId(null)
    // 文本图元没有边框和底色：只选中仍然只是一圈看不见的环。点「文本」就是要写字，
    // 所以直接进编辑态——这也是「点了文本却没有输入框」最直接的修法。
    if (shape === 'text') {
      setEditingId(createdId)
      setDraftText('')
    }
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

  /**
   * 对齐 / 等距分布 / 移到视野中心（T81）：三者都只是「算一批新坐标」，落地走同一条 commit
   * —— 一次点击仍然只有一条撤销项。几何全在 domain/whiteboardModel，这里不重复算。
   */
  const align = (mode: WhiteboardAlignMode): void => {
    commitNodes(alignNodes(selectedNodes, mode))
  }

  const distribute = (axis: WhiteboardAxis): void => {
    commitNodes(distributeNodes(selectedNodes, axis))
  }

  /** 白板是无限画布，没有「页面」可对齐——参照物只能是当前视野中心。 */
  const centerInView = (axis: WhiteboardAxis): void => {
    commitNodes(centerNodesOn(selectedNodes, axis, centerOfViewport()))
  }

  /** T74：导出前把画布上的图片读成 dataURL（导出物必须自包含，不能留 assets/ 死链）。 */
  const collectImageDataUrls = useCallback(
    async (target: Whiteboard): Promise<Map<string, string>> => {
      const result = new Map<string, string>()
      if (images === undefined) return result
      for (const node of target.nodes) {
        const ref = node.image
        if (node.shape !== 'image' || ref === undefined || result.has(ref)) continue
        const url = await waitForImageUrl(images, ref)
        if (url === null) continue
        const dataUrl = await blobUrlToDataUrl(url)
        if (dataUrl !== null) result.set(ref, dataUrl)
      }
      return result
    },
    [images],
  )

  const handleExport = async (format: 'png' | 'svg'): Promise<void> => {
    if (whiteboard === undefined) return
    if (whiteboard.nodes.length === 0) {
      setNotice(t('whiteboard.exportEmpty'))
      return
    }
    try {
      const imageData = await collectImageDataUrls(whiteboard)
      await exportWhiteboard({
        whiteboard,
        format,
        range: 'full',
        fileName: whiteboard.name,
        images: imageData,
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
      // position:relative 给 T81 的选中属性条当包含块（它悬浮在画布上，不参与工具栏的 flex 流）
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, outline: 'none', position: 'relative' }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
    >
      {/* T78：工具栏分两行。
          T77 时所有控件挤在一行（板操作 + 八个图元 + 模板 + 字重字号 + 色块 + 对齐 + 缩放 + 导出），
          1219 宽下就已经把「适应画布」顶出可视区，1080 下更是一路裁到只剩半个按钮。
          拆成「文档行（这块板 + 视图控制）」与「工具行（插入 + 选中态）」后，
          右端的缩放 / 导出永远钉在文档行，不再被工具挤走。 */}
      <div
        data-testid="whiteboard-toolbar"
        style={{
          flex: '0 0 auto',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--oe-material-bar)',
          borderBottom: '1px solid var(--oe-separator)',
        }}
      >
        <div data-testid="whiteboard-toolbar-doc" style={toolbarRowStyle}>
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

        {/* T78：模板从工具行搬到文档行——它是「给这张板生成一套现成结构」，与新建/重命名同属板级动作。
            搬走这 82px 之后，1080 宽下多选（字重 + 字号 + 色块 + 六个对齐）才装得进同一行。 */}
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

        {/* 视图控制钉在文档行右端：缩放、适应画布、导出。
            它们在 T77 的布局里会被工具行推出去，是「适应画布只剩半个」的直接原因。 */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: sp(6), paddingLeft: sp(8) }}>
          {notice === null ? null : (
            <span data-testid="whiteboard-notice" style={{ fontSize: fs(11), color: TEXT_MUTED }}>
              {notice}
            </span>
          )}
          <ToolButton testId="whiteboard-zoom-out" label="−" title={t('whiteboard.zoomOut')} onClick={() => viewport.zoomOut()} />
          <span
            data-testid="whiteboard-zoom"
            style={{ fontSize: fs(11), color: TEXT_MUTED, minWidth: sp(38), textAlign: 'center' }}
          >
            {`${zoomPercent}%`}
          </span>
          <ToolButton testId="whiteboard-zoom-in" label="+" title={t('whiteboard.zoomIn')} onClick={() => viewport.zoomIn()} />
          <ToolButton
            testId="whiteboard-fit"
            label={t('whiteboard.fit')}
            onClick={() => {
              if (whiteboard.nodes.length === 0) viewport.resetView()
              else viewport.fitToContent(whiteboardBounds(whiteboard.nodes), undefined, WHITEBOARD_FIT_MAX_ZOOM_INDEX)
            }}
          />
          <Divider />
          <ToolButton testId="whiteboard-export-svg" label="SVG" onClick={() => void handleExport('svg')} />
          <ToolButton testId="whiteboard-export-png" label="PNG" onClick={() => void handleExport('png')} />
        </div>
        </div>

        {/* 工具行：只放「往板里放什么」——插入形状与图片。选中态在下面独立一行。 */}
        <div data-testid="whiteboard-toolbar-tools" style={toolbarToolsRowStyle}>
        {SHAPE_ORDER.map((shape) => (
          <ToolButton
            key={shape}
            testId={`whiteboard-add-${shape}`}
            label={t(SHAPE_LABEL[shape])}
            onClick={() => addShape(shape)}
          />
        ))}

        {images === undefined ? null : (
          <ToolButton
            testId="whiteboard-image"
            label={t('whiteboard.shapeImage')}
            onClick={() => fileInputRef.current?.click()}
          />
        )}

        </div>

        {/*
        T81 · 选中态单独成行。
        原来它贴在工具行右端（`marginLeft: auto`）。加了等距分布与视野居中之后，这一组在
        1080 宽下量出来 579px，而工具行去掉插入按钮只剩 485px——差 94px，于是整组被挤到
        第二行右侧、左边空一大片，正是 T78 要消灭的那种观感。
        抠像素（缩图标、去分隔线）只能省下七八十，而且尺度档一放大就又不够；这里改成
        「工具行只管插入、选中行只管改属性」，两行各自宽松，以后往对齐类里再加功能也不会重演。
         */}
        {selectedIds.length > 0 ? (
          <div data-testid="whiteboard-toolbar-selection" style={toolbarSelectionRowStyle}>
            {textualNodes.length > 0 ? (
              <>
                <Divider />
                <ToolButton
                  testId="whiteboard-bold"
                  label="B"
                  title={t('whiteboard.bold')}
                  emphasis="bold"
                  active={allBold}
                  onClick={() => toggleTextStyle('bold')}
                />
                <ToolButton
                  testId="whiteboard-italic"
                  label="I"
                  title={t('whiteboard.italic')}
                  emphasis="italic"
                  active={allItalic}
                  onClick={() => toggleTextStyle('italic')}
                />
                <Divider />
                <ToolButton testId="whiteboard-font-down" label="A−" onClick={() => nudgeFont(-1)} />
                {/* T77：档位仍在下拉里（datalist），但框本身可以直接敲数字——8..96 都能存，
                    只能选档位等于把能存的范围藏起来了一半 */}
                <input
                  data-testid="whiteboard-font-size"
                  aria-label={t('whiteboard.fontSize')}
                  type="text"
                  inputMode="numeric"
                  list="whiteboard-font-choices"
                  value={fontDraft}
                  placeholder="—"
                  onChange={(event) => setFontDraft(event.target.value)}
                  onBlur={commitFontDraft}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitFontDraft()
                    } else if (event.key === 'Escape') {
                      event.stopPropagation()
                      setFontDraft(commonFontSize === null ? '' : String(commonFontSize))
                    }
                  }}
                  style={fontSelectStyle}
                />
                <datalist id="whiteboard-font-choices">
                  {fontChoices.map((size) => (
                    <option key={size} value={size} />
                  ))}
                </datalist>
                <ToolButton testId="whiteboard-font-up" label="A+" onClick={() => nudgeFont(1)} />
              </>
            ) : null}

            {imageNodes.length > 0 ? (
              <>
                <Divider />
                {/* 替换只给单选：多选时「换成哪一张」没有答案，硬做只会替掉其中一张 */}
                {imageNodes.length === 1 ? (
                  <ToolButton
                    testId="whiteboard-image-replace"
                    label={t('whiteboard.replaceImage')}
                    onClick={() => {
                      replaceTargetRef.current = imageNodes[0]!.id
                      replaceInputRef.current?.click()
                    }}
                  />
                ) : null}
                <ToolButton
                  testId="whiteboard-image-fit"
                  label={t('whiteboard.fitCover')}
                  active={allCover}
                  onClick={toggleImageFit}
                />
              </>
            ) : null}

            {colorableNodes.length > 0 ? (
              <>
                <Divider />
                <WhiteboardColorPanel nodes={colorableNodes} onPatch={commitSelectionPatch} t={t} />
              </>
            ) : null}
            {/* 对齐 / 分布 / 视野居中：六个文字标签在这里要占 320px，正是把工具栏顶出去的
                主力，所以沿用 T78 的 16px 图标（含义靠 title / aria-label，e2e 仍按 testid 点）。
                T81 又加了两组：等距分布（≥3 枚才有「中间」可排）与视野居中（单枚也成立）。
                分组按「用得上的门槛」从高到低，按钮成组出现，不会单独冒一个。 */}
            <Divider />
            {selectedIds.length > 1 ? (
              <>
                <AlignButton testId="whiteboard-align-left" edge="left" title={t('whiteboard.alignLeft')} onClick={() => align('left')} />
                <AlignButton
                  testId="whiteboard-align-center"
                  edge="center"
                  title={t('whiteboard.alignCenter')}
                  onClick={() => align('center')}
                />
                <AlignButton
                  testId="whiteboard-align-right"
                  edge="right"
                  title={t('whiteboard.alignRight')}
                  onClick={() => align('right')}
                />
                <AlignButton testId="whiteboard-align-top" edge="top" title={t('whiteboard.alignTop')} onClick={() => align('top')} />
                <AlignButton
                  testId="whiteboard-align-middle"
                  edge="middle"
                  title={t('whiteboard.alignMiddle')}
                  onClick={() => align('middle')}
                />
                <AlignButton
                  testId="whiteboard-align-bottom"
                  edge="bottom"
                  title={t('whiteboard.alignBottom')}
                  onClick={() => align('bottom')}
                />
              </>
            ) : null}
            {selectedIds.length > 2 ? (
              <>
                <Divider />
                <DistributeButton
                  testId="whiteboard-distribute-horizontal"
                  axis="horizontal"
                  title={t('whiteboard.distributeHorizontal')}
                  onClick={() => distribute('horizontal')}
                />
                <DistributeButton
                  testId="whiteboard-distribute-vertical"
                  axis="vertical"
                  title={t('whiteboard.distributeVertical')}
                  onClick={() => distribute('vertical')}
                />
              </>
            ) : null}
            <Divider />
            <CenterViewButton
              testId="whiteboard-center-view-horizontal"
              axis="horizontal"
              title={t('whiteboard.centerViewHorizontal')}
              onClick={() => centerInView('horizontal')}
            />
            <CenterViewButton
              testId="whiteboard-center-view-vertical"
              axis="vertical"
              title={t('whiteboard.centerViewVertical')}
              onClick={() => centerInView('vertical')}
            />
          </div>
        ) : null}

        {/* 隐藏的文件选择器：工具栏「图片」与它同一个入口，选完立刻清空 value（同一张图能连选两次） */}
        <input
          ref={fileInputRef}
          data-testid="whiteboard-image-input"
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            void insertImages(files)
          }}
        />

        {/* T77：替换图片用**另一个** input——它只收一张、且要带着「替换哪个节点」，
            混进上面那个会让「选了文件但不知道往哪儿换」变成一条新图元 */}
        <input
          ref={replaceInputRef}
          data-testid="whiteboard-image-replace-input"
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            const target = replaceTargetRef.current
            event.target.value = ''
            replaceTargetRef.current = null
            if (file === undefined || target === null) return
            void replaceImage(target, file)
          }}
        />
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
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <WhiteboardCanvas
          whiteboard={whiteboard}
          resolveImage={resolveImage}
          textPlaceholder={t('whiteboard.textPlaceholder')}
          panX={viewState.panX}
          panY={viewState.panY}
          zoom={zoom}
          selectedIds={selectedIds}
          selectedEdgeId={selectedEdgeId}
          editingId={editingId}
          draftText={draftText}
          editingHeight={editingHeight}
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
            // 选中属性条（T81）贴在底边：它出现时提示让路，避免叠在同一处
            bottom: selectedIds.length > 0 ? sp(46) : sp(10),
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
function resizeBy(
  rect: WhiteboardRect,
  corner: WhiteboardCorner,
  point: WhiteboardPoint,
  start: WhiteboardPoint,
  aspect: number | null = null,
): WhiteboardRect {
  const dx = snapToGrid(point.x - start.x)
  const dy = snapToGrid(point.y - start.y)
  if (aspect !== null && aspect > 0) {
    // 等比：两个方向各算一次缩放比，取更「用力」的那个（拖角时横竖都在动，取大的才跟手），
    // 宽高一起变，对角固定 —— 与 Figma 里拖带锁比例图层的观感一致。
    const horizontal = corner === 'nw' || corner === 'sw' ? -dx : dx
    const vertical = corner === 'nw' || corner === 'ne' ? -dy : dy
    const scaleW = (rect.width + horizontal) / rect.width
    const scaleH = (rect.height + vertical) / rect.height
    const scale = Math.max(0.05, Math.max(scaleW, scaleH))
    const width = Math.max(WHITEBOARD_MIN_WIDTH, snapToGrid(rect.width * scale))
    const height = Math.max(WHITEBOARD_MIN_HEIGHT, snapToGrid(width / aspect))
    return {
      x: corner === 'nw' || corner === 'sw' ? rect.x + rect.width - width : rect.x,
      y: corner === 'nw' || corner === 'ne' ? rect.y + rect.height - height : rect.y,
      width,
      height,
    }
  }
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

/** 等一张图的 blob URL 就绪的最长时间：读不出来就按「没图」处理，不能卡住插入 / 导出。 */
const IMAGE_WAIT_MS = 1500

/**
 * 从剪贴板 / 拖放里挑出图片文件。
 *
 * `files` 与 `items` 都要看：Chrome 的截图粘贴只填 files，而某些截图工具 / 旧版 Edge
 * 把文件挂在 items 上。只看一边会得到「在别人机器上贴不进去」的偶发问题。
 */
function imageFilesOf(data: DataTransfer | null): File[] {
  if (data === null) return []
  const files: File[] = []
  for (let index = 0; index < data.files.length; index += 1) {
    const file = data.files[index]
    if (file !== undefined && file.type.startsWith('image/')) files.push(file)
  }
  if (files.length > 0) return files
  for (let index = 0; index < data.items.length; index += 1) {
    const item = data.items[index]
    if (item === undefined || item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file !== null) files.push(file)
  }
  return files
}

/** 图片就绪后的 blob URL：还没读出来就等一次通知（宿主异步读盘），最多等 IMAGE_WAIT_MS。 */
function waitForImageUrl(port: WhiteboardImagePort, ref: string): Promise<string | null> {
  const immediate = port.resolve(ref)
  if (immediate !== null) return Promise.resolve(immediate)
  return new Promise<string | null>((resolve) => {
    let stop: () => void = () => {}
    const timer = window.setTimeout(() => {
      stop()
      resolve(port.resolve(ref))
    }, IMAGE_WAIT_MS)
    stop =
      port.subscribe?.(() => {
        const url = port.resolve(ref)
        if (url === null) return
        window.clearTimeout(timer)
        stop()
        resolve(url)
      }) ?? (() => {})
  })
}

/** 量图片的自然尺寸（按它决定贴进来的显示大小）；读不出来返回 null。 */
function measureImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image()
    let settled = false
    const finish = (value: { width: number; height: number } | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    image.onload = () => finish({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => finish(null)
    window.setTimeout(() => finish(null), IMAGE_WAIT_MS)
    image.src = url
  })
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

/**
 * 带抓握余量的命中（T80）。`slack` 是**内容坐标**，调用方按 1/zoom 折算过。
 * 从后往前找 = 视觉上更靠上的图元优先，与 `findNodeAt` 同一口径。
 */
function findNodeNear(whiteboard: Whiteboard, point: WhiteboardPoint, slack: number): { id: string } | null {
  for (let index = whiteboard.nodes.length - 1; index >= 0; index -= 1) {
    const node = whiteboard.nodes[index]!
    if (
      point.x >= node.x - slack &&
      point.x <= node.x + node.width + slack &&
      point.y >= node.y - slack &&
      point.y <= node.y + node.height + slack
    ) {
      return { id: node.id }
    }
  }
  return null
}

const chipStyle: CSSProperties = {
  // T78：10px 收到 8px。工具行有十来个 chip，这一项就是 40px——正好是 1080 宽下溢出的那一截。
  padding: px('2px 8px'),
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

/** T75 · 字号输入：与工具按钮同高同底；宽度固定，1–2 位数字切换时工具栏不会抖。 */
const fontSelectStyle: CSSProperties = {
  ...chipStyle,
  // 必须显式给宽度：`<input>` 的默认尺寸按 size=20 算，什么都不写就是 130px 宽，
  // 把整条工具行顶到换行（T78 在 1080 宽下多选时折成三行，量出来就是它）。
  width: sp(48),
  flex: '0 0 auto',
  padding: px('1px 4px'),
  // 与 chip 同高：边框 2 + 上下 2 + 行高 18 = 24，否则整个工具行会比文档行高 1px
  lineHeight: px('18px'),
  textAlign: 'center',
  border: '1px solid var(--oe-separator)',
}

/**
 * 工具栏的一行。放不下时**整组折行**而不是把它裁掉：
 * 左端（插入）与右端（选中态）各是一个 flex 项，一个塞不下就自己落到下一行，
 * 行高随之长高、画布让出这点高度。这比「横向滚动 + 右端被切掉半个按钮」诚实得多，
 * 也比继续抠像素稳——1280 能一行放下，1080 多选时自动变两行，两边都不裁。
 */
const toolbarRowStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: TOOLBAR_HEIGHT,
  flex: '0 0 auto',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: sp(4),
  rowGap: sp(4),
  padding: `${sp(6)} ${sp(10)}`,
}

/** 工具行的说明（T81 起它只装「往板里放什么」）。 */
/** 工具行：底色压一档，把「这块板」与「往板里放什么」分成两层。 */
const toolbarToolsRowStyle: CSSProperties = {
  ...toolbarRowStyle,
  borderTop: '1px solid var(--oe-separator)',
  background: 'var(--oe-surface)',
}

/**
 * 选中行（T81）：有选中时才出现的**浮动属性条**，贴着画布底边。
 *
 * 为什么悬浮而不是插进工具栏：把它放进 flex 流里，出现/消失会让画布高度抖 36px，
 * 视口中心随之漂移——连续新建图元时第二个落点会偏离第一个整整半行（2560 档真机复现：
 * 新框压住旧框 24px，点击被拦截）。悬浮在画布上，工具栏高度恒定，落点永远稳定。
 *
 * 仍用 `flexWrap`：窄到放不下时自己折行，不裁切任何一个按钮。
 */
const toolbarSelectionRowStyle: CSSProperties = {
  ...toolbarRowStyle,
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 4,
  borderTop: '1px solid var(--oe-separator)',
  background: 'var(--oe-surface)',
  justifyContent: 'flex-start',
}

function ToolButton(props: {
  testId: string
  label: string
  danger?: boolean
  /** T77：常驻开关（加粗 / 斜体 / 铺满）的按下态 */
  active?: boolean
  /** 悬停提示：单纯一个字母的按钮（B / I）靠它说清自己是干什么的 */
  title?: string
  /** 字重 / 斜体按钮自己就该长得像它的效果（B 加粗、I 斜体），否则两个字母读不出差别 */
  emphasis?: 'bold' | 'italic'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      title={props.title}
      aria-label={props.title ?? props.label}
      aria-pressed={props.active === undefined ? undefined : props.active}
      onClick={props.onClick}
      style={{
        ...chipStyle,
        ...(props.emphasis === 'bold' ? { fontWeight: 700 } : {}),
        ...(props.emphasis === 'italic' ? { fontStyle: 'italic' } : {}),
        ...(props.danger === true ? { color: 'var(--oe-overdue)', background: 'var(--oe-whiteboard-danger-bg)' } : {}),
        ...(props.active === true
          ? { background: 'var(--oe-accent-tint)', color: 'var(--oe-accent-deep)', fontWeight: 600 }
          : {}),
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

type AlignEdge = WhiteboardAlignMode

/**
 * 对齐图标的几何：一条**细**参考线 + 两根**实心**长短条。
 * 早先用同粗细的描边画三条线，16px 下三根划痕分不出左右中；改为实心条之后
 * 「往哪边贴」靠条的长短与位置直接读出来。
 */
const ALIGN_ICONS: Record<AlignEdge, { guide: [number, number, number, number]; bars: [number, number, number, number][] }> = {
  left: { guide: [2, 2, 0.9, 12], bars: [[2, 4.2, 11, 2.8], [2, 9.2, 7, 2.8]] },
  center: { guide: [7.5, 2, 0.9, 12], bars: [[1.5, 4.2, 13, 2.8], [4.5, 9.2, 7, 2.8]] },
  right: { guide: [13.1, 2, 0.9, 12], bars: [[3, 4.2, 11, 2.8], [7, 9.2, 7, 2.8]] },
  top: { guide: [2, 2, 12, 0.9], bars: [[4.2, 2, 2.8, 11], [9.2, 2, 2.8, 7]] },
  middle: { guide: [2, 7.5, 12, 0.9], bars: [[4.2, 1.5, 2.8, 13], [9.2, 4.5, 2.8, 7]] },
  bottom: { guide: [2, 13.1, 12, 0.9], bars: [[4.2, 3, 2.8, 11], [9.2, 7, 2.8, 7]] },
}

const iconButtonStyle: CSSProperties = {
  width: sp(24),
  height: sp(24),
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  color: TEXT,
  background: 'var(--oe-fill)',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

/** 工具行图标按钮的统一外壳：24×24 的底 + 16×16 的 currentColor 画布（T78 定的尺寸，别改）。 */
function IconButton(props: { testId: string; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      style={iconButtonStyle}
    >
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        {props.children}
      </svg>
    </button>
  )
}

/**
 * 对齐按钮用图标而不是「左对齐 / 水平居中 / …」六个标签：后者一头要占 320px，
 * 多选时正好把工具行顶出可视区（T78 修的就是这件事）。含义写在 title 与 aria-label。
 */
function AlignButton(props: { testId: string; edge: AlignEdge; title: string; onClick: () => void }) {
  const icon = ALIGN_ICONS[props.edge]
  return (
    <IconButton testId={props.testId} title={props.title} onClick={props.onClick}>
      <rect x={icon.guide[0]} y={icon.guide[1]} width={icon.guide[2]} height={icon.guide[3]} opacity={0.35} />
      {icon.bars.map((bar, index) => (
        <rect key={index} x={bar[0]} y={bar[1]} width={bar[2]} height={bar[3]} rx={0.7} />
      ))}
    </IconButton>
  )
}

/**
 * 等距分布图标：外侧两根**实心条**（首尾两枚，位置不动）+ 中间一道双向箭头。
 * 与对齐图标的区别一眼可辨——对齐是「一条参考线 + 两根长短条」，分布是「两根等长条 + 箭头」。
 */
const DISTRIBUTE_ICONS: Record<WhiteboardAxis, ReactNode> = {
  horizontal: (
    <>
      <rect x={1.4} y={3} width={2.2} height={10} rx={0.7} />
      <rect x={12.4} y={3} width={2.2} height={10} rx={0.7} />
      <rect x={5} y={7.4} width={6} height={1.2} rx={0.6} opacity={0.45} />
      <path d="M6.5 5.2 L5.5 8 L6.5 10.8 Z" />
      <path d="M9.5 5.2 L10.5 8 L9.5 10.8 Z" />
    </>
  ),
  vertical: (
    <>
      <rect x={3} y={1.4} width={10} height={2.2} rx={0.7} />
      <rect x={3} y={12.4} width={10} height={2.2} rx={0.7} />
      <rect x={7.4} y={5} width={1.2} height={6} rx={0.6} opacity={0.45} />
      <path d="M5.2 6.5 L8 5.5 L10.8 6.5 Z" />
      <path d="M5.2 9.5 L8 10.5 L10.8 9.5 Z" />
    </>
  ),
}

/**
 * 视野居中图标：两侧/上下两道细线 = **视野边界**，中间那枚实心块落在正中。
 * 「到视野里」和「彼此对齐」是两个不同的参照物，图标必须能分清参照物是谁。
 */
const CENTER_VIEW_ICONS: Record<WhiteboardAxis, ReactNode> = {
  horizontal: (
    <>
      <rect x={0.8} y={2} width={0.9} height={12} opacity={0.3} />
      <rect x={14.3} y={2} width={0.9} height={12} opacity={0.3} />
      <rect x={6.4} y={4.4} width={3.2} height={7.2} rx={0.8} />
    </>
  ),
  vertical: (
    <>
      <rect x={2} y={0.8} width={12} height={0.9} opacity={0.3} />
      <rect x={2} y={14.3} width={12} height={0.9} opacity={0.3} />
      <rect x={4.4} y={6.4} width={7.2} height={3.2} rx={0.8} />
    </>
  ),
}

function DistributeButton(props: { testId: string; axis: WhiteboardAxis; title: string; onClick: () => void }) {
  return (
    <IconButton testId={props.testId} title={props.title} onClick={props.onClick}>
      {DISTRIBUTE_ICONS[props.axis]}
      {/* 注意：`path` 的顶点方向决定箭头指向，别把 horizontal 的路径抄到 vertical 上 */}
    </IconButton>
  )
}

function CenterViewButton(props: { testId: string; axis: WhiteboardAxis; title: string; onClick: () => void }) {
  return (
    <IconButton testId={props.testId} title={props.title} onClick={props.onClick}>
      {CENTER_VIEW_ICONS[props.axis]}
    </IconButton>
  )
}

export default WhiteboardView
