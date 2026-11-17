/**
 * T73 · 文档属性行：话题 / 关联任务 / 标签。
 *
 * 为什么需要它：文档此前只有一行「更新于 2026-10-22」——研发打开一篇纪要，
 * 第一反应是「这是哪个需求的、里面那些行动项后来做了吗」，界面答不了。
 * 属性行把这三件事放到标题下面一行，全部可点：
 *  · 话题（所属笔记本）：只读，它由位置决定；
 *  · 关联任务：真的挂到任务上（存 id），点开就是任务详情；
 *  · 标签：自己打，用来做「同一类东西」的横向归拢。
 *
 * 三条实现约束：
 *  1) **本组件不碰 store**：增删全部由宿主回调外送（与 NoteEditor 同口径）；
 *  2) 任务选择弹层 **portal 到 body**：外壳的 `backdrop-filter` 会造包含块，
 *     留在行内的 absolute 定位在那种祖先下会错位（T24 的浮层踩过同一个坑）；
 *  3) 没有关联 / 没有标签时不留空标签占位——空行比少一行更碍眼。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import type { MsgKey, TranslateParams } from '../locales/i18n'
import type { Status } from '../domain/types'
import { Icon } from './IconSprite'
import { fs, px, sp } from '../styles/scale'

const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'
const FAINT = 'var(--oe-text-faint)'
const SURFACE = 'var(--oe-surface)'
const SEPARATOR = 'var(--oe-separator)'
const FILL = 'var(--oe-fill)'
const ACCENT = 'var(--oe-accent)'

/** 属性行只关心「够画一个 chip」的字段，不依赖完整 Task。 */
export interface NotePropertyTask {
  id: string
  title: string
  status: Status
}

export interface NotePropertiesProps {
  /** 所属话题（笔记本）名。 */
  notebookName: string
  /** 已挂上的标签（按写入顺序）。 */
  tags: readonly string[]
  /** 已关联的任务（顺序与文档里记的一致；找不到的任务由宿主过滤掉）。 */
  linked: readonly NotePropertyTask[]
  /** 「+ 关联任务」的候选池（宿主已排除已关联的）。 */
  candidates: readonly NotePropertyTask[]
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
  onToggleTask: (taskId: string) => void
  /** 点任务 chip 打开任务详情（不给就只是展示）。 */
  onOpenTask?: (taskId: string) => void
  t: (key: MsgKey, params?: TranslateParams) => string
}

const TASK_MENU_WIDTH = 260
const TASK_MENU_LIMIT = 8

/** 状态点：只用三种语义色（完成 / 进行中 / 其余），不自造第四套配色。 */
function statusColor(status: Status): string {
  if (status === 'done') return 'var(--oe-done)'
  if (status === 'doing') return ACCENT
  return 'var(--oe-text-faint)'
}

