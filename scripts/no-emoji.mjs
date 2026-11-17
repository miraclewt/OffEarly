#!/usr/bin/env node
// 禁 emoji lint（spec 8.4 / T05）：源码里出现 emoji 码位即失败。
// 只扫文本扩展名；箭头（U+2192 等）与中日韩文本是合法内容，不在拦截范围。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.css',
  '.html',
  '.json',
  '.md',
])

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git'])

// emoji 码位区段（Unicode Emoji Sources / RGI 集合的并集超集）
// 区段说明只写码位，不写示例字符——本脚本自身也在 lint 的可达范围内。
const EMOJI_RANGES = [
  [0x1f000, 0x1faff, 'emoji 图形区（麻将/符号/交通/补充符号/区域指示符）'],
  [0x2600, 0x27bf, '杂项符号与装饰符'],
  [0x2b00, 0x2bff, '箭头补充与星形'],
  [0x3030, 0x303d, 'CJK 兼容符号中的 emoji 呈现项'],
  [0xfe00, 0xfe0f, '变体选择符（把前一个字符切成 emoji 呈现）'],
  [0x203c, 0x203c, '双感叹号'],
  [0x2049, 0x2049, '感叹问号和'],
  [0x2122, 0x2122, '商标'],
  [0x2139, 0x2139, '信息'],
  [0x21a9, 0x21aa, '回折箭头'],
  [0x2934, 0x2935, '上扬/上扬回折箭头'],
  [0x3297, 0x3299, '祝贺/秘密'],
]

/** 返回文本内所有 emoji 命中：0 基行列 + 码位 + 区段说明。 */
export function findEmoji(text) {
  const hits = []
  let lineIndex = 0
  let column = 0
  for (const char of text) {
    if (char === '\n') {
      lineIndex += 1
      column = 0
      continue
    }
    const codePoint = char.codePointAt(0) ?? 0
    const range = EMOJI_RANGES.find(([from, to]) => codePoint >= from && codePoint <= to)
    if (range !== undefined) {
      hits.push({
        line: lineIndex + 1,
        column: column + 1,
        codePoint,
        description: range[2],
      })
    }
    column += 1
  }
  return hits
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (SKIPPED_DIRS.has(entry)) continue
    const stats = statSync(full)
    if (stats.isDirectory()) walk(full, out)
    else if (TEXT_EXTENSIONS.has(extname(entry).toLowerCase())) out.push(full)
  }
  return out
}

function collect(targets) {
  const files = []
  for (const target of targets) {
    const full = resolve(target)
    const stats = statSync(full)
    if (stats.isDirectory()) walk(full, files)
    else if (TEXT_EXTENSIONS.has(extname(full).toLowerCase())) files.push(full)
  }
  return files.sort()
}

const DEFAULT_TARGETS = ['src', 'src/locales']

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const targets = process.argv.slice(2)
  const root = process.cwd()
  const files = collect(targets.length > 0 ? targets.map((t) => resolve(root, t)) : DEFAULT_TARGETS)
  const findings = []
  for (const file of files) {
    for (const hit of findEmoji(readFileSync(file, 'utf8'))) {
      findings.push(
        `${relative(root, file).replaceAll('\\', '/')}:${hit.line}:${hit.column}  ` +
          `U+${hit.codePoint.toString(16).toUpperCase().padStart(4, '0')}  ${hit.description}`,
      )
    }
  }
  if (findings.length > 0) {
    console.error(`发现 ${findings.length} 处 emoji 码位，全项目禁用：`)
    for (const line of findings) console.error(`  ${line}`)
    process.exit(1)
  }
}
