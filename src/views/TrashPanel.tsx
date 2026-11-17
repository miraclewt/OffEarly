// T64 · 回收站面板：看得见删掉的笔记与任务，能恢复，也能彻底删除。
//
// 为什么是「面板」而不是一个视图：回收站是低频、临时、要看一眼就走的地方。
// 放进顶栏的视图切换会把 4 个主视图挤成 5 个，还会让用户以为它是一个平级的工作区。
//
// 三条口径：
//   ① 预览是**原始 Markdown 的纯文本**（去掉图片语法与 HTML 标签）。回收站里不该再跑
//      一套富文本渲染——它要回答的是「这是哪一篇」，而不是「排版对不对」。
//   ② 恢复不悄悄发生：成功给一条提示；失败给**具体原因**（话题没了 / 笔记本没了 / 同 id 已存在）。
//   ③ 彻底删除两段确认（与任务删除、文档删除同一手感），因为它的后果是「重开也回不来」。

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from 'zustand'
import dayjs from 'dayjs'

import { applyPurgeEntry, applyRestoreEntry } from '../controllers/trashActions'
import type { RestoreFailure } from '../controllers/trashActions'
import type { CommandBus } from '../domain/commandBus'
import type { VaultStore } from '../domain/store'
import type { TrashEntry } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { fs, px, sp } from '../styles/scale'
import { Icon } from './IconSprite'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const ACCENT = 'var(--oe-accent)'
const SURFACE = 'var(--oe-surface)'
const DANGER = 'var(--oe-overdue)'
const FILL = 'var(--oe-fill)'

/** 两段确认的有效期（与任务 / 文档删除同一节奏）。 */
const ARM_MS = 3000
/** 预览截断长度：够认出是哪一篇，又不至于把面板撑成阅读器。 */
const PREVIEW_CHARS = 220

export interface TrashPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传 Store 而不是快照：面板开着时用户可能先撤销了某次删除，列表要跟着变。 */
  store: VaultStore
  bus: CommandBus
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 恢复后可选回调（例如把视图切到对应位置）。 */
  onRestored?: (entry: TrashEntry) => void
}

/** 把 Markdown 压成一行可读的纯文本：图片与 HTML 标签不要出现在回收站列表里。 */
export function plainPreview(markdown: string, limit = PREVIEW_CHARS): string {
  const stripped = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length > limit ? `${stripped.slice(0, limit)}…` : stripped
}

/** 条目标题：任务是 title，文档是子树根标题。 */
export function entryTitle(entry: TrashEntry): string {
  if (entry.kind === 'task') return entry.task.title
  return entry.docs.find((item) => item.doc.id === entry.rootId)?.doc.title ?? ''
}

/** 条目正文（用于预览）：任务正文 / 子树根文档正文。 */
export function entryBody(entry: TrashEntry): string {
  if (entry.kind === 'task') return entry.task.note
  return entry.docs.find((item) => item.doc.id === entry.rootId)?.doc.content ?? ''
}

function sortNewest(entries: readonly TrashEntry[]): TrashEntry[] {
  return [...entries].sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0))
}

