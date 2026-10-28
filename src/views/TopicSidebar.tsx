// T14 · TopicSidebar：话题树（无限层）+ CRUD + 归档 + 里程碑/筛选器/备份/设置四入口
// （spec 6.5 topic 管理、6.1 话题标识色语言、§7 视觉规范）。
//
// 分层边界：视图只渲染 + 转发事件，不碰文件系统；所有写操作经 controllers/topicActions
// （它内部写唯一状态源与 CommandBus）。组件不持有领域状态——展开态是纯 UI 态，
// 话题数据与当前筛选一律从 VaultStore 派生，避免出现第二份真相。
//
// 底部四入口只提供**可点击的按钮 + 回调 props**：里程碑面板（T18）、筛选栏（T16）、
// 备份面板（T28）尚未实现，面板挂载由集成窗口接线，这里不 import 任何尚不存在的组件。
//
// 视觉：色块 swatch 与 T15 卡片色点共用同一套话题色（读 topic.color）；图标走 inline SVG sprite；
// 圆角 6–8px、无渐变、无 emoji。

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useStore } from 'zustand'

import { TOPIC_PALETTE, createTopicActions } from '../controllers/topicActions'
import type { TopicActions } from '../controllers/topicActions'
import type { CommandBus } from '../domain/commandBus'
import type { VaultStore } from '../domain/store'
import { createTopicTree } from '../domain/topicTree'
import type { Topic } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { Icon } from './IconSprite'
import type { IconName } from './IconSprite'
import { currentUiScale, fs, px, sp } from '../styles/scale'

const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'
const INDIGO = 'var(--oe-accent)'
const ROW_HOVER = 'var(--oe-row-selected)'
const ARCHIVED_TEXT = 'var(--oe-text-faint)'

/** 默认展开的层数：0 表示「根层展开」——可见根与它的直接子话题，共两层（spec 4.2「UI 默认展示两层」）。 */
const DEFAULT_EXPANDED_DEPTH = 0

/** 每层的缩进像素。 */
const INDENT = 14

/**
 * 右键菜单的估算盒子（T52）：`minWidth: 132`、四个菜单项各约 30px 高、外框内边距 8px。
 * 菜单是 fixed 定位，直接落在 clientX/clientY 上，贴着窗口右下角右键就会整个跑到视口外。
 * 这里在打开时钳制一次——用估算值而不是「渲染后测量再回移」，后者会看到一次跳动。
 */
const MENU_WIDTH = 132
const MENU_HEIGHT = 4 * 30 + 8
const MENU_MARGIN = 8

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  const scale = currentUiScale()
  const viewportW = typeof window === 'undefined' ? 0 : window.innerWidth
  const viewportH = typeof window === 'undefined' ? 0 : window.innerHeight
  const maxX = Math.max(MENU_MARGIN, viewportW - MENU_WIDTH * scale - MENU_MARGIN)
  const maxY = Math.max(MENU_MARGIN, viewportH - MENU_HEIGHT * scale - MENU_MARGIN)
  return {
    x: Math.min(Math.max(MENU_MARGIN, x), maxX),
    y: Math.min(Math.max(MENU_MARGIN, y), maxY),
  }
}

/** 话题树的一行（按显示顺序拍平后供键盘导航用）。 */
interface TopicRow {
  topic: Topic
  depth: number
  hasChildren: boolean
  expanded: boolean
}

export interface TopicSidebarProps {
  store: VaultStore
  bus: CommandBus
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 底部入口；面板尚未实现（T16/T18/T28/T64），由集成窗口接线。 */
  onOpenMilestones?: () => void
  onOpenFilters?: () => void
  onOpenBackup?: () => void
  onOpenSettings?: () => void
  /** T64：回收站（任务与笔记）。 */
  onOpenTrash?: () => void
  style?: CSSProperties
}

type Editing = { mode: 'rename'; topicId: string } | { mode: 'create'; parentId: string | null }

interface BottomEntry {
  id: string
  icon: IconName
  label: string
  onClick?: (() => void) | undefined
}

