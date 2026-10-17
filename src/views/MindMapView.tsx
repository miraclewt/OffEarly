// T45 · MindMapView：思维导图视图宿主（画布投影 + tab 接线，只读渲染）。
//
// 结构逐条照 GanttView：本地 viewport（只建一次，useSyncExternalStore 订阅）、
// 工具条高度 36、ResizeObserver 测量 → setViewportSize；数据流是
// vault.mindmaps ──(选中一张图)──▶ buildMindMapModel ──▶ MindMapCanvas。
//
// 状态边界（spec 裁决）：选中图 / 选中节点 / 编辑态全部留本地 state，不进 vault、不进 App；
// selectedMapId 为 null 或选中图已被删除时回退表首（数组序即显示序，T42 尾插口径保证
// 数组序 = order 升序）。事件时刻读 vault prop（每次渲染都是新快照），不摸 store.getVault()。
//
// 只读边界（T45）：本视图唯一的写入口是空态/工具条的「新建」（applyCreateMap），
// 折叠徽标、就地编辑、拖拽、平移缩放的交互都在 T46/T47 接线——canvas 的
// onToggleFold / editingId 两条缝已就位，这里刻意不传处理器。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'

import { createMindmapViewport, mindmapZoomFactorAt } from '../controllers/mindmapViewport'
import type { MindMapViewportController } from '../controllers/mindmapViewport'
import { applyCreateMap } from '../controllers/mindmapActions'
import { buildMindMapModel } from '../domain/mindmapModel'
import type { CommandBus } from '../domain/commandBus'
import type { Vault } from '../domain/types'
import { createI18n } from '../locales/i18n'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { MindMapCanvas } from './MindMapCanvas'

type Translate = (key: MsgKey, params?: TranslateParams) => string

const TEXT = 'var(--oe-text)'
const TEXT_MUTED = 'var(--oe-text-muted)'
const BODY_FONT = 'var(--oe-font)'
/** 工具条高度与甘特一致（36），两套视图的横向节奏对齐。 */
const TOOLBAR_HEIGHT = 36

/** 兜底文案表：与 GanttView 同款，测试或未接线场景也能独立挂载（不依赖 navigator.language）。 */
const fallbackI18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })

export interface MindMapViewProps {
  vault: Vault
  /** 写入口（T10 CommandBus，可能包了只读闸门）；T45 只用来 applyCreateMap。 */
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

  // 选中图：null = 「用户没选过」→ 回退表首；选中图被删后 find 落空，同样回退表首。
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // T46 就地编辑会持有这个；T45 只读——恒 null，但把它投给 canvas 以固化渲染分支。
  const [editingNodeId] = useState<string | null>(null)

  const maps = vault.mindmaps
  const selectedMap = useMemo(() => {
    if (maps.length === 0) return null
    return maps.find((map) => map.id === selectedMapId) ?? maps[0] ?? null
  }, [maps, selectedMapId])

  const model = useMemo(
    () => (selectedMap === null ? null : buildMindMapModel(selectedMap)),
    [selectedMap],
  )

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
        height: Math.max(0, box.height - TOOLBAR_HEIGHT),
      })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [viewport])

  /** 建图并选中新图（空态引导卡与工具条共用；vault 事件时刻现值，deps 缺省 id/时钟走 nanoid/Date）。 */
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

  const handleSelect = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
  }, [])

  const zoom = mindmapZoomFactorAt(state.zoomIndex)

  return (
    <div
      ref={rootRef}
      data-testid="mindmap"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        height: state.height + TOOLBAR_HEIGHT,
        background: 'var(--oe-surface)',
        color: TEXT,
        fontFamily: BODY_FONT,
        outline: 'none',
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
              gap: 8,
              padding: '0 12px',
              borderBottom: '1px solid var(--oe-separator)',
              boxSizing: 'border-box',
            }}
          >
            {/* 图切换：数组序即显示序（T42 尾插口径下数组序 = order 升序），显示 name。 */}
            <select
              data-testid="mindmap-select"
              aria-label={t('shell.viewMindmap')}
              value={selectedMap.id}
              onChange={(event) => setSelectedMapId(event.target.value)}
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
            <span style={{ flex: 1, minWidth: 8 }} />
            <button type="button" data-testid="mindmap-fit" onClick={handleFit} style={chipStyle}>
              {t('mindmap.fit')}
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <MindMapCanvas
              model={model}
              panX={state.panX}
              panY={state.panY}
              zoom={zoom}
              selectedId={selectedNodeId}
              editingId={editingNodeId}
              onSelect={handleSelect}
            />
          </div>
        </>
      )}
    </div>
  )
}

/** 空库引导卡：一句标题 + 一句说明 + 一个新建按钮（唯一的 T45 写入口）。 */
function MindMapEmptyCard(props: { t: Translate; onCreate: () => void }): ReactElement {
  return (
    <div data-testid="mindmap-empty" style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ maxWidth: 360, textAlign: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>{props.t('mindmap.emptyTitle')}</div>
        <p style={{ margin: '8px 0 16px', fontSize: 12, lineHeight: 1.6, color: TEXT_MUTED }}>
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
  height: 24,
  padding: '0 6px',
  fontSize: 12,
  color: TEXT,
  background: 'var(--oe-fill)',
  border: '1px solid var(--oe-separator)',
  borderRadius: 'var(--oe-radius-control)',
  fontFamily: 'inherit',
}

const chipStyle: CSSProperties = {
  padding: '2px 10px',
  fontSize: 12,
  lineHeight: '20px',
  color: TEXT,
  background: 'var(--oe-fill)',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

export default MindMapView
