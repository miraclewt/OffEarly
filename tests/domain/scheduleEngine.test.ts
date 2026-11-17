import dayjs from 'dayjs'
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_CALENDAR,
  ScheduleEngineError,
  addWorkdays,
  createScheduleEngine,
  duration,
  isWorkday,
  nextWorkday,
  toDateKey,
  workdaysBetween,
} from '../../src/domain/scheduleEngine'
import type { WorkCalendar } from '../../src/domain/types'

// ---------------------------------------------------------------------------
// 日历夹具。星期几已用真实日期核对：
//   2026-09-30 Wed ｜ 10-01 Thu ｜ 10-02 Fri ｜ 10-03 Sat ｜ 10-04 Sun
//   2026-10-05 Mon ｜ 10-09 Fri ｜ 10-10 Sat ｜ 10-11 Sun ｜ 10-12 Mon
//   2026-12-30 Wed ｜ 12-31 Thu ｜ 2027-01-01 Fri ｜ 01-02 Sat ｜ 01-03 Sun
// ---------------------------------------------------------------------------

const CAL_STD: WorkCalendar = { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] }

// 国庆假期 10-01~10-03 放假，10-10（周六）补班。
const CAL_CN: WorkCalendar = {
  workdays: [1, 2, 3, 4, 5],
  holidays: ['2026-10-01', '2026-10-02', '2026-10-03'],
  extraWorkdays: ['2026-10-10'],
}

// ---------------------------------------------------------------------------
// 独立参照实现：用原生 Date 逐日数工作日，只用于交叉验证计数逻辑。
// 刻意不复用被测代码，避免「自己验自己」。
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function rawIsWorkday(key: string, cal: WorkCalendar): boolean {
  if (cal.holidays.includes(key)) return false
  if (cal.extraWorkdays.includes(key)) return true
  const dow = new Date(`${key}T00:00:00`).getDay()
  return cal.workdays.includes(dow)
}

