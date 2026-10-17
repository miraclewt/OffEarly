// T35 · SettingsPanel：设置面板。
//
// 入口：侧栏底部「设置」（T14 的 onOpenSettings，此前是 shell.panelPending 占位）。
// 覆盖面：spec 4.2 里 settings 六项中面向用户的四项——语言（locale）、主题（theme，只读展示）、
// 甘特图默认刻度（ganttScale）、工作日历（calendar）；lastFilter 由筛选器面板维护，
// boardColumns 由 spec 12 定为不可自定义（固定四列），二者在这里只做只读呈现。
// 末尾附「关于」：库标识 / 修订号 / 版本 / 计数，给单文件本地库一个自查入口。
//
// 分层：纯视图 —— 零文件系统调用（spec 3 硬规则 1），写入一律交 controllers/settingsActions.ts，
// 命令经 T10 CommandBus（settings.patch）→ Store → T08 autosave 落盘。
// 因此每个设置项都可撤销：Ctrl+Z 会把整块字段还原（逆 patch 按 key 回滚，不留半新半旧）。
//
// 视觉：颜色一律取 --oe-* token（T30 的 theme.css 是唯一色彩源），圆角两档、无渐变、无 emoji。

import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useStore } from 'zustand'

import {
  WEEK_ORDER,
  addCalendarDate,
  canToggleWorkday,
  isCalendarDate,
  isWorkdaySet,
  patchCalendar,
  patchGanttScale,
  patchLocale,
  removeCalendarDate,
  toggleWorkday,
} from '../controllers/settingsActions'
import type { CalendarDateList } from '../controllers/settingsActions'
import type { CommandBus } from '../domain/commandBus'
import type { VaultStore } from '../domain/store'
import type { GanttScale, LocaleSetting, WorkCalendar } from '../domain/types'
import type { MsgKey, TranslateParams } from '../locales/i18n'
import { Icon } from './IconSprite'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const SECONDARY = 'var(--oe-text-secondary)'
const MUTED = 'var(--oe-text-muted)'
const INDIGO = 'var(--oe-accent)'
const SURFACE = 'var(--oe-surface)'

/** 面板宽度：与 FilterBar 同宽，贴着侧栏浮起。 */
const PANEL_WIDTH = 320

export interface SettingsPanelProps {
  store: VaultStore
  bus: CommandBus
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 受控打开态；省略时面板自管开合（可独立挂载）。 */
  open?: boolean
  /** 开合请求外送（受控时由接线方决定，非受控时仅作通知）。 */
  onOpenChange?: (open: boolean) => void
  style?: CSSProperties
}

/** 周一 → 周日：值（dayjs 的 day()）与文案键。 */
const WEEKDAY_KEYS: Record<number, MsgKey> = {
  0: 'settingsPanel.weekday.sun',
  1: 'settingsPanel.weekday.mon',
  2: 'settingsPanel.weekday.tue',
  3: 'settingsPanel.weekday.wed',
  4: 'settingsPanel.weekday.thu',
  5: 'settingsPanel.weekday.fri',
  6: 'settingsPanel.weekday.sat',
}

const SECTION_TITLE: CSSProperties = {
  marginTop: 14,
  marginBottom: 6,
  fontSize: 11,
  fontWeight: 600,
  color: MUTED,
  letterSpacing: 0.2,
}

const HINT: CSSProperties = { fontSize: 11, color: MUTED, marginTop: 6, lineHeight: 1.6 }

const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '4px 6px',
  fontSize: 12,
  color: TEXT,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  outline: 'none',
  boxSizing: 'border-box',
}

const GHOST_BUTTON: CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  color: SECONDARY,
  background: 'transparent',
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

