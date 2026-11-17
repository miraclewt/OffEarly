// T63 · 语法着色的纯函数口径：只验「切对没切错」，不验颜色（颜色在 CSS 里）。
//
// 断言的重点不是「有没有颜色」，而是**有没有吃字**：把所有 token 拼回去必须等于原文，
// 且区间有序不重叠。这两条一过，漏判只是少一层颜色，不会造成内容丢失。

import { describe, expect, it } from 'vitest'

import { codeFamily, highlightCode, tokenClassNames } from '../../src/domain/codeHighlight'
import type { CodeToken } from '../../src/domain/codeHighlight'

function pick(code: string, language: string, cls: string): string[] {
  return highlightCode(code, language)
    .filter((token: CodeToken) => token.cls === cls)
    .map((token) => code.slice(token.from, token.to))
}

/** 不变式：有序、不重叠、可完整还原。 */
function expectInvariant(code: string, language: string): void {
  const tokens = highlightCode(code, language)
  let cursor = 0
  for (const token of tokens) {
    expect(token.from).toBeGreaterThanOrEqual(cursor)
    expect(token.to).toBeGreaterThan(token.from)
    cursor = token.to
  }
  // 所有 token 覆盖的字符拼起来 = 原文里被着色的部分（未被着色的是「普通文字」，不参与拼接）
  const rebuilt = tokens.map((token) => code.slice(token.from, token.to)).join('')
  const mask = new Array<string>(code.length).fill('')
  for (const token of tokens) for (let index = token.from; index < token.to; index += 1) mask[index] = code[index] ?? ''
  expect(mask.join('')).toBe(rebuilt)
}

describe('codeFamily', () => {
  it('识别常见别名，不认识的语言返回 null', () => {
    expect(codeFamily('JavaScript')).toBe('js')
    expect(codeFamily('ts')).toBe('js')
    expect(codeFamily('bash')).toBe('sh')
    expect(codeFamily('yml')).toBe('yaml')
    expect(codeFamily('')).toBe(null)
    expect(codeFamily(undefined)).toBe(null)
    expect(codeFamily('mermaid')).toBe(null)
  })
})

describe('highlightCode · 通用不变式', () => {
  const samples: [string, string][] = [
    ['const a = "x" // hi\nfunction f() { return 1 }', 'js'],
    ['{"a": 1, "b": [true, null]}', 'json'],
    ['def f(x):\n    return x  # ok', 'py'],
    ['if [ -f "$HOME/x" ]; then echo ok; fi', 'sh'],
    ['.a { color: #fff; width: 12px }', 'css'],
    ['<div class="a"><span>hi</span></div>', 'html'],
    ['key: value # note\nother: 2', 'yaml'],
    ['SELECT * FROM t WHERE a = \'x\' -- c', 'sql'],
  ]

  it.each(samples)('切分不重叠且不丢字：%s', (code, language) => {
    expectInvariant(code, language)
  })
})

describe('highlightCode · JS', () => {
  it('关键字 / 字符串 / 注释 / 数字', () => {
    const code = 'const n = 12\n// 说明\nreturn "ok"'
    expect(pick(code, 'js', 'kw')).toEqual(['const', 'return'])
    expect(pick(code, 'js', 'num')).toEqual(['12'])
    expect(pick(code, 'js', 'str')).toEqual(['"ok"'])
    expect(pick(code, 'js', 'com')).toEqual(['// 说明'])
  })

  it('模板串跨行，普通引号遇到换行就收尾', () => {
    const code = 'const a = `line1\nline2`\nconst b = "oops\nlet c = 1'
    expect(pick(code, 'js', 'str')).toEqual(['`line1\nline2`', '"oops'])
    // 未闭合的普通引号不吃掉下一行的 let
    expect(pick(code, 'js', 'kw')).toContain('let')
  })

  it('单行注释里的引号不影响后续', () => {
    const code = "// don't panic\nconst x = 1"
    expect(pick(code, 'js', 'com')).toEqual(["// don't panic"])
    expect(pick(code, 'js', 'num')).toEqual(['1'])
  })

  it('十六进制与下划线数字连读', () => {
    const code = 'const a = 0x1F + 1_000'
    expect(pick(code, 'js', 'num')).toEqual(['0x1F', '1_000'])
  })
})

describe('highlightCode · JSON / YAML', () => {
  it('JSON 的键是 prop、值是 str', () => {
    const code = '{"name": "x", "n": 2}'
    expect(pick(code, 'json', 'prop')).toEqual(['"name"', '"n"'])
    expect(pick(code, 'json', 'str')).toEqual(['"x"'])
    expect(pick(code, 'json', 'num')).toEqual(['2'])
  })

  it('YAML 的键是 prop、布尔是关键字、# 注释到行尾', () => {
    const code = 'enabled: true # 开关\ntitle: "hello # not a comment"'
    expect(pick(code, 'yaml', 'prop').slice(0, 1)).toEqual(['enabled'])
    expect(pick(code, 'yaml', 'kw')).toEqual(['true'])
    expect(pick(code, 'yaml', 'com')).toEqual(['# 开关'])
    // 引号里的 # 不算注释
    expect(pick(code, 'yaml', 'str')).toEqual(['"hello # not a comment"'])
  })
})

describe('highlightCode · Python / shell / SQL / CSS', () => {
  it('py 的三引号当一整个字符串', () => {
    const code = 'x = """a\nb"""\n# note'
    expect(pick(code, 'py', 'str')).toEqual(['"""a\nb"""'])
    expect(pick(code, 'py', 'com')).toEqual(['# note'])
  })

  it('shell 变量与注释', () => {
    const code = 'echo $HOME ${PATH} # 说明'
    expect(pick(code, 'sh', 'prop')).toEqual(['$HOME', '${PATH}'])
    expect(pick(code, 'sh', 'com')).toEqual(['# 说明'])
  })

  it('SQL 关键字大小写不敏感，\'\' 是转义', () => {
    const code = "select * from t where name = 'a''b'"
    expect(pick(code, 'sql', 'kw')).toEqual(['select', 'from', 'where'])
    expect(pick(code, 'sql', 'str')).toEqual(["'a''b'"])
  })

  it('CSS 的十六进制颜色与属性名', () => {
    const code = '.a { color: #5e5ce6; margin: 0 }'
    expect(pick(code, 'css', 'num')).toEqual(['#5e5ce6', '0'])
    expect(pick(code, 'css', 'prop')).toEqual(['color', 'margin'])
  })
})

describe('highlightCode · HTML', () => {
  it('标签名 + 属性名 + 属性值 + 注释', () => {
    const code = '<!-- c --><div class="a">x</div>'
    expect(pick(code, 'html', 'com')).toEqual(['<!-- c -->'])
    expect(pick(code, 'html', 'kw')).toEqual(['<div', '</div'])
    expect(pick(code, 'html', 'prop')).toEqual(['class'])
    expect(pick(code, 'html', 'str')).toEqual(['"a"'])
  })
})

describe('highlightCode · 边界', () => {
  it('不认识的语言 / 空文本 → 空数组', () => {
    expect(highlightCode('const a = 1', 'mermaid')).toEqual([])
    expect(highlightCode('', 'js')).toEqual([])
    expect(highlightCode('const a = 1', null)).toEqual([])
  })

  it('只有结尾的未闭合块注释到文件尾', () => {
    const code = 'a\n/* 没关'
    expect(pick(code, 'js', 'com')).toEqual(['/* 没关'])
  })

  it('类名带统一前缀（编辑器与导出共用）', () => {
    expect(tokenClassNames('kw')).toBe('oe-hl oe-hl-kw')
  })
})
