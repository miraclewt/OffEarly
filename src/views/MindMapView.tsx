// T45-T47 · MindMapView：思维导图视图宿主（画布投影 + tab 接线 + 编辑交互 + 拖拽/图管理）。
//
// 结构逐条照 GanttView：本地 viewport（只建一次，useSyncExternalStore 订阅）、
// 工具条高度 36、ResizeObserver 测量 → setViewportSize；数据流是
// vault.mindmaps ──(选中一张图)──▶ buildMindMapModel ──▶ MindMapCanvas。
//
// 状态边界（spec 裁决）：选中图 / 选中节点 / 编辑态全部留本地 state，不进 vault、不进 App；
// selectedMapId 为 null 或选中图已被删除时回退表首（数组序即显示序，T42 尾插口径保证
// 数组序 = order 升序）。事件时刻读 vault prop（每次渲染都是新快照），不摸 store.getVault()。
//
// T46 交互层（三条缝全部接线）：
//   · 键盘层：根容器 tabIndex=0 + role="application"，onKeyDown 按 xmind 键位表——
//     Tab 加子 / Enter 加同级（根 no-op）/ Delete·Backspace 删（根 no-op）/ F2·双击编辑 /
//     Space 折叠 / Escape 退编辑再按清选中 / 方向键树游走。游走只改选中态，不写库；
//     写入一律走 T42 apply*，vault 用事件时刻的 prop。
//   · 就地编辑：HTML overlay <input>（不进 foreignObject），绝对定位在画布表面容器内，
//     screen = content * zoom + pan 与 viewport 契约一致；预填 vault 树里的**未截断**原文
//     （模型 text 已截断），提交 applyRenameNode(原始 trim 输入)；Enter/blur 提交、Esc 取消。
//   · 指针/滚轮：空白拖拽 pointerdown→panBy 增量（pointer capture，jsdom 缺实现则 typeof 守卫）；
//     wheel 照 GanttCanvas 用 ref + addEventListener(passive:false) 注册，仅当 applyWheel
//     真正消费才 preventDefault。
//
// T47 交互层（跨父拖拽 move + 图管理工具条）：
//   · 拖拽 move：节点 pointerdown（同帧完成选中）布防；同一指针移动 >4px 进入拖拽——阈值前
//     viewport 纹丝不动（节点 pointerdown 已 stopPropagation，平移链路根本不布防）。命中检测 =
//     屏幕坐标反变换 content=(screen-pan)/zoom 落进某**可见**节点矩形；候选只排除自身与
//     自身后代（isDescendant）——**中心主题（根）是合法落点**（把子树回挂第一层 / 重排一级分支），
//     根作为拖拽源天然无候选（树上其余节点全是它的后代）。合法候选才亮 data-mindmap-drop-target；
//     pointerup 命中 → applyMoveNode(…, index = 目标 children.length 尾插)；非法/未命中静默取消零写；
//     命令抛错（stale snapshot 竞态）try/catch 兜住——抛错在 bus.apply 之前，undo 栈必然干净。
//   · 图管理工具条：重命名 = inline input（Enter/blur 提交 applyRenameMap，空 trim 不提交，
//     Esc 取消）；删除 = 两段确认钮（首点切 mindmap.deleteConfirm 文案，二次 applyDeleteMap；
//     **确认态钉在 armed 的图 id 上**——选中图换了别的图时首点只重新布防，二次点不会误删新图；
//     外点复位 + selectedMap.id 变化即整体复位本地图态；删除后选中回退表首由既有
//     selectedMapId 悬空兜底承担）；折叠全部/展开全部 = 单 toggle 走
//     buildMindMapModel(map,{foldAll:true}) 的**纯视图本地态**（不写库、零 undo）。
//
// T48 交互层（导出菜单，照 GanttView）：工具条右侧 PNG/SVG × 仅可见区/全图 弹层，
//   Esc/外点关闭与 R3 PNG 探针同甘特口径；导出喂的是**当前显示模型**——「全部折叠」开着时
//   导出的就是折叠后的图（所见即所导）。范围/按钮等导出语汇复用 ganttExport.* 键，唯一例外是
//   PNG 不可用提示走 mindmap.exportPngUnsupported（甘特那句写着「请改用 SVG 或 CSV」，而导图
//   没有 CSV 导出——T48 终审修复轮）；范围反算与 PNG 管线在 MindMapExporter
//   （probePngSupport / svgToPngBlob / triggerDownload 由 GanttExporter 共用）。
//
// T48 终审修复轮（whole-branch review）三条：
//   · Critical · 幽灵编辑态锁死键盘：编辑中的节点不在显示模型里时输入框不渲染，而键位表的
//     「编辑中」早退又挡在 Escape 之前。修法两层——editingView 为空即自动解除编辑态（兜底），
//     startAddChild 在「全部折叠」开着时先揭示折叠再进编辑（加出来的子就在眼前）。
//   · Important · 进入导图/切图 fitToContent（spec 5 的第二处调用点），fittedMapIdRef 保证
//     每张图只 fit 一次，重命名等重渲染不把用户调好的 pan/zoom 抹掉。
//   · Important · 拖拽落到折叠目标由 applyMoveNode 先展开目的地（见 controllers/mindmapActions），
//     视图侧的落点逻辑不变。
//
// IME 手动验证项：jsdom 能模拟 compositionstart/end 与 isComposing，但真实中文输入法
// （组词 Enter 上屏 vs 提交）的行为必须在浏览器里人工回归一遍。导图跨父拖拽同理——
// 真实指针 capture 下越出画布的跟随行为需要浏览器验证。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from 'react'

import { createMindmapViewport, mindmapZoomFactorAt } from '../controllers/mindmapViewport'
import type { MindMapViewportController } from '../controllers/mindmapViewport'
import {
  applyAddNode,
  applyCreateMap,
  applyDeleteMap,
  applyDeleteNode,
  applyMoveNode,
  applyRenameMap,
  applyRenameNode,
  applyToggleFold,
} from '../controllers/mindmapActions'
import { buildMindMapModel, MINDMAP_FONT_SIZE } from '../domain/mindmapModel'
import { findNode, findParent, isDescendant } from '../domain/mindmapTree'
import type { CommandBus } from '../domain/commandBus'
import type { Vault } from '../domain/types'
import { createI18n } from '../locales/i18n'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { MindMapCanvas } from './MindMapCanvas'
import type { MindMapPointerPoint } from './MindMapCanvas'
import { exportMindMap, probePngSupport } from './MindMapExporter'
import type { MindMapExportFormat, MindMapExportRange } from './MindMapExporter'
import { Icon } from './IconSprite'
import { fs, px, sp } from '../styles/scale'
import { useUiScale } from '../styles/useUiScale'

