// T63 · 极简语法着色：一个零依赖的 token 扫描器。
//
// 为什么不自带 lowlight / shiki：单文件产物已经 6.37MB（mermaid 占了 5.2MB），
// highlight.js 的常用语言包再放进来是几百 KB + 一张需要跟版本的语法定义表。
// 笔记里的代码块是**给人读的片段**，不是 IDE——认得出注释、字符串、数字、关键字
// 就足以让一段代码「有结构」，而这四类几乎不随语言规范变化。
//
// 输出是**偏移区间 + 语义类名**，不产出 HTML：编辑器走 ProseMirror 的 inline decoration、
// 导出走自己拼 span，两处共用同一份 token——否则「编辑器里好看、导出的 HTML 全灰」，
// 而这种不一致只有导出后才看得见。
//
// 一条硬约束：扫描器**只读文本、绝不改动内容**。漏判顶多少一行颜色，
// 多判绝不能吃掉字符——所以任何「没闭合」的情况都退到行尾 / 文件尾，不抛错。

export type CodeTokenClass = 'kw' | 'str' | 'num' | 'com' | 'prop'

export interface CodeToken {
  /** 在代码文本里的起始偏移（含）。 */
  from: number
  /** 结束偏移（不含）。 */
  to: number
  cls: CodeTokenClass
}

/** 支持的语法族。同一个族下的语言共用一套扫描规则（js 与 ts 的差别不影响着色）。 */
export type CodeFamily = 'js' | 'json' | 'py' | 'sh' | 'css' | 'html' | 'yaml' | 'sql'

const ALIASES: Record<string, CodeFamily> = {
  js: 'js',
  javascript: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  json: 'json',
  jsonc: 'json',
  py: 'py',
  python: 'py',
  sh: 'sh',
  shell: 'sh',
  bash: 'sh',
  zsh: 'sh',
  console: 'sh',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
}

/** 语言标识 → 语法族；不认识的语言返回 null（= 不上色，原样显示）。 */
export function codeFamily(language: string | null | undefined): CodeFamily | null {
  if (language === null || language === undefined) return null
  return ALIASES[language.trim().toLowerCase()] ?? null
}

const JS_KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
  'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'private', 'protected', 'public',
  'readonly', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof',
  'undefined', 'var', 'void', 'while', 'yield', 'as', 'enum', 'satisfies',
]

const PY_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield',
]

const SH_KEYWORDS = [
  'case', 'cd', 'do', 'done', 'echo', 'elif', 'else', 'esac', 'exit', 'export', 'fi', 'for', 'function',
  'if', 'in', 'local', 'read', 'return', 'set', 'shift', 'source', 'then', 'trap', 'unset', 'while',
]

const SQL_KEYWORDS = [
  'add', 'all', 'alter', 'and', 'as', 'asc', 'avg', 'between', 'by', 'case', 'count', 'create', 'default',
  'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'exists', 'foreign', 'from', 'group', 'having',
  'index', 'inner', 'insert', 'into', 'join', 'key', 'left', 'like', 'limit', 'max', 'min', 'not', 'null',
  'offset', 'on', 'or', 'order', 'outer', 'primary', 'references', 'right', 'select', 'set', 'sum', 'table',
  'then', 'union', 'update', 'values', 'when', 'where',
]

const BOOL_KEYWORDS = ['true', 'false', 'null']
const YAML_KEYWORDS = ['true', 'false', 'yes', 'no', 'null', 'on', 'off']

interface ScanConfig {
  lineComments: string[]
  blockComments: [string, string][]
  quotes: string[]
  /** 允许跨行的引号（js 的反引号模板串）——其余引号遇换行即收尾，避免一个笔误吞掉全文。 */
  multilineQuotes: string[]
  /** 反斜杠转义。 */
  escape: boolean
  /** SQL 的 `''` 转义（同一字符连写两次）。 */
  doubleEscape: boolean
  /** Python 的三引号。 */
  tripleQuotes: boolean
  /** CSS 的 `#rrggbb` / `#fff`。 */
  hexColor: boolean
  /** `$VAR` / `${...}`（shell）。 */
  dollarVar: boolean
  /** 标识符后面跟这个字符 → 当成「键 / 属性名」。 */
  propAfterIdent: string | null
  /** 字符串后面跟这个字符 → 当成「键」（json / yaml）。 */
  propAfterString: string | null
  keywords: Set<string>
  /** 大小写不敏感（SQL）。 */
  caseInsensitive: boolean
}

