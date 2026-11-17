// ScheduleEngine · 工作日历下的工期计算（spec 5.2）
//
// 本模块是纯函数：不读时钟、不碰 I/O、不引用 Store；给定同一个日历，同一输入永远同一输出。
// 唯一的可变状态是 createScheduleEngine() 实例内部的日期串缓存，实例之间互不共享，
// 因此裸函数调用方拿到的仍是引用透明的结果。

import dayjs, { type Dayjs } from 'dayjs'

import type { WorkCalendar } from './types'

/** 可接受的日期输入：`YYYY-MM-DD` 串、原生 Date、dayjs 对象。 */
export type DateInput = string | Dayjs | Date

/** duration() 只需要这两个字段，Task 天然满足（结构兼容，不反向依赖 types 的完整形状）。 */
export interface Schedulable {
  start?: string
  due?: string
}

export class ScheduleEngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleEngineError'
  }
}

/** 与 schema.ts 的默认日历一致：周一至周五工作，无额外假期与补班。 */
export const DEFAULT_CALENDAR: WorkCalendar = { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] }

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 推移时的扫描上限。正常日历远达不到：`|n|` 个工作日最多跨 7|n| 天，
 * 额外给 10 年余量。`workdays: []` 这类自相矛盾的日历会撞上此上限并显式报错，
 * 而不是把浏览器标签页卡死在无限循环里。
 */
const SCAN_SLACK_DAYS = 3660

/** 把任意受支持的日期输入规整为 `YYYY-MM-DD`；非法输入抛 ScheduleEngineError。 */
export function toDateKey(d: DateInput): string {
  if (typeof d === 'string') {
    if (!DATE_KEY_RE.test(d)) {
      throw new ScheduleEngineError(`非法日期「${d}」：只接受 YYYY-MM-DD 形式的日期串`)
    }
    const parsed = dayjs(d)
    if (!parsed.isValid() || parsed.format('YYYY-MM-DD') !== d) {
      throw new ScheduleEngineError(`非法日期「${d}」：该日期在实际日历中不存在`)
    }
    return d
  }

  const parsed = dayjs(d)
  if (!parsed.isValid()) {
    throw new ScheduleEngineError('非法日期：无法解析该 Date / dayjs 输入')
  }
  return parsed.format('YYYY-MM-DD')
}

/**
 * 由日历造出一个「某个日期串是不是工作日」的判定函数。
 * 优先级：holidays > extraWorkdays > 按周几判断。
 * 同一天同时出现在两个列表里属于自相矛盾的配置，此时取「休息」——
 * 把假期误判成工作日会让排期过于乐观，比反过来更危险。
 */
function makeProbe(cal: WorkCalendar): (dateKey: string) => boolean {
  const holidays = new Set(cal.holidays)
  const extraWorkdays = new Set(cal.extraWorkdays)
  const workdays = new Set(cal.workdays)

  return (dateKey: string): boolean => {
    if (holidays.has(dateKey)) return false
    if (extraWorkdays.has(dateKey)) return true
    return workdays.has(dayjs(dateKey).day())
  }
}

export function isWorkday(d: DateInput, cal: WorkCalendar): boolean {
  return makeProbe(cal)(toDateKey(d))
}

/** 从 `d` 的次日起向前（未来方向）找到第一个工作日，返回 `YYYY-MM-DD`。输入本身是工作日也会继续往后走。 */
export function nextWorkday(d: DateInput, cal: WorkCalendar): string {
  return addWorkdays(d, 1, cal)
}

function shiftWorkdays(startKey: string, n: number, probe: (dateKey: string) => boolean): string {
  if (!Number.isInteger(n)) {
    throw new ScheduleEngineError(`推移天数必须是整数，收到 ${n}`)
  }

  let cursor = dayjs(startKey)
  let remaining = Math.abs(n)
  const step = n < 0 ? -1 : 1
  const scanLimit = 7 * Math.abs(n) + SCAN_SLACK_DAYS
  let scanned = 0

  while (remaining > 0) {
    cursor = cursor.add(step, 'day')
    scanned += 1
    if (scanned > scanLimit) {
      throw new ScheduleEngineError(
        `工作日历中找不到足够的工作日（已扫描 ${scanned} 天，仍差 ${remaining} 天）；请检查 calendar.workdays 是否为空`,
      )
    }
    if (probe(cursor.format('YYYY-MM-DD'))) remaining -= 1
  }

  return cursor.format('YYYY-MM-DD')
}

