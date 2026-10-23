// T15 · BoardView：看板主视图（spec 6.1）。
//
// 数据流（依赖只向下）：vault + filter ──QueryEngine──▶ 可见任务集 ──分列──▶ 四列卡片。
// 看板与甘特图共用同一份 filter（spec 6.2），筛选状态由外部（集成窗口 / T16 FilterBar）
// 算好传入；本组件只消费，不持有筛选状态。归档任务由 QueryEngine 默认排除。
//
// 拖拽（dnd-kit）：跨列改 status、同列改 order（LexoRank 中点插入）。
// 判定逻辑全部在 controllers/boardDnd.ts 的纯函数里，这里只把 onDragEnd 事件
// 归一化成 BoardDrop 再 applyBoardDrop——jsdom 下 pointer 手势不可靠复刻，
// 单测直接打纯函数与渲染结构（见 tests/views/BoardView.test.tsx）。
//
// 可挂载性（分支约定第 4 条）：导出默认组件 + 显式 props，vault / filter / bus / t /
// onOpenTask 全部由外部传入，不读 store、不改 App.tsx。根元素保留
// data-testid="board"（与替换掉的 EmptyBoard 占位一致，E2E 依赖它）。
//
// 未接线边界：TaskDrawer（T17）只经 onOpenTask 回调暴露；FilterBar（T16）不 import。
// 列内新建（T34）同样只外送 (status, title)——命令由接线方（App 的 Workspace）用实时库构造，
// 本组件不读 store、也不需要知道 taskCreate 的存在。