function keywordSet(words: string[], extra: string[] = []): Set<string> {
  return new Set([...words, ...extra])
}

const CONFIG: Record<CodeFamily, ScanConfig> = {
  js: {
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    quotes: ['"', "'", '`'],
    multilineQuotes: ['`'],
    escape: true,
    doubleEscape: false,
    tripleQuotes: false,
    hexColor: false,
    dollarVar: false,
    propAfterIdent: null,
    propAfterString: null,
    keywords: keywordSet(JS_KEYWORDS),
    caseInsensitive: false,
  },
  json: {
    lineComments: ['//'],
    blockComments: [],
    quotes: ['"'],
    multilineQuotes: [],
    escape: true,
    doubleEscape: false,
    tripleQuotes: false,
    hexColor: false,
    dollarVar: false,
    propAfterIdent: null,
    propAfterString: ':',
    keywords: keywordSet(BOOL_KEYWORDS),
    caseInsensitive: false,
  },
  py: {
    lineComments: ['#'],
    blockComments: [],
    quotes: ['"', "'"],
    multilineQuotes: [],
    escape: true,
    doubleEscape: false,
    tripleQuotes: true,
    hexColor: false,
    dollarVar: false,
    propAfterIdent: null,
    propAfterString: null,
    keywords: keywordSet(PY_KEYWORDS),
    caseInsensitive: false,
  },
  sh: {
    lineComments: ['#'],
    blockComments: [],
    quotes: ['"', "'"],
    multilineQuotes: [],
    escape: true,
    doubleEscape: false,
    tripleQuotes: false,
    hexColor: false,
    dollarVar: true,
    propAfterIdent: null,
    propAfterString: null,
    keywords: keywordSet(SH_KEYWORDS),
    caseInsensitive: false,
  },
  css: {
    lineComments: [],
    blockComments: [['/*', '*/']],
    quotes: ['"', "'"],
    multilineQuotes: [],
    escape: true,
    doubleEscape: false,
    tripleQuotes: false,
    hexColor: true,
    dollarVar: false,
    propAfterIdent: ':',
    propAfterString: null,
    keywords: new Set<string>(),
    caseInsensitive: false,
  },
  html: {
    lineComments: [],
    blockComments: [['<!--', '-->']],
    quotes: ['"', "'"],
    multilineQuotes: ['"', "'"],
    escape: false,
    doubleEscape: false,
    tripleQuotes: false,
    hexColor: false,
    dollarVar: false,
    propAfterIdent: null,
    propAfterString: null,
    keywords: new Set<string>(),
    caseInsensitive: true,
  },
  yaml: {
    lineComments: ['#'],
    blockComments: [],
    quotes: ['"', "'"],
    multilineQuotes: [],
    escape: false,
    doubleEscape: false,
    tripleQuotes: false,
    hexColor: false,
    dollarVar: false,
    propAfterIdent: ':',
    propAfterString: ':',
    keywords: keywordSet(YAML_KEYWORDS),
    caseInsensitive: false,
  },
  sql: {
    lineComments: ['--'],
    blockComments: [['/*', '*/']],
    quotes: ["'", '"'],
    multilineQuotes: [],
    escape: false,
    doubleEscape: true,
    tripleQuotes: false,
    hexColor: false,
    dollarVar: false,
    propAfterIdent: null,
    propAfterString: null,
    keywords: keywordSet(SQL_KEYWORDS),
    caseInsensitive: true,
  },
}

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$]/
const DIGIT = /[0-9]/

/** 越界安全的取字符（tsconfig 开了 noUncheckedIndexedAccess，`code[i]` 是 string | undefined）。 */
function char(code: string, index: number): string {
  return code[index] ?? ''
}

function isIdentStart(ch: string): boolean {
  return ch !== undefined && IDENT_START.test(ch)
}

function isIdentPart(ch: string): boolean {
  return ch !== undefined && IDENT_PART.test(ch)
}

/** 跳过空白（不跨行）——用来判断「字符串/标识符后面是不是分隔符」。 */
function skipSpaces(code: string, from: number): number {
  let index = from
  while (index < code.length && (code[index] === ' ' || code[index] === '\t')) index += 1
  return index
}