type Translate = (key: MsgKey, params?: TranslateParams) => string

const TEXT = 'var(--oe-text)'
const TEXT_MUTED = 'var(--oe-text-muted)'
const INDIGO = 'var(--oe-accent)'
const BODY_FONT = 'var(--oe-font)'
/** 工具条高度与甘特一致（36），两套视图的横向节奏对齐。 */
const TOOLBAR_HEIGHT = 36
/** 拖拽阈值（px）：节点 pointerdown 后移动超过这个距离才从 click-select 升级为 drag（裁决 4px）。 */
const MINDMAP_DRAG_THRESHOLD = 4

/**
 * T48 导出菜单的常量顺序与文案键：格式 PNG/SVG × 范围 可见/全图。
 * 格式与范围沿用甘特弹层同一套导出语汇；范围键走 mindmap.exportVisible / exportFull，
 * PNG 不可用提示走导图自己的 mindmap.exportPngUnsupported（T48 终审修复轮：甘特文案里的
 * 「或 CSV」对导图不成立）。
 */
const EXPORT_FORMAT_ORDER: MindMapExportFormat[] = ['png', 'svg']
const EXPORT_FORMAT_LABEL: Record<MindMapExportFormat, MsgKey> = {
  png: 'ganttExport.png',
  svg: 'ganttExport.svg',
}
const EXPORT_RANGE_ORDER: MindMapExportRange[] = ['visible', 'full']
const EXPORT_RANGE_LABEL: Record<MindMapExportRange, MsgKey> = {
  visible: 'mindmap.exportVisible',
  full: 'mindmap.exportFull',
}

/** 兜底文案表：与 GanttView 同款，测试或未接线场景也能独立挂载（不依赖 navigator.language）。 */
const fallbackI18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })

export interface MindMapViewProps {
  vault: Vault
  /** 写入口（T10 CommandBus，可能包了只读闸门）；承载全部 apply*（节点加/删/改名/折叠、拖拽 move、图管理）。 */
  bus: CommandBus
  t?: Translate
  /** 视口控制器（pan/zoom/fit）；省略时内部自建。T46 的滚轮/拖拽平移经同一个控制器。 */
  viewport?: MindMapViewportController
  /** 注入视口尺寸（jsdom / file:// 单文件下测不到布局时的出口），照 GanttView 的 width/height。 */
  width?: number
  height?: number
  style?: CSSProperties
}

