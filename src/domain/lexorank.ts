// LexoRank：任务/话题排序键。键是 62 进制「分数串」，比较只走字符串词典序。
//
// 为什么不用定长中点：定长方案在反复插同一间隙时会把间隙二分到 0，只能用等长键硬顶，
// 最终产生冲突并退化。这里让键可长可短——有界间隙走真中点（每次加一位），
// 开区间（首/尾）走「紧邻的上下一个键」，于是每多一个字符能容纳约 61 次同向插入。
//
// 不变式（整个模块依赖它，between 才有解）：
//   ① 键非空、只含 ALPHABET 中的字符；
//   ② 键至少含一个非零位 —— 否则会出现「k 与 k + 全零」这种邻对，
//      二者之间不存在任何字符串，插入将无解。

/** '0'-'9' 'A'-'Z' 'a'-'z'，ASCII 顺序 = 数值顺序，所以词典序比较天然正确。 */
export const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 基数。 */
const BASE = ALPHABET.length

/** 空表首插用的中值，也是「无上界」时补位的默认字符。 */
const MID_DIGIT = 31

function digitOf(ch: string): number {
  const index = ALPHABET.indexOf(ch)
  if (index < 0) throw new Error(`lexorank: 非法字符 ${JSON.stringify(ch)}`)
  return index
}

function charOf(digit: number): string {
  const char = ALPHABET[digit]
  if (char === undefined) throw new Error(`lexorank: 位值越界 ${digit}`)
  return char
}

/** 严格大于 s 的键，尽量贴近 s：优先给最靠右的可进位加一，全满位才延长一位。 */
function above(s: string): string {
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const digit = digitOf(s[i] as string)
    if (digit < BASE - 1) return s.slice(0, i) + charOf(digit + 1)
  }
  return s + charOf(MID_DIGIT)
}

/**
 * 严格小于 s 的键。给最靠右的非零位减一；该位为 1 时降到 0 并补一个最大位，
 * 这样后续同向插入能在这个新档位里再走满 ~61 次，而不是每位只容纳几次。
 */
function below(s: string): string {
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const digit = digitOf(s[i] as string)
    if (digit > 1) return s.slice(0, i) + charOf(digit - 1)
    if (digit === 1) return s.slice(0, i) + charOf(0) + charOf(BASE - 1)
  }
  throw new Error('lexorank: 键不含非零位（不变式被破坏）')
}

/**
 * 返回严格介于 a、b 之间的键；undefined 表示该侧无界。b 省略即追加到末尾，a 省略即插到最前。
 * a >= b 时抛错——静默兜底只会让排序悄悄错乱。
 */
export function mid(a?: string, b?: string): string {
  if (a === undefined && b === undefined) return charOf(MID_DIGIT)
  if (b === undefined) return above(a as string)
  if (a === undefined) return below(b)
  if (!(a < b)) throw new Error(`lexorank: 入参顺序错误（${JSON.stringify(a)} >= ${JSON.stringify(b)}）`)

  // 逐位下钻：L 取下界该位的值（下界用尽后为 0），H 取上界该位的值（上界用尽后为最大值）。
  // 两位之间还有空隙就直接取中点收工；否则沿用下界那一位继续往下钻。
  let prefix = ''
  /** 已进入上界内部（某一位严格小于上界）——此后上界不再约束，只需压过下界。 */
  let upperFree = false
  for (let i = 0; ; i += 1) {
    if (!upperFree && i === b.length) {
      // 走到这里说明 prefix 与 b 完全相同，再延长只会得到比 b 更大的键；唯一可能是
      // 「b = a + 全零后缀」，而 ② 保证了生成器不会产出这种键。
      throw new Error(`lexorank: ${JSON.stringify(a)} 与 ${JSON.stringify(b)} 之间不存在可用键`)
    }
    const lower = i < a.length ? digitOf(a[i] as string) : 0
    const upper = upperFree || i >= b.length ? BASE : digitOf(b[i] as string)
    if (upper > lower + 1) {
      // 这一位就有 ≥1 的空隙：到此为止，不必再长
      return prefix + charOf(lower + Math.floor((upper - lower) / 2))
    }
    prefix += charOf(lower)
    if (upper === lower + 1) upperFree = true
  }
}
