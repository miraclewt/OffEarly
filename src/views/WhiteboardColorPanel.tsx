// T70 · 白板的色块面板（选中图元后从工具栏弹出）。
//
// 为什么要有「语义色 + 自定义色」两层：
//   - 语义色（plain/accent/ok/warn/danger/muted）表达「这一格是干什么的」，走 CSS 令牌，
//     深浅主题自动跟随；模板与新建图元都用它。
//   - 自定义色表达「我就要这个颜色」，是**用户数据**，落盘成 `#rrggbb` 字面量，主题不参与。
//
// 面板必须 createPortal 到 body：工具栏是 `overflow-x: auto` 的滚动容器（横轴一滚就会把
// 溢出的浮层裁掉），面板挂在工具栏内部会被剪成一条。同一坑 DateField 的日历浮层踩过。
//
// 字色不在面板里给用户挑：由底色算（见 domain/whiteboardModel 的 readableInk）。让用户
// 同时挑底与字，必然造出「白底白字」，而这种错误用户自己是看不见的。

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { WHITEBOARD_SWATCHES, normalizeHex } from '../domain/whiteboardModel'
import type { WhiteboardNode, WhiteboardNodePatch, WhiteboardTone } from '../domain/types'
import type { MsgKey } from '../locales/i18n'
import { fs, px, pxNum, sp } from '../styles/scale'
import { TONE_ORDER, tonePaint } from './whiteboardPaint'

const TONE_LABEL: Record<WhiteboardTone, MsgKey> = {
  plain: 'whiteboard.tonePlain',
  muted: 'whiteboard.toneMuted',
  accent: 'whiteboard.toneAccent',
  ok: 'whiteboard.toneOk',
  warn: 'whiteboard.toneWarn',
  danger: 'whiteboard.toneDanger',
}

const PANEL_WIDTH = 268

export interface WhiteboardColorPanelProps {
  /** 当前选中的图元（至少一个） */
  nodes: readonly WhiteboardNode[]
  /** 一次点击 → 一条命令（批量时是同一条撤销项） */
  onPatch: (patch: WhiteboardNodePatch) => void
  t: (key: MsgKey) => string
}