export function MindMapView(props: MindMapViewProps): ReactElement {
  const { vault, bus } = props
  const t = props.t ?? fallbackI18n.t

  // 外部控制器优先；自建只建一次，pan/zoom 不会被重渲染抹掉（GanttView 同款）
  const [ownViewport] = useState(() => createMindmapViewport())
  const viewport = props.viewport ?? ownViewport
  const state = useSyncExternalStore(viewport.subscribe, viewport.getState)

  const rootRef = useRef<HTMLDivElement | null>(null)
  // 画布表面（canvas 外层容器）：wheel 原生监听 + 空白拖拽指针层都挂这里。
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  // 选中图：null = 「用户没选过」→ 回退表首；选中图被删后 find 落空，同样回退表首。
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  // editingRef 与 editingNodeId 同步（state 更新是异步的，blur/Enter 竞态要靠 ref 判定：
  // Enter 提交后组件卸载前浏览器若补发 blur，ref 已是 null，不会二次提交出多余 undo 记录）。
  const editingRef = useRef<string | null>(null)
  // IME 组词期间标记（compositionstart/end 驱动）：组词中的 Enter 一律不上报提交。
  const composingRef = useRef(false)
  const setEditing = useCallback((nodeId: string | null) => {
    editingRef.current = nodeId
    composingRef.current = false
    setEditingNodeId(nodeId)
  }, [])

  const maps = vault.mindmaps
  const selectedMap = useMemo(() => {
    if (maps.length === 0) return null
    return maps.find((map) => map.id === selectedMapId) ?? maps[0] ?? null
  }, [maps, selectedMapId])

  // T47 · 全部折叠：纯视图本地态（foldAll 进 buildMindMapModel 的展示口径，root-inclusive，
  // 模型只剩中心主题）。不写库、零 undo——「展开全部」= 该态置 false。
  const [foldAllView, setFoldAllView] = useState(false)
  // T40：导图的行高/间距/节点宽都在模型里按尺度算，视图只需订阅并在变化时重算
  const uiScale = useUiScale()
  // T47 · 图重命名：inline input 开关。renamingRef 与 state 同步（同 editingRef 手法）：
  // Enter 提交后卸载前浏览器补发的 blur 靠 ref 守卫吃掉，不会二次提交。
  const [renaming, setRenaming] = useState(false)
  const renamingRef = useRef(false)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  // T47 · 删除两段确认：首点进确认态，二次点才落命令；外点/切图复位。
  // 确认态**钉在 armed 的图 id** 上（不是布尔）：布防后当前选中图被外部改动换成了另一张图时，
  // 二次点击绝不能把删除落到新图上——见 handleDeleteMap。
  const [deleteConfirmingFor, setDeleteConfirmingFor] = useState<string | null>(null)
  // T47 · 节点拖拽：ref 持指针跟踪态（move/up 判定用），state 只承载渲染所需的
  // ghost id + 落点高亮 id（每次 pointermove 重算后同步进 state 触发重渲染）。
  const nodeDragRef = useRef<{
    pointerId: number
    nodeId: string
    startX: number
    startY: number
    started: boolean
    targetId: string | null
  } | null>(null)
  const [nodeDrag, setNodeDrag] = useState<{ nodeId: string; targetId: string | null } | null>(null)

  const model = useMemo(
    () => (selectedMap === null ? null : buildMindMapModel(selectedMap, { foldAll: foldAllView, uiScale })),
    [selectedMap, foldAllView, uiScale],
  )

  // ---- T48 · 导出菜单（照 GanttView 的弹层交互与 R3 探针） ----------------------
  // 「全部折叠」开着时 model 就是折叠后的显示模型——导出器喂什么画什么，
  // 因此**折叠态下导出 PNG/SVG 得到的就是折叠后的图**（刻意行为：所见即所导）。
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<MindMapExportFormat>('png')
  const [exportRange, setExportRange] = useState<MindMapExportRange>('visible')
  const [pngSupported, setPngSupported] = useState<boolean | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportHint, setExportHint] = useState<string | null>(null)

  // 弹层的 Esc / 点击外部关闭（GanttView L125-145 同款）：mousedown 判「不在弹层容器内」，
  // 按钮本身在容器内，再点按钮仍走既有 toggle，不受影响。
  const exportMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!exportMenuOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExportMenuOpen(false)
    }
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && exportMenuRef.current?.contains(target) !== true) {
        setExportMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [exportMenuOpen])

  // R3 探针：挂载时跑一次最小 SVG → Canvas → toBlob；不可用就禁用 PNG 选项并提示，
  // 而不是等用户点下去才失败。jsdom 无真 2d 上下文，探针如常返回 false。
  useEffect(() => {
    let alive = true
    void probePngSupport().then((supported) => {
      if (alive) setPngSupported(supported)
    })
    return () => {
      alive = false
    }
  }, [])

  /** 当前档缩放（viewport 反算「仅可见区」要用同一个数，与画布投影同源）。 */
  const zoom = mindmapZoomFactorAt(state.zoomIndex)

  const handleExportConfirm = useCallback(() => {
    if (selectedMap === null || model === null) return
    setExportHint(null)
    setExporting(true)
    void exportMindMap({
      model,
      format: exportFormat,
      range: exportRange,
      viewport: { panX: state.panX, panY: state.panY, zoom, width: state.width, height: state.height },
      fileName: selectedMap.name,
    })
      .then((result) => {
        setExportMenuOpen(false)
        setExportHint(t('shell.exported', { name: result.filename }))
      })
      .catch(() => {
        if (exportFormat === 'png') setPngSupported(false)
        setExportHint(t('ganttExport.failed'))
      })
      .finally(() => {
        setExporting(false)
      })
  }, [selectedMap, model, exportFormat, exportRange, state.panX, state.panY, state.width, state.height, zoom, t])

  const exportDisabled = exporting || (exportFormat === 'png' && pngSupported === false)

  /** 本地图态复位体：选中/编辑/重命名/删除布防/拖拽都隶属于旧图的树，不带进新图。 */
  const resetMapLocalState = useCallback(() => {
    setSelectedNodeId(null)
    setEditing(null)
    setDeleteConfirmingFor(null)
    renamingRef.current = false
    setRenaming(false)
    nodeDragRef.current = null
    setNodeDrag(null)
  }, [setEditing])

  // 换图 = 本地图态整体换代：选中节点 / 编辑 / 重命名 / 删除布防 / 拖拽都隶属于旧图的树。
  // 单一复位入口（T47 修复轮）：外部改动让选中图落到另一张图（如当前图被 undo/删除，
  // selectedMapId 悬空 → 回退表首）时同样触发，两段删除的确认态因此永远不会跨图存活。
  // foldAllView 是全局展示口径（与图无关），刻意不在复位范围内。
  useEffect(() => {
    resetMapLocalState()
  }, [selectedMap?.id, resetMapLocalState])

  // 注入尺寸优先（照 GanttView：props 缺省时 setViewportSize 是 no-op，沿用控制器默认值）
  useEffect(() => {
    viewport.setViewportSize({ width: props.width, height: props.height })
  }, [viewport, props.width, props.height])

  // 真实容器测量（ResizeObserver；jsdom 没有该全局时整段跳过，视口沿用注入值）。
  // NaN 纪律：宽度必须 > 0（NaN 过不了该比较），高度必须有限——两者都筛过才进 viewport。
  useEffect(() => {
    const element = rootRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box === undefined || !(box.width > 0) || !Number.isFinite(box.height)) return
      viewport.setViewportSize({
        width: Math.max(0, box.width),
        height: Math.max(0, box.height - TOOLBAR_HEIGHT * uiScale),
      })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [viewport])

  /** 建图并选中新图（空态引导卡与工具条共用；vault 事件时刻现值，deps 缺省 id/时钟走 nanoid/Date）。
   *  本地图态由 selectedMap.id 的复位 effect 统一清理，这里不再单独调一次。 */
  const handleCreate = useCallback(() => {
    const plan = applyCreateMap(bus, vault, {
      fallbackName: t('mindmap.defaultName'),
      rootText: t('mindmap.centerTopic'),
    })
    setSelectedMapId(plan.map.id)
  }, [bus, vault, t])

  const handleFit = useCallback(() => {
    if (model !== null) viewport.fitToContent(model.bounds)
  }, [viewport, model])

  // T48 终审修复轮（Important 2）· 进入导图 / 切图自动适应画布：spec 5 点名的第二处
  // fitToContent 调用点（另一处就是上面的「适应画布」按钮）。此前打开导图页或换图都停在
  // 默认 pan/zoom，宽树直接切出屏幕外。
  // fittedMapIdRef 保证「每张图只 fit 一次」：重命名、折叠、加删节点都会重建 model，
  // 没有这道守卫的话用户手动调好的 pan/zoom 会被反复抹掉。
  // 视口尺寸未知（0/NaN——注入值缺省且容器还没测到）时跳过：那种尺寸只会算出退化 pan/zoom；
  // 等尺寸到位，同一条 effect 会补上这次 fit（守卫尚未占用该图 id）。
  const fittedMapIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (selectedMap === null || model === null) return
    // 尺寸读控制器现值而不是这一帧的 state 快照：同一批 effect 里「注入尺寸」那条可能刚把
    // 0×0 落库，本帧闭包里的 state 还是控制器初值——读现值才不会拿退化尺寸去 fit。
    const size = viewport.getState()
    if (!(size.width > 0) || !(size.height > 0)) return
    if (fittedMapIdRef.current === selectedMap.id) return
    fittedMapIdRef.current = selectedMap.id
    viewport.fitToContent(model.bounds)
  }, [selectedMap?.id, model, viewport, state.width, state.height])

  /** 节点 pointerdown：选中即刻完成（T46 口径）；附带落点时布防 T47 拖拽（>4px 才升级为 drag）。 */
  const handleSelect = useCallback((nodeId: string, point?: MindMapPointerPoint) => {
    setSelectedNodeId(nodeId)
    // 只主按键布防拖拽（与背景平移的 button!==0 守卫同口径）；右键选中后移动不误入 drag
    nodeDragRef.current =
      point !== undefined && point.button === 0
        ? {
            pointerId: point.pointerId,
            nodeId,
            startX: point.clientX,
            startY: point.clientY,
            started: false,
            targetId: null,
          }
        : null
  }, [])

  // ---- T46 · 就地编辑层 ----------------------------------------------------

  /** 进入编辑（F2 / 双击 / 加子加同级之后）：双击同时补齐选中。 */
  const startEdit = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId)
      setEditing(nodeId)
    },
    [setEditing],
  )

  /**
   * 结束编辑。commit=true → applyRenameNode(raw 输入，trim 与兜底在控制器里做)；
   * false → 纯退出，零 bus 写入（Escape 裁决）。先清 ref 再写库，blur 竞态自然被
   * editingRef 守卫吃掉（Enter 提交卸载后浏览器补发的 blur 不会再提交一次）。
   * 文本没变（与 normalizeText 同口径：空白落兜底文案）就不写库——不然「进编辑原样 blur」
   * 会留一条零变更 undo 记录，撤销栈被无意义条目灌满。
   */
  const finishEditing = useCallback(
    (commit: boolean, raw: string) => {
      const nodeId = editingRef.current
      setEditing(null)
      if (!commit || nodeId === null || selectedMap === null) return
      const original = findNode(selectedMap.root, nodeId)?.text
      if (original === undefined) return // 节点已被他处删除：没有可改写的目标
      const trimmed = raw.trim()
      if (trimmed === original || (trimmed === '' && t('mindmap.branch') === original)) return
      applyRenameNode(bus, vault, selectedMap.id, nodeId, raw, t('mindmap.branch'))
    },
    [bus, vault, selectedMap, t, setEditing],
  )

  /**
   * 在 parentId 下加子（Tab/Enter 共用出口）：落库 → 选中新节点 → 立即进入编辑。
   * T48 终审修复轮（Critical）：「全部折叠」开着时新子不在显示模型里——直接进编辑 = 编辑一个
   * 看不见的节点（还会连带锁死键盘）。所以先揭示折叠视图（纯展示态，不写库）再进编辑：
   * 加出来的子就在眼前。数据折叠的父由 applyAddNode 自己展开，两条命令两条 undo。
   */
  const startAddChild = useCallback(
    (parentId: string) => {
      if (selectedMap === null) return
      const created = applyAddNode(bus, vault, selectedMap.id, parentId, {
        fallbackText: t('mindmap.branch'),
      })
      if (created === null) return
      if (foldAllView) setFoldAllView(false)
      setSelectedNodeId(created.id)
      setEditing(created.id)
    },
    [bus, vault, selectedMap, t, setEditing, foldAllView],
  )

  // ---- T47 · 图管理工具条（重命名 / 两段删除 / 全部折叠 toggle） ----------------

  const enterRename = useCallback(() => {
    setDeleteConfirmingFor(null)
    renamingRef.current = true
    setRenaming(true)
  }, [])

  const exitRename = useCallback(() => {
    renamingRef.current = false
    setRenaming(false)
  }, [])

  /**
   * 重命名提交：renamingRef 守卫同 editingRef 手法（Enter 收尾后补发的 blur 不二次提交）。
   * 空/纯空白 = 不提交（applyRenameMap 内部同样拦空，这里连 bus 都不碰）；裁决只约束空串，
   * 同名提交不拦——patchMap 会盖 updatedAt，属正常编辑。
   */
  const commitRename = useCallback(
    (raw: string) => {
      if (!renamingRef.current) return
      exitRename()
      if (raw.trim() === '' || selectedMap === null) return
      applyRenameMap(bus, vault, selectedMap.id, raw)
    },
    [bus, vault, selectedMap, exitRename],
  )

  /**
   * 删除两段确认：首点只切确认文案（布防 = 记住当时的图 id）；二次点且**当前选中图仍是那张图**
   * 才落 applyDeleteMap。armed id 与当前图不一致时只重新布防——外部改动（undo / 别处删图）让选中
   * 回退到另一张图时，一次点击绝不允许把删除落到新图上。选中回退表首由 selectedMapId 悬空兜底承担。
   */
  const handleDeleteMap = useCallback(() => {
    if (selectedMap === null) return
    if (deleteConfirmingFor !== selectedMap.id) {
      setDeleteConfirmingFor(selectedMap.id)
      return
    }
    exitRename()
    setDeleteConfirmingFor(null)
    applyDeleteMap(bus, vault, selectedMap.id)
    setSelectedNodeId(null)
    setEditing(null)
    nodeDragRef.current = null
    setNodeDrag(null)
  }, [bus, vault, selectedMap, deleteConfirmingFor, setEditing, exitRename])

  // 重命名输入自动聚焦并全选（与节点编辑 overlay 同款手感）。
  useEffect(() => {
    if (!renaming) return
    const element = renameInputRef.current
    if (element === null) return
    element.focus()
    element.select()
  }, [renaming])

  // ---- T46 · 键盘层（根容器 onKeyDown，xmind 键位表） -----------------------

  function handleRootKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    // 控件守卫：工具条（图切换 select / 新建 / 适应画布按钮）与编辑输入框里的 keydown 会
    // 冒泡到这里，但它们不属于「画布节点快捷键」的作用域——不加这层拦截，焦点在「新建」上
    // 按 Enter 会同时加同级节点并 preventDefault 吞掉按钮激活；在 select 上按方向键会
    // 选项与游走双触发；Tab 在输入框里打字/切焦点会被 preventDefault 劫持成「加子节点」。
    const target = event.target as Element | null
    if (target !== null && target.closest('button,select,input,textarea') !== null) return
    // IME 守卫：组词期间的 keydown 一律不响应快捷键。
    // React 19 的 synthetic KeyboardEvent 连 isComposing 接口都不透出（tsc 实证），
    // nativeEvent 才是事实源。手动验证项：真实中文输入法（搜狗/微软拼音等）的组词时序
    // jsdom 无法完全复刻，浏览器里必须人工回归「IME 组词中按 Enter 不提交/不触发快捷键」。
    if (event.nativeEvent.isComposing) return
    // 编辑中：输入框自己的 onKeyDown 处理 Enter/Esc（并 stopPropagation），其余按键归打字，
    // 根容器一律不响应——不然 Escape 会是「退编辑 + 清选中」两连击。
    if (editingNodeId !== null) return
    if (selectedMap === null) return
    const nodeId = selectedNodeId
    if (nodeId === null) return
    const node = findNode(selectedMap.root, nodeId)
    if (node === null) return // 选中指向已不存在的节点（他处删除）：快捷键一律 no-op

    const map = selectedMap
    const selectNode = (candidate: string | null): void => {
      if (candidate !== null) setSelectedNodeId(candidate)
    }

    switch (event.key) {
      case 'Tab': {
        event.preventDefault() // Tab 默认是焦点漫游，这里要截胡成「加子节点」
        startAddChild(node.id)
        return
      }
      case 'Enter': {
        event.preventDefault()
        // 加同级 = 挂到父下；根没有「同级」——no-op（裁决：根上禁用）
        const located = findParent(map.root, node.id)
        if (located === null) return
        startAddChild(located.parent.id)
        return
      }
      case 'Delete':
      case 'Backspace': {
        event.preventDefault()
        if (map.root.id === node.id) return // 根禁删：applyDeleteNode 也会拒绝，这里连命令都不产
        if (applyDeleteNode(bus, vault, map.id, node.id)) {
          setEditing(null)
          setSelectedNodeId(null)
        }
        return
      }
      case 'F2': {
        event.preventDefault()
        startEdit(node.id)
        return
      }
      case ' ': {
        // Space = 折叠切换（写库；折叠徽标是同一条 applyToggleFold）
        event.preventDefault()
        applyToggleFold(bus, vault, map.id, node.id)
        return
      }
      case 'Escape': {
        // 编辑态在上面已 early-return：能走到这里说明没在编辑 → 清选中
        setSelectedNodeId(null)
        return
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        // 兄弟游走（数据树序 = children 数组序，T43 口径①）；只改选中态，零写入
        event.preventDefault()
        const located = findParent(map.root, node.id)
        if (located === null) return // 根无兄弟
        const delta = event.key === 'ArrowDown' ? 1 : -1
        selectNode(located.parent.children[located.index + delta]?.id ?? null)
        return
      }
      case 'ArrowLeft': {
        // 父节点；折叠与否不改这条（游走读数据树，模型可见性由 Space/徽标折叠控制）
        event.preventDefault()
        const located = findParent(map.root, node.id)
        selectNode(located?.parent.id ?? null) // 根上 no-op
        return
      }
      case 'ArrowRight': {
        // 首子（折叠下也按数据树走——展开当前请用 Space/徽标，游走本身不写库）
        event.preventDefault()
        selectNode(node.children[0]?.id ?? null) // 叶子上 no-op
        return
      }
      default:
    }
  }

  // ---- T46 · 指针/滚轮层（画布表面） ----------------------------------------

  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)

  function handleSurfacePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    // 背景按下 = 旧手势一律作废：清掉可能残留的节点拖拽跟踪态，避免上一轮 pointerup
    // 丢失（真实浏览器丢事件 / 指针 id 变化）后，下一次背景平移期间拖拽分支抢先命中。
    nodeDragRef.current = null
    const element = event.currentTarget
    // jsdom 未实现 setPointerCapture：typeof 守卫，真实浏览器捕获后拖拽可越出画布继续
    if (typeof element.setPointerCapture === 'function') element.setPointerCapture(event.pointerId)
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  /**
   * T47 命中检测：屏幕坐标反变换成内容坐标（content = (screen - pan) / zoom，与 <g transform>
   * 同一投影）后落进某**可见**节点矩形。候选排除（修复轮裁决）：自身、自身后代（isDescendant）
   * ——在命中层过滤，不靠命令抛错兜底。**中心主题（根）是合法落点**：把子树回挂第一层 /
   * 重排一级分支都靠它，reducer 的 insertChild 对根 id 天然成立；根作为拖拽源也无需额外拦截
   * ——树上其余节点全是它的后代，isDescendant 直接清空候选（命令层另有移根抛错兜底）。
   * 矩形纯模型驱动：jsdom 下 surface 的 getBoundingClientRect 全 0，clientX 即 surface 局部
   * 屏幕坐标，测试零 DOM 依赖。
   */
  function resolveDropTargetId(clientX: number, clientY: number, nodeId: string): string | null {
    if (selectedMap === null || model === null) return null
    const rect = surfaceRef.current?.getBoundingClientRect()
    const contentX = (clientX - (rect?.left ?? 0) - state.panX) / zoom
    const contentY = (clientY - (rect?.top ?? 0) - state.panY) / zoom
    for (const view of model.nodes) {
      if (view.id === nodeId) continue
      if (isDescendant(selectedMap.root, nodeId, view.id)) continue // 自己的子树 = 环
      if (
        contentX >= view.x &&
        contentX <= view.x + view.width &&
        contentY >= view.y &&
        contentY <= view.y + view.height
      ) {
        return view.id
      }
    }
    return null
  }

  function handleSurfacePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    // 拖拽分支先行：节点 pointerdown 已 stopPropagation，平移链路对同一指针根本没布防，
    // 阈值前 viewport 纹丝不动、阈值后进入 drag——选中已在 pointerdown 完成，不再重复。
    const drag = nodeDragRef.current
    if (drag !== null && drag.pointerId === event.pointerId) {
      if (!drag.started) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= MINDMAP_DRAG_THRESHOLD) return
        drag.started = true
        // 真实浏览器：把后续 move/up 钉在 surface 上，越出画布也能继续拖；jsdom 缺实现则跳过
        const surface = surfaceRef.current
        if (surface !== null && typeof surface.setPointerCapture === 'function') {
          surface.setPointerCapture(event.pointerId)
        }
      }
      drag.targetId = resolveDropTargetId(event.clientX, event.clientY, drag.nodeId)
      setNodeDrag((prev) =>
        prev !== null && prev.nodeId === drag.nodeId && prev.targetId === drag.targetId
          ? prev
          : { nodeId: drag.nodeId, targetId: drag.targetId },
      )
      return
    }
    const pan = panRef.current
    if (pan === null || pan.pointerId !== event.pointerId) return
    viewport.panBy(event.clientX - pan.x, event.clientY - pan.y)
    // 增量式记录：panBy 收的是 delta，起点跟着 move 走
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  function handleSurfacePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    // pointerup 时浏览器隐式释放捕获，这里只清本地拖拽态
    const drag = nodeDragRef.current
    if (drag !== null && drag.pointerId === event.pointerId) {
      nodeDragRef.current = null
      if (drag.started) {
        setNodeDrag(null)
        if (drag.targetId !== null && selectedMap !== null) {
          try {
            const target = findNode(selectedMap.root, drag.targetId)
            if (target !== null) {
              // 落点 = 目标子列尾部追加：index = target.children.length（remove→insert 语义，
              // 工厂内不做同父补偿——mindmapActions 测试锁定）；length 恒 ≥0，负下标不可能出现。
              applyMoveNode(bus, vault, selectedMap.id, drag.nodeId, drag.targetId, target.children.length)
            }
          } catch {
            // 拖拽的 race-cancel 路径（与 spec 8 的「id 找不到 → 全局 notice 呈现」不是一条）：
            // 视图持的是事件时刻的 vault 快照，落点/被拖节点在他处已不存在时命令层在 bus.apply
            // 之前抛错——这里静默取消即可，不崩、undo 栈干净，也不该弹 notice 打断手势。
          }
        }
      }
      return
    }
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null
  }

  /** T47 · 删除确认态的外点复位：capture 相位先于子层 stopPropagation，视图内任何按下都复位。 */
  function handleRootPointerDownCapture(event: ReactPointerEvent<HTMLDivElement>): void {
    const target = event.target as Element | null
    if (target !== null && target.closest('[data-testid="mindmap-delete-map"]') !== null) return
    setDeleteConfirmingFor(null)
  }

  /** 手势被打断（pointercancel）：拖拽与平移一律作废——cancel 不是 pointerup，绝不落 move。 */
  function handleSurfacePointerCancel(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = nodeDragRef.current
    if (drag !== null && drag.pointerId === event.pointerId) {
      nodeDragRef.current = null
      if (drag.started) setNodeDrag(null)
    }
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null
  }

  // wheel 照 GanttCanvas：React 的 onWheel 是 passive 的，preventDefault 必须走非 passive
  // 原生监听；effect 随 selectedMap 重挂（空态引导卡 ↔ 画布切换时 surface div 会换）。
  useEffect(() => {
    const element = surfaceRef.current
    if (element === null) return
    function handleNativeWheel(event: WheelEvent): void {
      // 仅当视口真的消费了这次滚轮（换档或平移产生状态变化）才拦截默认行为
      if (
        viewport.applyWheel({
          ctrlKey: event.ctrlKey || event.metaKey,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        })
      ) {
        event.preventDefault()
      }
    }
    element.addEventListener('wheel', handleNativeWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', handleNativeWheel)
    }
  }, [viewport, selectedMap?.id])

  // 编辑输入自动聚焦并全选（进编辑即覆盖重写，与 xmind 手感一致）。
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const element = inputRef.current
    if (element === null) return
    element.focus()
    element.select()
  }, [editingNodeId])

  // overlay 输入框定位需要节点矩形；被折叠藏掉的节点不渲染输入框（模型里没有它的视图）。
  const editingView =
    editingNodeId === null || model === null
      ? null
      : model.nodes.find((candidate) => candidate.id === editingNodeId) ?? null

  // T48 终审修复轮（Critical）· 幽灵编辑态兜底：编辑态存在但目标节点不在显示模型里 = 输入框
  // 不会渲染，而 handleRootKeyDown 的「编辑中」早退又排在 Escape 分支之前——键盘整条死掉，
  // 直到换图或鼠标点开才恢复。这里主动解除，键位表立刻回生活。
  // （F2 落在被折叠藏起的节点上就是这条路径：编辑态被解除，不落任何写入。）
  // 守卫只认「数据树里查得到、显示模型里查不到」的目标：树里也查不到 = vault 快照还在途
  // （视图刚 bus.apply 完、新节点还没顺着 props 传进来），那一刻清编辑态会把「加子即进编辑」抹平。
  useEffect(() => {
    if (editingNodeId === null || editingView !== null) return
    if (selectedMap === null) return // 图刚被删/空库：resetMapLocalState 那条 effect 负责整体复位
    if (findNode(selectedMap.root, editingNodeId) !== null) setEditing(null)
  }, [editingNodeId, editingView, selectedMap, setEditing])

  // 预填走 vault 数据树里的未截断原文（模型 text 已被 MINDMAP_MAX_TEXT_WIDTH 截断）。
  const editingRawText =
    editingNodeId === null || selectedMap === null
      ? ''
      : findNode(selectedMap.root, editingNodeId)?.text ?? ''

  return (
    <div
      ref={rootRef}
      data-testid="mindmap"
      tabIndex={0}
      role="application"
      aria-label={t('shell.viewMindmap')}
      onKeyDown={handleRootKeyDown}
      onPointerDownCapture={handleRootPointerDownCapture}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        height: '100%',
        minHeight: 0,
        background: 'var(--oe-surface)',
        color: TEXT,
        fontFamily: BODY_FONT,
        outline: 'none',
        position: 'relative',
        ...props.style,
      }}
    >
      {selectedMap === null || model === null ? (
        <MindMapEmptyCard t={t} onCreate={handleCreate} />
      ) : (
        <>
          <div
            data-testid="mindmap-toolbar"
            style={{
              height: TOOLBAR_HEIGHT,
              flex: `0 0 ${TOOLBAR_HEIGHT}px`,
              display: 'flex',
              alignItems: 'center',
              gap: sp(8),
              padding: px('0 12px'),
              borderBottom: '1px solid var(--oe-separator)',
              boxSizing: 'border-box',
            }}
          >
            {/* 图切换：数组序即显示序（T42 尾插口径下数组序 = order 升序），显示 name。 */}
            <select
              data-testid="mindmap-select"
              aria-label={t('shell.viewMindmap')}
              value={selectedMap.id}
              onChange={(event) => {
                // T45 遗留修复（T46 落地）：切图必须清选中/编辑，选中 id 属于旧图的树。
                // T47 修复轮起复位由 selectedMap.id 的 effect 单点承担（切图 / 新建 / 外部改动
                // 导致选中换图，走同一条路），这里只改选中。
                setSelectedMapId(event.target.value)
              }}
              style={selectStyle}
            >
              {maps.map((map) => (
                <option key={map.id} value={map.id}>
                  {map.name}
                </option>
              ))}
            </select>
            <button type="button" data-testid="mindmap-create" onClick={handleCreate} style={chipStyle}>
              {t('mindmap.create')}
            </button>
            {/* T47 · 重命名：点钮切 inline input（Enter/blur 提交、Esc 取消、空 trim 不提交）。 */}
            {renaming ? (
              <input
                ref={renameInputRef}
                type="text"
                data-testid="mindmap-rename-input"
                aria-label={t('mindmap.renameMap')}
                defaultValue={selectedMap.name}
                style={renameInputStyle}
                onKeyDown={(event) => {
                  // IME 组词期间的 Enter = 上屏候选词，不提交（与节点编辑 overlay 同一守卫）
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitRename(event.currentTarget.value)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    exitRename()
                  }
                }}
                onBlur={(event) => commitRename(event.currentTarget.value)}
              />
            ) : (
              <button type="button" data-testid="mindmap-rename-map" onClick={enterRename} style={chipStyle}>
                {t('mindmap.renameMap')}
              </button>
            )}
            {/* T47 · 删除：两段确认，首点只切文案并记住 armed 图 id（外点复位见 handleRootPointerDownCapture，
                换图复位见 selectedMap.id 的 effect；armed ≠ 当前图时二次点击只会重新布防，不会误删）。 */}
            <button type="button" data-testid="mindmap-delete-map" onClick={handleDeleteMap} style={chipStyle}>
              {t(deleteConfirmingFor === selectedMap.id ? 'mindmap.deleteConfirm' : 'mindmap.deleteMap')}
            </button>
            <span style={{ flex: 1, minWidth: sp(8) }} />
            {/* T47 · 全部折叠/展开：单 toggle 走视图本地 foldAll 态，不写库、零 undo。 */}
            <button
              type="button"
              data-testid="mindmap-fold-all"
              onClick={() => {
                setFoldAllView((value) => !value)
              }}
              style={chipStyle}
            >
              {t(foldAllView ? 'mindmap.unfoldAll' : 'mindmap.foldAll')}
            </button>
            <button type="button" data-testid="mindmap-fit" onClick={handleFit} style={chipStyle}>
              {t('mindmap.fit')}
            </button>
            {/* T48 · 导出反馈（成功/失败）与 PNG 不可用的说明放在弹层内靠近该格式处（甘特同款） */}
            {exportHint === null ? null : (
              <span
                data-testid="mindmap-export-hint"
                style={{ fontSize: fs(12), color: TEXT_MUTED, maxWidth: sp(180), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {exportHint}
              </span>
            )}
            {/* T48 · 导出入口：格式 PNG/SVG × 范围 仅可见区/全图（弹层交互与文案键复用甘特）。 */}
            <div ref={exportMenuRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <button
                type="button"
                data-testid="mindmap-export-button"
                aria-label={t('ganttExport.button')}
                aria-haspopup="dialog"
                aria-expanded={exportMenuOpen}
                onClick={() => setExportMenuOpen((open) => !open)}
                style={iconButtonStyle}
              >
                <Icon name="download" />
              </button>

              {exportMenuOpen ? (
                <div
                  data-testid="mindmap-export-menu"
                  role="dialog"
                  aria-label={t('ganttExport.button')}
                  style={{
                    position: 'absolute',
                    top: sp(26),
                    right: 0,
                    zIndex: 5,
                    width: sp(198),
                    display: 'flex',
                    flexDirection: 'column',
                    gap: sp(8),
                    padding: sp(10),
                    boxSizing: 'border-box',
                    background: 'var(--oe-surface)',
                    border: '1px solid var(--oe-separator)',
                    borderRadius: 'var(--oe-radius-card)',
                    boxShadow: 'var(--oe-shadow-hover)',
                    color: TEXT,
                  }}
                >
                  <div style={{ fontSize: fs(12), color: TEXT_MUTED }}>{t('ganttExport.format')}</div>
                  <div role="radiogroup" aria-label={t('ganttExport.format')} style={{ display: 'flex', gap: sp(6) }}>
                    {EXPORT_FORMAT_ORDER.map((format) => {
                      const disabled = format === 'png' && pngSupported === false
                      return (
                        <button
                          key={format}
                          type="button"
                          role="radio"
                          aria-checked={exportFormat === format}
                          data-testid={`mindmap-export-format-${format}`}
                          disabled={disabled}
                          onClick={() => setExportFormat(format)}
                          style={{
                            ...exportChipStyle,
                            ...(exportFormat === format ? exportChipActiveStyle : null),
                            ...(disabled ? exportChipDisabledStyle : null),
                          }}
                        >
                          {t(EXPORT_FORMAT_LABEL[format])}
                        </button>
                      )
                    })}
                  </div>

                  <div style={{ fontSize: fs(12), color: TEXT_MUTED }}>{t('ganttExport.range')}</div>
                  <div role="radiogroup" aria-label={t('ganttExport.range')} style={{ display: 'flex', gap: sp(6) }}>
                    {EXPORT_RANGE_ORDER.map((range) => (
                      <button
                        key={range}
                        type="button"
                        role="radio"
                        aria-checked={exportRange === range}
                        data-testid={`mindmap-export-range-${range}`}
                        onClick={() => setExportRange(range)}
                        style={{ ...exportChipStyle, ...(exportRange === range ? exportChipActiveStyle : null) }}
                      >
                        {t(EXPORT_RANGE_LABEL[range])}
                      </button>
                    ))}
                  </div>

                  {pngSupported === false ? (
                    <div data-testid="mindmap-export-png-hint" style={{ fontSize: fs(11), lineHeight: 1.45, color: 'var(--oe-blocked)' }}>
                      {t('mindmap.exportPngUnsupported')}
                    </div>
                  ) : null}

                  <div style={{ display: 'flex', gap: sp(6), justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      data-testid="mindmap-export-cancel"
                      onClick={() => setExportMenuOpen(false)}
                      style={exportChipStyle}
                    >
                      {t('ganttExport.cancel')}
                    </button>
                    <button
                      type="button"
                      data-testid="mindmap-export-confirm"
                      disabled={exportDisabled}
                      onClick={handleExportConfirm}
                      style={{
                        ...exportChipStyle,
                        ...exportChipActiveStyle,
                        ...(exportDisabled ? exportChipDisabledStyle : null),
                      }}
                    >
                      {exporting ? t('safemode.busy') : t('ganttExport.confirm')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          {/* 画布表面：wheel 原生监听 + 空白拖拽平移的宿主；relative 承载编辑 overlay 的绝对定位。 */}
          <div
            ref={surfaceRef}
            data-testid="mindmap-viewport"
            style={{ flex: 1, minHeight: 0, position: 'relative', touchAction: 'none' }}
            onPointerDown={handleSurfacePointerDown}
            onPointerMove={handleSurfacePointerMove}
            onPointerUp={handleSurfacePointerUp}
            onPointerCancel={handleSurfacePointerCancel}
          >
            <MindMapCanvas
              model={model}
              panX={state.panX}
              panY={state.panY}
              zoom={zoom}
              selectedId={selectedNodeId}
              editingId={editingNodeId}
              draggingId={nodeDrag === null ? null : nodeDrag.nodeId}
              dropTargetId={nodeDrag === null ? null : nodeDrag.targetId}
              onSelect={handleSelect}
              onToggleFold={(nodeId) => {
                if (selectedMap !== null) applyToggleFold(bus, vault, selectedMap.id, nodeId)
              }}
              onEdit={startEdit}
            />
            {editingView === null ? null : (
              <input
                // key：同一节点二次进编辑也要重挂，defaultValue 才会重新读原文
                key={editingView.id}
                ref={inputRef}
                type="text"
                data-testid="mindmap-input"
                data-mindmap-input={editingView.id}
                aria-label={t('mindmap.renameNode')}
                defaultValue={editingRawText}
                // 与 <g transform="translate(pan) scale(zoom)"> 同一投影：screen = content*zoom + pan
                style={{
                  position: 'absolute',
                  left: editingView.x * zoom + state.panX,
                  top: editingView.y * zoom + state.panY,
                  width: editingView.width * zoom,
                  height: editingView.height * zoom,
                  // 缩到 12px 以下就钳住并 overflow hidden——「块可见」降级，xmind 同款
                  fontSize: Math.max(12, MINDMAP_FONT_SIZE * uiScale * zoom),
                  overflow: 'hidden',
                  boxSizing: 'border-box',
                  margin: 0,
                  padding: px('0 4px'),
                  color: TEXT,
                  background: 'var(--oe-surface)',
                  border: '1px solid var(--oe-accent-deep)',
                  borderRadius: 'var(--oe-radius-control)',
                  fontFamily: 'inherit',
                  outline: 'none',
                }}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={() => {
                  composingRef.current = false
                }}
                // 在输入框里按下不牵动画布：选中文字的操作不该变成拖拽
                onPointerDown={(event) => {
                  event.stopPropagation()
                }}
                onKeyDown={(event) => {
                  // IME：组词期间的 Enter 是上屏候选词，绝不提交——isComposing 标志 +
                  // compositionstart/end 驱动的 ref 双保险（React 19 synthetic 不透传 isComposing）
                  if (event.nativeEvent.isComposing || composingRef.current) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation() // 别让 Enter 再触到根容器的「加同级」
                    finishEditing(true, event.currentTarget.value)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation() // Escape 只退编辑；再按一次才轮到根容器清选中
                    finishEditing(false, '')
                  }
                }}
                // 三路收尾之一（Step 2 裁决）：blur 提交——点空白 / Tab 切走焦点都不丢字
                onBlur={(event) => {
                  if (editingRef.current !== editingNodeId) return // Enter/Esc 已收尾，卸载竞态跳过
                  finishEditing(true, event.target.value)
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** 空库引导卡：一句标题 + 一句说明 + 一个新建按钮（唯一的 T45 写入口）。 */
function MindMapEmptyCard(props: { t: Translate; onCreate: () => void }): ReactElement {
  return (
    <div data-testid="mindmap-empty" style={{ flex: 1, display: 'grid', placeItems: 'center', padding: sp(24) }}>
      <div style={{ maxWidth: sp(360), textAlign: 'center' }}>
        <div style={{ fontSize: fs(14), fontWeight: 600, color: TEXT }}>{props.t('mindmap.emptyTitle')}</div>
        <p style={{ margin: px('8px 0 16px'), fontSize: fs(12), lineHeight: 1.6, color: TEXT_MUTED }}>
          {props.t('mindmap.emptyHint')}
        </p>
        <button type="button" data-testid="mindmap-create" onClick={props.onCreate} style={chipStyle}>
          {props.t('mindmap.create')}
        </button>
      </div>
    </div>
  )
}

const selectStyle: CSSProperties = {
  height: sp(24),
  padding: px('0 6px'),
  fontSize: fs(12),
  color: TEXT,
  background: 'var(--oe-fill)',
  border: '1px solid var(--oe-separator)',
  borderRadius: 'var(--oe-radius-control)',
  fontFamily: 'inherit',
}

/** 图重命名 inline input：与 select 同族外观，宽度给到能看清中长图名。 */
const renameInputStyle: CSSProperties = {
  ...selectStyle,
  width: sp(160),
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
}

/** 导出入口的图标钮（GanttView 同款尺寸，两套工具栏节奏对齐）。 */
const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: sp(26),
  height: sp(24),
  padding: 0,
  fontSize: fs(12),
  color: TEXT,
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

// T48 导出弹层的选项 chip（格式 / 范围 / 取消 / 导出共用一套，甘特同款）
const exportChipStyle: CSSProperties = {
  padding: px('2px 8px'),
  fontSize: fs(12),
  lineHeight: px('18px'),
  color: TEXT,
  background: 'var(--oe-fill)',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

const exportChipActiveStyle: CSSProperties = {
  color: 'var(--oe-on-accent)',
  background: INDIGO,
}

const exportChipDisabledStyle: CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
}

export default MindMapView
