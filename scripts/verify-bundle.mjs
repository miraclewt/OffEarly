#!/usr/bin/env node
/**
 * T31 · 构建产物校验（机器断言，不靠人眼）
 *
 * 交付物的形态是硬约束：`dist/OffEarly.html` 必须能被双击、离线、自包含地跑起来。
 * 任何一条被破坏都属于「交付物坏了」，不是「体验差一点」——所以这里一律 exit 1。
 *
 * 校验项：
 *   1. 产物存在，且 dist/ 下只有这一个 HTML（单文件）
 *   2. 体积 < 8MB（T31 时为 1.6MB；T50 起 mermaid 引擎进包，见 MAX_BYTES 注释）
 *   3. 无 `<script src>`
 *   4. 无外链 `<link href>`（只接受 data: URI，即内联 favicon）
 *   5. 无 `type="module"`（file:// 下必须是经典脚本）
 *   6. 无 http(s) 资源引用（含 src= / href= / url() 位置的兜底扫描）
 *   7. favicon 的 data URI 逐字节等于 brand/logo-mark-mono.svg
 *   8. 内联脚本非空、#root 存在（防止产出一个「空的壳」）
 *   9. 禁 emoji（lint:emoji 并入 verify）
 *
 * 只读脚本：不写任何文件，不改 dist。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findEmoji } from './no-emoji.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const ARTIFACT = join(DIST, 'OffEarly.html')
const FAVICON_SOURCE = join(ROOT, 'brand', 'logo-mark-mono.svg')

/**
 * 8MB。
 *
 * 历史：T31 设的是 1.6MB（当时产物 ~220KB）。T50 起 mermaid 引擎进包——离线渲染
 * flowchart / 时序图 / 类图 / 状态图 / ER / 甘特 / 饼图 / 思维导图的全部语法与布局算法，
 * 产物从 1,196,672 字节涨到约 6.35MB。这不是"没做代码分割"：单文件 + `file://`
 * 双击即用的前提下没有第二个选择（走 CDN 会在无网时静默不出图）。
 * 阈值仍写成字节数，并且仍然是一条硬约束——它的意义是拦住无意识膨胀，不是越松越好。
 */
const MAX_BYTES = 8 * 1024 * 1024

/**
 * 允许出现在产物里的 http(s) 主机。这些全部是**打包进 JS 的字符串常量**，
 * 运行时不会发起任何请求（例如 SVG 命名空间只是 SVG 元素身份的一部分）。
 * 白名单之外出现任何 http(s) 主机即失败——真外链会在这里露头。
 */
const URL_ALLOWLIST = new Map([
  ['www.w3.org', 'SVG / XML 命名空间常量'],
  ['json-schema.org', 'JSON Schema $schema 标识'],
  ['react.dev', 'React 报错文档链接（仅字符串）'],
  // T24 变更提议追加：TipTap / ProseMirror 进包后新增的两条报错文案常量（均只在异常分支里拼字符串，
  // 运行时不会发起请求）。白名单仍然只认「库内字符串常量」，真外链照旧会被这条检查拦下。
  ['prosemirror.net', 'ProseMirror 报错文案里的文档链接（仅字符串）'],
  ['github.com', 'marked 报错文案里的 issue 提交链接（仅字符串）'],
  // T50 变更提议追加：mermaid 引擎（含 chevrotain 解析器 / langium / elk 布局）进包后新增的四条。
  // 逐条在产物里复核过上下文：两条是 ELK 的 XML **命名空间标识符**（`http://www.eclipse.org/elk/ElkGraph`、
  // `http://www.eclipse.org/emf/2002/Ecore`，同样的用法见 SVG 的 xmlns），另外三条是语法报错文案里的
  // 文档链接（"See: https://chevrotain.io/docs/…" / "Visit https://langium.org/docs/…" /
  // "see: https://en.wikipedia.org/wiki/LL_parser"）。运行时无一发起请求。
  ['www.eclipse.org', 'ELK 图的 XML 命名空间标识符（字符串常量）'],
  ['chevrotain.io', 'chevrotain 词法/语法报错文案里的文档链接（仅字符串）'],
  ['langium.org', 'langium 报错文案里的配置文档链接（仅字符串）'],
  ['en.wikipedia.org', 'LL 解析报错文案里的维基链接（仅字符串）'],
])

const results = []
const record = (name, ok, detail) => results.push({ name, ok, detail })

function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

function checkEmojiLint() {
  const targets = [join(ROOT, 'src')]
  const findings = []
  for (const dir of targets) {
    for (const file of walkFiles(dir)) {
      if (!['.ts', '.tsx', '.css'].includes(extname(file).toLowerCase())) continue
      for (const hit of findEmoji(readFileSync(file, 'utf8'))) {
        findings.push(`${relative(ROOT, file).replaceAll('\\', '/')}:${hit.line}  U+${hit.codePoint.toString(16).toUpperCase()}`)
      }
    }
  }
  record('禁 emoji lint（并入 verify）', findings.length === 0, findings.length === 0 ? 'src 下零命中' : findings.slice(0, 5).join(' | '))
}

