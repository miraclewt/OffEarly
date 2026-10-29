// T35 · settingsActions：设置面板的写入计算（纯函数）+ 空操作卫生。

import { describe, expect, it } from 'vitest'

import {
  WEEK_ORDER,
  addCalendarDate,
  canToggleWorkday,
  isCalendarDate,
  normalizeNoteFontSize,
  patchCalendar,
  patchGanttScale,
  patchLocale,
  patchNoteFontSize,
  removeCalendarDate,
  sameCalendar,
  stepNoteFontSize,
  toggleWorkday,
} from '../../src/controllers/settingsActions'
import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Vault, WorkCalendar } from '../../src/domain/types'

const NOW = '2026-10-17T08:30:00.000Z'

function calendar(overrides: Partial<WorkCalendar> = {}): WorkCalendar {
  return { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [], ...overrides }
}

function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: 'OffEarly 0.1.0',
    revision: 1,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: calendar(),
      ganttScale: 'day',
      theme: 'light',
      locale: 'auto',
      lastFilter: null,
      noteFontSize: 13,
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    trash: [],
    whiteboards: [],
    ...overrides,
  }
}

describe('settingsActions · 日期校验', () => {
  it('接受真实存在的 YYYY-MM-DD', () => {
    expect(isCalendarDate('2026-10-01')).toBe(true)
    expect(isCalendarDate('2026-02-28')).toBe(true)
  })

  it('拒绝格式错误与伪日期（复用 ScheduleEngine 的 toDateKey）', () => {
    expect(isCalendarDate('2026/10/01')).toBe(false)
    expect(isCalendarDate('2026-2-01')).toBe(false)
    expect(isCalendarDate('2026-02-30')).toBe(false)
    expect(isCalendarDate('')).toBe(false)
  })
})

describe('settingsActions · 工作日开关', () => {
  it('展示顺序是周一 → 周日（dayjs 里 0 是周日）', () => {
    expect(WEEK_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0])
  })

  it('取消一个工作日 / 加回一个工作日，结果按数值升序', () => {
    expect(toggleWorkday(calendar(), 3).workdays).toEqual([1, 2, 4, 5])
    expect(toggleWorkday(calendar({ workdays: [1, 5] }), 3).workdays).toEqual([1, 3, 5])
    expect(toggleWorkday(calendar(), 0).workdays).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('只剩一个工作日时不允许再取消（空 workdays 是自相矛盾的日历）', () => {
    const single = calendar({ workdays: [1] })
    expect(canToggleWorkday(single, 1)).toBe(false)
    expect(canToggleWorkday(single, 2)).toBe(true)
    expect(toggleWorkday(single, 1)).toEqual(single)
  })
})

describe('settingsActions · 假期与补班', () => {
  it('加日期：去重 + 升序', () => {
    const once = addCalendarDate(calendar(), 'holidays', '2026-10-05')
    expect(once.holidays).toEqual(['2026-10-05'])
    expect(addCalendarDate(once, 'holidays', '2026-10-05').holidays).toEqual(['2026-10-05'])
    expect(addCalendarDate(once, 'holidays', '2026-10-01').holidays).toEqual(['2026-10-01', '2026-10-05'])
  })

  it('同一天不能既是假期又是补班：加到一边自动从另一边摘掉', () => {
    const withHoliday = addCalendarDate(calendar(), 'holidays', '2026-10-05')
    const asExtra = addCalendarDate(withHoliday, 'extraWorkdays', '2026-10-05')
    expect(asExtra.extraWorkdays).toEqual(['2026-10-05'])
    expect(asExtra.holidays).toEqual([])
  })

  it('非法日期抛错（视图先用 isCalendarDate 拦下，这里是第二道闸）', () => {
    expect(() => addCalendarDate(calendar(), 'holidays', '2026-02-30')).toThrow(/非法日期/)
  })

  it('移除日期只动目标列表', () => {
    const base = calendar({ holidays: ['2026-10-01', '2026-10-05'], extraWorkdays: ['2026-10-10'] })
    expect(removeCalendarDate(base, 'holidays', '2026-10-01')).toEqual({
      workdays: [1, 2, 3, 4, 5],
      holidays: ['2026-10-05'],
      extraWorkdays: ['2026-10-10'],
    })
  })

  it('sameCalendar 认得出等价与不等价', () => {
    expect(sameCalendar(calendar(), calendar())).toBe(true)
    expect(sameCalendar(calendar(), calendar({ workdays: [1, 2, 3, 4] }))).toBe(false)
    expect(sameCalendar(calendar(), calendar({ holidays: ['2026-10-01'] }))).toBe(false)
  })
})

describe('settingsActions · 写入口（空操作不发命令）', () => {
  it('换语言落命令并写进 settings，undo 一步还原', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    expect(patchLocale(bus, store.getVault(), 'en')).toBe(true)
    expect(store.getVault().settings.locale).toBe('en')
    expect(bus.undoDepth()).toBe(1)
    bus.undo()
    expect(store.getVault().settings.locale).toBe('auto')
  })

  it('已是当前语言 / 当前刻度时不发命令（撤销栈保持干净）', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    expect(patchLocale(bus, store.getVault(), 'auto')).toBe(false)
    expect(patchGanttScale(bus, store.getVault(), 'day')).toBe(false)
    expect(bus.undoDepth()).toBe(0)
  })

  it('换刻度落命令；日历等值时被拦', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    expect(patchGanttScale(bus, store.getVault(), 'week')).toBe(true)
    expect(store.getVault().settings.ganttScale).toBe('week')
    expect(patchCalendar(bus, store.getVault(), calendar())).toBe(false)
    expect(bus.undoDepth()).toBe(1)
  })

  it('改日历是一整块可撤销的变更', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    const next = addCalendarDate(store.getVault().settings.calendar, 'holidays', '2026-10-01')
    expect(patchCalendar(bus, store.getVault(), next)).toBe(true)
    expect(store.getVault().settings.calendar.holidays).toEqual(['2026-10-01'])
    bus.undo()
    expect(store.getVault().settings.calendar.holidays).toEqual([])
  })

  it('其余设置项不受影响（只 patch 目标字段）', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    patchLocale(bus, store.getVault(), 'zh')
    const settings = store.getVault().settings
    expect(settings.locale).toBe('zh')
    expect(settings.ganttScale).toBe('day')
    expect(settings.theme).toBe('light')
    expect(settings.calendar).toEqual(calendar())
    expect(settings.lastFilter).toBeNull()
  })
})

