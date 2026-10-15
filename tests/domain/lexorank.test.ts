import { describe, expect, it } from 'vitest'

import { ALPHABET, mid } from '../../src/domain/lexorank'

/** 词典序即分数序：整个模块只依赖字符串比较，不做任何数值解析。 */
function sorted(keys: string[]): string[] {
  return [...keys].sort()
}

describe('mid 的基本契约', () => {
  it('两端都为空时返回一个可用中值', () => {
    const k = mid()
    expect(k.length).toBe(1)
    expect(ALPHABET).toContain(k)
  })

  it('严格介于 a、b 之间（词典序）', () => {
    const k = mid('5', '9')
    expect('5' < k).toBe(true)
    expect(k < '9').toBe(true)
  })

  it('a、b 相邻（差 1）时自动加长，仍严格介于', () => {
    const k = mid('5', '6')
    expect('5' < k).toBe(true)
    expect(k < '6').toBe(true)
    expect(k.length).toBeGreaterThan(1)
  })

  it('a、b 长度不同、共前缀时正确下钻', () => {
    const k = mid('52', '55')
    expect('52' < k).toBe(true)
    expect(k < '55').toBe(true)

    const j = mid('5', '55')
    expect('5' < j).toBe(true)
    expect(j < '55').toBe(true)
  })

  it('等值或逆序入参直接抛错，不做静默兜底', () => {
    expect(() => mid('9', '5')).toThrow(/顺序/)
    expect(() => mid('5', '5')).toThrow(/顺序/)
  })

  it('结果永不含全零（否则会造出「前缀 + 全零」邻对，后续插入无解）', () => {
    const samples = [mid(), mid('5', '6'), mid(undefined, '1'), mid('z', undefined)]
    for (const k of samples) {
      expect(/[^0]/.test(k)).toBe(true)
    }
  })
})

describe('首尾插入', () => {
  it('b 为 undefined：结果严格大于 a', () => {
    for (const a of ['0', '5', 'V', 'z', 'zz', 'zV', '5z']) {
      const k = mid(a, undefined)
      expect(k > a).toBe(true)
    }
  })

  it('a 为 undefined：结果严格小于 b', () => {
    for (const b of ['1', '2', '5', 'V', 'z', '01', '0V', 'zz']) {
      const k = mid(undefined, b)
      expect(k < b).toBe(true)
    }
  })

  it('空表首插再首尾各插一次，顺序自洽', () => {
    const first = mid()
    const after = mid(first, undefined)
    const before = mid(undefined, first)
    expect(sorted([first, after, before])).toEqual([before, first, after])
  })
})

describe('连续插入不退化', () => {
  it('尾部连续追加 100 次：100 个互异键、严格递增、长度有界', () => {
    let last = mid()
    const keys = [last]
    for (let i = 0; i < 100; i += 1) {
      const next = mid(last, undefined)
      expect(next > last).toBe(true)
      keys.push(next)
      last = next
    }
    expect(new Set(keys).size).toBe(keys.length)
    expect(sorted(keys)).toEqual(keys)
    // 定长中点方案会在这里退化成等长冲突；本实现每字符约容纳 61 次追加
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(4)
  })

  it('头部连续插入 100 次：100 个互异键、严格递减、长度有界', () => {
    let first = mid()
    const keys = [first]
    for (let i = 0; i < 100; i += 1) {
      const prev = mid(undefined, first)
      expect(prev < first).toBe(true)
      keys.push(prev)
      first = prev
    }
    expect(new Set(keys).size).toBe(keys.length)
    expect(sorted(keys)).toEqual([...keys].reverse())
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(8)
  })

  it('同一间隙反复插入 100 次：每次都严格落在间隙内且互异', () => {
    const lo = '5'
    const hi = '6'
    const keys: string[] = []
    let upper = hi
    for (let i = 0; i < 100; i += 1) {
      const k = mid(lo, upper)
      expect(lo < k).toBe(true)
      expect(k < upper).toBe(true)
      keys.push(k)
      upper = k
    }
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('随机插入 300 次后整体有序且无重复', () => {
    const keys = [mid()]
    for (let i = 0; i < 300; i += 1) {
      const index = Math.floor(Math.random() * (keys.length + 1))
      const lo = index === 0 ? undefined : keys[index - 1]
      const hi = index === keys.length ? undefined : keys[index]
      const k = mid(lo, hi)
      keys.splice(index, 0, k)
      expect(sorted(keys)).toEqual(keys)
    }
    expect(new Set(keys).size).toBe(301)
  })
})
