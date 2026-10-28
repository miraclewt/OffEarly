// T64 · 笔记展示模式：按二级标题一页一页地看，而不是在长文档里滚动。
//
// 为什么是「全屏浮层 + 单页只读编辑器」而不是「在正文里插分页符」：
//   · 分页是**只读派生**，不该写进 vault（否则每按一次演示都要进撤销栈）；
//   · 每页仍由 NoteEditor 的只读实例渲染，于是图片、表格、Mermaid、链接、任务列表
//     全部和编辑态同一套渲染路径——不存在「演示态少了某样东西」的分叉；
//   · 浮层 createPortal 到 body：外壳的 backdrop-filter 会给 position:fixed 造包含块
//     （DateField / 会议导入面板踩过同一个坑）。
//
// 层极取 45：高于任务弹窗（25）、低于灯箱（60）——演示时点开大图仍然应该盖在上面。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { MsgKey, TranslateParams } from '../locales/i18n'
import { fs, px, sp } from '../styles/scale'
import { Icon } from './IconSprite'
import { NoteEditor } from './NoteEditor'
import type { NoteAssetsPort, NoteLinkTarget } from './NoteEditor'
import { splitNotePages } from './notePages'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const ACCENT = 'var(--oe-accent)'
const SURFACE = 'var(--oe-surface)'

export interface NotePresenterProps {
  open: boolean
  /** 文档标题（页眉左侧）。 */
  title: string
  /** 全文 Markdown；分页在组件内部派生，调用方只负责给「要展示的这一刻」的正文。 */
  markdown: string
  assets?: NoteAssetsPort
  fontSize?: number
  linkTargets?: readonly NoteLinkTarget[]
  onNavigate?: (title: string, matches: readonly NoteLinkTarget[]) => void
  onClose: () => void
  t?: (key: MsgKey, params?: TranslateParams) => string
}