export function TopicSidebar(props: TopicSidebarProps) {
  const { store, bus, t } = props

  const vault = useStore(store, (state) => state.vault)
  const actions: TopicActions = useMemo(() => createTopicActions({ store, bus }), [store, bus])
  const tree = useMemo(() => createTopicTree(vault.topics), [vault.topics])

  /** 展开态是纯 UI 态；未出现过的行按 DEFAULT_EXPANDED_DEPTH 决定默认值。 */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number } | null>(null)
  const [paletteFor, setPaletteFor] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  /** 归档话题连整棵子树一起从树里收起；它们靠「显示已归档」找回。 */
  const hidden = useMemo(() => {
    const ids = new Set<string>()
    if (showArchived) return ids
    for (const topic of vault.topics) {
      if (!topic.archived) continue
      for (const id of tree.subtreeIds(topic.id)) ids.add(id)
    }
    return ids
  }, [vault.topics, tree, showArchived])

  /** 行上的计数 = 该话题子树内**未归档**任务数（归档的不计入，避免数字与看板不一致）。 */
  const countOf = useMemo(() => {
    const perTopic = new Map<string, number>()
    for (const task of vault.tasks) {
      if (task.archived) continue
      perTopic.set(task.topicId, (perTopic.get(task.topicId) ?? 0) + 1)
    }
    return (topicId: string): number =>
      tree.subtreeIds(topicId).reduce((sum, id) => sum + (perTopic.get(id) ?? 0), 0)
  }, [vault.tasks, tree])

  const selectedIds = vault.settings.lastFilter?.topicIds ?? []

  /** 可见行的拍平序列（深度优先，只含展开了的行）：键盘上下移动与 roving tabindex 共用。 */
  const rows = useMemo(() => {
    const out: TopicRow[] = []
    const walk = (topic: Topic, depth: number): void => {
      const children = tree.childrenOf(topic.id).filter((child) => !hidden.has(child.id))
      const expanded = overrides[topic.id] ?? depth === DEFAULT_EXPANDED_DEPTH
      out.push({ topic, depth, hasChildren: children.length > 0, expanded })
      if (!expanded) return
      for (const child of children) walk(child, depth + 1)
    }
    for (const root of tree.roots()) {
      if (!hidden.has(root.id)) walk(root, 0)
    }
    return out
  }, [tree, hidden, overrides])

  const rowIndexById = useMemo(() => new Map(rows.map((row, index) => [row.topic.id, index])), [rows])
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const [focusId, setFocusId] = useState<string | null>(null)
  // roving tabindex：整棵树只占一个 Tab 停靠点，进树之后靠方向键走（WAI-ARIA tree 的标准做法）。
  // focusId 指向的行已经不可见（被收起 / 归档）时回落到第一行，否则 Tab 会掉进虚空。
  const activeRowId = focusId !== null && rowIndexById.has(focusId) ? focusId : rows[0]?.topic.id ?? null

  function focusRow(id: string | null): void {
    if (id === null) return
    setFocusId(id)
    rowRefs.current.get(id)?.focus()
  }

  /** 方向键导航（T52）：↑↓ 换行、→ 展开或进子行、← 收起或回父行、Enter/Space 切换筛选。 */
  function handleRowKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, row: TopicRow, index: number): void {
    const move = (delta: number): void => {
      event.preventDefault()
      focusRow(rows[index + delta]?.topic.id ?? null)
    }
    switch (event.key) {
      case 'ArrowDown':
        move(1)
        return
      case 'ArrowUp':
        move(-1)
        return
      case 'Home':
        event.preventDefault()
        focusRow(rows[0]?.topic.id ?? null)
        return
      case 'End':
        event.preventDefault()
        focusRow(rows[rows.length - 1]?.topic.id ?? null)
        return
      case 'ArrowRight':
        event.preventDefault()
        if (row.hasChildren && !row.expanded) {
          setOverrides((prev) => ({ ...prev, [row.topic.id]: true }))
        } else if (row.expanded) {
          focusRow(rows[index + 1]?.topic.id ?? null)
        }
        return
      case 'ArrowLeft':
        event.preventDefault()
        if (row.hasChildren && row.expanded) {
          setOverrides((prev) => ({ ...prev, [row.topic.id]: false }))
        } else if (row.topic.parentId !== null) {
          focusRow(row.topic.parentId)
        }
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        actions.toggleTopicFilter(row.topic.id)
        return
      default:
    }
  }

  // Esc 关闭右键菜单 / 调色板（T52）：此前只有「点遮罩」一条出路，
  // 而遮罩盖住整页——用户按 Esc 完全没反应，只能去点一下别处。
  useEffect(() => {
    if (menuFor === null && paletteFor === null) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      setMenuFor(null)
      setPaletteFor(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuFor, paletteFor])

  function closeOverlays(): void {
    setMenuFor(null)
    setPaletteFor(null)
  }

  function commitEditing(raw: string): void {
    if (editing === null) return
    const trimmed = raw.trim()
    const name = trimmed === '' ? t('sidebar.untitled') : trimmed
    if (editing.mode === 'rename') {
      actions.renameTopic(editing.topicId, name)
    } else {
      actions.createTopic(editing.parentId, name)
      // 新建的子话题要当场看得见
      if (editing.parentId !== null) {
        const parentId = editing.parentId
        setOverrides((prev) => ({ ...prev, [parentId]: true }))
      }
    }
    setEditing(null)
    closeOverlays()
  }

  function renderEditor(editingHere: Editing): ReactNode {
    if (editing === null) return null
    const same =
      editing.mode === 'rename'
        ? editingHere.mode === 'rename' && editingHere.topicId === editing.topicId
        : editingHere.mode === 'create' && editingHere.parentId === editing.parentId
    if (!same) return null
    const initial = editing.mode === 'rename' ? tree.byId.get(editing.topicId)?.name ?? '' : ''
    return (
      <input
        key="topic-name-input"
        data-testid="topic-name-input"
        aria-label={editing.mode === 'rename' ? t('sidebar.rename') : t('sidebar.newTopicPlaceholder')}
        placeholder={t('sidebar.newTopicPlaceholder')}
        defaultValue={initial}
        autoFocus
        onClick={(event) => {
          event.stopPropagation()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitEditing(event.currentTarget.value)
          if (event.key === 'Escape') setEditing(null)
        }}
        onBlur={() => {
          setEditing(null)
        }}
        style={{
          margin: px('4px 0 4px 20px'),
          padding: px('3px 6px'),
          fontSize: fs(12),
          color: TEXT,
          background: 'var(--oe-surface)',
          border: `1px solid ${INDIGO}`,
          borderRadius: 'var(--oe-radius-control)',
          outline: 'none',
          width: px('calc(100% - 24px)'),
          boxSizing: 'border-box',
        }}
      />
    )
  }

  function renderPalette(topic: Topic): ReactNode {
    if (paletteFor !== topic.id) return null
    return (
      <div
        data-testid="topic-palette"
        role="group"
        aria-label={t('sidebar.changeColor')}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: sp(4),
          padding: px('6px 0 6px 20px'),
        }}
      >
        {TOPIC_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            data-color={color}
            data-current={color === topic.color ? 'true' : 'false'}
            onClick={(event) => {
              event.stopPropagation()
              actions.setTopicColor(topic.id, color)
              setPaletteFor(null)
            }}
            style={{
              width: sp(16),
              height: sp(16),
              padding: 0,
              background: color,
              border: color === topic.color ? `1px solid ${TEXT}` : '1px solid transparent',
              borderRadius: 'var(--oe-radius-control)',
              cursor: 'pointer',
            }}
          />
        ))}
      </div>
    )
  }

  function renderRow(topic: Topic, depth: number): ReactNode {
    const children = tree.childrenOf(topic.id).filter((child) => !hidden.has(child.id))
    const hasChildren = children.length > 0
    const expanded = overrides[topic.id] ?? (depth === DEFAULT_EXPANDED_DEPTH)
    const selected = selectedIds.includes(topic.id)
    const hovered = hoverId === topic.id
    const focused = focusId === topic.id
    const index = rowIndexById.get(topic.id) ?? 0
    const row = rows[index] ?? { topic, depth, hasChildren, expanded }

    return (
      <Fragment key={topic.id}>
        <div
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-selected={selected}
          // roving tabindex：只有一个行可被 Tab 探到，其余靠方向键
          tabIndex={activeRowId === topic.id ? 0 : -1}
          ref={(node) => {
            if (node === null) rowRefs.current.delete(topic.id)
            else rowRefs.current.set(topic.id, node)
          }}
          data-testid={`topic-row-${topic.id}`}
          data-topic-id={topic.id}
          data-depth={depth}
          data-archived={topic.archived ? 'true' : 'false'}
          data-selected={selected ? 'true' : 'false'}
          onClick={() => {
            setFocusId(topic.id)
            actions.toggleTopicFilter(topic.id)
          }}
          onFocus={() => {
            setFocusId(topic.id)
          }}
          onKeyDown={(event) => {
            handleRowKeyDown(event, row, index)
          }}
          onMouseEnter={() => {
            setHoverId(topic.id)
          }}
          onMouseLeave={() => {
            setHoverId((prev) => (prev === topic.id ? null : prev))
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setPaletteFor(null)
            const at = clampMenuPosition(event.clientX, event.clientY)
            setMenuFor({ id: topic.id, x: at.x, y: at.y })
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: sp(6),
            height: sp(26),
            paddingLeft: sp(4) + depth * INDENT,
            paddingRight: sp(4),
            // 左色条 / 整行底色都在禁用之列（spec 9.3 C 方案），选中态只用圆角浅底行 + 文字色
            background: selected ? ROW_HOVER : hovered ? 'var(--oe-row-hover)' : 'transparent',
            borderRadius: 'var(--oe-radius-control)',
            cursor: 'pointer',
            color: topic.archived
              ? ARCHIVED_TEXT
              : selected
                ? 'var(--oe-accent-deep)'
                : 'var(--oe-text-secondary)',
            fontSize: fs(13),
            fontWeight: selected ? 600 : 400,
          }}
        >
          {hasChildren ? (
            <button
              type="button"
              data-testid={`topic-toggle-${topic.id}`}
              aria-label={topic.name}
              onClick={(event) => {
                event.stopPropagation()
                setOverrides((prev) => ({ ...prev, [topic.id]: !expanded }))
              }}
              style={{
                display: 'flex',
                width: sp(16),
                height: sp(16),
                padding: 0,
                alignItems: 'center',
                justifyContent: 'center',
                color: MUTED,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <Icon name={expanded ? 'chevron' : 'chevron-right'} size={14} />
            </button>
          ) : (
            <span style={{ width: sp(16), flex: px('0 0 16px') }} />
          )}

          {/* 色块 swatch：与 T15 卡片色点同一套颜色（都读 topic.color） */}
          <span
            data-testid={`topic-swatch-${topic.id}`}
            data-color={topic.color}
            style={{
              width: sp(10),
              height: sp(10),
              flex: px('0 0 10px'),
              borderRadius: '50%',
              background: topic.color,
              opacity: topic.archived ? 0.4 : 1,
            }}
          />

          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {topic.name}
          </span>

          <span data-testid={`topic-count-${topic.id}`} style={{ fontSize: fs(11), color: MUTED }}>
            {countOf(topic.id)}
          </span>

          {/* 新建子话题：鼠标悬停时出现，键盘用户则是「焦点在这一行」时出现——
              此前只有 hover 一条路，纯键盘永远看不到这个按钮。 */}
          {!topic.archived && (hovered || focused) ? (
            <button
              type="button"
              data-testid={`topic-add-child-${topic.id}`}
              aria-label={t('sidebar.newSubtopic')}
              title={t('sidebar.newSubtopic')}
              onClick={(event) => {
                event.stopPropagation()
                closeOverlays()
                setOverrides((prev) => ({ ...prev, [topic.id]: true }))
                setEditing({ mode: 'create', parentId: topic.id })
              }}
              style={{
                display: 'flex',
                width: sp(16),
                height: sp(16),
                padding: 0,
                alignItems: 'center',
                justifyContent: 'center',
                color: INDIGO,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <Icon name="plus" size={14} />
            </button>
          ) : null}
        </div>

        {renderPalette(topic)}
        {renderEditor({ mode: 'rename', topicId: topic.id })}
        {renderEditor({ mode: 'create', parentId: topic.id })}
        {hasChildren && expanded ? children.map((child) => renderRow(child, depth + 1)) : null}
      </Fragment>
    )
  }

  function renderMenu(): ReactNode {
    if (menuFor === null) return null
    const topic = tree.byId.get(menuFor.id)
    if (topic === undefined) return null

    const itemStyle: CSSProperties = {
      display: 'block',
      width: '100%',
      padding: px('6px 10px'),
      textAlign: 'left',
      fontSize: fs(12),
      color: TEXT,
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
    }

    return (
      <>
        <div
          data-testid="topic-menu-backdrop"
          onClick={closeOverlays}
          style={{ position: 'fixed', inset: 0, zIndex: 10 }}
        />
        <div
          role="menu"
          data-testid="topic-menu"
          style={{
            position: 'fixed',
            left: menuFor.x === 0 ? 16 : menuFor.x,
            top: menuFor.y === 0 ? 16 : menuFor.y,
            minWidth: sp(132),
            padding: sp(4),
            background: 'var(--oe-surface)',
            border: '1px solid var(--oe-separator)',
            borderRadius: 'var(--oe-radius-card)',
            boxShadow: 'var(--oe-shadow-hover)',
            zIndex: 11,
          }}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="topic-menu-rename"
            style={itemStyle}
            onClick={() => {
              setEditing({ mode: 'rename', topicId: topic.id })
              closeOverlays()
            }}
          >
            {t('sidebar.rename')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="topic-menu-color"
            style={itemStyle}
            onClick={() => {
              setPaletteFor(topic.id)
              setMenuFor(null)
            }}
          >
            {t('sidebar.changeColor')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="topic-menu-add-child"
            style={itemStyle}
            onClick={() => {
              setOverrides((prev) => ({ ...prev, [topic.id]: true }))
              setEditing({ mode: 'create', parentId: topic.id })
              closeOverlays()
            }}
          >
            {t('sidebar.newSubtopic')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="topic-menu-archive"
            style={itemStyle}
            onClick={() => {
              if (topic.archived) actions.unarchiveTopic(topic.id)
              else actions.archiveTopic(topic.id)
              closeOverlays()
            }}
          >
            {topic.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
          </button>
        </div>
      </>
    )
  }

  const roots = tree.roots().filter((topic) => !hidden.has(topic.id))

  const bottom: BottomEntry[] = [
    { id: 'milestones', icon: 'milestone', label: t('sidebar.milestones'), onClick: props.onOpenMilestones },
    { id: 'filters', icon: 'filter', label: t('sidebar.filters'), onClick: props.onOpenFilters },
    { id: 'backup', icon: 'backup', label: t('sidebar.backup'), onClick: props.onOpenBackup },
    // T64：回收站排在「备份」之后、「设置」之前——它是数据维护类入口，不是主工作区
    { id: 'trash', icon: 'trash', label: t('sidebar.trash'), onClick: props.onOpenTrash },
    { id: 'settings', icon: 'settings', label: t('sidebar.settings'), onClick: props.onOpenSettings },
  ]

  return (
    <aside
      data-testid="topic-sidebar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: sp(220),
        flex: px('0 0 220px'),
        height: '100%',
        minHeight: 0,
        // 材质由 App 外壳的振镜侧栏提供，这里保持透明，避免双层底色
        background: 'transparent',
        boxSizing: 'border-box',
        fontFamily: 'var(--oe-font)',
        ...props.style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: sp(6),
          padding: px('10px 8px 6px 12px'),
          fontSize: fs(11),
          fontWeight: 650,
          letterSpacing: '0.02em',
          color: 'var(--oe-text-faint)',
        }}
      >
        <span style={{ flex: 1 }}>{t('sidebar.topics')}</span>
        <button
          type="button"
          data-testid="sidebar-toggle-archived"
          onClick={() => {
            setShowArchived((prev) => !prev)
          }}
          style={{
            padding: px('1px 6px'),
            fontSize: fs(11),
            fontWeight: 400,
            color: MUTED,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived')}
        </button>
        <button
          type="button"
          data-testid="topic-add-root"
          aria-label={t('sidebar.newTopic')}
          title={t('sidebar.newTopic')}
          onClick={() => {
            closeOverlays()
            setEditing({ mode: 'create', parentId: null })
          }}
          style={{
            display: 'flex',
            width: sp(18),
            height: sp(18),
            padding: 0,
            alignItems: 'center',
            justifyContent: 'center',
            color: INDIGO,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      <div
        role="tree"
        data-testid="topic-tree"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: px('0 8px 8px') }}
      >
        {roots.map((topic) => renderRow(topic, 0))}
        {renderEditor({ mode: 'create', parentId: null })}
      </div>

      <div
        data-testid="topic-sidebar-footer"
        style={{
          borderTop: '1px solid var(--oe-separator)',
          padding: sp(6),
          display: 'flex',
          flexDirection: 'column',
          gap: sp(2),
        }}
      >
        {bottom.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-testid={`sidebar-open-${entry.id}`}
            onClick={() => {
              entry.onClick?.()
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: sp(8),
              padding: px('6px 8px'),
              fontSize: fs(12),
              color: 'var(--oe-text-secondary)',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--oe-radius-control)',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <Icon name={entry.icon} size={15} />
            <span>{entry.label}</span>
          </button>
        ))}
      </div>

      {renderMenu()}
    </aside>
  )
}

export default TopicSidebar
