// T62 · iCalendar（.ics）解析：把 Outlook / Teams 导出的会议变成可落库的纯数据。
//
// 定位是「一次性取数」——不做任何网络请求、不碰文件系统、不认识 vault。
// 输入一段 iCalendar 文本，输出若干场会议；调用方（controllers/meetingImport）负责
// 把它写成笔记。
//
// 四个真实存在的坑，都在这里消化掉：
//  1) 折行：RFC 5545 每行 75 字节硬折，续行以一个空格或 Tab 开头，必须先拼回来再解析；
//  2) 转义：TEXT 值里 `\,` `\;` `\n` `\\` 是转义序列，公司名带逗号极常见；
//  3) 时区：Outlook 导出多用 `TZID=China Standard Time` 这类 **Windows 时区名**，
//     不是 IANA 名，需要一张小映射表；认不出来就按本机时区兜底，绝不因此丢弃事件；
//  4) 重复事件：RRULE 一个系列只有一条 VEVENT，这里只取「这一场」，由调用方在正文注明。

export interface IcsAttendee {
  /** 显示名：优先 CN 参数，其次邮箱本地部分。 */
  name: string
  email: string
  /** ROLE 参数，如 REQ-PARTICIPANT / OPT-PARTICIPANT / CHAIR，缺失为空串。 */
  role: string
  /** PARTSTAT 参数，如 ACCEPTED / DECLINED / NEEDS-ACTION / TENTATIVE，缺失为空串。 */
  status: string
}

export interface IcsEvent {
  uid: string
  summary: string
  /** 本机时区下的墙上时间 `YYYY-MM-DDTHH:mm`；全天事件取当日 00:00。 */
  start: string
  /** 同上；缺 DTEND/DURATION 时为 null。 */
  end: string | null
  /** 本机时区下的日期键 `YYYY-MM-DD`，用于去重与排序。 */
  dateKey: string
  allDay: boolean
  location: string
  /** `张三 <a@b.com>` 或纯邮箱；缺失为空串。 */
  organizer: string
  attendees: IcsAttendee[]
  description: string
  /** 会议链接：URL 属性优先，其次 Teams / Google 的私有属性。 */
  url: string
  /** 带 RRULE 即视为重复会议（本模块不展开系列）。 */
  recurring: boolean
}

// ── 基础解析 ────────────────────────────────────────────────────────────────

const lineBreak = /\r\n|\n|\r/