// T50 · 正文字号：唯一写入口的归一与撤销栈卫生
describe('noteFontSize', () => {
  it('归一：越界夹到 12–20，非数字退回默认值', () => {
    expect(normalizeNoteFontSize(13)).toBe(13)
    expect(normalizeNoteFontSize(11)).toBe(12)
    expect(normalizeNoteFontSize(41)).toBe(20)
    expect(normalizeNoteFontSize(14.6)).toBe(15)
    expect(normalizeNoteFontSize(Number.NaN)).toBe(13)
    expect(normalizeNoteFontSize(Number.POSITIVE_INFINITY)).toBe(13)
  })

  it('步进在两端停住，不会越过 12 / 20', () => {
    expect(stepNoteFontSize(13, 1)).toBe(14)
    expect(stepNoteFontSize(13, -1)).toBe(12)
    expect(stepNoteFontSize(12, -1)).toBe(12)
    expect(stepNoteFontSize(20, 1)).toBe(20)
  })

  it('写进 settings 且可撤销；同值不产生空命令', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    expect(patchNoteFontSize(bus, store.getVault(), 16)).toBe(true)
    expect(store.getVault().settings.noteFontSize).toBe(16)
    expect(patchNoteFontSize(bus, store.getVault(), 16)).toBe(false)
    expect(bus.undoDepth()).toBe(1)

    // 越界值也会被归一后再落盘（手改 vault.json / 连点都不会写坏值）
    expect(patchNoteFontSize(bus, store.getVault(), 99)).toBe(true)
    expect(store.getVault().settings.noteFontSize).toBe(20)

    bus.undo()
    bus.undo()
    expect(store.getVault().settings.noteFontSize).toBe(13)
  })

  it('不影响其它设置项', () => {
    const store = createVaultStore(vault())
    const bus = createCommandBus(store)
    patchNoteFontSize(bus, store.getVault(), 18)
    const settings = store.getVault().settings
    expect(settings.noteFontSize).toBe(18)
    expect(settings.ganttScale).toBe('day')
    expect(settings.locale).toBe('auto')
  })
})
