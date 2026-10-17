// T35 · settingsActions：设置面板的写入计算（纯函数，编排层）。
//
// 分层边界（spec 第 3 节）：views 只渲染 + 转发事件；设置项属于 Vault.settings，
// 写入走 T10 CommandBus 的 `settings.patch`（逆 patch 按 key 还原整个字段，
// 所以「改日历」在撤销栈里是一步整块回滚，不会留下半新半旧的日历）。
//
// 本模块只做两件事：把一次交互算成新的 Settings 片段，以及**判定这次交互是不是空操作**——
// patchSettingsCommand 对空 patch 抛错，且点一个已选中的选项不该在撤销栈里留一条空命令
// （沿用 filters.ts / topicActions.ts 的撤销栈卫生先例）。

import { patchSettingsCommand } from '../domain/commandBus'
import type { CommandBus } from '../domain/commandBus'
import { toDateKey } from '../domain/scheduleEngine'
import type { GanttScale, LocaleSetting, Vault, WorkCalendar } from '../domain/types'

/** 工作日展示顺序：周一 → 周日（dayjs 的 day() 里 0 = 周日，2026-10-15 既定口径）。 */
export const WEEK_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]

/**
 * 日期键校验：直接复用 ScheduleEngine 的 `toDateKey` —— 领域层唯一的日期权威，
 * 它同时挡住「格式不对」与「2026-02-30 这类实际不存在的一天」，这里不另写一套正则。
 */
export function isCalendarDate(value: string): boolean {
  try {
    toDateKey(value)
    return true
  } catch {
    return false
  }
}

export function isWorkdaySet(cal: WorkCalendar, day: number): boolean {
  return cal.workdays.includes(day)
}

/**
 * 只剩一个工作日时不允许再取消：`workdays: []` 是自相矛盾的日历
 * （ScheduleEngine 的扫描上限就是为这种配置准备的，会给出一路报错的排期）。
 * 视图据此置灰最后一个开关，把「非法状态」挡在交互层，而不是等排期时报错。
 */
export function canToggleWorkday(cal: WorkCalendar, day: number): boolean {
  return !(cal.workdays.includes(day) && cal.workdays.length <= 1)
}

/** 开关一个工作日；结果按数值升序（与 schema 默认值 [1,2,3,4,5] 同序，写盘后 diff 稳定）。 */
export function toggleWorkday(cal: WorkCalendar, day: number): WorkCalendar {
  if (!canToggleWorkday(cal, day)) return cal
  const workdays = cal.workdays.includes(day)
    ? cal.workdays.filter((value) => value !== day)
    : [...cal.workdays, day].sort((a, b) => a - b)
  return { ...cal, workdays }
}

/** 日历上的两个日期列表。 */
export type CalendarDateList = 'holidays' | 'extraWorkdays'

const OTHER_LIST: Record<CalendarDateList, CalendarDateList> = {
  holidays: 'extraWorkdays',
  extraWorkdays: 'holidays',
}

/** 去重 + 升序：ISO 日期串的词典序就是时间序，写盘后 diff 稳定。 */
function normalizeDates(dates: readonly string[]): string[] {
  return [...new Set(dates)].sort()
}

/**
 * 往假期 / 补班里加一天，**并从另一份列表里剔除同一天**：
 * 同一天同时出现在两份列表里是自相矛盾的配置（ScheduleEngine 按「假期限优先」取休息），
 * 与其留下一条永远不生效的补班记录，不如在写入时就把冲突解掉。
 */
export function addCalendarDate(cal: WorkCalendar, list: CalendarDateList, date: string): WorkCalendar {
  if (!isCalendarDate(date)) throw new Error(`settingsActions: 非法日期（${date}）`)
  const other = OTHER_LIST[list]
  return {
    ...cal,
    [list]: normalizeDates([...cal[list], date]),
    [other]: cal[other].filter((value) => value !== date),
  }
}

export function removeCalendarDate(cal: WorkCalendar, list: CalendarDateList, date: string): WorkCalendar {
  return { ...cal, [list]: cal[list].filter((value) => value !== date) }
}

/** 日历是否等价：相等即视为空操作，不发命令。 */
export function sameCalendar(a: WorkCalendar, b: WorkCalendar): boolean {
  const same = (x: readonly (string | number)[], y: readonly (string | number)[]): boolean =>
    x.length === y.length && x.every((value, index) => value === y[index])
  return same(a.workdays, b.workdays) && same(a.holidays, b.holidays) && same(a.extraWorkdays, b.extraWorkdays)
}

// ── 三个写入口（视图只调它们，不自己组 Command） ──────────────────────────

/** 换语言；已是当前值即空操作。返回是否真的落了命令。 */
export function patchLocale(bus: CommandBus, vault: Vault, locale: LocaleSetting): boolean {
  if (vault.settings.locale === locale) return false
  bus.apply(patchSettingsCommand(vault, { locale }))
  return true
}

export function patchGanttScale(bus: CommandBus, vault: Vault, scale: GanttScale): boolean {
  if (vault.settings.ganttScale === scale) return false
  bus.apply(patchSettingsCommand(vault, { ganttScale: scale }))
  return true
}

export function patchCalendar(bus: CommandBus, vault: Vault, next: WorkCalendar): boolean {
  if (sameCalendar(vault.settings.calendar, next)) return false
  bus.apply(patchSettingsCommand(vault, { calendar: next }))
  return true
}
