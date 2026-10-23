// T62 · 会议导入面板：选一个 .ics，勾几场会，落成笔记。
//
// 三条与既有约定对齐的地方：
//  1) 文件选择走隐藏 `<input type="file">`（T28 BackupPanel 先例，jsdom 可测），
//     另外挂一个拖放区——`file://` 下 dataTransfer.files 拿得到 File 对象，不需要任何权限；
//  2) 浮层 createPortal 到 body：外壳的 backdrop-filter 会给 position:fixed 造包含块，
//     留在树里会被量到错误的位置（DateField 的浮层踩过同一个坑）；
//  3) 面板是纯视图：不碰 store、不碰文件系统，`onImport` 把选中的事件交回调用方。
//
// 层极取 30：高于任务弹窗（25）、低于灯箱（60）——导入面板要能压在任务弹窗之上，
// 但不该盖住全屏看图。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, DragEvent, ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { meetingKey } from '../controllers/meetingImport'
import { parseIcs } from '../domain/ics'
import type { IcsEvent } from '../domain/ics'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { Icon } from './IconSprite'
import { fs, px, sp } from '../styles/scale'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const ACCENT = 'var(--oe-accent)'
const SURFACE = 'var(--oe-surface)'
const DANGER = 'var(--oe-overdue)'

export interface MeetingImportPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 目标笔记本名称，只用于「将导入到哪里」这行提示。 */
  notebookName: string
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 全库已导入的令牌，用来标「已导入」并默认不勾。 */
  importedKeys: ReadonlySet<string>
  onImport: (events: IcsEvent[]) => void
}

/** 面板里一场会议的展示行（纯派生，便于单测断言）。 */
export interface MeetingRow {
  key: string
  event: IcsEvent
  imported: boolean
  title: string
  time: string
}

export function buildMeetingRows(
  events: readonly IcsEvent[],
  importedKeys: ReadonlySet<string>,
  labels: { untitled: string; allDay: string },
): MeetingRow[] {
  return events.map((event) => {
    const key = meetingKey(event)
    const startTime = event.start.slice(11, 16)
    const time = event.allDay
      ? `${event.dateKey} · ${labels.allDay}`
      : event.end === null
        ? `${event.dateKey} ${startTime}`
        : event.end.slice(0, 10) === event.dateKey
          ? `${event.dateKey} ${startTime}–${event.end.slice(11, 16)}`
          : `${event.dateKey} ${startTime} – ${event.end.slice(0, 10)} ${event.end.slice(11, 16)}`
    return {
      key,
      event,
      imported: importedKeys.has(key),
      title: event.summary !== '' ? event.summary : labels.untitled,
      time,
    }
  })
}