export function TrashPanel(props: TrashPanelProps): ReactElement | null {
  const { open, onOpenChange, store, bus, t } = props
  const vault = useStore(store, (state) => state.vault)
  const [armed, setArmed] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const entries = useMemo(() => sortNewest(vault.trash), [vault.trash])

  // 收起即复位：确认态 / 展开态 / 提示都不该留到下一次打开
  useEffect(() => {
    if (open) return
    setArmed(null)
    setExpanded(null)
    setNotice(null)
  }, [open])

  useEffect(() => {
    if (armed === null) return
    const timer = window.setTimeout(() => setArmed(null), ARM_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => setNotice(null), ARM_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const failureKey = (reason: RestoreFailure): MsgKey =>
    reason === 'topic'
      ? 'trash.restoreTopic'
      : reason === 'notebook'
        ? 'trash.restoreNotebook'
        : reason === 'conflict'
          ? 'trash.restoreConflict'
          : 'trash.missing'

  function restore(entry: TrashEntry): void {
    const failure = applyRestoreEntry(bus, vault, entry.id)
    if (failure === null) {
      setNotice(t('trash.restored', { name: entryTitle(entry) }))
      props.onRestored?.(entry)
      return
    }
    setNotice(t(failureKey(failure)))
  }

  function purge(entry: TrashEntry): void {
    if (armed !== entry.id) {
      setArmed(entry.id)
      return
    }
    setArmed(null)
    if (applyPurgeEntry(bus, vault, entry.id)) setNotice(t('trash.purged', { name: entryTitle(entry) }))
  }

  useEffect(() => {
    if (!open) return
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  if (!open) return null

  return createPortal(
    <div
      data-testid="trash-backdrop"
      style={BACKDROP}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('trash.title')}
        data-testid="trash-panel"
        style={PANEL}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div style={HEADER}>
          <span style={{ display: 'flex', color: ACCENT }}>
            <Icon name="trash" size={14} />
          </span>
          <span style={{ fontSize: fs(14), fontWeight: 550, color: TEXT }}>{t('trash.title')}</span>
          <span data-testid="trash-count" style={COUNT}>
            {t('trash.count', { n: entries.length })}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="trash-close"
            aria-label={t('trash.close')}
            title={t('trash.close')}
            onClick={() => onOpenChange(false)}
            style={ICON_BUTTON}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div data-testid="trash-list" style={LIST}>
          {entries.length === 0 ? (
            <div data-testid="trash-empty" style={EMPTY}>
              <span style={{ display: 'flex', color: MUTED }}>
                <Icon name="trash" size={24} />
              </span>
              <div style={{ fontSize: fs(13), fontWeight: 550, color: TEXT }}>{t('trash.emptyTitle')}</div>
              <p style={{ margin: 0, fontSize: fs(12), lineHeight: 1.7, color: MUTED, maxWidth: sp(320), textAlign: 'center' }}>
                {t('trash.emptyHint')}
              </p>
            </div>
          ) : (
            entries.map((entry) => {
              const title = entryTitle(entry)
              const body = entryBody(entry)
              const expandedHere = expanded === entry.id
              const childCount = entry.kind === 'doc' ? entry.docs.length - 1 : 0
              return (
                <div key={entry.id} data-testid={`trash-entry-${entry.id}`} style={ROW}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: sp(8), minWidth: 0 }}>
                    <span style={KIND_BADGE}>{entry.kind === 'task' ? t('trash.kindTask') : t('trash.kindDoc')}</span>
                    <span data-testid={`trash-entry-title-${entry.id}`} style={ROW_TITLE}>
                      {title === '' ? t('trash.untitled') : title}
                    </span>
                    {childCount > 0 ? (
                      <span style={COUNT}>{t('trash.withChildren', { n: childCount })}</span>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <span data-testid={`trash-entry-time-${entry.id}`} style={COUNT}>
                      {/* 删除时刻按**本地时间**显示：deletedAt 是 UTC ISO，直接截字符串会比用户看到的钟早 8 小时 */}
                      {dayjs(entry.deletedAt).format('YYYY-MM-DD HH:mm')}
                    </span>
                  </div>

                  {body.trim() === '' ? (
                    <p style={PREVIEW_EMPTY}>{t('trash.noContent')}</p>
                  ) : (
                    <p
                      data-testid={`trash-entry-preview-${entry.id}`}
                      style={expandedHere ? PREVIEW_FULL : PREVIEW}
                      onClick={() => setExpanded((value) => (value === entry.id ? null : entry.id))}
                    >
                      {expandedHere ? body : plainPreview(body)}
                    </p>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: sp(6), marginTop: sp(2) }}>
                    <button
                      type="button"
                      data-testid={`trash-restore-${entry.id}`}
                      onClick={() => restore(entry)}
                      style={BUTTON}
                    >
                      <Icon name="undo" size={12} />
                      <span>{t('trash.restore')}</span>
                    </button>
                    <button
                      type="button"
                      data-testid={`trash-purge-${entry.id}`}
                      aria-label={armed === entry.id ? t('trash.purgeConfirm') : t('trash.purge')}
                      onClick={() => purge(entry)}
                      style={
                        armed === entry.id
                          ? { ...BUTTON, color: 'var(--oe-on-accent)', background: DANGER, borderColor: DANGER }
                          : { ...BUTTON, color: DANGER }
                      }
                    >
                      <Icon name="trash" size={12} />
                      <span>{armed === entry.id ? t('trash.purgeConfirm') : t('trash.purge')}</span>
                    </button>
                    <span style={{ flex: 1 }} />
                    <span style={HINT}>
                      {armed === entry.id ? t('trash.purgeHint') : t('trash.restoreHint')}
                    </span>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {notice === null ? null : (
          <div data-testid="trash-notice" role="status" style={NOTICE}>
            {notice}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

const BACKDROP: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 30,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--oe-scrim)',
}

const PANEL: CSSProperties = {
  width: 'min(640px, calc(100vw - 48px))',
  maxHeight: 'min(640px, calc(100vh - 96px))',
  display: 'flex',
  flexDirection: 'column',
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: sp(14),
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.18)',
  overflow: 'hidden',
}

const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(8),
  padding: px('0 14px'),
  height: sp(44),
  flex: '0 0 auto',
  borderBottom: `1px solid ${BORDER}`,
}

const COUNT: CSSProperties = {
  fontSize: fs(11),
  color: MUTED,
  fontVariantNumeric: 'tabular-nums',
  flex: '0 0 auto',
}

const LIST: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: sp(8),
  padding: px('12px 14px'),
}

const EMPTY: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: sp(8),
  padding: px('40px 20px'),
}

const ROW: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: sp(4),
  padding: px('10px 12px'),
  border: `1px solid ${BORDER}`,
  borderRadius: sp(10),
  background: FILL,
}

const KIND_BADGE: CSSProperties = {
  flex: '0 0 auto',
  padding: px('0 6px'),
  fontSize: fs(10),
  lineHeight: 1.8,
  color: SECONDARY,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: sp(5),
}

const ROW_TITLE: CSSProperties = {
  minWidth: 0,
  fontSize: fs(13),
  fontWeight: 550,
  color: TEXT,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const PREVIEW: CSSProperties = {
  margin: 0,
  fontSize: fs(12),
  lineHeight: 1.65,
  color: SECONDARY,
  cursor: 'pointer',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

const PREVIEW_FULL: CSSProperties = {
  margin: 0,
  fontSize: fs(12),
  lineHeight: 1.65,
  color: SECONDARY,
  cursor: 'pointer',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: sp(220),
  overflowY: 'auto',
}

const PREVIEW_EMPTY: CSSProperties = {
  margin: 0,
  fontSize: fs(12),
  color: MUTED,
}

const BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(4),
  height: sp(26),
  padding: px('0 9px'),
  fontSize: fs(11),
  color: TEXT,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: sp(7),
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const HINT: CSSProperties = {
  fontSize: fs(10),
  color: MUTED,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const NOTICE: CSSProperties = {
  flex: '0 0 auto',
  padding: px('8px 14px'),
  borderTop: `1px solid ${BORDER}`,
  fontSize: fs(11),
  color: SECONDARY,
}

const ICON_BUTTON: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: sp(24),
  height: sp(24),
  padding: 0,
  color: MUTED,
  background: 'transparent',
  border: 'none',
  borderRadius: sp(6),
  cursor: 'pointer',
}