/** 扫一个字符串字面量，返回结束下标（含收尾引号；未闭合则到行尾 / 文件尾）。 */
function scanString(code: string, start: number, cfg: ScanConfig): number {
  const quote = char(code, start)
  const multiline = cfg.multilineQuotes.includes(quote)
  let index = start + 1
  while (index < code.length) {
    const ch = char(code, index)
    if (cfg.escape && ch === '\\') {
      index += 2
      continue
    }
    if (cfg.doubleEscape && ch === quote && code[index + 1] === quote) {
      index += 2
      continue
    }
    if (ch === quote) return index + 1
    if (ch === '\n' && !multiline) return index
    index += 1
  }
  return code.length
}

/** 扫一个数字字面量（含 0x 十六进制 / 小数 / 下划线分隔）。 */
function scanNumber(code: string, start: number): number {
  let index = start
  if (code[index] === '0' && (code[index + 1] === 'x' || code[index + 1] === 'X')) {
    index += 2
    while (index < code.length && /[0-9a-fA-F_]/.test(char(code, index))) index += 1
    return index
  }
  while (index < code.length) {
    const ch = char(code, index)
    if (DIGIT.test(ch) || ch === '_') {
      index += 1
      continue
    }
    if (ch === '.' && DIGIT.test(code[index + 1] ?? '')) {
      index += 1
      continue
    }
    if ((ch === 'e' || ch === 'E') && /[0-9+-]/.test(code[index + 1] ?? '')) {
      index += 2
      while (index < code.length && DIGIT.test(char(code, index))) index += 1
      return index
    }
    break
  }
  return index
}

function scan(code: string, cfg: ScanConfig): CodeToken[] {
  const tokens: CodeToken[] = []
  const length = code.length
  let index = 0

  while (index < length) {
    const ch = char(code, index)

    // ① 块注释
    let handled = false
    for (const [open, close] of cfg.blockComments) {
      if (!code.startsWith(open, index)) continue
      const end = code.indexOf(close, index + open.length)
      const stop = end === -1 ? length : end + close.length
      tokens.push({ from: index, to: stop, cls: 'com' })
      index = stop
      handled = true
      break
    }
    if (handled) continue

    // ② 行注释
    for (const marker of cfg.lineComments) {
      if (!code.startsWith(marker, index)) continue
      const end = code.indexOf('\n', index)
      const stop = end === -1 ? length : end
      tokens.push({ from: index, to: stop, cls: 'com' })
      index = stop
      handled = true
      break
    }
    if (handled) continue

    // ③ Python 三引号（必须先于普通引号，否则 """ 会被当成空串 + 一个孤引号）
    if (cfg.tripleQuotes && (code.startsWith('"""', index) || code.startsWith("'''", index))) {
      const fence = code.slice(index, index + 3)
      const end = code.indexOf(fence, index + 3)
      const stop = end === -1 ? length : end + 3
      tokens.push({ from: index, to: stop, cls: 'str' })
      index = stop
      continue
    }

    // ④ 字符串
    if (cfg.quotes.includes(ch)) {
      const stop = scanString(code, index, cfg)
      let cls: CodeTokenClass = 'str'
      if (cfg.propAfterString !== null && code[skipSpaces(code, stop)] === cfg.propAfterString) {
        cls = 'prop'
      }
      tokens.push({ from: index, to: stop, cls })
      index = stop
      continue
    }

    // ⑤ 数字（前面紧邻标识符字符时不算，避免把 foo1 拆开）
    if (DIGIT.test(ch) && !isIdentPart(code[index - 1] ?? '')) {
      const stop = scanNumber(code, index)
      tokens.push({ from: index, to: stop, cls: 'num' })
      index = stop
      continue
    }

    // ⑥ CSS 十六进制颜色
    if (cfg.hexColor && ch === '#' && /[0-9a-fA-F]/.test(code[index + 1] ?? '')) {
      let stop = index + 1
      while (stop < length && /[0-9a-fA-F]/.test(char(code, stop))) stop += 1
      tokens.push({ from: index, to: stop, cls: 'num' })
      index = stop
      continue
    }

    // ⑦ shell 变量：$VAR / ${...} / $1 / $?
    if (cfg.dollarVar && ch === '$') {
      let stop = index + 1
      if (char(code, stop) === '{') {
        const end = code.indexOf('}', stop)
        stop = end === -1 ? length : end + 1
      } else {
        while (stop < length && IDENT_PART.test(char(code, stop))) stop += 1
        if (stop === index + 1) stop += 1
      }
      tokens.push({ from: index, to: stop, cls: 'prop' })
      index = stop
      continue
    }

    // ⑧ 标识符 / 关键字 / 属性名
    if (isIdentStart(ch)) {
      let stop = index
      while (stop < length && IDENT_PART.test(char(code, stop))) stop += 1
      const word = code.slice(index, stop)
      const probe = cfg.caseInsensitive ? word.toLowerCase() : word
      const afterIdent = cfg.propAfterIdent === null ? -1 : skipSpaces(code, stop)
      if (cfg.keywords.has(probe)) {
        tokens.push({ from: index, to: stop, cls: 'kw' })
      } else if (cfg.propAfterIdent !== null && char(code, afterIdent) === cfg.propAfterIdent) {
        tokens.push({ from: index, to: stop, cls: 'prop' })
      }
      index = stop
      continue
    }

    index += 1
  }

  return tokens
}