function bruteForceInclusive(from: string, to: string, cal: WorkCalendar): number {
  let cur = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  let n = 0
  while (cur.getTime() <= end.getTime()) {
    if (rawIsWorkday(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`, cal)) n += 1
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1)
  }
  return n
}

// ---------------------------------------------------------------------------

describe('toDateKey · 输入规整', () => {
  it('同一日期以 string / Date / Dayjs 三种形式传入得到同一 key', () => {
    expect(toDateKey('2026-10-05')).toBe('2026-10-05')
    expect(toDateKey(new Date(2026, 9, 5))).toBe('2026-10-05')
    expect(toDateKey(dayjs('2026-10-05'))).toBe('2026-10-05')
  })

  it('日期串非法时抛 ScheduleEngineError，而不是产出 NaN 日期', () => {
    expect(() => toDateKey('2026-13-01')).toThrow(ScheduleEngineError)
    expect(() => toDateKey('2026-02-30')).toThrow(ScheduleEngineError)
    expect(() => toDateKey('not-a-date')).toThrow(ScheduleEngineError)
    expect(() => toDateKey('2026/10/05')).toThrow(ScheduleEngineError)
  })

  it('DEFAULT_CALENDAR 为周一至周五工作、无节假日与补班', () => {
    expect(DEFAULT_CALENDAR).toEqual({ workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] })
    expect(isWorkday('2026-10-05', DEFAULT_CALENDAR)).toBe(true)
    expect(isWorkday('2026-10-10', DEFAULT_CALENDAR)).toBe(false)
  })
})

describe('isWorkday · 周末 / 节假日 / 补班', () => {
  it('工作日历默认口径下周一至周五为工作日，周六周日不是', () => {
    expect(isWorkday('2026-10-05', CAL_STD)).toBe(true) // Mon
    expect(isWorkday('2026-10-09', CAL_STD)).toBe(true) // Fri
    expect(isWorkday('2026-10-10', CAL_STD)).toBe(false) // Sat
    expect(isWorkday('2026-10-11', CAL_STD)).toBe(false) // Sun
  })

  it('holidays 里的工作日不算工作日', () => {
    expect(isWorkday('2026-10-01', CAL_CN)).toBe(false) // Thu，法定假期
    expect(isWorkday('2026-10-02', CAL_CN)).toBe(false) // Fri，法定假期
  })

  it('extraWorkdays 里的周六算工作日（补班）', () => {
    expect(isWorkday('2026-10-10', CAL_CN)).toBe(true) // Sat，补班
    expect(isWorkday('2026-10-10', CAL_STD)).toBe(false) // 未配补班时仍是休息日
  })

  it('同一日期同时出现在 holidays 与 extraWorkdays 时以 holidays 为准（取休息）', () => {
    const conflicting: WorkCalendar = {
      workdays: [1, 2, 3, 4, 5],
      holidays: ['2026-10-05'],
      extraWorkdays: ['2026-10-05'],
    }
    expect(isWorkday('2026-10-05', conflicting)).toBe(false)
  })

  it('自定义 workdays 生效（可把周末设为工作日、把平日设为休息日）', () => {
    const weekendOnly: WorkCalendar = { workdays: [0, 6], holidays: [], extraWorkdays: [] }
    expect(isWorkday('2026-10-10', weekendOnly)).toBe(true) // Sat
    expect(isWorkday('2026-10-11', weekendOnly)).toBe(true) // Sun
    expect(isWorkday('2026-10-05', weekendOnly)).toBe(false) // Mon
  })

  it('workdays 为空数组时没有任何工作日', () => {
    const none: WorkCalendar = { workdays: [], holidays: [], extraWorkdays: [] }
    expect(isWorkday('2026-10-05', none)).toBe(false)
    expect(isWorkday('2026-10-10', none)).toBe(false)
  })
})

describe('nextWorkday · 严格向后取下一个工作日', () => {
  it('周五的下一个工作日是下周一（跳过周末）', () => {
    expect(nextWorkday('2026-10-09', CAL_STD)).toBe('2026-10-12')
  })

  it('输入本身是工作日时仍取其后一天，不会返回自己', () => {
    expect(nextWorkday('2026-10-05', CAL_STD)).toBe('2026-10-06')
  })

  it('连续假期整体顺延（09-30 → 10-05，跳过 3 天假期与周末）', () => {
    expect(nextWorkday('2026-09-30', CAL_CN)).toBe('2026-10-05')
  })

  it('补班周六被认得：10-09 的下一个工作日就是 10-10', () => {
    expect(nextWorkday('2026-10-09', CAL_CN)).toBe('2026-10-10')
  })

  it('跨年边界正确（12-31 → 2027-01-01）', () => {
    expect(nextWorkday('2026-12-31', CAL_STD)).toBe('2027-01-01')
    expect(nextWorkday('2027-01-01', CAL_STD)).toBe('2027-01-04')
  })
})

describe('addWorkdays · 工作日推移', () => {
  it('n=0 返回当日，即使当日不是工作日', () => {
    expect(addWorkdays('2026-10-05', 0, CAL_STD)).toBe('2026-10-05')
    expect(addWorkdays('2026-10-10', 0, CAL_STD)).toBe('2026-10-10') // Sat
  })

  it('正向推移跳过周末（Fri +1 → Mon）', () => {
    expect(addWorkdays('2026-10-09', 1, CAL_STD)).toBe('2026-10-12')
  })

  it('正向推移可跨多个周末（Mon +5 → 下下周一）', () => {
    expect(addWorkdays('2026-10-05', 5, CAL_STD)).toBe('2026-10-12')
  })

  it('负数向前推（Mon -1 → 上周五）', () => {
    expect(addWorkdays('2026-10-05', -1, CAL_STD)).toBe('2026-10-02')
  })

  it('跳过节假日（09-30 +1 → 10-05）', () => {
    expect(addWorkdays('2026-09-30', 1, CAL_CN)).toBe('2026-10-05')
  })

  it('补班周六计入工作日（Fri +1 → 补班周六）', () => {
    expect(addWorkdays('2026-10-09', 1, CAL_CN)).toBe('2026-10-10')
    expect(addWorkdays('2026-10-09', 1, CAL_STD)).toBe('2026-10-12')
  })

  it('跨年正向正确（12-30 +2 → 2027-01-01）', () => {
    expect(addWorkdays('2026-12-30', 2, CAL_STD)).toBe('2027-01-01')
  })

  it('跨年负向正确（2027-01-03 -2 → 2026-12-31）', () => {
    expect(addWorkdays('2027-01-03', -2, CAL_STD)).toBe('2026-12-31')
  })

  it('节假日与补班叠加时跨年仍正确（12-31 +1，元旦放假、01-02 补班不计）', () => {
    const cal: WorkCalendar = {
      workdays: [1, 2, 3, 4, 5],
      holidays: ['2027-01-01'],
      extraWorkdays: [],
    }
    expect(addWorkdays('2026-12-31', 1, cal)).toBe('2027-01-04')
  })

  it('日历上永不存在工作日时抛错，而不是无限循环', () => {
    const none: WorkCalendar = { workdays: [], holidays: [], extraWorkdays: [] }
    expect(() => addWorkdays('2026-10-05', 1, none)).toThrow(ScheduleEngineError)
    expect(() => addWorkdays('2026-10-05', -1, none)).toThrow(ScheduleEngineError)
  })
})

describe('workdaysBetween · 含末日、不含首日', () => {
  it('Mon → Fri 记 4（区间为 (首日, 末日]）', () => {
    expect(workdaysBetween('2026-10-05', '2026-10-09', CAL_STD)).toBe(4)
  })

  it('同一日期记 0（配合 duration 的 +1 恰好得 1 天工期）', () => {
    expect(workdaysBetween('2026-10-05', '2026-10-05', CAL_STD)).toBe(0)
    expect(workdaysBetween('2026-10-10', '2026-10-10', CAL_STD)).toBe(0) // Sat
  })

  it('a > b 返回负值，且与正向反对称', () => {
    expect(workdaysBetween('2026-10-09', '2026-10-05', CAL_STD)).toBe(-4)
    expect(workdaysBetween('2026-10-09', '2026-10-05', CAL_STD)).toBe(
      -workdaysBetween('2026-10-05', '2026-10-09', CAL_STD),
    )
  })

  it('末日落在周末时不计入（Mon → Sat 仍为 4）', () => {
    expect(workdaysBetween('2026-10-05', '2026-10-10', CAL_STD)).toBe(4)
  })

  it('首日落在周末时不影响计数（Sat → Mon 为 1）', () => {
    expect(workdaysBetween('2026-10-10', '2026-10-12', CAL_STD)).toBe(1)
    expect(workdaysBetween('2026-10-11', '2026-10-12', CAL_STD)).toBe(1)
  })

  it('纯周末区间记 0', () => {
    expect(workdaysBetween('2026-10-10', '2026-10-11', CAL_STD)).toBe(0)
  })

  it('跨年正确（12-30 → 2027-01-03 为 2）', () => {
    expect(workdaysBetween('2026-12-30', '2027-01-03', CAL_STD)).toBe(2)
  })

  it('跨年反向返回负值（2027-01-03 → 12-30 为 -2）', () => {
    expect(workdaysBetween('2027-01-03', '2026-12-30', CAL_STD)).toBe(-2)
  })

  it('跨年叠加节假日与补班（元旦放假、01-02 补班）', () => {
    const cal: WorkCalendar = {
      workdays: [1, 2, 3, 4, 5],
      holidays: ['2027-01-01'],
      extraWorkdays: ['2027-01-02'],
    }
    // (12-30, 01-03] = 12-31(Thu 工作) ｜ 01-01(Fri 假期 不计) ｜ 01-02(Sat 补班 计) ｜ 01-03(Sun 不计)
    expect(workdaysBetween('2026-12-30', '2027-01-03', cal)).toBe(2)
  })

  it('与原生 Date 逐日遍历的独立实现一致（两年跨度 + 假期 + 补班）', () => {
    const cal: WorkCalendar = {
      workdays: [1, 2, 3, 4, 5],
      holidays: ['2026-01-01', '2026-05-01', '2026-10-01', '2026-10-02', '2027-01-01'],
      extraWorkdays: ['2026-02-08', '2026-10-10', '2027-02-07'],
    }
    const from = '2026-01-05'
    const to = '2027-12-31'
    expect(workdaysBetween(from, to, cal) + 1).toBe(bruteForceInclusive(from, to, cal))
  })

  it('与独立实现在反向区间上同样一致（负值取反）', () => {
    const from = '2026-01-05'
    const to = '2027-12-31'
    expect(workdaysBetween(to, from, CAL_CN)).toBe(-(bruteForceInclusive(from, to, CAL_CN) - 1))
  })
})

describe('duration · 工期', () => {
  it('start / due 缺失一律返回 null', () => {
    expect(duration({}, CAL_STD)).toBeNull()
    expect(duration({ start: '2026-10-05' }, CAL_STD)).toBeNull()
    expect(duration({ due: '2026-10-09' }, CAL_STD)).toBeNull()
    expect(duration({ start: undefined, due: undefined }, CAL_STD)).toBeNull()
  })

  it('Mon → Fri 为 5 个工作日', () => {
    expect(duration({ start: '2026-10-05', due: '2026-10-09' }, CAL_STD)).toBe(5)
  })

  it('同日任务为 1 天', () => {
    expect(duration({ start: '2026-10-05', due: '2026-10-05' }, CAL_STD)).toBe(1)
  })

  it('跨周末的工期只数工作日（Fri → Mon 为 2）', () => {
    expect(duration({ start: '2026-10-09', due: '2026-10-12' }, CAL_STD)).toBe(2)
  })

  it('扣除节假日、计入补班周六（09-30 → 10-09 为 6）', () => {
    expect(duration({ start: '2026-09-30', due: '2026-10-09' }, CAL_CN)).toBe(6)
  })

  it('跨年工期正确（12-30 → 2027-01-03 为 3）', () => {
    expect(duration({ start: '2026-12-30', due: '2027-01-03' }, CAL_STD)).toBe(3)
  })

  it('恒等于 workdaysBetween(start, due) + 1（含 due < start 的反向输入）', () => {
    const cases: Array<{ start: string; due: string }> = [
      { start: '2026-10-05', due: '2026-10-09' },
      { start: '2026-10-05', due: '2026-10-05' },
      { start: '2026-10-09', due: '2026-10-05' },
      { start: '2026-12-30', due: '2027-01-03' },
      { start: '2026-10-10', due: '2026-10-11' },
    ]
    for (const c of cases) {
      expect(duration(c, CAL_CN)).toBe(workdaysBetween(c.start, c.due, CAL_CN) + 1)
    }
    // 反向输入的产物为负值，交由调用方按 start <= due 校验；此处只锁公式
    expect(duration({ start: '2026-10-09', due: '2026-10-05' }, CAL_STD)).toBe(-3)
  })
})

describe('memoize · 按日期串缓存', () => {
  it('同一日期二次调用 isWorkday 只计算一次（spy 计数为 1）', () => {
    const onCompute = vi.fn()
    const engine = createScheduleEngine(CAL_STD, { onCompute })

    expect(engine.isWorkday('2026-10-05')).toBe(true)
    expect(engine.isWorkday('2026-10-05')).toBe(true)

    expect(onCompute).toHaveBeenCalledTimes(1)
    expect(onCompute).toHaveBeenCalledWith('2026-10-05')
  })

  it('同一区间二次调用 workdaysBetween 不新增计算（全命中缓存）', () => {
    const onCompute = vi.fn()
    const engine = createScheduleEngine(CAL_STD, { onCompute })

    engine.workdaysBetween('2026-10-05', '2026-10-09')
    const afterFirst = onCompute.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    engine.workdaysBetween('2026-10-05', '2026-10-09')
    expect(onCompute.mock.calls.length).toBe(afterFirst)
  })

  it('不同日期分别计算，重复日期不重复计', () => {
    const onCompute = vi.fn()
    const engine = createScheduleEngine(CAL_STD, { onCompute })

    engine.isWorkday('2026-10-05')
    engine.isWorkday('2026-10-06')
    engine.isWorkday('2026-10-05')

    expect(onCompute).toHaveBeenCalledTimes(2)
  })

  it('duration 复用同一缓存：首次真算，二次零计算', () => {
    const onCompute = vi.fn()
    const engine = createScheduleEngine(CAL_CN, { onCompute })
    const task = { start: '2026-09-30', due: '2026-10-09' }

    expect(engine.duration(task)).toBe(6)
    const afterFirst = onCompute.mock.calls.length
    // (09-30, 10-09] 共 9 天，首次必须真的逐日算过，否则下面的零增量是假的
    expect(afterFirst).toBe(9)

    expect(engine.duration(task)).toBe(6)
    expect(onCompute.mock.calls.length).toBe(afterFirst)
    expect(engine.cacheSize()).toBe(afterFirst)
  })

  it('addWorkdays / nextWorkday 也走缓存，重复调用零新增计算', () => {
    const onCompute = vi.fn()
    const engine = createScheduleEngine(CAL_CN, { onCompute })

    expect(engine.addWorkdays('2026-10-09', 1)).toBe('2026-10-10')
    const afterFirst = onCompute.mock.calls.length
    expect(engine.addWorkdays('2026-10-09', 1)).toBe('2026-10-10')
    expect(engine.nextWorkday('2026-10-09')).toBe('2026-10-10')
    expect(onCompute.mock.calls.length).toBe(afterFirst)
  })

  it('每个实例独立持有缓存（模块级无共享可变状态）', () => {
    const spyA = vi.fn()
    const spyB = vi.fn()
    const a = createScheduleEngine(CAL_STD, { onCompute: spyA })
    const b = createScheduleEngine(CAL_STD, { onCompute: spyB })

    a.isWorkday('2026-10-05')
    b.isWorkday('2026-10-05')

    expect(spyA).toHaveBeenCalledTimes(1)
    expect(spyB).toHaveBeenCalledTimes(1)
    expect(a.cacheSize()).toBe(1)
    expect(b.cacheSize()).toBe(1)
  })

  it('memoize 不改变结果：engine 与裸函数逐项一致', () => {
    const engine = createScheduleEngine(CAL_CN)
    const days = ['2026-09-30', '2026-10-01', '2026-10-03', '2026-10-10', '2026-10-12']
    for (const d of days) {
      expect(engine.isWorkday(d)).toBe(isWorkday(d, CAL_CN))
    }
    expect(engine.workdaysBetween('2026-09-30', '2026-10-09')).toBe(
      workdaysBetween('2026-09-30', '2026-10-09', CAL_CN),
    )
    expect(engine.addWorkdays('2026-09-30', 1)).toBe(addWorkdays('2026-09-30', 1, CAL_CN))
    expect(engine.nextWorkday('2026-10-09')).toBe(nextWorkday('2026-10-09', CAL_CN))
    expect(engine.duration({ start: '2026-09-30', due: '2026-10-09' })).toBe(
      duration({ start: '2026-09-30', due: '2026-10-09' }, CAL_CN),
    )
  })

  it('每实例日历互不干扰（同一实例缓存被日历正确解释）', () => {
    const weekend = createScheduleEngine({ workdays: [0, 6], holidays: [], extraWorkdays: [] })
    const weekday = createScheduleEngine(CAL_STD)
    expect(weekend.isWorkday('2026-10-10')).toBe(true)
    expect(weekday.isWorkday('2026-10-10')).toBe(false)
  })
})