/** 按行切开并把折行拼回去。空行保留（解析属性时会被忽略）。 */
export function unfoldLines(text: string): string[] {
  const raw = text.split(lineBreak)
  const out: string[] = []
  for (const line of raw) {
    const isContinuation = line.startsWith(' ') || line.startsWith('\t')
    if (isContinuation && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1] ?? ''}${line.slice(1)}`
      continue
    }
    out.push(line)
  }
  return out
}

/**
 * 还原 TEXT 值里的转义。未知转义保留字符本身（宁可多一个字，也不要吞掉内容）。
 */
export function unescapeIcsText(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i)
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = value.charAt(i + 1)
    if (next === '') {
      out += ch
      continue
    }
    if (next === 'n' || next === 'N') out += '\n'
    else out += next
    i += 1
  }
  return out
}

/** 找出引号外的第一个 target（属性名与值之间的冒号、参数之间的分号都靠它）。 */
function findSeparator(text: string, target: string): number {
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && ch === target) return i
  }
  return -1
}

function splitUnquoted(text: string, target: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (ch === '"') {
      quoted = !quoted
      current += ch
      continue
    }
    if (!quoted && ch === target) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

export interface IcsProp {
  name: string
  params: Record<string, string>
  value: string
}

export function parseProp(line: string): IcsProp | null {
  const colon = findSeparator(line, ':')
  if (colon <= 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const semi = findSeparator(head, ';')
  const name = (semi < 0 ? head : head.slice(0, semi)).trim().toUpperCase()
  if (name === '') return null
  const params: Record<string, string> = {}
  if (semi >= 0) {
    for (const part of splitUnquoted(head.slice(semi + 1), ';')) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const key = part.slice(0, eq).trim().toUpperCase()
      let raw = part.slice(eq + 1).trim()
      if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1)
      if (key !== '') params[key] = raw
    }
  }
  return { name, params, value }
}

/** 只收 VEVENT 的直接子属性；VALARM 之类的嵌套组件里的属性一律丢掉。 */
function collectEvents(props: readonly IcsProp[]): IcsProp[][] {
  const stack: string[] = []
  const out: IcsProp[][] = []
  let current: IcsProp[] | null = null
  for (const prop of props) {
    if (prop.name === 'BEGIN') {
      stack.push(prop.value.trim().toUpperCase())
      if (stack.length === 2 && stack[1] === 'VEVENT') current = []
      continue
    }
    if (prop.name === 'END') {
      const closed = stack.pop()
      if (closed === 'VEVENT' && current !== null) {
        out.push(current)
        current = null
      }
      continue
    }
    if (current !== null && stack.length === 2) current.push(prop)
  }
  return out
}

// ── 时间 ───────────────────────────────────────────────────────────────────

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  /** VALUE=DATE 或只有 8 位数字：全天事件。 */
  dateOnly: boolean
  /** 尾部带 Z：UTC 时间。 */
  utc: boolean
}

const num = (text: string | undefined): number => Number(text ?? '0')

function parseWallClock(value: string): WallClock | null {
  const text = value.trim()
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (dateOnly !== null) {
    return { year: num(dateOnly[1]), month: num(dateOnly[2]), day: num(dateOnly[3]), hour: 0, minute: 0, dateOnly: true, utc: false }
  }
  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(text)
  if (stamp === null) return null
  return {
    year: num(stamp[1]),
    month: num(stamp[2]),
    day: num(stamp[3]),
    hour: num(stamp[4]),
    minute: num(stamp[5]),
    dateOnly: false,
    utc: (stamp[7] ?? '').toUpperCase() === 'Z',
  }
}

/**
 * Windows 时区名 → IANA。只收常见的一批：Outlook 中文/英文版导出的会议绝大多数落在这里，
 * 表里没有的走 IANA 直通，再不行按本机时区兜底。
 */
const WINDOWS_TIME_ZONES: Record<string, string> = {
  'china standard time': 'Asia/Shanghai',
  'taipei standard time': 'Asia/Taipei',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'singapore standard time': 'Asia/Singapore',
  'india standard time': 'Asia/Kolkata',
  'se asia standard time': 'Asia/Bangkok',
  'arabian standard time': 'Asia/Dubai',
  'israel standard time': 'Asia/Jerusalem',
  'utc': 'UTC',
  'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'e. europe standard time': 'Europe/Chisinau',
  'russian standard time': 'Europe/Moscow',
  'pacific standard time': 'America/Los_Angeles',
  'mountain standard time': 'America/Denver',
  'central standard time': 'America/Chicago',
  'eastern standard time': 'America/New_York',
  'atlantic standard time': 'America/Halifax',
  'australian eastern standard time': 'Australia/Sydney',
  'new zealand standard time': 'Pacific/Auckland',
  'hawaiian standard time': 'Pacific/Honolulu',
}

/** 认不出就返回 null（调用方按本机时区处理，不丢事件）。 */
export function resolveTimeZone(tzid: string | undefined): string | null {
  if (tzid === undefined) return null
  const raw = tzid.trim()
  if (raw === '') return null
  const mapped = WINDOWS_TIME_ZONES[raw.toLowerCase()]
  if (mapped !== undefined) return mapped
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw })
    return raw
  } catch {
    return null
  }
}

/** 某时刻在某时区的偏移（分钟，东八区为 +480）。 */
function zoneOffsetMinutes(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const pick = (type: string): number =>
    num(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour') % 24,
    pick('minute'),
    pick('second'),
  )
  return Math.round((asUtc - utcMs) / 60000)
}

/**
 * 墙钟 → 绝对时刻。三步：按 UTC 先猜一次偏移，再用猜出的时刻复算一次（跨夏令时当天
 * 两次偏移不同的边界情形靠这一步收敛）。
 */
function wallToInstant(wall: WallClock, timeZone: string | null): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  if (wall.utc) return asUtc
  if (timeZone === null) {
    return new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute).getTime()
  }
  const first = zoneOffsetMinutes(timeZone, asUtc)
  const guessed = asUtc - first * 60000
  const second = zoneOffsetMinutes(timeZone, guessed)
  return asUtc - second * 60000
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** 本机时区的 `YYYY-MM-DDTHH:mm`。 */
function localStamp(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dateKeyOf(stamp: string): string {
  return stamp.slice(0, 10)
}

/** `P1DT2H30M` → 分钟数；解析不了返回 null。 */
export function parseIcsDuration(value: string): number | null {
  const match = /^[+-]?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
    value.trim(),
  )
  if (match === null) return null
  const [, weeks, days, hours, minutes, seconds] = match
  const total =
    num(weeks) * 7 * 24 * 60 + num(days) * 24 * 60 + num(hours) * 60 + num(minutes) + num(seconds) / 60
  return total > 0 ? total : null
}

// ── 事件 ───────────────────────────────────────────────────────────────────

function textOf(props: readonly IcsProp[], name: string): string {
  const found = props.find((prop) => prop.name === name)
  return found === undefined ? '' : unescapeIcsText(found.value).trim()
}

function addressOf(prop: IcsProp | undefined): { name: string; email: string } | null {
  if (prop === undefined) return null
  const raw = unescapeIcsText(prop.value).trim().replace(/^mailto:/i, '')
  const email = raw.trim()
  const common = unescapeIcsText(prop.params.CN ?? '').trim()
  if (email === '' && common === '') return null
  return { name: common !== '' ? common : email, email }
}

function toEvent(props: IcsProp[]): IcsEvent | null {
  const status = textOf(props, 'STATUS').toUpperCase()
  // 已取消的会议不该生成笔记：它连会都不开了
  if (status === 'CANCELLED') return null

  const startProp = props.find((prop) => prop.name === 'DTSTART')
  if (startProp === undefined) return null
  const startWall = parseWallClock(startProp.value)
  if (startWall === null) return null

  const timeZone = resolveTimeZone(startProp.params.TZID)
  const startMs = wallToInstant(startWall, timeZone)
  const start = startWall.dateOnly
    ? `${startWall.year}-${pad(startWall.month)}-${pad(startWall.day)}T00:00`
    : localStamp(startMs)

  let end: string | null = null
  const endProp = props.find((prop) => prop.name === 'DTEND')
  const endWall = endProp === undefined ? null : parseWallClock(endProp.value)
  if (endWall !== null) {
    // 全天事件的 DTEND 是「次日零点」的排他写法，这里不纠正——展示层只显示单日
    end = endWall.dateOnly
      ? `${endWall.year}-${pad(endWall.month)}-${pad(endWall.day)}T00:00`
      : localStamp(wallToInstant(endWall, resolveTimeZone(endProp?.params.TZID)))
  } else {
    const durationText = textOf(props, 'DURATION')
    const minutes = durationText === '' ? null : parseIcsDuration(durationText)
    if (minutes !== null) end = localStamp(startMs + minutes * 60000)
  }

  const attendees: IcsAttendee[] = []
  const seen = new Set<string>()
  for (const prop of props) {
    if (prop.name !== 'ATTENDEE') continue
    const address = addressOf(prop)
    if (address === null) continue
    const key = (address.email !== '' ? address.email : address.name).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    attendees.push({
      name: address.name,
      email: address.email,
      role: (prop.params.ROLE ?? '').toUpperCase(),
      status: (prop.params.PARTSTAT ?? '').toUpperCase(),
    })
  }

  const organizerAddress = addressOf(props.find((prop) => prop.name === 'ORGANIZER'))
  // 刻意不用 RFC 的 `Name <mail@x>` 写法：正文是 Markdown，尖括号会被当成 HTML 标签吃掉，
  // 屏幕上看就只剩「张三 邮箱」两截。括号是唯一在 Markdown 与纯文本里都安全的分隔。
  const organizer =
    organizerAddress === null
      ? ''
      : organizerAddress.email === '' || organizerAddress.name === organizerAddress.email
        ? organizerAddress.name
        : `${organizerAddress.name} (${organizerAddress.email})`

  const url =
    textOf(props, 'URL') ||
    textOf(props, 'X-MICROSOFT-SKYPETEAMSMEETINGURL') ||
    textOf(props, 'X-GOOGLE-CONFERENCE')

  return {
    uid: textOf(props, 'UID'),
    summary: textOf(props, 'SUMMARY'),
    start,
    end,
    dateKey: dateKeyOf(start),
    allDay: startWall.dateOnly,
    location: textOf(props, 'LOCATION'),
    organizer,
    attendees,
    description: textOf(props, 'DESCRIPTION'),
    url,
    recurring: props.some((prop) => prop.name === 'RRULE'),
  }
}

/**
 * 解析整个文件。遇到读不懂的行就跳过——一份日历里混进别的组件是常态，
 * 因为一行不认识就整份失败，对用户毫无意义。
 */
export function parseIcs(text: string): IcsEvent[] {
  const props: IcsProp[] = []
  for (const line of unfoldLines(text)) {
    const prop = parseProp(line)
    if (prop !== null) props.push(prop)
  }
  const events: IcsEvent[] = []
  for (const group of collectEvents(props)) {
    const event = toEvent(group)
    if (event !== null) events.push(event)
  }
  return events.sort((a, b) => (a.start === b.start ? a.summary.localeCompare(b.summary) : a.start < b.start ? -1 : 1))
}