export function NoteProperties(props: NotePropertiesProps): React.ReactElement {
  const { t } = props
  const [tagDraft, setTagDraft] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState('')
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const addTaskRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const suggestion = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const pool =
      needle === ''
        ? props.candidates
        : props.candidates.filter((task) => task.title.toLowerCase().includes(needle))
    return pool.slice(0, TASK_MENU_LIMIT)
  }, [props.candidates, query])

  // 弹层跟着按钮走（视口坐标 + portal）。窗口缩放时重算一次。
  useEffect(() => {
    if (!picking) return
    const measure = (): void => {
      const box = addTaskRef.current?.getBoundingClientRect()
      if (box === undefined) return
      const left = Math.max(8, Math.min(box.left, window.innerWidth - TASK_MENU_WIDTH - 8))
      setAnchor({ top: box.bottom + 4, left })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [picking])

  // 点外面 / Esc 收起弹层。菜单本身 portal 在 body 上，只能靠文档级监听判「是不是点在里面」。
  useEffect(() => {
    if (!picking) return
    const onDown = (event: MouseEvent): void => {
      const menu = menuRef.current
      if (menu !== null && event.target instanceof Element && menu.contains(event.target)) return
      if (event.target instanceof Element && addTaskRef.current?.contains(event.target) === true) return
      setPicking(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPicking(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [picking])

  const commitTag = (): void => {
    if (tagDraft === null) return
    const tag = tagDraft.trim()
    if (tag !== '') props.onAddTag(tag)
    setTagDraft(null)
  }

  return (
    <div data-testid="note-properties" style={ROW}>
      <span data-testid="note-prop-topic" style={TOPIC} title={t('notebookProp.topic')}>
        <Icon name="notebook" size={11} />
        <span style={ELLIPSIS}>{props.notebookName}</span>
      </span>

      {props.linked.map((task) => (
        <span key={task.id} data-testid={`note-prop-task-${task.id}`} style={TASK_CHIP}>
          <span style={{ ...DOT, background: statusColor(task.status) }} aria-hidden="true" />
          <button
            type="button"
            data-testid={`note-prop-task-open-${task.id}`}
            title={`${t(`status.${task.status}` as MsgKey)} · ${task.title}`}
            onClick={() => props.onOpenTask?.(task.id)}
            style={CHIP_BUTTON}
          >
            {task.title}
          </button>
          <button
            type="button"
            data-testid={`note-prop-task-remove-${task.id}`}
            aria-label={t('notebookProp.unlinkTask')}
            title={t('notebookProp.unlinkTask')}
            onClick={() => props.onToggleTask(task.id)}
            style={CHIP_X}
          >
            <Icon name="close" size={9} />
          </button>
        </span>
      ))}

      <button
        ref={addTaskRef}
        type="button"
        data-testid="note-prop-add-task"
        aria-expanded={picking}
        onClick={() => {
          setPicking((open) => !open)
          setQuery('')
        }}
        style={ADD_BUTTON}
      >
        <Icon name="plus" size={10} />
        {t('notebookProp.linkTask')}
      </button>

      {props.tags.map((tag) => (
        <span key={tag} data-testid={`note-prop-tag-${tag}`} style={TAG_CHIP}>
          <span style={TAG_HASH}>#</span>
          <span style={ELLIPSIS}>{tag}</span>
          <button
            type="button"
            data-testid={`note-prop-tag-remove-${tag}`}
            aria-label={t('notebookProp.removeTag')}
            title={t('notebookProp.removeTag')}
            onClick={() => props.onRemoveTag(tag)}
            style={CHIP_X}
          >
            <Icon name="close" size={9} />
          </button>
        </span>
      ))}

      {tagDraft === null ? (
        <button
          type="button"
          data-testid="note-prop-add-tag"
          onClick={() => setTagDraft('')}
          style={ADD_BUTTON}
        >
          <Icon name="plus" size={10} />
          {t('notebookProp.addTag')}
        </button>
      ) : (
        <input
          autoFocus
          data-testid="note-prop-tag-input"
          aria-label={t('notebookProp.addTag')}
          placeholder={t('notebookProp.tagPlaceholder')}
          value={tagDraft}
          onChange={(event) => setTagDraft(event.target.value)}
          onBlur={commitTag}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
            event.stopPropagation() // 别让 Esc / Ctrl+Z 冒到弹窗或全局快捷键
            if (event.key === 'Enter') {
              event.preventDefault()
              commitTag()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setTagDraft(null)
            }
          }}
          style={TAG_INPUT}
        />
      )}

      {picking && anchor !== null && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              data-testid="note-prop-task-menu"
              role="listbox"
              aria-label={t('notebookProp.linkTask')}
              style={{ ...TASK_MENU, top: anchor.top, left: anchor.left }}
            >
              <input
                autoFocus
                data-testid="note-prop-task-search"
                aria-label={t('notebookProp.searchTask')}
                placeholder={t('notebookProp.searchTask')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Escape') setPicking(false)
                }}
                style={TASK_SEARCH}
              />
              {suggestion.length === 0 ? (
                <div data-testid="note-prop-task-empty" style={MENU_EMPTY}>
                  {t('notebookProp.noTask')}
                </div>
              ) : (
                suggestion.map((task, index) => (
                  <button
                    key={task.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    data-testid={`note-prop-task-option-${index}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      props.onToggleTask(task.id)
                      setPicking(false)
                    }}
                    style={MENU_ITEM}
                  >
                    <span style={{ ...DOT, background: statusColor(task.status) }} aria-hidden="true" />
                    <span style={ELLIPSIS}>{task.title}</span>
                    <span style={MENU_STATUS}>{t(`status.${task.status}` as MsgKey)}</span>
                  </button>
                ))
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: sp(5),
  marginTop: sp(4),
  minWidth: 0,
}

const ELLIPSIS: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const TOPIC: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(3),
  maxWidth: sp(150),
  fontSize: fs(10),
  color: MUTED,
}

const DOT: CSSProperties = {
  flex: '0 0 auto',
  width: fs(6),
  height: fs(6),
  borderRadius: '50%',
}

const TASK_CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(3),
  maxWidth: sp(190),
  padding: px('1px 4px'),
  fontSize: fs(10),
  color: TEXT,
  background: FILL,
  borderRadius: 'var(--oe-radius-control)',
}

const TAG_CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(2),
  maxWidth: sp(140),
  padding: px('1px 5px'),
  fontSize: fs(10),
  color: MUTED,
  border: `1px solid ${SEPARATOR}`,
  borderRadius: 'var(--oe-radius-control)',
}

const TAG_HASH: CSSProperties = { color: FAINT }

const CHIP_BUTTON: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const CHIP_X: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: FAINT,
  cursor: 'pointer',
}

const ADD_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(2),
  padding: px('1px 5px'),
  fontSize: fs(10),
  color: MUTED,
  background: 'transparent',
  border: `1px dashed ${SEPARATOR}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const TAG_INPUT: CSSProperties = {
  width: sp(96),
  padding: px('1px 5px'),
  fontSize: fs(10),
  color: TEXT,
  background: SURFACE,
  border: `1px solid ${ACCENT}`,
  borderRadius: 'var(--oe-radius-control)',
  outline: 'none',
  fontFamily: 'inherit',
}

const TASK_MENU: CSSProperties = {
  position: 'fixed',
  zIndex: 46,
  display: 'flex',
  flexDirection: 'column',
  gap: sp(1),
  padding: sp(4),
  background: SURFACE,
  border: `1px solid ${SEPARATOR}`,
  borderRadius: 'var(--oe-radius-overlay)',
  boxShadow: 'var(--oe-shadow-pop)',
}

const TASK_SEARCH: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: px('3px 6px'),
  fontSize: fs(11),
  color: TEXT,
  background: SURFACE,
  border: `1px solid ${SEPARATOR}`,
  borderRadius: 'var(--oe-radius-control)',
  outline: 'none',
  fontFamily: 'inherit',
}

const MENU_ITEM: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(6),
  padding: px('3px 6px'),
  fontSize: fs(11),
  color: TEXT,
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
}

const MENU_STATUS: CSSProperties = {
  flex: '0 0 auto',
  fontSize: fs(9),
  color: FAINT,
}

const MENU_EMPTY: CSSProperties = {
  padding: px('4px 6px'),
  fontSize: fs(10),
  color: MUTED,
}
