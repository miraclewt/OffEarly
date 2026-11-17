// T62 · iCalendar 解析：折行 / 转义 / 时区 / 全天 / 嵌套组件 / 取消状态。

import { describe, expect, it } from 'vitest'

import {
  parseIcs,
  parseIcsDuration,
  resolveTimeZone,
  unescapeIcsText,
  unfoldLines,
} from '../../src/domain/ics'

const CRLF = '\r\n'

/** 拼一份最小可用的日历；lines 是 VEVENT 内的属性行（不含 BEGIN/END）。 */
function calendar(...lines: string[]): string {
  return (
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//OffEarly//T62//CN',
      'BEGIN:VEVENT',
      ...lines,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(CRLF) + CRLF
  )
}

describe('ics · 折行与转义', () => {
  it('把「空格开头的续行」拼回上一行（RFC 5545 的 75 字节硬折）', () => {
    const lines = unfoldLines(['SUMMARY:支付对账文件解', ' 析方案评审'].join(CRLF))
    expect(lines).toEqual(['SUMMARY:支付对账文件解析方案评审'])
  })

  it('Tab 续行同样拼接，且只吃掉一个前缀字符', () => {
    expect(unfoldLines([`SUMMARY:abc`, `\tdef`].join(CRLF))).toEqual(['SUMMARY:abcdef'])
  })

  it('普通行不由上一行吞掉', () => {
    expect(unfoldLines(['A:1', 'B:2'].join(CRLF))).toEqual(['A:1', 'B:2'])
  })

  it('还原 \\, \\; \\n 与 \\\\ 四种转义', () => {
    expect(unescapeIcsText('甲\\,乙\\;丙\\n丁\\\\戊')).toBe('甲,乙;丙\n丁\\戊')
  })

  it('未知转义保留字符本身，不吞内容', () => {
    expect(unescapeIcsText('a\\:b')).toBe('a:b')
  })
})

describe('ics · 单个事件的字段', () => {
  const text = calendar(
    'UID:t62-0001',
    'SUMMARY:支付对账文件解析方案评审',
    'DTSTART:20261023T060000Z',
    'DTEND:20261023T070000Z',
    'LOCATION:3 楼会议室 / Teams',
    'ORGANIZER;CN=张三:mailto:zhangsan@example.com',
    'ATTENDEE;CN=李四;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:lisi@example.com',
    'ATTENDEE;CN="Doe, John":mailto:john@example.com',
    'URL:https://outlook.office.com/calendar/item/abc',
    'DESCRIPTION:议题一\\n议题二',
  )

  it('主题 / 地点 / 组织者 / 链接 / 正文逐个落地', () => {
    const [event] = parseIcs(text)
    expect(event?.uid).toBe('t62-0001')
    expect(event?.summary).toBe('支付对账文件解析方案评审')
    expect(event?.location).toBe('3 楼会议室 / Teams')
    expect(event?.organizer).toBe('张三 (zhangsan@example.com)')
    expect(event?.url).toBe('https://outlook.office.com/calendar/item/abc')
    expect(event?.description).toBe('议题一\n议题二')
    expect(event?.allDay).toBe(false)
    expect(event?.recurring).toBe(false)
  })

  it('参会人取 CN 作显示名，引号里的逗号不切断参数', () => {
    const [event] = parseIcs(text)
    expect(event?.attendees.map((person) => person.name)).toEqual(['李四', 'Doe, John'])
    expect(event?.attendees[1]?.email).toBe('john@example.com')
    expect(event?.attendees[0]?.status).toBe('ACCEPTED')
  })

  it('引号里的冒号不当作属性分隔符', () => {
    const [event] = parseIcs(
      calendar('DTSTART:20261023T060000Z', 'ATTENDEE;CN="Zoom: Room 3":mailto:room@example.com', 'SUMMARY:A'),
    )
    expect(event?.attendees[0]?.name).toBe('Zoom: Room 3')
    expect(event?.attendees[0]?.email).toBe('room@example.com')
  })

  it('同一邮箱重复出现只算一个人', () => {
    const [event] = parseIcs(
      calendar(
        'DTSTART:20261023T060000Z',
        'ATTENDEE;CN=李四:mailto:lisi@example.com',
        'ATTENDEE;CN=李四（备用）:mailto:LISI@example.com',
        'SUMMARY:A',
      ),
    )
    expect(event?.attendees).toHaveLength(1)
  })
})

