// T82 · Markdown 导入面板：选几个 .md（或拖进来）→ 勾几篇 → 落成笔记。
//
// 与 T62 会议导入面板同款骨架（隐藏 input + 拖放区 + 勾选列表 + 底部动作），
// 三处不同是刻意保留的：
//  ① `multiple`：导入 md 是**批量**动作（AI 一次吐十几篇），让用户一个个选等于没做；
//  ② 跳过原因要看得见：不是 md、超过 2MB、空文件都单独成行并写明原因——
//     「选了 6 个只进来 4 个」必须能在面板里解释清楚，不能静默丢；
//  ③ 标题是猜的，所以要标注来源（YAML 头 / 首个 # 标题 / 文件名），
//     并且对上笔记本里已有的同名文档标「同名已存在」——由用户决定要不要重复导入。
//
// 层级取 30（与会议导入同层）：高于任务弹窗（25）、低于灯箱（60）。
// 浮层 createPortal 到 body：外壳的 backdrop-filter 会给 position:fixed 造包含块。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, DragEvent, ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { buildMarkdownEntries } from '../controllers/markdownImport'
import type {
  MarkdownImportDoc,
  MarkdownImportEntry,
  MarkdownImportSkipReason,
  MarkdownTitleSource,
} from '../controllers/markdownImport'
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

export interface MarkdownImportPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 目标笔记本名称，只用于「将导入到哪里」这行提示。 */
  notebookName: string
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 目标笔记本里已有的文档标题：用来标「同名已存在」。 */
  existingTitles: ReadonlySet<string>
  onImport: (docs: MarkdownImportDoc[]) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 行的键：文件名（选文件场景下不会重复；万一重名，两行一起勾选也符合直觉）。 */
function rowKey(entry: MarkdownImportEntry): string {
  return entry.file
}

