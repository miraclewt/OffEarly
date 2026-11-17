// T54 · 日期纯函数：掩码 / 解析 / 网格。
//
// 这一层是 F10 的可测部分：原生 `<input type="date">` 会把伪日期消毒成空串，
// 浏览器与 jsdom 同行为，所以「2026-02-30 必须被拒」这类断言只能落在纯函数上。

import { describe, expect, it } from 'vitest'

import {
  buildMonthGrid,
  daysInMonth,
  isLeapYear,
  isValidIsoDate,
  maskDateInput,
  monthKey,
  parseDateDraft,
  shiftIsoDate,
  shiftIsoMonth,
} from '../../src/views/dateInput'

describe('maskDateInput', () => {
  it('只留数字并按 YYYY-MM-DD 分组补连字符', () => {
    expect(maskDateInput('1')).toBe('1')
    expect(maskDateInput('2026')).toBe('2026')
    expect(maskDateInput('20261')).toBe('2026-1')
    expect(maskDateInput('202610')).toBe('2026-10')
    expect(maskDateInput('2026100')).toBe('2026-10-0')
    expect(maskDateInput('20261005')).toBe('2026-10-05')
  })

  it('粘贴带分隔符的串保留分组：非补零的月日不会被挤成一组', () => {
    expect(maskDateInput('2026/10/05')).toBe('2026-10-05')
    expect(maskDateInput('2026.1.5')).toBe('2026-1-5')
    expect(maskDateInput('2026年10月5日')).toBe('2026-10-5')
    expect(maskDateInput('2026--1')).toBe('2026-1')
  })

  it('超过 8 位截断（多打的数字不会顶到年份前面）', () => {
    expect(maskDateInput('202610059999')).toBe('2026-10-05')
  })

  it('逐字输入 `2026-1-5` 不会被掩码吞掉第二个连字符', () => {
    let value = ''
    for (const char of '2026-1-5') value = maskDateInput(value + char)
    expect(value).toBe('2026-1-5')
    expect(parseDateDraft(value)).toEqual({ kind: 'valid', value: '2026-01-05' })
  })
})

describe('parseDateDraft', () => {
  it('空文本是「清空」而不是错误', () => {
    expect(parseDateDraft('')).toEqual({ kind: 'empty' })
    expect(parseDateDraft('   ')).toEqual({ kind: 'empty' })
  })

  it('接受补齐与不补齐的写法，统一输出 ISO', () => {
    expect(parseDateDraft('2026-10-05')).toEqual({ kind: 'valid', value: '2026-10-05' })
    expect(parseDateDraft('2026-1-5')).toEqual({ kind: 'valid', value: '2026-01-05' })
    expect(parseDateDraft('2026/1/5')).toEqual({ kind: 'valid', value: '2026-01-05' })
    expect(parseDateDraft('2026.1.5')).toEqual({ kind: 'valid', value: '2026-01-05' })
    expect(parseDateDraft('20260105')).toEqual({ kind: 'valid', value: '2026-01-05' })
  })

  it('伪日期一律拒绝：2 月 30 日、13 月、0 日、非闰年的 2 月 29 日', () => {
    expect(parseDateDraft('2026-02-30')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('2026-13-01')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('2026-00-10')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('2026-10-00')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('2026-10-32')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('2027-02-29')).toEqual({ kind: 'invalid' })
  })

  it('闰年 2 月 29 日合法，上半年/下半年的月长都算对', () => {
    expect(parseDateDraft('2028-02-29')).toEqual({ kind: 'valid', value: '2028-02-29' })
    expect(parseDateDraft('2000-02-29')).toEqual({ kind: 'valid', value: '2000-02-29' })
    expect(parseDateDraft('1900-02-29')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('2026-04-31')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('2026-12-31')).toEqual({ kind: 'valid', value: '2026-12-31' })
  })

  it('半截文本与乱码算非法（但不含数字以外的东西会被掩码先挡掉）', () => {
    expect(parseDateDraft('2026-1')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('2026-')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('abc')).toEqual({ kind: 'invalid' })
    expect(parseDateDraft('0000-01-01')).toEqual({ kind: 'invalid' })
  })
})

describe('isValidIsoDate', () => {
  it('只认补齐的 ISO 串', () => {
    expect(isValidIsoDate('2026-10-05')).toBe(true)
    expect(isValidIsoDate('2026-1-5')).toBe(false)
    expect(isValidIsoDate('2026-02-30')).toBe(false)
    expect(isValidIsoDate('')).toBe(false)
  })
})

describe('日历基础计算', () => {
  it('闰年与月长', () => {
    expect(isLeapYear(2026)).toBe(false)
    expect(isLeapYear(2028)).toBe(true)
    expect(isLeapYear(1900)).toBe(false)
    expect(isLeapYear(2000)).toBe(true)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
  })

  it('按天平移跨月跨年', () => {
    expect(shiftIsoDate('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftIsoDate('2026-10-05', 7)).toBe('2026-10-12')
    expect(shiftIsoDate('2026-10-05', 0)).toBe('2026-10-05')
  })

  it('按月平移，31 号落到短月最后一天而不是溢出到下个月', () => {
    expect(shiftIsoMonth('2026-01-31', 1)).toBe('2026-02-28')
    expect(shiftIsoMonth('2026-12-01', 1)).toBe('2027-01-01')
    expect(shiftIsoMonth('2026-03-01', -1)).toBe('2026-02-01')
  })

  it('monthKey 只截年月', () => {
    expect(monthKey('2026-10-05')).toBe('2026-10')
    expect(monthKey('2026-10')).toBe('2026-10')
  })
})

describe('buildMonthGrid', () => {
  it('首列对齐周一：2026-10-01 是周四，网格从 2026-09-28 起', () => {
    const cells = buildMonthGrid('2026-10-01')
    expect(cells[0]?.iso).toBe('2026-09-28')
    expect(cells[0]?.inMonth).toBe(false)
    expect(cells[3]?.iso).toBe('2026-10-01')
    expect(cells[3]?.inMonth).toBe(true)
    expect(cells[3]?.day).toBe(1)
  })

  it('行数是 7 的整数倍，6 行只出现在需要的月份', () => {
    // 2026-10：3 格补月初 + 31 天 = 34 → 5 行
    expect(buildMonthGrid('2026-10-01')).toHaveLength(35)
    // 2026-08：8 月 1 日是周六 → 5 格补月初 + 31 天 = 36 → 6 行
    expect(buildMonthGrid('2026-08-01')).toHaveLength(42)
  })

  it('补格是真实日期，不是占位空串（点它也能落到正确的一天）', () => {
    const cells = buildMonthGrid('2026-10-01')
    expect(cells[34]?.iso).toBe('2026-11-01')
    expect(cells[34]?.inMonth).toBe(false)
    expect(cells.every((cell) => isValidIsoDate(cell.iso))).toBe(true)
  })

  it('闰年 2 月有 29 天', () => {
    const inMonth = buildMonthGrid('2028-02-01').filter((cell) => cell.inMonth)
    expect(inMonth).toHaveLength(29)
    expect(inMonth[28]?.iso).toBe('2028-02-29')
  })
})
