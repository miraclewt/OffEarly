// T54 · DateField 的纯函数部分：掩码、解析、日历网格（F10 的修复主体）。
//
// **为什么不再用 `<input type="date">`**：原生控件的显示格式由**浏览器区域设置**
// 决定，页面 `lang` 改不动它——同一条 `2026-10-05`，zh-CN 的 Chrome 显示
// `2026/10/05`，en-US 显示 `10/05/2026`，而本应用其余所有位置（任务卡、
// 甘特左表、导出、里程碑列表）显示的都是裸 ISO 串。于是同一个库里出现两套
// 日期写法，且随用户浏览器变化。接管输入框之后显示恒为 `YYYY-MM-DD`。
//
// 这里只做纯计算：不读时钟（`todayIso()` 是唯一的时钟入口，供组件显式调用）、
// 不碰 DOM、不引用 Store，因此可以在 jsdom 之外单测——伪日期（2026-02-30）
// 这类用例必须靠纯函数覆盖，原生 input 会把它消毒成空串，测不到。

import dayjs from 'dayjs'

/** 一遍解析的结果。`invalid` 与 `empty` 分开，是因为清空是合法操作而错字不是。 */
export type DateDraft =
  | { kind: 'empty' }
  | { kind: 'valid'; value: string }
  | { kind: 'invalid' }

const SEPARATED_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/
const COMPACT_RE = /^(\d{8})$/

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** 某年某月的天数（month 取 1–12）。闰年交给 `isLeapYear`，不借道 Date 的溢出行为。 */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** 掩码的三组容量：年 4 位、月 2 位、日 2 位。 */
const GROUP_CAPACITY = [4, 2, 2] as const

/**
 * 输入掩码：边打边补连字符，最多 `YYYY-MM-DD`。
 *
 * 不是「抽掉所有非数字再按 4/2/2 切」——那样打 `2026-1-5` 会变成 `2026-15`
 * （第二个连字符被吃掉，`1` 和 `5` 挤进月分组）。这里把**分隔符当分组信号**：
 * 遇到分隔符且当前组非空就推进一组，于是 `2026-1-5`、`2026/1/5`、`2026年1月5日`
 * 都能原样落到 `2026-1-5`，再由 `parseDateDraft` 补零。连续输入 8 位数字
 * 也照样自动分组（`20261005` → `2026-10-05`），退格沿掩码原路返回。
 */
export function maskDateInput(raw: string): string {
  const groups: string[] = []
  let index = 0
  for (const char of raw) {
    if (!/[0-9]/.test(char)) {
      // 分隔符只在「当前组已有内容」时推进，多打的连字符不会跳过一组
      if ((groups[index]?.length ?? 0) > 0 && index < GROUP_CAPACITY.length - 1) index += 1
      continue
    }
    while (
      index < GROUP_CAPACITY.length &&
      (groups[index]?.length ?? 0) >= (GROUP_CAPACITY[index] ?? 0)
    ) {
      index += 1
    }
    if (index >= GROUP_CAPACITY.length) break
    groups[index] = `${groups[index] ?? ''}${char}`
  }
  const joined = groups.join('-')
  // 末尾的分隔符要留在显示里，否则用户打 `2026-1-5` 时第二下连字符会被吞掉、
  // 下一个数字挤进月分组变成 `2026-15`（受控输入框只回传值，看不见按键本身）。
  const trailingSeparator = /[^0-9]$/.test(raw)
  if (trailingSeparator && joined !== '' && groups.length < GROUP_CAPACITY.length) {
    return `${joined}-`
  }
  return joined
}

/**
 * 把用户敲的文本解析成 ISO 日期串。
 *
 * 接受 `YYYY-MM-DD`、`YYYY/M/D`、`YYYY.M.D`、`YYYYMMDD`（月日可不补零）；
 * 空文本是「清空」而不是错误。范围与真实日历都对上才算合法——
 * `2026-02-30`、`2026-13-01`、`0000-01-01` 一律 invalid。
 */
export function parseDateDraft(text: string): DateDraft {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'empty' }

  let parts: [number, number, number] | null = null
  const compact = COMPACT_RE.exec(trimmed)
  if (compact !== null) {
    parts = [
      Number(trimmed.slice(0, 4)),
      Number(trimmed.slice(4, 6)),
      Number(trimmed.slice(6, 8)),
    ]
  } else {
    const separated = SEPARATED_RE.exec(trimmed)
    if (separated !== null) {
      parts = [Number(separated[1]), Number(separated[2]), Number(separated[3])]
    }
  }
  if (parts === null) return { kind: 'invalid' }

  const [year, month, day] = parts
  if (year < 1000 || year > 9999) return { kind: 'invalid' }
  if (month < 1 || month > 12) return { kind: 'invalid' }
  if (day < 1 || day > daysInMonth(year, month)) return { kind: 'invalid' }
  return { kind: 'valid', value: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` }
}

/** ISO 串是否对应真实存在的一天（含格式校验）。 */
export function isValidIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const draft = parseDateDraft(text)
  return draft.kind === 'valid'
}

/** 按天平移。月/年边界交给 dayjs 的 add，避免自己处理闰年与月长。 */
export function shiftIsoDate(iso: string, days: number): string {
  return dayjs(iso).add(days, 'day').format('YYYY-MM-DD')
}

/** 按月平移。锚点通常是当月 1 号；给 31 号也只回落到目标月最后一天，不溢出。 */
export function shiftIsoMonth(iso: string, delta: number): string {
  return dayjs(iso).add(delta, 'month').format('YYYY-MM-DD')
}

/** `YYYY-MM-DD` → `YYYY-MM`，日历头与网格锚点都用它。 */
export function monthKey(iso: string): string {
  return iso.slice(0, 7)
}

/** 时钟的唯一入口：组件显式调用，纯函数本身仍然无副作用的可测。 */
export function todayIso(): string {
  return dayjs().format('YYYY-MM-DD')
}

export interface MonthCell {
  iso: string
  day: number
  /** false = 补格（上月末 / 下月初），用来把首列对齐到周一。 */
  inMonth: boolean
}

/**
 * 一个月的日历网格（**周一为首列**，与 `WEEK_ORDER` 同一口径）。
 *
 * 返回长度是 7 的整数倍：5 行或 6 行，按当月实际覆盖的周数决定，
 * 不强行补满 6 行——补出来的空行只会让人以为日历还能往下滚。
 */
export function buildMonthGrid(monthIso: string): MonthCell[] {
  const first = `${monthKey(monthIso)}-01`
  const firstDay = dayjs(first)
  const offset = (firstDay.day() + 6) % 7
  const total = firstDay.daysInMonth()
  const weeks = Math.ceil((offset + total) / 7)
  const cells: MonthCell[] = []
  for (let index = 0; index < weeks * 7; index += 1) {
    const delta = index - offset
    const iso = shiftIsoDate(first, delta)
    cells.push({ iso, day: Number(iso.slice(8, 10)), inMonth: delta >= 0 && delta < total })
  }
  return cells
}