describe('ics · 时间', () => {
  it('UTC 与东八区墙钟指向同一时刻', () => {
    const utc = parseIcs(calendar('UID:a', 'DTSTART:20261023T060000Z', 'SUMMARY:A'))[0]
    const iana = parseIcs(calendar('UID:a', 'DTSTART;TZID=Asia/Shanghai:20261023T140000', 'SUMMARY:A'))[0]
    expect(iana?.start).toBe(utc?.start)
  })

  it('Windows 时区名按映射表折算（Outlook 的常见导出形态）', () => {
    const windows = parseIcs(
      calendar('UID:a', 'DTSTART;TZID=China Standard Time:20261023T140000', 'SUMMARY:A'),
    )[0]
    const iana = parseIcs(calendar('UID:a', 'DTSTART;TZID=Asia/Shanghai:20261023T140000', 'SUMMARY:A'))[0]
    expect(windows?.start).toBe(iana?.start)
    expect(resolveTimeZone('China Standard Time')).toBe('Asia/Shanghai')
    expect(resolveTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(resolveTimeZone('火星标准时')).toBeNull()
  })

  it('VALUE=DATE 是全天事件，不受时区换算影响', () => {
    const [event] = parseIcs(
      calendar('UID:a', 'DTSTART;VALUE=DATE:20261023', 'DTEND;VALUE=DATE:20261024', 'SUMMARY:全天评审'),
    )
    expect(event?.allDay).toBe(true)
    expect(event?.start).toBe('2026-10-23T00:00')
    expect(event?.dateKey).toBe('2026-10-23')
  })

  it('没有 DTEND 时用 DURATION 推结束时间', () => {
    const [event] = parseIcs(
      calendar('UID:a', 'DTSTART;TZID=Asia/Shanghai:20261023T140000', 'DURATION:PT1H30M', 'SUMMARY:A'),
    )
    expect(event?.end).not.toBeNull()
    const span = Date.parse(event?.end ?? '') - Date.parse(event?.start ?? '')
    expect(span).toBe(90 * 60000)
  })

  it('DURATION 解析：周 / 天 / 时分秒，非法值返回 null', () => {
    expect(parseIcsDuration('PT1H30M')).toBe(90)
    expect(parseIcsDuration('P1D')).toBe(1440)
    expect(parseIcsDuration('P2W')).toBe(20160)
    expect(parseIcsDuration('PT45S')).toBe(0.75)
    expect(parseIcsDuration('随便写的')).toBeNull()
  })
})

describe('ics · 过滤与容器', () => {
  it('已取消的会议不产出事件', () => {
    expect(parseIcs(calendar('UID:a', 'DTSTART:20261023T060000Z', 'SUMMARY:A', 'STATUS:CANCELLED'))).toHaveLength(0)
  })

  it('没有 DTSTART 的条目被跳过', () => {
    expect(parseIcs(calendar('UID:a', 'SUMMARY:没有开始时间'))).toHaveLength(0)
  })

  it('VALARM 里的同名属性不会污染事件（只收 VEVENT 直接子节点）', () => {
    const [event] = parseIcs(
      calendar(
        'UID:a',
        'DTSTART:20261023T060000Z',
        'SUMMARY:真主题',
        'BEGIN:VALARM',
        'SUMMARY:提醒',
        'TRIGGER:-PT15M',
        'END:VALARM',
      ),
    )
    expect(event?.summary).toBe('真主题')
  })

  it('带 RRULE 标记为重复会议，但仍按单场返回', () => {
    const events = parseIcs(
      calendar('UID:a', 'DTSTART:20261023T060000Z', 'SUMMARY:周会', 'RRULE:FREQ=WEEKLY;BYDAY=WE'),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.recurring).toBe(true)
  })

  it('多场会议按开始时间升序，读不懂的行不影响整体', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:late',
      'DTSTART:20261024T060000Z',
      'SUMMARY:晚的',
      'END:VEVENT',
      '这一行没有冒号',
      'BEGIN:VEVENT',
      'UID:early',
      'DTSTART:20261023T060000Z',
      'SUMMARY:早的',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(CRLF)
    expect(parseIcs(text).map((event) => event.uid)).toEqual(['early', 'late'])
  })

  it('空文件 / 非日历文本返回空数组而不是抛错', () => {
    expect(parseIcs('')).toEqual([])
    expect(parseIcs('随便一段文字')).toEqual([])
  })
})
