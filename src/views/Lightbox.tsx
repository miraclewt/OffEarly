// T25 · Lightbox：笔记图片的预览浮层（spec 6.4「图片点击 → 灯箱预览（原图、缩放、下载）」）。
//
// 纯视图：不碰文件系统、不碰 store。src 由宿主给（blob URL，file:// 下唯一能显示的形态），
// 组件只负责「看清楚」——缩放是 transform 而不是改 img 尺寸（原图下载必须拿到未缩放的字节），
// 下载走 `<a download>`：href 是 blob URL，浏览器直接落盘，不经过任何网络请求。
//
// 可挂载性：默认导出 + 显式 props，文案经 `t` 注入（省缺时中文兜底），
// 与 ConflictDialog / SafeModeBanner 同一手法，接线归集成窗口。

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react'

import { createI18n } from '../locales/i18n'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { Icon } from './IconSprite'

const SURFACE = 'var(--oe-surface)'
const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'
const RADIUS_CARD = 'var(--oe-radius-card)'
const RADIUS_CONTROL = 'var(--oe-radius-control)'

/** 缩放档位的上下界：低于 0.25 看不清，高于 4 已远超原图像素密度。 */
const MIN_SCALE = 0.25
const MAX_SCALE = 4
const SCALE_STEP = 1.25

export interface LightboxProps {
  open: boolean
  /** 显示用 URL（blob URL）。 */
  src: string
  alt?: string
  /** 下载时用的文件名；省缺时从 src 末段推导。 */
  filename?: string
  onClose: () => void
  t?: (key: MsgKey, params?: TranslateParams) => string
}

const fallbackI18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })

function clampScale(next: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(next.toFixed(3))))
}

function nameOf(src: string): string {
  const tail = src.slice(src.lastIndexOf('/') + 1)
  return tail === '' ? 'image' : tail
}

export function Lightbox(props: LightboxProps): ReactElement | null {
  const t = props.t ?? fallbackI18n.t
  const [scale, setScale] = useState(1)

  // 换图即回 100%：连看两张图时保留上一张的缩放没意义（尺寸不同，倍率也不同）。
  useEffect(() => {
    setScale(1)
  }, [props.src])

  const close = useCallback(() => props.onClose(), [props])

  useEffect(() => {
    if (!props.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        props.onClose()
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        setScale((current) => clampScale(current * SCALE_STEP))
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        setScale((current) => clampScale(current / SCALE_STEP))
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        setScale(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [props.open, props.onClose])

  if (!props.open) return null

  const filename = props.filename ?? nameOf(props.src)

  const onBackdropClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    // 只有点在遮罩本身才关闭：图片周围一圈留白属于浮层，误点不该丢掉当前预览。
    if (event.target !== event.currentTarget) return
    props.onClose()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') props.onClose()
  }

  return (
    <div
      data-testid="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('lightbox.title')}
      onClick={onBackdropClick}
      onKeyDown={onKeyDown}
      style={BACKDROP}
    >
      <div data-testid="lightbox-panel" style={PANEL}>
        <div style={HEADER}>
          <span data-testid="lightbox-filename" style={FILENAME} title={filename}>
            {filename}
          </span>
          <span data-testid="lightbox-scale" style={SCALE_TEXT}>
            {t('lightbox.zoomLevel', { n: String(Math.round(scale * 100)) })}
          </span>
          <div style={ACTIONS}>
            <button
              type="button"
              data-testid="lightbox-zoom-out"
              aria-label={t('lightbox.zoomOut')}
              title={t('lightbox.zoomOut')}
              onClick={() => setScale((current) => clampScale(current / SCALE_STEP))}
              style={ICON_BUTTON}
            >
              <Icon name="zoom-out" size={15} />
            </button>
            <button
              type="button"
              data-testid="lightbox-reset"
              aria-label={t('lightbox.reset')}
              title={t('lightbox.reset')}
              onClick={() => setScale(1)}
              style={ICON_BUTTON}
            >
              <span style={RESET_TEXT}>{t('lightbox.zoomLevel', { n: '100' })}</span>
            </button>
            <button
              type="button"
              data-testid="lightbox-zoom-in"
              aria-label={t('lightbox.zoomIn')}
              title={t('lightbox.zoomIn')}
              onClick={() => setScale((current) => clampScale(current * SCALE_STEP))}
              style={ICON_BUTTON}
            >
              <Icon name="zoom-in" size={15} />
            </button>
            <a
              data-testid="lightbox-download"
              href={props.src}
              download={filename}
              aria-label={t('lightbox.download')}
              title={t('lightbox.download')}
              style={{ ...ICON_BUTTON, textDecoration: 'none' }}
            >
              <Icon name="download" size={15} />
            </a>
            <button
              type="button"
              data-testid="lightbox-close"
              aria-label={t('lightbox.close')}
              title={t('lightbox.close')}
              onClick={close}
              style={ICON_BUTTON}
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        </div>

        <div style={STAGE}>
          <img
            data-testid="lightbox-image"
            src={props.src}
            alt={props.alt ?? filename}
            style={{ ...IMAGE, transform: `scale(${scale})` }}
          />
        </div>
      </div>
    </div>
  )
}

const BACKDROP: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  background: 'var(--oe-scrim)',
}

const PANEL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  maxWidth: 960,
  maxHeight: 720,
  overflow: 'hidden',
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: RADIUS_CARD,
  boxShadow: 'var(--oe-shadow-hover)',
}

const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderBottom: `1px solid ${BORDER}`,
  fontSize: 12,
  color: TEXT,
}

const FILENAME: CSSProperties = {
  maxWidth: 320,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const SCALE_TEXT: CSSProperties = {
  minWidth: 44,
  fontSize: 11,
  color: MUTED,
}

const ACTIONS: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  marginLeft: 'auto',
}

const ICON_BUTTON: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 24,
  height: 24,
  padding: '0 4px',
  color: MUTED,
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: RADIUS_CONTROL,
  cursor: 'pointer',
}

const RESET_TEXT: CSSProperties = {
  fontSize: 11,
}

const STAGE: CSSProperties = {
  display: 'flex',
  flex: 1,
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'auto',
  padding: 12,
  background: 'var(--oe-fill)',
}

const IMAGE: CSSProperties = {
  maxWidth: '100%',
  maxHeight: '100%',
  objectFit: 'contain',
  transformOrigin: 'center',
  transition: 'transform 80ms ease-out',
}

export default Lightbox