export function MeetingImportPanel(props: MeetingImportPanelProps): ReactElement | null {
  const { open, onOpenChange, notebookName, t, importedKeys, onImport } = props
  const [rows, setRows] = useState<MeetingRow[]>([])
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set<string>())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const backdropDown = useRef(false)

  // 收起即清空：下次打开是干净的「选文件」态，不会残留上一个文件里的会议
  useEffect(() => {
    if (open) return
    setRows([])
    setPicked(new Set<string>())
    setError(null)
    setBusy(false)
    setDragging(false)
  }, [open])

  const close = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  useEffect(() => {
    if (!open) return
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  async function loadFile(file: File): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const text = await file.text()
      if (!/BEGIN:VCALENDAR/i.test(text)) {
        setRows([])
        setPicked(new Set<string>())
        setError(t('meetingImport.parseFailed'))
        return
      }
      const events = parseIcs(text)
      if (events.length === 0) {
        setRows([])
        setPicked(new Set<string>())
        setError(t('meetingImport.empty'))
        return
      }
      const next = buildMeetingRows(events, importedKeys, {
        untitled: t('meetingImport.untitled'),
        allDay: t('meetingImport.allDay'),
      })
      setRows(next)
      // 默认只勾「还没导过的」：同一个日历文件导入两次不该产生重复笔记
      setPicked(new Set(next.filter((row) => !row.imported).map((row) => row.key)))
    } catch {
      setRows([])
      setPicked(new Set<string>())
      setError(t('meetingImport.readFailed'))
    } finally {
      setBusy(false)
    }
  }

  function onFileChosen(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    event.target.value = '' // 允许再次选择同一个文件
    if (file === undefined) return
    void loadFile(file)
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file === undefined) return
    void loadFile(file)
  }

  function toggle(key: string): void {
    const next = new Set(picked)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setPicked(next)
  }

  function confirm(): void {
    const chosen = rows.filter((row) => picked.has(row.key)).map((row) => row.event)
    if (chosen.length === 0) return
    onImport(chosen)
    onOpenChange(false)
  }

  if (!open) return null

  const selectable = rows.filter((row) => !row.imported)
  const count = picked.size

  return createPortal(
    <div
      data-testid="meeting-import-backdrop"
      style={BACKDROP}
      onMouseDown={(event) => {
        backdropDown.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // 只在「按下与抬起都落在遮罩上」才关：笔记里拖完文字松手不该把面板关掉
        if (backdropDown.current && event.target === event.currentTarget) close()
        backdropDown.current = false
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('meetingImport.title')}
        data-testid="meeting-import"
        style={PANEL}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: sp(8), padding: px('0 16px'), height: sp(44), borderBottom: `1px solid ${BORDER}`, flex: '0 0 auto' }}>
          <span style={{ display: 'flex', color: ACCENT }}>
            <Icon name="calendar" size={14} />
          </span>
          <span style={{ fontSize: fs(14), fontWeight: 500, color: TEXT }}>{t('meetingImport.title')}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="meeting-import-close"
            aria-label={t('meetingImport.cancel')}
            title={t('meetingImport.cancel')}
            onClick={close}
            style={ICON_BUTTON}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div style={{ padding: px('14px 16px 0'), flex: '0 0 auto' }}>
          <div style={{ fontSize: fs(12), color: MUTED, lineHeight: 1.7 }}>
            {t('meetingImport.hint', { notebook: notebookName })}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".ics,text/calendar"
            data-testid="meeting-import-file-input"
            style={{ display: 'none' }}
            onChange={onFileChosen}
          />

          <div
            data-testid="meeting-import-dropzone"
            data-dragging={dragging ? 'true' : 'false'}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            style={{
              marginTop: sp(10),
              padding: px('14px 12px'),
              border: `1px dashed ${dragging ? ACCENT : BORDER}`,
              borderRadius: sp(10),
              background: dragging ? 'var(--oe-row-selected)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              gap: sp(10),
            }}
          >
            <span style={{ display: 'flex', color: MUTED }}>
              <Icon name="doc" size={16} />
            </span>
            <span style={{ flex: 1, fontSize: fs(12), color: SECONDARY }}>{t('meetingImport.dropHint')}</span>
            <button
              type="button"
              data-testid="meeting-import-choose"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              style={{
                ...BUTTON,
                color: busy ? MUTED : ACCENT,
                borderColor: busy ? BORDER : ACCENT,
              }}
            >
              {busy ? t('meetingImport.reading') : t('meetingImport.choose')}
            </button>
          </div>

          {error !== null ? (
            <div data-testid="meeting-import-error" style={{ marginTop: sp(10), fontSize: fs(12), color: DANGER, lineHeight: 1.7 }}>
              {error}
            </div>
          ) : null}
        </div>

        {rows.length > 0 ? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: sp(10),
                padding: px('12px 16px 6px'),
                flex: '0 0 auto',
              }}
            >
              <span data-testid="meeting-import-count" style={{ fontSize: fs(12), color: SECONDARY }}>
                {t('meetingImport.count', { n: count, total: rows.length })}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                data-testid="meeting-import-select-all"
                disabled={selectable.length === 0}
                onClick={() => setPicked(new Set(selectable.map((row) => row.key)))}
                style={{ ...LINK_BUTTON, color: selectable.length === 0 ? MUTED : SECONDARY }}
              >
                {t('meetingImport.selectAll')}
              </button>
              <button
                type="button"
                data-testid="meeting-import-select-none"
                disabled={count === 0}
                onClick={() => setPicked(new Set<string>())}
                style={{ ...LINK_BUTTON, color: count === 0 ? MUTED : SECONDARY }}
              >
                {t('meetingImport.selectNone')}
              </button>
            </div>

            <div
              data-testid="meeting-import-list"
              style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: px('0 10px 10px') }}
            >
              {rows.map((row) => {
                const checked = picked.has(row.key)
                return (
                  <label
                    key={row.key}
                    data-testid="meeting-import-row"
                    data-imported={row.imported ? 'true' : 'false'}
                    data-checked={checked ? 'true' : 'false'}
                    data-key={row.key}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: sp(10),
                      padding: px('9px 8px'),
                      borderRadius: sp(8),
                      background: checked && !row.imported ? 'var(--oe-row-selected)' : 'transparent',
                      cursor: row.imported ? 'default' : 'pointer',
                      opacity: row.imported ? 0.55 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked && !row.imported}
                      disabled={row.imported}
                      onChange={() => toggle(row.key)}
                      style={{ marginTop: sp(2), accentColor: ACCENT }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: fs(13),
                          color: TEXT,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.title}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          marginTop: sp(2),
                          fontSize: fs(11),
                          color: MUTED,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.time}
                        {row.event.location !== '' ? ` · ${row.event.location}` : ''}
                        {row.event.attendees.length > 0
                          ? ` · ${t('meetingImport.attendeeCount', { n: row.event.attendees.length })}`
                          : ''}
                      </span>
                    </span>
                    {row.imported ? (
                      <span
                        data-testid="meeting-import-badge"
                        style={{
                          flex: '0 0 auto',
                          fontSize: fs(10),
                          color: MUTED,
                          border: `1px solid ${BORDER}`,
                          borderRadius: sp(9),
                          padding: px('1px 7px'),
                        }}
                      >
                        {t('meetingImport.imported')}
                      </span>
                    ) : null}
                  </label>
                )
              })}
            </div>
          </>
        ) : (
          <div style={{ flex: 1 }} />
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: sp(8),
            padding: px('12px 16px'),
            borderTop: `1px solid ${BORDER}`,
            flex: '0 0 auto',
          }}
        >
          <span style={{ flex: 1 }} />
          <button type="button" onClick={close} style={BUTTON} data-testid="meeting-import-cancel">
            {t('meetingImport.cancel')}
          </button>
          <button
            type="button"
            data-testid="meeting-import-confirm"
            disabled={count === 0}
            onClick={confirm}
            style={{
              ...BUTTON,
              color: count === 0 ? MUTED : '#fff',
              borderColor: count === 0 ? BORDER : ACCENT,
              background: count === 0 ? 'transparent' : ACCENT,
            }}
          >
            {count === 0 ? t('meetingImport.importActionEmpty') : t('meetingImport.importAction', { n: count })}
          </button>
        </div>
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
  width: 'min(520px, calc(100vw - 48px))',
  maxHeight: 'min(620px, calc(100vh - 96px))',
  display: 'flex',
  flexDirection: 'column',
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: sp(14),
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.18)',
  overflow: 'hidden',
}

const BUTTON: CSSProperties = {
  flex: '0 0 auto',
  height: sp(30),
  padding: px('0 12px'),
  fontSize: fs(12),
  borderRadius: sp(8),
  border: `1px solid ${BORDER}`,
  background: 'transparent',
  color: TEXT,
  cursor: 'pointer',
}

const LINK_BUTTON: CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  fontSize: fs(12),
  cursor: 'pointer',
}

const ICON_BUTTON: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: sp(26),
  height: sp(26),
  border: 'none',
  borderRadius: sp(7),
  background: 'transparent',
  color: MUTED,
  cursor: 'pointer',
}