export function MarkdownImportPanel(props: MarkdownImportPanelProps): ReactElement | null {
  const { open, onOpenChange, notebookName, t, existingTitles, onImport } = props
  const [entries, setEntries] = useState<MarkdownImportEntry[]>([])
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set<string>())
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const backdropDown = useRef(false)

  // 收起即清空：下次打开是干净的「选文件」态
  useEffect(() => {
    if (open) return
    setEntries([])
    setPicked(new Set<string>())
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

  async function loadFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) return
    setBusy(true)
    try {
      const sources = await Promise.all(
        files.map(async (file) => ({ name: file.name, text: await file.text() })),
      )
      const next = buildMarkdownEntries(sources)
      setEntries(next)
      // 默认全勾可导入的：选了 6 个再一个个勾，是纯负担
      setPicked(new Set(next.filter((entry) => entry.doc !== null).map(rowKey)))
    } catch {
      setEntries([])
      setPicked(new Set<string>())
    } finally {
      setBusy(false)
    }
  }

  function onFileChosen(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? [])
    event.target.value = '' // 允许再次选择同一批文件
    void loadFiles(files)
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(false)
    void loadFiles(Array.from(event.dataTransfer.files))
  }

  function toggle(key: string): void {
    const next = new Set(picked)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setPicked(next)
  }

  function confirm(): void {
    const chosen = entries
      .filter((entry) => entry.doc !== null && picked.has(rowKey(entry)))
      .map((entry) => entry.doc as MarkdownImportDoc)
    if (chosen.length === 0) return
    onImport(chosen)
    onOpenChange(false)
  }

  if (!open) return null

  const selectable = entries.filter((entry) => entry.doc !== null)
  const count = entries.filter((entry) => entry.doc !== null && picked.has(rowKey(entry))).length
  const skipped = entries.length - selectable.length

  return createPortal(
    <div
      data-testid="markdown-import-backdrop"
      style={BACKDROP}
      onMouseDown={(event) => {
        backdropDown.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // 只在「按下与抬起都落在遮罩上」才关：拖完文件松手不该把面板关掉
        if (backdropDown.current && event.target === event.currentTarget) close()
        backdropDown.current = false
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('markdownImport.title')}
        data-testid="markdown-import"
        style={PANEL}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={HEAD}>
          <span style={{ display: 'flex', color: ACCENT }}>
            <Icon name="doc" size={14} />
          </span>
          <span style={{ fontSize: fs(14), fontWeight: 500, color: TEXT }}>{t('markdownImport.title')}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="markdown-import-close"
            aria-label={t('markdownImport.cancel')}
            title={t('markdownImport.cancel')}
            onClick={close}
            style={ICON_BUTTON}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div style={{ padding: px('14px 16px 0'), flex: '0 0 auto' }}>
          <div style={{ fontSize: fs(12), color: MUTED, lineHeight: 1.7 }}>
            {t('markdownImport.hint', { notebook: notebookName })}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".md,.markdown,.mdown,.mkd,.mdtext,.txt,text/markdown,text/plain"
            data-testid="markdown-import-file-input"
            style={{ display: 'none' }}
            onChange={onFileChosen}
          />

          <div
            data-testid="markdown-import-dropzone"
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
            <span style={{ flex: 1, fontSize: fs(12), color: SECONDARY }}>
              {t('markdownImport.dropHint')}
            </span>
            <button
              type="button"
              data-testid="markdown-import-choose"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              style={{
                ...BUTTON,
                color: busy ? MUTED : ACCENT,
                borderColor: busy ? BORDER : ACCENT,
              }}
            >
              {busy ? t('markdownImport.reading') : t('markdownImport.choose')}
            </button>
          </div>
        </div>

        {entries.length > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: sp(10), padding: px('12px 16px 6px'), flex: '0 0 auto' }}>
              <span data-testid="markdown-import-count" style={{ fontSize: fs(12), color: SECONDARY }}>
                {t('markdownImport.count', { n: count, total: selectable.length })}
              </span>
              {skipped > 0 ? (
                <span data-testid="markdown-import-skipped" style={{ fontSize: fs(12), color: MUTED }}>
                  {t('markdownImport.skipped', { n: skipped })}
                </span>
              ) : null}
              <span style={{ flex: 1 }} />
              <button
                type="button"
                data-testid="markdown-import-select-all"
                disabled={selectable.length === 0}
                onClick={() => setPicked(new Set(selectable.map(rowKey)))}
                style={{ ...LINK_BUTTON, color: selectable.length === 0 ? MUTED : SECONDARY }}
              >
                {t('markdownImport.selectAll')}
              </button>
              <button
                type="button"
                data-testid="markdown-import-select-none"
                disabled={count === 0}
                onClick={() => setPicked(new Set<string>())}
                style={{ ...LINK_BUTTON, color: count === 0 ? MUTED : SECONDARY }}
              >
                {t('markdownImport.selectNone')}
              </button>
            </div>

            <div
              data-testid="markdown-import-list"
              style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: px('0 10px 10px') }}
            >
              {entries.map((entry) =>
                entry.doc === null ? (
                  <SkippedRow
                    key={rowKey(entry)}
                    entry={entry}
                    reason={entry.skip}
                    t={t}
                  />
                ) : (
                  <DocRow
                    key={rowKey(entry)}
                    entry={entry}
                    doc={entry.doc}
                    checked={picked.has(rowKey(entry))}
                    exists={existingTitles.has(entry.doc.title)}
                    onToggle={() => toggle(rowKey(entry))}
                    t={t}
                  />
                ),
              )}
            </div>
          </>
        ) : (
          <div style={{ flex: 1 }} />
        )}

        <div style={FOOT}>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={close} style={BUTTON} data-testid="markdown-import-cancel">
            {t('markdownImport.cancel')}
          </button>
          <button
            type="button"
            data-testid="markdown-import-confirm"
            disabled={count === 0}
            onClick={confirm}
            style={{
              ...BUTTON,
              color: count === 0 ? MUTED : '#fff',
              borderColor: count === 0 ? BORDER : ACCENT,
              background: count === 0 ? 'transparent' : ACCENT,
            }}
          >
            {count === 0 ? t('markdownImport.importActionEmpty') : t('markdownImport.importAction', { n: count })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function DocRow(props: {
  entry: MarkdownImportEntry
  doc: MarkdownImportDoc
  checked: boolean
  exists: boolean
  onToggle: () => void
  t: (key: MsgKey, params?: TranslateParams) => string
}): ReactElement {
  const { doc, checked, exists, onToggle, t } = props
  return (
    <label
      data-testid="markdown-import-row"
      data-checked={checked ? 'true' : 'false'}
      data-title={doc.title}
      data-source={doc.titleSource}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: sp(10),
        padding: px('9px 8px'),
        borderRadius: sp(8),
        background: checked ? 'var(--oe-row-selected)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ marginTop: sp(2), accentColor: ACCENT }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          data-testid="markdown-import-row-title"
          style={{
            display: 'block',
            fontSize: fs(13),
            color: TEXT,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {doc.title}
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
          {t('markdownImport.meta', {
            lines: doc.lines,
            bytes: formatBytes(doc.bytes),
            file: doc.file,
          })}
        </span>
      </span>
      {exists ? (
        <span data-testid="markdown-import-badge-exists" style={BADGE}>
          {t('markdownImport.exists')}
        </span>
      ) : null}
      <span
        data-testid="markdown-import-badge-source"
        title={sourceHint(doc.titleSource, t)}
        style={BADGE}
      >
        {sourceLabel(doc.titleSource, t)}
      </span>
    </label>
  )
}

function SkippedRow(props: {
  entry: MarkdownImportEntry
  reason: MarkdownImportSkipReason | null
  t: (key: MsgKey, params?: TranslateParams) => string
}): ReactElement {
  const { entry, reason, t } = props
  return (
    <div
      data-testid="markdown-import-row"
      data-skipped={reason ?? 'unknown'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: sp(10),
        padding: px('9px 8px 9px 38px'),
        borderRadius: sp(8),
        opacity: 0.6,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: fs(13),
          color: TEXT,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.file}
      </span>
      <span data-testid="markdown-import-badge-skip" style={{ ...BADGE, color: DANGER, borderColor: DANGER }}>
        {skipLabel(reason, t)}
      </span>
    </div>
  )
}

function sourceLabel(source: MarkdownTitleSource, t: (key: MsgKey) => string): string {
  if (source === 'frontmatter') return t('markdownImport.fromFrontMatter')
  if (source === 'heading') return t('markdownImport.fromHeading')
  return t('markdownImport.fromFilename')
}

function sourceHint(source: MarkdownTitleSource, t: (key: MsgKey) => string): string {
  if (source === 'filename') return t('markdownImport.titleHintFilename')
  return t('markdownImport.titleHint')
}

function skipLabel(reason: MarkdownImportSkipReason | null, t: (key: MsgKey) => string): string {
  if (reason === 'unsupported') return t('markdownImport.skipUnsupported')
  if (reason === 'tooLarge') return t('markdownImport.skipTooLarge')
  if (reason === 'empty') return t('markdownImport.skipEmpty')
  return t('markdownImport.skipUnknown')
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

const HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(8),
  padding: px('0 16px'),
  height: sp(44),
  borderBottom: `1px solid ${BORDER}`,
  flex: '0 0 auto',
}

const FOOT: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(8),
  padding: px('12px 16px'),
  borderTop: `1px solid ${BORDER}`,
  flex: '0 0 auto',
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

const BADGE: CSSProperties = {
  flex: '0 0 auto',
  fontSize: fs(10),
  color: MUTED,
  border: `1px solid ${BORDER}`,
  borderRadius: sp(9),
  padding: px('1px 7px'),
}