/**
 * HTML / XML 的着色：标签名与属性名是它的「结构」，字符串与注释与别处一致。
 * 用独立分支而不是塞进通用扫描器——它的 `<` `>` 语义和 C 系差得太远。
 */
function scanMarkup(code: string): CodeToken[] {
  const tokens: CodeToken[] = []
  const length = code.length
  let index = 0

  while (index < length) {
    if (code.startsWith('<!--', index)) {
      const end = code.indexOf('-->', index + 4)
      const stop = end === -1 ? length : end + 3
      tokens.push({ from: index, to: stop, cls: 'com' })
      index = stop
      continue
    }

    if (char(code, index) === '<') {
      // 标签名：`</div` 也算
      let cursor = index + 1
      if (char(code, cursor) === '/') cursor += 1
      const nameStart = cursor
      while (cursor < length && /[A-Za-z0-9:_-]/.test(char(code, cursor))) cursor += 1
      if (cursor > nameStart) {
        tokens.push({ from: index, to: cursor, cls: 'kw' })
        // 标签内部的属性名与属性值
        while (cursor < length && char(code, cursor) !== '>') {
          const ch = char(code, cursor)
          if (ch === '"' || ch === "'") {
            const stop = scanString(code, cursor, CONFIG.html)
            tokens.push({ from: cursor, to: stop, cls: 'str' })
            cursor = stop
            continue
          }
          if (isIdentStart(ch)) {
            let stop = cursor
            while (stop < length && /[A-Za-z0-9:_.-]/.test(char(code, stop))) stop += 1
            tokens.push({ from: cursor, to: stop, cls: 'prop' })
            cursor = stop
            continue
          }
          cursor += 1
        }
        index = cursor
        continue
      }
    }

    index += 1
  }

  return tokens
}

/**
 * 主入口：按语言把代码切成着色区间。语言不认识 / 代码为空 → 空数组（原样显示）。
 * 返回的区间**有序、不重叠**，调用方可直接顺序拼 HTML 或在编辑器里逐个挂装饰。
 *
 * 带一层缓存：编辑器每次事务（每次按键）都会重算全文档的代码块装饰，
 * 而没被编辑的代码块内容一个字都没变——不缓存就是每键 O(全文) 的重扫。
 * 键里带语言（同一段文本换了语言标记结果不同），上限用 FIFO 而不是 LRU：
 * 笔记里的代码块数量本来就只有几十段，命中率靠"同一个块反复出现"就足够。
 */
const CACHE_LIMIT = 128
const cache = new Map<string, CodeToken[]>()

export function highlightCode(code: string, language: string | null | undefined): CodeToken[] {
  const family = codeFamily(language)
  if (family === null || code.length === 0) return []
  const cacheKey = `${family}\u0000${code}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached

  const tokens = family === 'html' ? scanMarkup(code) : scan(code, CONFIG[family])
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(cacheKey, tokens)
  return tokens
}

/** 着色类名：编辑器装饰与导出 span 共用，避免两处各写一套前缀。 */
export function tokenClassNames(cls: CodeTokenClass): string {
  return `oe-hl oe-hl-${cls}`
}