export function NotePresenter(props: NotePresenterProps): ReactElement | null {
  const { open, title, markdown, assets, fontSize } = props
  const t = props.t ?? ((key: MsgKey) => key)
  const [index, setIndex] = useState(0)
  const backdropDown = useRef(false)

  // 分页只在打开时算：解析整篇 Markdown 有成本，关着的时候不该跟着每次输入重跑
  const pages = useMemo(() => (open ? splitNotePages(markdown) : []), [open, markdown])

  // 换文档 / 重新打开都从第一页开始；正文变短时把越界的页码夹回来
  useEffect(() => {
    setIndex(0)
  }, [open, markdown])

  const total = pages.length
  const current = total === 0 ? 0 : Math.min(index, total - 1)

  useEffect(() => {
    if (!open) return
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        props.onClose()
        return
      }
      if (total === 0) return
      const last = total - 1
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault()
        setIndex((value) => Math.min(last, value + 1))
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        setIndex((value) => Math.max(0, value - 1))
      } else if (event.key === 'Home') {
        event.preventDefault()
        setIndex(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setIndex(last)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, total, props])

  if (!open) return null

  const page = pages[current]
  const atStart = current === 0
  const atEnd = current >= total - 1

  return createPortal(
    <div
      data-testid="note-present-backdrop"
      style={BACKDROP}
      onMouseDown={(event) => {
        backdropDown.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // 按下与抬起都落在遮罩上才关：选中文字拖到遮罩外松手不算「点外面」
        if (backdropDown.current && event.target === event.currentTarget) props.onClose()
        backdropDown.current = false
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('notebook.present')}
        data-testid="note-present"
        style={PANEL}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={HEADER}>
          <span style={{ display: 'flex', color: ACCENT }}>
            <Icon name="present" size={14} />
          </span>
          <span data-testid="note-present-title" style={HEADER_TITLE}>
            {title}
          </span>
          <span style={{ flex: 1 }} />
          <span data-testid="note-present-counter" style={COUNTER}>
            {t('notebook.presentPage', { n: current + 1, total: Math.max(total, 1) })}
          </span>
          <button
            type="button"
            data-testid="note-present-close"
            aria-label={t('notebook.presentClose')}
            title={t('notebook.presentClose')}
            onClick={props.onClose}
            style={ICON_BUTTON}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        <div data-testid="note-present-body" style={BODY}>
          <div style={READING}>
            {page === undefined ? null : (
              <NoteEditor
                // 每页一个新实例：只读态在挂载时确定，切页就是换内容（也顺手复位了滚动位置）
                key={`${current}:${page.markdown.length}`}
                value={page.markdown}
                onCommit={() => undefined}
                readOnly
                grow
                assets={assets}
                linkTargets={props.linkTargets}
                onNavigate={props.onNavigate}
                fontSize={fontSize}
                showStats={false}
                minHeight={0}
                t={t}
                style={{ border: 'none', background: 'transparent' }}
              />
            )}
          </div>
        </div>

        <div style={FOOTER}>
          <button
            type="button"
            data-testid="note-present-prev"
            aria-label={t('notebook.presentPrev')}
            title={t('notebook.presentPrev')}
            disabled={atStart}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
            style={{ ...NAV_BUTTON, ...(atStart ? NAV_BUTTON_OFF : null) }}
          >
            <span style={CHEVRON_LEFT}>
              <Icon name="chevron" size={13} />
            </span>
            <span>{t('notebook.presentPrev')}</span>
          </button>
          <span data-testid="note-present-section" style={SECTION}>
            {page?.title === undefined || page.title === '' ? t('notebook.presentIntro') : page.title}
          </span>
          <button
            type="button"
            data-testid="note-present-next"
            aria-label={t('notebook.presentNext')}
            title={t('notebook.presentNext')}
            disabled={atEnd}
            onClick={() => setIndex((value) => Math.min(total - 1, value + 1))}
            style={{ ...NAV_BUTTON, ...(atEnd ? NAV_BUTTON_OFF : null) }}
          >
            <span>{t('notebook.presentNext')}</span>
            <span style={CHEVRON_RIGHT}>
              <Icon name="chevron" size={13} />
            </span>
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
  zIndex: 45,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--oe-scrim)',
}

const PANEL: CSSProperties = {
  width: 'min(960px, calc(100vw - 48px))',
  height: 'min(760px, calc(100vh - 64px))',
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

const HEADER_TITLE: CSSProperties = {
  fontSize: fs(13),
  fontWeight: 550,
  color: TEXT,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: sp(420),
}

const COUNTER: CSSProperties = {
  fontSize: fs(11),
  color: MUTED,
  fontVariantNumeric: 'tabular-nums',
  flex: '0 0 auto',
}

const BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  justifyContent: 'center',
  // 上下留白让正文不贴边，同时保证滚动条属于这一层
  padding: px('18px 20px'),
  overflowY: 'auto',
  background: 'var(--oe-bg)',
}

/** 阅读宽度固定 760（与知识库编辑区同口径），太宽的行长读起来会跳行。 */
const READING: CSSProperties = {
  width: '100%',
  maxWidth: 760,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
}

const FOOTER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: sp(10),
  padding: px('8px 14px'),
  flex: '0 0 auto',
  borderTop: `1px solid ${BORDER}`,
}

const SECTION: CSSProperties = {
  flex: 1,
  minWidth: 0,
  textAlign: 'center',
  fontSize: fs(11),
  color: SECONDARY,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const NAV_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(4),
  height: sp(28),
  padding: px('0 10px'),
  fontSize: fs(11),
  color: TEXT,
  background: 'transparent',
  border: `1px solid ${BORDER}`,
  borderRadius: sp(8),
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const NAV_BUTTON_OFF: CSSProperties = {
  opacity: 0.45,
  cursor: 'default',
}

/** chevron 的几何图形朝下；旋转 90° 得到「上一页」，-90° 得到「下一页」。 */
const CHEVRON_LEFT: CSSProperties = { display: 'flex', transform: 'rotate(90deg)' }
const CHEVRON_RIGHT: CSSProperties = { display: 'flex', transform: 'rotate(-90deg)' }

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
