// T54 · DateField：全站唯一的日期输入控件（F10）。
//
// **为什么自己造**：原生 `<input type="date">` 的显示格式跟着浏览器区域设置走
// （zh-CN 是 `2026/10/05`、en-US 是 `10/05/2026`），页面 `lang` 改不动它；而本应用
// 其余所有位置显示的都是裸 ISO 串。于是同一个库里出现两套日期写法，还随用户浏览器
// 变化。接管之后：显示恒为 `YYYY-MM-DD`，输入有掩码，校验在 `dateInput.ts` 的纯函数里。
//
// 交互口径：
// - **只在解析成功后提交**。边打边提交会让 `2026-1` 这种半截文本写进库；
//   打错成 `2026-02-30` 时保留原文并就地提示，失焦才回退到上次提交的值。
// - 日历用 `position: fixed` + 视口钳制，而不是挂在父级里：FilterBar 的面板
//   `overflow-y: auto`（计算后 x 轴也成了 auto），绝对定位的浮层会被裁掉并顶出滚动条。
// - 键盘：输入框 Enter 提交 / Esc 回退 / Alt+↓ 开日历；网格内方向键按天移动，
//   Esc 关闭并把焦点交回输入框。

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import type { MsgKey, TranslateParams } from '../locales/i18n'
import { currentUiScale, fs, sp } from '../styles/scale'
import { Icon } from './IconSprite'
import {
  buildMonthGrid,
  maskDateInput,
  monthKey,
  parseDateDraft,
  shiftIsoDate,
  shiftIsoMonth,
  todayIso,
} from './dateInput'

const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const BORDER = 'var(--oe-border)'
const SURFACE = 'var(--oe-surface)'
const ACCENT = 'var(--oe-accent)'
const DANGER = 'var(--oe-overdue)'

/** 日历单元格基准边长（缩放前）。浮层尺寸与位置估算都用它，别在两处各写一份。 */
const CELL = 26
const POPOVER_Z = 40

export interface DateFieldProps {
  testId: string
  ariaLabel: string
  /** 已提交的值：`''` 或 `YYYY-MM-DD`。 */
  value: string
  onCommit: (next: string) => void
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 外层容器（决定 flex 占位）。 */
  style?: CSSProperties
  /** 输入框本身的外观，各处沿用各自的 INPUT 常量。 */
  inputStyle?: CSSProperties
  placeholder?: string
  /** 注入今天，便于测试冻结时钟；省略时取系统日期。 */
  today?: string
  disabled?: boolean
}

interface Anchor {
  left: number
  top: number
}

/** 浮层的估算尺寸：月份头 + 星期行 + 6 行格子 + 底部两个动作（含 2px 列间距）。 */
function estimatePopoverSize(): { width: number; height: number } {
  const scale = currentUiScale()
  return {
    width: (7 * CELL + 6 * 2 + 20) * scale,
    height: (20 + 6 + 14 + 6 + (6 * CELL + 5 * 2) + 6 + 24 + 20) * scale,
  }
}

/** 贴着输入框右侧展开；下方放不下就翻到上方，左右按视口钳制（与右键菜单同一套办法）。 */
function placePopover(rect: DOMRect): Anchor {
  const scale = currentUiScale()
  const { width, height } = estimatePopoverSize()
  const margin = 8 * scale
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, viewportWidth - width - margin),
  )
  const below = rect.bottom + 4 * scale
  const above = rect.top - height - 4 * scale
  return { left, top: below + height + margin > viewportHeight ? Math.max(margin, above) : below }
}