/** 分段选择（语言 / 刻度）：选中态靠底色与文字色，不用边框噪声。 */
function Segmented<T extends string>(props: {
  testid: string
  value: T
  options: readonly { value: T; label: string }[]
  onPick: (value: T) => void
}) {
  return (
    <div role="group" data-testid={props.testid} style={{ display: 'flex', gap: 6 }}>
      {props.options.map((option) => {
        const active = option.value === props.value
        return (
          <button
            key={option.value}
            type="button"
            data-testid={`${props.testid}-${option.value}`}
            aria-pressed={active}
            onClick={() => {
              props.onPick(option.value)
            }}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: active ? 600 : 400,
              color: active ? 'var(--oe-on-accent)' : SECONDARY,
              background: active ? INDIGO : 'transparent',
              border: `1px solid ${active ? INDIGO : BORDER}`,
              borderRadius: 'var(--oe-radius-control)',
              cursor: 'pointer',
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** 假期 / 补班：一个日期输入 + 一串可移除的条目（同一组件两份实例）。 */
function DateList(props: {
  testid: string
  title: string
  dates: readonly string[]
  emptyLabel: string
  draft: string
  placeholder: string
  addLabel: string
  removeLabel: string
  onDraft: (value: string) => void
  onAdd: () => void
  onRemove: (date: string) => void
}) {
  return (
    <div data-testid={props.testid} style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: TEXT }}>{props.title}</span>
        <span data-testid={`${props.testid}-count`} style={{ fontSize: 11, color: MUTED }}>
          {props.dates.length}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          data-testid={`${props.testid}-input`}
          aria-label={props.title}
          placeholder={props.placeholder}
          value={props.draft}
          onChange={(event) => {
            props.onDraft(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') props.onAdd()
          }}
          style={INPUT}
        />
        <button type="button" data-testid={`${props.testid}-add`} onClick={props.onAdd} style={GHOST_BUTTON}>
          {props.addLabel}
        </button>
      </div>
      {props.dates.length === 0 ? (
        <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>{props.emptyLabel}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {props.dates.map((date) => (
            <span
              key={date}
              data-testid={`${props.testid}-item-${date}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 6px',
                fontSize: 11,
                color: TEXT,
                background: 'var(--oe-fill-subtle)',
                border: `1px solid ${BORDER}`,
                borderRadius: 'var(--oe-radius-control)',
              }}
            >
              {date}
              <button
                type="button"
                data-testid={`${props.testid}-remove-${date}`}
                aria-label={`${props.removeLabel} ${date}`}
                onClick={() => {
                  props.onRemove(date)
                }}
                style={{
                  display: 'flex',
                  width: 12,
                  height: 12,
                  padding: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: MUTED,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { store, bus, t } = props
  const vault = useStore(store, (state) => state.vault)
  const calendar = vault.settings.calendar

  const [selfOpen, setSelfOpen] = useState(false)
  const open = props.open ?? selfOpen
  const [holidayDraft, setHolidayDraft] = useState('')
  const [extraDraft, setExtraDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  function requestClose(): void {
    if (props.open === undefined) setSelfOpen(false)
    props.onOpenChange?.(false)
  }

  // Esc 关闭：面板贴着侧栏浮起，Esc 是最自然的退出（与 T16 FilterBar 同一手法）
  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  /** 所有写入都用**实时**库算基底（同一 tick 内连续两次交互不会用旧基底互相覆盖）。 */
  function applyCalendar(next: WorkCalendar): void {
    patchCalendar(bus, store.getVault(), next)
  }

  function addDate(list: CalendarDateList, draft: string, clear: () => void): void {
    const value = draft.trim()
    if (!isCalendarDate(value)) {
      setError(t('settingsPanel.invalidDate'))
      return
    }
    setError(null)
    applyCalendar(addCalendarDate(store.getVault().settings.calendar, list, value))
    clear()
  }

  if (!open) return null

  const localeOptions: readonly { value: LocaleSetting; label: string }[] = [
    { value: 'auto', label: t('settingsPanel.languageAuto') },
    { value: 'zh', label: t('settingsPanel.languageZh') },
    { value: 'en', label: t('settingsPanel.languageEn') },
  ]
  const scaleOptions: readonly { value: GanttScale; label: string }[] = [
    { value: 'day', label: t('settingsPanel.ganttScaleDay') },
    { value: 'week', label: t('settingsPanel.ganttScaleWeek') },
  ]

  const aboutRows: readonly { label: string; value: ReactNode }[] = [
    { label: t('settingsPanel.aboutVault'), value: vault.vaultId },
    { label: t('settingsPanel.aboutRevision'), value: String(vault.revision) },
    { label: t('settingsPanel.aboutVersion'), value: vault.appVersion },
  ]

  return (
    <>
      <div
        data-testid="settings-backdrop"
        onClick={requestClose}
        style={{ position: 'fixed', inset: 0, zIndex: 19 }}
      />
      <aside
        data-testid="settings-panel"
        aria-label={t('settingsPanel.title')}
        style={{
          position: 'fixed',
          left: 8,
          bottom: 52,
          width: PANEL_WIDTH,
          maxHeight: 'min(640px, 78vh)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          padding: '9px 12px 14px',
          background: SURFACE,
          border: `1px solid ${BORDER}`,
          borderRadius: 'var(--oe-radius-card)',
          boxShadow: 'var(--oe-shadow-hover)',
          boxSizing: 'border-box',
          fontFamily: 'var(--oe-font)',
          zIndex: 20,
          ...props.style,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="settings" size={15} />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: TEXT }}>
            {t('settingsPanel.title')}
          </span>
          <button
            type="button"
            data-testid="settings-close"
            aria-label={t('settingsPanel.close')}
            title={t('settingsPanel.close')}
            onClick={requestClose}
            style={{ ...GHOST_BUTTON, padding: '2px 7px' }}
          >
            <Icon name="close" size={13} />
          </button>
        </div>

        {/* ── 语言 ── */}
        <div style={SECTION_TITLE}>{t('settingsPanel.language')}</div>
        <Segmented
          testid="settings-locale"
          value={vault.settings.locale}
          options={localeOptions}
          onPick={(locale) => {
            if (patchLocale(bus, store.getVault(), locale)) setError(null)
          }}
        />

        {/* ── 主题（本版只有浅色，只读展示） ── */}
        <div style={SECTION_TITLE}>{t('settingsPanel.theme')}</div>
        <div data-testid="settings-theme" style={{ display: 'flex', gap: 6 }}>
          <span
            data-testid="settings-theme-light"
            aria-pressed="true"
            style={{
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--oe-on-accent)',
              background: INDIGO,
              border: `1px solid ${INDIGO}`,
              borderRadius: 'var(--oe-radius-control)',
            }}
          >
            {t('settingsPanel.themeLight')}
          </span>
        </div>
        <div style={HINT}>{t('settingsPanel.themeHint')}</div>

        {/* ── 甘特图默认刻度 ── */}
        <div style={SECTION_TITLE}>{t('settingsPanel.gantt')}</div>
        <Segmented
          testid="settings-gantt-scale"
          value={vault.settings.ganttScale}
          options={scaleOptions}
          onPick={(scale) => {
            patchGanttScale(bus, store.getVault(), scale)
          }}
        />

        {/* ── 工作日历 ── */}
        <div style={SECTION_TITLE}>{t('settingsPanel.calendar')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: TEXT }}>{t('settingsPanel.workdays')}</span>
        </div>
        <div data-testid="settings-workdays" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {WEEK_ORDER.map((day) => {
            const on = isWorkdaySet(calendar, day)
            const enabled = canToggleWorkday(calendar, day)
            return (
              <button
                key={day}
                type="button"
                data-testid={`settings-workday-${day}`}
                aria-pressed={on}
                disabled={!enabled}
                title={enabled ? undefined : t('settingsPanel.workdayHint')}
                onClick={() => {
                  applyCalendar(toggleWorkday(store.getVault().settings.calendar, day))
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 8px',
                  fontSize: 12,
                  color: on ? TEXT : MUTED,
                  background: on ? 'var(--oe-fill-subtle)' : 'transparent',
                  border: `1px solid ${on ? BORDER : 'transparent'}`,
                  borderRadius: 'var(--oe-radius-control)',
                  cursor: enabled ? 'pointer' : 'not-allowed',
                  opacity: enabled ? 1 : 0.6,
                }}
              >
                <Icon name={on ? 'chevron' : 'plus'} size={11} />
                {t(WEEKDAY_KEYS[day] ?? 'settingsPanel.weekday.mon')}
              </button>
            )
          })}
        </div>
        <div style={HINT}>{t('settingsPanel.workdayHint')}</div>

        <DateList
          testid="settings-holidays"
          title={t('settingsPanel.holidays')}
          dates={calendar.holidays}
          emptyLabel={t('settingsPanel.noHolidays')}
          draft={holidayDraft}
          placeholder={t('settingsPanel.datePlaceholder')}
          addLabel={t('settingsPanel.add')}
          removeLabel={t('settingsPanel.remove')}
          onDraft={setHolidayDraft}
          onAdd={() => {
            addDate('holidays', holidayDraft, () => {
              setHolidayDraft('')
            })
          }}
          onRemove={(date) => {
            applyCalendar(removeCalendarDate(store.getVault().settings.calendar, 'holidays', date))
          }}
        />

        <DateList
          testid="settings-extra"
          title={t('settingsPanel.extraWorkdays')}
          dates={calendar.extraWorkdays}
          emptyLabel={t('settingsPanel.noExtraWorkdays')}
          draft={extraDraft}
          placeholder={t('settingsPanel.datePlaceholder')}
          addLabel={t('settingsPanel.add')}
          removeLabel={t('settingsPanel.remove')}
          onDraft={setExtraDraft}
          onAdd={() => {
            addDate('extraWorkdays', extraDraft, () => {
              setExtraDraft('')
            })
          }}
          onRemove={(date) => {
            applyCalendar(removeCalendarDate(store.getVault().settings.calendar, 'extraWorkdays', date))
          }}
        />

        <div style={HINT}>{t('settingsPanel.calendarHint')}</div>
        <div style={HINT}>{t('settingsPanel.crossCleared')}</div>
        {error === null ? null : (
          <div data-testid="settings-error" style={{ fontSize: 11, color: 'var(--oe-blocked)', marginTop: 6 }}>
            {error}
          </div>
        )}

        {/* ── 关于 ── */}
        <div style={SECTION_TITLE}>{t('settingsPanel.about')}</div>
        <div data-testid="settings-about" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {aboutRows.map((row) => (
            <div key={row.label} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
              <span style={{ flex: '0 0 64px', color: MUTED }}>{row.label}</span>
              <span style={{ flex: 1, minWidth: 0, color: SECONDARY, wordBreak: 'break-all' }}>{row.value}</span>
            </div>
          ))}
          <div data-testid="settings-counts" style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
            {t('settingsPanel.aboutCounts', {
              tasks: vault.tasks.length,
              topics: vault.topics.length,
              milestones: vault.milestones.length,
            })}
          </div>
        </div>
      </aside>
    </>
  )
}

export default SettingsPanel