function main() {
  if (!existsSync(ARTIFACT)) {
    record('产物存在', false, `找不到 ${relative(ROOT, ARTIFACT)}，先跑构建`)
    return report()
  }
  record('产物存在', true, relative(ROOT, ARTIFACT).replaceAll('\\', '/'))

  const htmlFiles = readdirSync(DIST).filter((name) => ['.html', '.htm'].includes(extname(name).toLowerCase()))
  record('单文件（dist 下仅一个 HTML）', htmlFiles.length === 1, htmlFiles.join(', ') || '（无 HTML）')

  const bytes = statSync(ARTIFACT).size
  record(`体积 < ${Math.round(MAX_BYTES / 1024 / 1024)}MB（${MAX_BYTES} 字节）`, bytes < MAX_BYTES, `${bytes} 字节（余量 ${MAX_BYTES - bytes}）`)

  const html = readFileSync(ARTIFACT, 'utf8')

  const scriptSrc = html.match(/<script[^>]*\bsrc\s*=/gi) ?? []
  record('无 <script src>（脚本必须内联）', scriptSrc.length === 0, `命中 ${scriptSrc.length} 处`)

  const linkTags = html.match(/<link\b[^>]*>/gi) ?? []
  const externalLinks = linkTags.filter((tag) => {
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bhref\s*=\s*'([^']*)'/i.exec(tag)?.[1] ?? ''
    return !href.startsWith('data:')
  })
  record(
    '无外链 <link href>（仅允许 data:）',
    externalLinks.length === 0,
    linkTags.length === 0 ? '产物无 link 标签' : `共 ${linkTags.length} 个 link，其中外链 ${externalLinks.length} 个${externalLinks.length > 0 ? '：' + externalLinks.slice(0, 2).join(' ') : ''}`,
  )

  const moduleAttr = html.match(/type\s*=\s*["']module["']/gi) ?? []
  record('无 type="module"', moduleAttr.length === 0, `命中 ${moduleAttr.length} 处`)

  const resourcePosition = html.match(/(?:\bsrc|\bhref)\s*=\s*["']?\s*https?:\/\//gi) ?? []
  const cssUrl = html.match(/url\(\s*["']?\s*https?:\/\//gi) ?? []
  const hosts = [...new Set((html.match(/https?:\/\/([A-Za-z0-9.-]+)/g) ?? []).map((u) => u.replace(/^https?:\/\//, '')))]
  const unknownHosts = hosts.filter((host) => !URL_ALLOWLIST.has(host))
  const externalOk = resourcePosition.length === 0 && cssUrl.length === 0 && unknownHosts.length === 0
  record(
    '无 http(s) 资源引用',
    externalOk,
    externalOk
      ? `仅剩白名单常量：${hosts.map((h) => `${h}(${URL_ALLOWLIST.get(h)})`).join('、') || '无'}`
      : `src/href 位置 ${resourcePosition.length} 处、url() 位置 ${cssUrl.length} 处、白名单外主机 ${unknownHosts.join(',') || '无'}`,
  )

  const faviconMatch = /<link\b[^>]*rel\s*=\s*["']icon["'][^>]*>/i.exec(html)
  if (faviconMatch === null) {
    record('favicon 内联且与 brand 一致', false, '产物里找不到 rel="icon"')
  } else {
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(faviconMatch[0])?.[1] ?? ''
    const prefix = 'data:image/svg+xml;base64,'
    if (!href.startsWith(prefix)) {
      record('favicon 内联且与 brand 一致', false, `favicon 不是 base64 SVG data URI：${href.slice(0, 40)}`)
    } else {
      const decoded = Buffer.from(href.slice(prefix.length), 'base64')
      const source = existsSync(FAVICON_SOURCE) ? readFileSync(FAVICON_SOURCE) : null
      const same = source !== null && source.equals(decoded)
      record(
        'favicon 内联且与 brand 一致',
        same,
        same
          ? `${decoded.length} 字节，与 brand/logo-mark-mono.svg 逐字节相同`
          : source === null
            ? 'brand/logo-mark-mono.svg 缺失'
            : `与 brand/logo-mark-mono.svg 不一致（产物 ${decoded.length} 字节 / 源文件 ${source.length} 字节），请重新生成 data URI`,
      )
    }
  }

  const scriptBodies = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
  const nonEmpty = scriptBodies.filter((body) => body.trim().length > 0)
  const hasRoot = /<div\s+id\s*=\s*"root"/i.test(html)
  record(
    '内联脚本非空且 #root 存在',
    nonEmpty.length > 0 && hasRoot,
    `内联脚本 ${nonEmpty.length} 段（合计 ${nonEmpty.reduce((n, b) => n + b.length, 0)} 字符），#root ${hasRoot ? '存在' : '缺失'}`,
  )

  checkEmojiLint()
  return report()
}

function report() {
  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    console.log(`${r.ok ? '[ok]  ' : '[FAIL]'} ${r.name}${r.detail ? ` -- ${r.detail}` : ''}`)
  }
  if (failed.length > 0) {
    console.error(`\n产物校验失败：${failed.length}/${results.length} 项未通过`)
    process.exit(1)
  }
  console.log(`\n产物校验通过：${results.length}/${results.length} 项`)
}

main()