export function DateField(props: DateFieldProps) {
  const { testId, t } = props
  const [draft, setDraft] = useState(props.value)
  const [invalid, setInvalid] = useState(false)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [viewMonth, setViewMonth] = useState(() => monthKey(props.today ?? todayIso()))

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<string | null>(null)

  const open = anchor !== null
  const today = props.today ?? todayIso()

  // 外部改值（撤销、切任务、清空筛选）时同步回输入框。
  useEffect(() => {
    setDraft(props.value)
  }, [props.value])

  // 方向键跨月时网格要先重渲染，焦点等渲染完再交过去。
  useEffect(() => {
    const iso = pendingFocus.current
    if (iso === null) return
    pendingFocus.current = null
    const target = popoverRef.current?.querySelector(`[data-date="${iso}"]`)
    if (target instanceof HTMLElement) target.focus()
  }, [viewMonth, open])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent): void {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target) === true) return
      if (rootRef.current?.contains(target) === true) return
      setAnchor(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  /**
   * 「日分组已经满 2 位」才算打完。
   *
   * 不能只判断「解析成功」：`2026-02-3` 本身就是一个合法日期，若此刻就提交，
   * 提交会把它归一化成 `2026-02-03`，用户接着敲的第四位数字就接不上了
   * （打 `20260230` 会得到 `2026-02-03`）。所以边打边提交的门槛是「日的两位都到齐」，
   * 补零与归一化留到失焦 / Enter / 选日历这几种明确的收尾动作上。
   */
  function isCompleteDraft(text: string): boolean {
    const groups = text.split('-')
    return groups.length === 3 && (groups[2]?.length ?? 0) === 2
  }

  function commit(next: string): void {
    setDraft(next)
    setInvalid(false)
    if (next !== props.value) props.onCommit(next)
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const text = maskDateInput(event.target.value)
    setDraft(text)
    const parsed = parseDateDraft(text)
    if (parsed.kind === 'empty') {
      commit('')
      return
    }
    if (parsed.kind === 'valid' && isCompleteDraft(text)) {
      commit(parsed.value)
      return
    }
    // 半截文本（`2026-1`）不报错也不提交——用户还在打；打满 10 位仍不合法才算错。
    setInvalid(text.length >= 10)
  }

  /** 失焦：合法就收尾（顺手补零），不合法或没打完就回到上次提交的值。 */
  function settle(): void {
    const parsed = parseDateDraft(draft)
    if (parsed.kind === 'valid') {
      commit(parsed.value)
      return
    }
    if (parsed.kind === 'empty') {
      commit('')
      return
    }
    revert()
  }

  function revert(): void {
    setDraft(props.value)
    setInvalid(false)
  }

  function openCalendar(): void {
    const rect = (inputRef.current ?? rootRef.current)?.getBoundingClientRect()
    setViewMonth(monthKey(props.value !== '' ? props.value : today))
    setAnchor(rect === undefined ? { left: 0, top: 0 } : placePopover(rect))
  }

  function closeCalendar(focusInput: boolean): void {
    setAnchor(null)
    if (focusInput) inputRef.current?.focus()
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      settle()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      revert()
      return
    }
    if (event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault()
      openCalendar()
    }
  }

  function selectDate(next: string): void {
    commit(next)
    if (next !== '') setViewMonth(monthKey(next))
    closeCalendar(true)
  }

  function handleGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeCalendar(true)
      return
    }
    const stepByKey: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    }
    const step = stepByKey[event.key]
    if (step === undefined) return
    event.preventDefault()
    const active = document.activeElement
    const from =
      active instanceof HTMLElement && active.dataset.date !== undefined
        ? active.dataset.date
        : props.value !== ''
          ? props.value
          : today
    const next = shiftIsoDate(from, step)
    if (monthKey(next) !== viewMonth) {
      pendingFocus.current = next
      setViewMonth(monthKey(next))
      return
    }
    const target = popoverRef.current?.querySelector(`[data-date="${next}"]`)
    if (target instanceof HTMLElement) target.focus()
  }

  const cells = buildMonthGrid(`${viewMonth}-01`)
  const weekdays = t('dateField.weekdays').split(' ')

  return (
    <div
      ref={rootRef}
      style={{ position: 'relative', display: 'flex', minWidth: 0, ...props.style }}
    >
      <input
        ref={inputRef}
        data-testid={testId}
        // 刻意不是 type="date"：原生控件的显示格式由浏览器区域设置决定（F10 的根因）
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        aria-label={props.ariaLabel}
        aria-invalid={invalid ? true : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        placeholder={props.placeholder ?? 'YYYY-MM-DD'}
        value={draft}
        disabled={props.disabled}
        onChange={handleChange}
        onBlur={() => {
          settle()
        }}
        onKeyDown={handleKeyDown}
        style={{ ...props.inputStyle, paddingRight: sp(22), cursor: 'text' }}
      />
      <button
        type="button"
        data-testid={`${testId}-calendar`}
        aria-label={t('dateField.openCalendar')}
        tabIndex={-1}
        disabled={props.disabled}
        onClick={() => {
          if (open) closeCalendar(true)
          else openCalendar()
        }}
        style={{
          position: 'absolute',
          right: sp(2),
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: sp(18),
          height: sp(18),
          padding: 0,
          background: 'transparent',
          border: 'none',
          borderRadius: 'var(--oe-radius-control)',
          color: open ? ACCENT : MUTED,
          cursor: 'pointer',
        }}
      >
        <Icon name="calendar" size={12} />
      </button>

      {invalid ? (
        <span
          data-testid={`${testId}-invalid`}
          style={{
            position: 'absolute',
            left: 0,
            top: '100%',
            marginTop: sp(2),
            fontSize: fs(10),
            color: DANGER,
            whiteSpace: 'nowrap',
          }}
        >
          {t('dateField.invalid')}
        </span>
      ) : null}

      {/* 挂到 body：外壳的 backdrop-filter 会给 position:fixed 造一个包含块，
          留在原地时 left/top 会按面板而不是视口解析（实测整体下移 200px 且溢出屏幕） */}
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label={t('dateField.calendar')}
              data-testid={`${testId}-popover`}
          onKeyDown={handleGridKeyDown}
          style={{
            position: 'fixed',
            left: anchor.left,
            top: anchor.top,
            zIndex: POPOVER_Z,
            padding: sp(10),
            background: SURFACE,
            border: `1px solid ${BORDER}`,
            borderRadius: 'var(--oe-radius-overlay)',
            boxShadow: 'var(--oe-shadow-hover)',
            display: 'flex',
            flexDirection: 'column',
            gap: sp(6),
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: sp(4) }}>
            <NavButton
              testId={`${testId}-prev-month`}
              label={t('dateField.previousMonth')}
              flipped
              onClick={() => setViewMonth(monthKey(shiftIsoMonth(`${viewMonth}-01`, -1)))}
            />
            <span
              data-testid={`${testId}-month`}
              style={{
                flex: '1 1 auto',
                textAlign: 'center',
                fontSize: fs(12),
                fontWeight: 600,
                color: TEXT,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {viewMonth}
            </span>
            <NavButton
              testId={`${testId}-next-month`}
              label={t('dateField.nextMonth')}
              onClick={() => setViewMonth(monthKey(shiftIsoMonth(`${viewMonth}-01`, 1)))}
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(7, ${sp(CELL)})`,
              gap: sp(2),
            }}
          >
            {weekdays.map((label, index) => (
              <span
                key={`${label}-${String(index)}`}
                style={{ fontSize: fs(10), color: MUTED, textAlign: 'center' }}
              >
                {label}
              </span>
            ))}
          </div>

          <div
            data-testid={`${testId}-grid`}
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(7, ${sp(CELL)})`,
              gap: sp(2),
            }}
          >
            {cells.map((cell) => {
              const selected = cell.iso === props.value
              const isToday = cell.iso === today
              return (
                <button
                  key={cell.iso}
                  type="button"
                  data-date={cell.iso}
                  data-testid={`${testId}-day-${cell.iso}`}
                  aria-pressed={selected}
                  aria-current={isToday ? 'date' : undefined}
                  onClick={() => selectDate(cell.iso)}
                  style={{
                    width: sp(CELL),
                    height: sp(CELL),
                    padding: 0,
                    fontSize: fs(11),
                    fontVariantNumeric: 'tabular-nums',
                    color: selected ? SURFACE : cell.inMonth ? TEXT : MUTED,
                    background: selected ? ACCENT : 'transparent',
                    border:
                      isToday && !selected ? `1px solid ${ACCENT}` : '1px solid transparent',
                    borderRadius: 'var(--oe-radius-control)',
                    cursor: 'pointer',
                    opacity: cell.inMonth ? 1 : 0.55,
                  }}
                >
                  {cell.day}
                </button>
              )
            })}
          </div>

          <div style={{ display: 'flex', gap: sp(6), borderTop: `1px solid ${BORDER}`, paddingTop: sp(6) }}>
            <FooterButton
              testId={`${testId}-today`}
              label={t('dateField.today')}
              onClick={() => selectDate(today)}
            />
            <FooterButton
              testId={`${testId}-clear`}
              label={t('dateField.clear')}
              onClick={() => selectDate('')}
            />
          </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function NavButton(props: {
  testId: string
  label: string
  flipped?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={props.label}
      onClick={props.onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: sp(18),
        height: sp(18),
        padding: 0,
        background: 'transparent',
        border: 'none',
        borderRadius: 'var(--oe-radius-control)',
        color: SECONDARY,
        cursor: 'pointer',
        // sprite 里的 chevron 朝下：顺时针 90° 变「上个月」，逆时针 90° 变「下个月」
        transform: props.flipped === true ? 'rotate(90deg)' : 'rotate(-90deg)',
      }}
    >
      <Icon name="chevron" size={12} />
    </button>
  )
}

function FooterButton(props: { testId: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      onClick={props.onClick}
      style={{
        flex: '1 1 0',
        padding: sp(3),
        fontSize: fs(11),
        color: SECONDARY,
        background: 'transparent',
        border: `1px solid ${BORDER}`,
        borderRadius: 'var(--oe-radius-control)',
        cursor: 'pointer',
      }}
    >
      {props.label}
    </button>
  )
}