/**
 * 从 `d` 起按工作日推移 n 天。语义对齐 Excel 的 WORKDAY：**起点不计入**。
 * n = 0 原样返回当日（即便当日不是工作日）；n 为负则向前推。
 */
export function addWorkdays(d: DateInput, n: number, cal: WorkCalendar): string {
  return shiftWorkdays(toDateKey(d), n, makeProbe(cal))
}

/** 数 `(from, to]` 内的工作日数；调用方保证 from <= to。 */
function countForward(fromKey: string, toKey: string, probe: (dateKey: string) => boolean): number {
  let cursor = dayjs(fromKey)
  const end = dayjs(toKey)
  let count = 0

  while (cursor.isBefore(end)) {
    cursor = cursor.add(1, 'day')
    if (probe(cursor.format('YYYY-MM-DD'))) count += 1
  }

  return count
}

/**
 * 区间工作日数：**含末日、不含首日**，即 `(a, b]`。
 *
 * 这个口径是与 `duration()` 的 `+1` 配套的：`duration = workdaysBetween + 1`
 * 恰好得到「首尾两端都算」的工作日天数（同日任务 = 1 天，周一→周五 = 5 天）。
 * 若这里改成两端都含，工期会凭空多出一天。
 *
 * `a > b` 时返回对应的负值，与正向严格反对称；`a === b` 返回 0。
 */
function betweenKeys(fromKey: string, toKey: string, probe: (dateKey: string) => boolean): number {
  if (fromKey === toKey) return 0
  return fromKey < toKey ? countForward(fromKey, toKey, probe) : -countForward(toKey, fromKey, probe)
}

export function workdaysBetween(a: DateInput, b: DateInput, cal: WorkCalendar): number {
  return betweenKeys(toDateKey(a), toDateKey(b), makeProbe(cal))
}

/**
 * 工期 = workdaysBetween(start, due) + 1。
 * start 或 due 缺失返回 null；二者颠倒时按公式得到负值，由调用方负责校验 start <= due。
 */
function durationWith(target: Schedulable, probe: (dateKey: string) => boolean): number | null {
  if (!target.start || !target.due) return null
  return betweenKeys(toDateKey(target.start), toDateKey(target.due), probe) + 1
}

export function duration(target: Schedulable, cal: WorkCalendar): number | null {
  return durationWith(target, makeProbe(cal))
}

export interface ScheduleEngine {
  isWorkday(d: DateInput): boolean
  nextWorkday(d: DateInput): string
  addWorkdays(d: DateInput, n: number): string
  workdaysBetween(a: DateInput, b: DateInput): number
  duration(target: Schedulable): number | null
  /** 当前缓存条目数，供测试与性能断言使用。 */
  cacheSize(): number
}

export interface ScheduleEngineHooks {
  /** 每次真正发生计算（缓存未命中）时回调一次；命中缓存不触发。 */
  onCompute?: (dateKey: string) => void
}

/**
 * 绑定日历并按日期串 memoize 的引擎（spec 5.2：`Map<dateStr, boolean>`，避免逐格重算）。
 * 甘特图与看板走这个入口，裸函数留给一次性计算与测试。
 */
export function createScheduleEngine(cal: WorkCalendar, hooks?: ScheduleEngineHooks): ScheduleEngine {
  const cache = new Map<string, boolean>()
  const baseProbe = makeProbe(cal)

  const probe = (dateKey: string): boolean => {
    const cached = cache.get(dateKey)
    if (cached !== undefined) return cached

    const value = baseProbe(dateKey)
    cache.set(dateKey, value)
    hooks?.onCompute?.(dateKey)
    return value
  }

  return {
    isWorkday: (d) => probe(toDateKey(d)),
    nextWorkday: (d) => shiftWorkdays(toDateKey(d), 1, probe),
    addWorkdays: (d, n) => shiftWorkdays(toDateKey(d), n, probe),
    workdaysBetween: (a, b) => betweenKeys(toDateKey(a), toDateKey(b), probe),
    duration: (target) => durationWith(target, probe),
    cacheSize: () => cache.size,
  }
}
