#!/usr/bin/env node
// 车道合入时的冲突并集工具（《完成记录》这类纯追加冲突专用）。
//
//   node scripts/resolve-conflict.mjs task.md                       # 预演
//   node scripts/resolve-conflict.mjs task.md --write               # 落盘
//   node scripts/resolve-conflict.mjs src/locales/zh.ts --brace-after-head --write
//
// 规则：
//   1. 每个冲突块取并集（head 段 + incoming 段），段间补一个空行，删掉三行标记；
//   2. `--brace-after-head` 指定的文件，在 head 段后补一行 `  },`——zh.ts 是嵌套表，
//      两车道各自尾部追加时两侧块都不含自己的闭合 `},`，git 会把这两个 `},` 当成
//      同一行公共上下文，并集后 `sidebar` 就丢了闭合括号（T21 踩过：`tsc` 报语法错，
//      而 en.ts 是扁平表不中招，容易误判成已修好）；
//   3. **总表是禁区**：同一个任务号在两侧各被改一次时，并集会产生两行且状态相反
//      （wave-4 踩过：T16/T17 各出两行）。检测到就报错退出，要求人工按
//      「状态取较晚完成者」去重后再跑；
//   4. 默认 dry-run（只报块数），加 `--write` 才写盘；行尾风格按原文件保持。
import fs from 'node:fs'

const START = '<<<<<<<'
const SEP = '======='
const END = '>>>>>>>'

/** 总表行：`- [x] **T16** …`。这类行不允许脚本并集，必须人工裁决。 */
const TABLE_ROW = /^\s*- \[[ xX]\] \*\*(T\d+)\*\*/

function parseArgs(argv) {
  const files = []
  const braceFiles = []
  let write = false
  let collectingBrace = false
  for (const arg of argv) {
    if (arg === '--write') {
      write = true
      collectingBrace = false
    } else if (arg === '--brace-after-head') {
      collectingBrace = true
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数：${arg}`)
    } else if (collectingBrace) {
      braceFiles.push(arg)
    } else {
      files.push(arg)
    }
  }
  if (files.length === 0) throw new Error('至少给一个待处理文件')
  return { files, braceFiles, write }
}

/** 切分为「普通行」与「冲突块」，保留顺序。 */
function tokenize(lines, path) {
  const tokens = []
  let state = 'normal'
  let head = []
  let incoming = []
  let headStart = 0

  for (const [index, line] of lines.entries()) {
    if (state === 'normal' && line.startsWith(START)) {
      state = 'head'
      headStart = index + 1
      head = []
      continue
    }
    if (state === 'head' && line.startsWith(SEP)) {
      state = 'incoming'
      incoming = []
      continue
    }
    if (state !== 'normal' && line.startsWith(END)) {
      tokens.push({ type: 'conflict', head, incoming, line: headStart })
      state = 'normal'
      head = []
      incoming = []
      continue
    }
    if (state === 'head') head.push(line)
    else if (state === 'incoming') incoming.push(line)
    else tokens.push({ type: 'line', text: line })
  }

  if (state !== 'normal') {
    throw new Error(`${path}: 冲突标记不完整（缺 ${END}），未做任何修改`)
  }
  return tokens
}

/** 总表行在**同一块的两侧**各出现 → 并集会让状态打架。返回这些任务号。 */
function tableOffenders(blocks) {
  const offenders = new Set()
  for (const block of blocks) {
    const left = new Set(idsIn(block.head))
    const right = new Set(idsIn(block.incoming))
    for (const id of left) {
      if (right.has(id)) offenders.add(id)
    }
  }
  return [...offenders].sort()
}

function idsIn(lines) {
  const ids = []
  for (const line of lines) {
    const hit = TABLE_ROW.exec(line)
    if (hit) ids.push(hit[1])
  }
  return ids
}

function trimBlank(lines) {
  const copy = [...lines]
  while (copy.length > 0 && copy[0].trim() === '') copy.shift()
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop()
  return copy
}

function resolve(path, { addBraceAfterHead = false, write = false } = {}) {
  const source = fs.readFileSync(path, 'utf8')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const tokens = tokenize(source.split(/\r?\n/), path)
  const blocks = tokens.filter((token) => token.type === 'conflict')

  if (blocks.length === 0) {
    console.log(`${path}: 无冲突块，跳过`)
    return { blocks: 0, leftover: 0 }
  }

  const offenders = tableOffenders(blocks)
  if (offenders.length > 0) {
    throw new Error(
      `${path}: 总表行在两侧各被改过一次（${offenders.join(' / ')}），并集会产生重复行。\n` +
        '  请先人工按「状态取较晚完成者」去重，再重跑本脚本。',
    )
  }

  const output = []
  for (const token of tokens) {
    if (token.type === 'line') {
      output.push(token.text)
      continue
    }
    const head = trimBlank(token.head)
    const incoming = trimBlank(token.incoming)
    output.push(...head)
    if (addBraceAfterHead && head.length > 0) output.push('  },')
    if (head.length > 0 && incoming.length > 0) output.push('')
    output.push(...incoming)
  }

  const leftover = output.filter((line) => /^(<{7}|={7}|>{7})/.test(line)).length
  if (write) fs.writeFileSync(path, output.join(eol))
  console.log(
    `${path}: blocks=${blocks.length} leftover=${leftover}${write ? '' : '（dry-run，加 --write 落盘）'}`,
  )
  return { blocks: blocks.length, leftover }
}

const { files, braceFiles, write } = parseArgs(process.argv.slice(2))
for (const file of files) {
  resolve(file, { addBraceAfterHead: braceFiles.includes(file), write })
}
