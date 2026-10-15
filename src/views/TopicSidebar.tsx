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

import { Fragment, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
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

const BORDER = '#E5E7EB'
const TEXT = '#111827'
const MUTED = '#6B7280'
const INDIGO = '#4F46E5'
const ROW_HOVER = '#E5E7EB'
const ARCHIVED_TEXT = '#9CA3AF'

/** 默认展开的层数：0 表示「根层展开」——可见根与它的直接子话题，共两层（spec 4.2「UI 默认展示两层」）。 */
const DEFAULT_EXPANDED_DEPTH = 0

/** 每层的缩进像素。 */
const INDENT = 14

export interface TopicSidebarProps {
  store: VaultStore
  bus: CommandBus
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 四个底部入口；面板尚未实现（T16/T18/T28），由集成窗口接线。 */
  onOpenMilestones?: () => void
  onOpenFilters?: () => void
  onOpenBackup?: () => void
  onOpenSettings?: () => void
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
          margin: '4px 0 4px 20px',
          padding: '3px 6px',
          fontSize: 12,
          color: TEXT,
          background: '#FFFFFF',
          border: `1px solid ${INDIGO}`,
          borderRadius: 6,
          outline: 'none',
          width: 'calc(100% - 24px)',
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
          gap: 4,
          padding: '6px 0 6px 20px',
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
              width: 16,
              height: 16,
              padding: 0,
              background: color,
              border: color === topic.color ? `1px solid ${TEXT}` : '1px solid transparent',
              borderRadius: 4,
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

    return (
      <Fragment key={topic.id}>
        <div
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-selected={selected}
          data-testid={`topic-row-${topic.id}`}
          data-topic-id={topic.id}
          data-depth={depth}
          data-archived={topic.archived ? 'true' : 'false'}
          data-selected={selected ? 'true' : 'false'}
          onClick={() => {
            actions.toggleTopicFilter(topic.id)
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
            setMenuFor({ id: topic.id, x: event.clientX, y: event.clientY })
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 26,
            paddingLeft: 4 + depth * INDENT,
            paddingRight: 4,
            // 左色条 / 整行底色都在禁用之列（spec 9.3 C 方案），选中态只用文字色与底色提示
            background: selected ? ROW_HOVER : hovered ? '#F9FAFB' : 'transparent',
            borderRadius: 6,
            cursor: 'pointer',
            color: topic.archived ? ARCHIVED_TEXT : selected ? TEXT : '#374151',
            fontSize: 13,
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
                width: 16,
                height: 16,
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
            <span style={{ width: 16, flex: '0 0 16px' }} />
          )}

          {/* 色块 swatch：与 T15 卡片色点同一套颜色（都读 topic.color） */}
          <span
            data-testid={`topic-swatch-${topic.id}`}
            data-color={topic.color}
            style={{
              width: 10,
              height: 10,
              flex: '0 0 10px',
              borderRadius: 3,
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

          <span data-testid={`topic-count-${topic.id}`} style={{ fontSize: 11, color: MUTED }}>
            {countOf(topic.id)}
          </span>

          {hovered && !topic.archived ? (
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
                width: 16,
                height: 16,
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
      padding: '6px 10px',
      textAlign: 'left',
      fontSize: 12,
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
            minWidth: 132,
            padding: 4,
            background: '#FFFFFF',
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            boxShadow: '0 2px 8px rgba(17, 24, 39, 0.08)',
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
    { id: 'settings', icon: 'settings', label: t('sidebar.settings'), onClick: props.onOpenSettings },
  ]

  return (
    <aside
      data-testid="topic-sidebar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 220,
        flex: '0 0 220px',
        height: '100%',
        minHeight: 0,
        background: '#F3F4F6',
        borderRight: `1px solid ${BORDER}`,
        boxSizing: 'border-box',
        fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
        ...props.style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '10px 8px 6px 12px',
          fontSize: 12,
          fontWeight: 600,
          color: MUTED,
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
            padding: '1px 6px',
            fontSize: 11,
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
            width: 18,
            height: 18,
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
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' }}
      >
        {roots.map((topic) => renderRow(topic, 0))}
        {renderEditor({ mode: 'create', parentId: null })}
      </div>

      <div
        data-testid="topic-sidebar-footer"
        style={{ borderTop: `1px solid ${BORDER}`, padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}
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
              gap: 8,
              padding: '6px 8px',
              fontSize: 12,
              color: '#374151',
              background: 'transparent',
              border: 'none',
              borderRadius: 6,
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