export function WhiteboardColorPanel(props: WhiteboardColorPanelProps): ReactElement {
  const { nodes, onPatch, t } = props
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const [hexDraft, setHexDraft] = useState('')
  const [hexError, setHexError] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const first = nodes[0]
  const sameFill = nodes.every((node) => node.fill === first?.fill)
  const sameTone = nodes.every((node) => node.tone === first?.tone)
  const activeFill = sameFill ? first?.fill : undefined
  const activeTone = sameTone && activeFill === undefined ? first?.tone : undefined

  // 打开时量一次锚点（工具栏会横向滚，量在开的那一刻就够：面板开着时用户不会同时滚工具栏）
  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const width = pxNum(PANEL_WIDTH)
    setAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: rect.bottom + 6,
    })
  }, [open])

  // 关掉面板：Esc、面板外按下、窗口尺寸变化（锚点会失准）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (panelRef.current?.contains(target) === true) return
      if (triggerRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onResize = (): void => setOpen(false)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const triggerChip = activeFill ?? (activeTone === undefined ? null : tonePaint(activeTone).background)

  const submitHex = (): void => {
    const normalized = normalizeHex(hexDraft)
    if (normalized === null) {
      setHexError(true)
      return
    }
    setHexError(false)
    onPatch({ fill: normalized })
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="whiteboard-color"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('whiteboard.color')}
        onClick={() => {
          setHexError(false)
          setHexDraft(activeFill ?? '')
          setOpen((value) => !value)
        }}
        style={triggerStyle}
      >
        <span
          data-testid="whiteboard-color-chip"
          aria-hidden="true"
          style={{
            width: sp(12),
            height: sp(12),
            borderRadius: sp(3),
            // 没选中统一色时给一块斜纹，表示「颜色不一致」
            background: triggerChip ?? 'repeating-linear-gradient(45deg, var(--oe-border) 0 3px, transparent 3px 6px)',
            border: '1px solid var(--oe-border)',
            flex: '0 0 auto',
          }}
        />
        <span>{t('whiteboard.color')}</span>
      </button>

      {open && anchor !== null
        ? createPortal(
              <div
                ref={panelRef}
                data-testid="whiteboard-color-panel"
                role="dialog"
                aria-label={t('whiteboard.color')}
                style={{ ...panelStyle, left: anchor?.left ?? 0, top: anchor?.top ?? 0 }}
                // portal 仍在 WhiteboardView 的 React 树里：面板上的 Delete 会一路冒泡到视图的
                // 全局快捷键，把正在上色的图元删掉。这里把它吃掉。
                onKeyDown={(event) => {
                  if (event.key === 'Delete' || event.key === 'Backspace') event.stopPropagation()
                }}
              >
                <div style={sectionLabelStyle}>{t('whiteboard.colorTone')}</div>
                <div style={gridStyle}>
                  {TONE_ORDER.map((tone) => {
                    const paint = tonePaint(tone)
                    return (
                      <button
                        key={tone}
                        type="button"
                        data-testid={`whiteboard-tone-${tone}`}
                        aria-label={t(TONE_LABEL[tone])}
                        aria-pressed={activeTone === tone}
                        title={t(TONE_LABEL[tone])}
                        onClick={() => onPatch({ tone, fill: null })}
                        style={{
                          ...swatchStyle,
                          background: paint.background,
                          border: `1px solid ${paint.border}`,
                          ...(activeTone === tone ? activeRingStyle : {}),
                        }}
                      />
                    )
                  })}
                </div>

                <div style={sectionLabelStyle}>{t('whiteboard.colorCustom')}</div>
                <div style={gridStyle}>
                  {WHITEBOARD_SWATCHES.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      data-testid={`whiteboard-swatch-${hex.slice(1)}`}
                      aria-label={hex}
                      aria-pressed={activeFill === hex}
                      title={hex}
                      onClick={() => onPatch({ fill: hex })}
                      style={{
                        ...swatchStyle,
                        background: hex,
                        border: '1px solid rgba(0, 0, 0, 0.14)',
                        ...(activeFill === hex ? activeRingStyle : {}),
                      }}
                    />
                  ))}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: sp(6), marginTop: sp(8) }}>
                  <input
                    data-testid="whiteboard-color-hex"
                    aria-label={t('whiteboard.colorHex')}
                    placeholder="#RRGGBB"
                    value={hexDraft}
                    onChange={(event) => {
                      setHexDraft(event.target.value)
                      setHexError(false)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        submitHex()
                      }
                    }}
                    style={{
                      flex: '1 1 auto',
                      minWidth: 0,
                      padding: px('2px 8px'),
                      fontFamily: 'inherit',
                      fontSize: fs(12),
                      lineHeight: px('20px'),
                      color: 'var(--oe-text)',
                      background: 'var(--oe-surface)',
                      border: `1px solid ${hexError ? 'var(--oe-overdue)' : 'var(--oe-border)'}`,
                      borderRadius: 'var(--oe-radius-control)',
                    }}
                  />
                  <button
                    type="button"
                    data-testid="whiteboard-color-apply"
                    onClick={submitHex}
                    style={smallButtonStyle}
                  >
                    {t('whiteboard.colorApply')}
                  </button>
                </div>
                {hexError ? (
                  <div data-testid="whiteboard-color-error" style={{ marginTop: sp(4), fontSize: fs(11), color: 'var(--oe-overdue)' }}>
                    {t('whiteboard.colorHexInvalid')}
                  </div>
                ) : null}

                <button
                  type="button"
                  data-testid="whiteboard-color-clear"
                  onClick={() => {
                    setHexError(false)
                    setHexDraft('')
                    onPatch({ tone: 'plain', fill: null })
                  }}
                  style={{ ...smallButtonStyle, width: '100%', marginTop: sp(8) }}
                >
                  {t('whiteboard.colorClear')}
                </button>
              </div>,
              document.body,
            )
          : null}
    </>
  )
}

const triggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: sp(5),
  padding: px('2px 10px'),
  fontSize: fs(12),
  lineHeight: px('20px'),
  color: 'var(--oe-text)',
  background: 'var(--oe-fill)',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 30,
  width: sp(PANEL_WIDTH),
  boxSizing: 'border-box',
  padding: sp(10),
  background: 'var(--oe-surface)',
  border: '1px solid var(--oe-border)',
  borderRadius: 'var(--oe-radius-card)',
  boxShadow: 'var(--oe-shadow-hover)',
}

const sectionLabelStyle: CSSProperties = {
  fontSize: fs(11),
  color: 'var(--oe-text-muted)',
  marginBottom: sp(4),
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(7, 1fr)',
  gap: sp(5),
}

const swatchStyle: CSSProperties = {
  width: '100%',
  aspectRatio: '1 / 1',
  padding: 0,
  borderRadius: sp(4),
  cursor: 'pointer',
  boxSizing: 'border-box',
}

/** 选中态描边走 outline，不占布局——否则被选中的色块会比邻居小一圈。 */
const activeRingStyle: CSSProperties = {
  outline: '2px solid var(--oe-accent)',
  outlineOffset: 1,
}

const smallButtonStyle: CSSProperties = {
  padding: px('2px 10px'),
  fontSize: fs(12),
  lineHeight: px('20px'),
  color: 'var(--oe-text)',
  background: 'var(--oe-fill)',
  border: 'none',
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
}