import { useCallback, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import { DndContext, PointerSensor, closestCorners, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'

import { applyBoardDrop, isAboveCenter, sortByOrder } from '../controllers/boardDnd'
import type { BoardDrop } from '../controllers/boardDnd'
import { BoardColumn } from './BoardColumn'
import { fs, px, sp } from '../styles/scale'
import { createDependencyGraph } from '../domain/dependencyGraph'
import { createEmptyFilter, createQueryEngine, localDateKey } from '../domain/queryEngine'
import type { CommandBus } from '../domain/commandBus'
import type { Filter, Status, Task, Vault } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'

/** 固定四列（Global Constraints / spec 12 非目标：看板列不可自定义）。 */
const BOARD_COLUMNS: readonly Status[] = ['todo', 'doing', 'review', 'done']

/** 指针拖动超过 6px 才判定为拖拽；否则视为点击（打开详情）。 */
const DRAG_ACTIVATION_DISTANCE = 6

const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'

export interface BoardViewProps {
  vault: Vault
  /** 外部算好的筛选条件；省略按空筛选（看板默认无筛选）。 */
  filter?: Filter
  /** 写入口（T10 CommandBus，可能包了 T29 只读闸门）。 */
  bus: CommandBus
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 点击卡片（T17 TaskDrawer 接线点）。 */
  onOpenTask?: (taskId: string) => void
  /**
   * 列内新建任务：列底「+ 新建任务」提交时外送 (列 status, 标题)。
   * 命令构造交给上层（App 的 Workspace 用 store.getVault() 读**实时**库来算排序键，
   * 连续录入时不会拿渲染快照算重 key）；省略即视为不可创建（只渲染 createHint 灰行）。
   */
  onCreateTask?: (status: Status, title: string) => void
  /** 不可创建时的说明（库里没有未归档话题）。 */
  createHint?: string
  /**
   * 空库引导（T52）：一个未归档话题都没有时，看板顶部渲染「新建话题」主按钮。
   * 此前这种情况下四列各重复一行灰字，新用户找不到任何可点的入口。
   * 省略即不渲染引导（组件仍可独立挂载）。
   */
  onCreateTopic?: () => void
  /** 判定逾期的今天（YYYY-MM-DD）；省略取本地当天，测试注入以确定化。 */
  today?: string
  style?: CSSProperties
}

export function BoardView(props: BoardViewProps) {
  const { vault, bus, t } = props
  // 省略 filter 时按空筛选；useMemo 保证引用稳定，否则每次渲染都会重建查询
  const filter = useMemo(() => props.filter ?? createEmptyFilter(), [props.filter])
  const today = props.today ?? localDateKey(new Date())

  // 筛选结果驱动列内容（QueryEngine 默认排除归档任务）
  const engine = useMemo(
    () => createQueryEngine(vault.topics, vault.tasks, vault.links, { today }),
    [vault.topics, vault.tasks, vault.links, today],
  )
  const visible = useMemo(() => engine.query(filter), [engine, filter])

  // 阻塞标记与依赖角标都来自 T12 的 DependencyGraph（派生数据不落盘）
  const graph = useMemo(() => createDependencyGraph(vault.links, vault.tasks), [vault.links, vault.tasks])
  const blockedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const task of visible) {
      if (task.status !== 'doing' && task.status !== 'review') continue
      if (graph.isBlocked(task.id)) ids.add(task.id)
    }
    return ids
  }, [visible, graph])
  const dependencyCountById = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of visible) counts.set(task.id, graph.blockedBy(task.id).length)
    return counts
  }, [visible, graph])
  const topicsById = useMemo(
    () => new Map(vault.topics.map((topic) => [topic.id, topic])),
    [vault.topics],
  )

  const columns = useMemo(() => {
    const byStatus = new Map<Status, Task[]>()
    for (const status of BOARD_COLUMNS) byStatus.set(status, [])
    for (const task of visible) {
      const bucket = byStatus.get(task.status)
      if (bucket !== undefined) bucket.push(task)
    }
    for (const status of BOARD_COLUMNS) byStatus.set(status, sortByOrder(byStatus.get(status)!))
    return byStatus
  }, [visible])

  // 拖拽结束后的 click 抑制：pointerdown/pointerup 跨卡片时 click 落在公共容器上，
  // 但同卡内误放仍会触发 click；用一次性标记挡掉，避免拖完莫名打开弹窗
  const suppressClickRef = useRef(false)
  function clearSuppressClick(): void {
    setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }),
  )

  function handleDragStart(_event: DragStartEvent): void {
    suppressClickRef.current = true
  }

  // TaskCard 是 memo 的：这个回调若每次渲染都换引用，memo 就白做了
  const openTask = useCallback(
    (taskId: string) => {
      if (suppressClickRef.current) return
      props.onOpenTask?.(taskId)
    },
    [props.onOpenTask],
  )

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    if (over === null || over.id === active.id) {
      clearSuppressClick()
      return
    }

    const draggedId = String(active.id)
    const overId = String(over.id)

    let drop: BoardDrop
    const columnData = over.data.current
    if (columnData !== undefined && columnData.type === 'column') {
      // 落到列内空白处：列尾（含空列）
      drop = { draggedId, targetStatus: columnData.status as Status, position: 'end', overId: null }
    } else {
      // 落到某张卡片上：目标列即该卡所在列，上下位置由指针与卡片中心的几何关系决定
      const overTask = vault.tasks.find((task) => task.id === overId)
      if (overTask === undefined) {
        clearSuppressClick()
        return
      }
      const translated = active.rect.current.translated
      const position = translated !== null && isAboveCenter(translated, over.rect) ? 'above' : 'below'
      drop = { draggedId, targetStatus: overTask.status, position, overId }
    }

    try {
      applyBoardDrop(bus, vault, drop)
    } finally {
      clearSuppressClick()
    }
  }

  function handleDragCancel(): void {
    clearSuppressClick()
  }

  // 引导与列底的灰行是同一件事的两种说法：有引导时不再让四列各重复一遍
  const showGuide = props.onCreateTopic !== undefined && props.onCreateTask === undefined

  return (
    <DndContext
      sensors={sensors}
      // 多容器排序官方推荐 closestCorners：指针贴近某张卡片即算落在那张卡片上，
      // 只有落到列内空白才解析到列 droppable（列尾）
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        data-testid="board"
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          boxSizing: 'border-box',
          ...props.style,
        }}
      >
        {showGuide ? (
          <div
            data-testid="board-guide"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: sp(12),
              margin: `${sp(16)} ${sp(16)} 0`,
              padding: `${sp(12)} ${sp(14)}`,
              background: 'var(--oe-surface)',
              border: '1px solid var(--oe-card-border)',
              borderRadius: 'var(--oe-radius-card)',
              boxShadow: 'var(--oe-shadow-card)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: fs(13), fontWeight: 600, color: TEXT }}>{t('boardGuide.noTopicTitle')}</div>
              <div style={{ fontSize: fs(12), color: MUTED, marginTop: sp(2) }}>{t('boardGuide.noTopicHint')}</div>
            </div>
            <button
              type="button"
              data-testid="board-create-topic"
              onClick={() => {
                props.onCreateTopic?.()
              }}
              style={{
                flex: '0 0 auto',
                padding: px('6px 14px'),
                fontSize: fs(13),
                fontWeight: 600,
                color: 'var(--oe-on-accent)',
                background: 'var(--oe-accent)',
                border: 'none',
                borderRadius: 'var(--oe-radius-control)',
                cursor: 'pointer',
              }}
            >
              {t('boardGuide.createTopic')}
            </button>
          </div>
        ) : null}

        <div
          style={{
            display: 'flex',
            gap: sp(12),
            padding: sp(16),
            flex: 1,
            minHeight: 0,
            boxSizing: 'border-box',
          }}
        >
          {BOARD_COLUMNS.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              title={t(`status.${status}`)}
              tasks={columns.get(status) ?? []}
              topicsById={topicsById}
              blockedIds={blockedIds}
              dependencyCountById={dependencyCountById}
              today={today}
              t={t}
              onOpenTask={openTask}
              // 列底新建：把 status 绑进回调，列组件只管「回车提交了标题」
              onCreateTask={
                props.onCreateTask === undefined
                  ? undefined
                  : (title: string) => props.onCreateTask?.(status, title)
              }
              createHint={showGuide ? undefined : props.createHint}
            />
          ))}
        </div>
      </div>
    </DndContext>
  )
}

export default BoardView
