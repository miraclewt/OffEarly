/**
 * T64 · 成品图：标签页里的样子（浅色 / 深色标签条 + 尺寸阶梯）。
 *
 * 图标直接取 dist/OffEarly.html 里那一份 data URI，不另抄一遍——图与产物必须同源，
 * 否则改了图标而图没跟着变，这张图就成了假证据。
 * 右侧「普通网页文件」用 Chrome 在没有 favicon 时给本地 html 的文档图标近似，
 * 用来对照「能不能一眼分开」。
 * 出图：docs/t64-favicon.png
 */
import { test } from '@playwright/test'
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { ARTIFACT, ROOT } from '../playwright.config'

const html = readFileSync(ARTIFACT, 'utf8')
const ICON = /<link\b[^>]*rel\s*=\s*["']icon["'][^>]*\bhref\s*=\s*"([^"]*)"/i.exec(html)?.[1]
if (ICON === undefined) throw new Error('产物里找不到 favicon')

/** 近似 Chrome 给「无 favicon 的本地 html」画的默认文档图标 */
const PLAIN_DOC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <path d="M3.5 1.5h6L12.5 4.5v10h-9z" fill="#f1f3f4" stroke="#bdc1c6" stroke-width="1"/>
  <path d="M9.5 1.5v3h3" fill="none" stroke="#bdc1c6" stroke-width="1"/>
  <g stroke="#9aa0a6" stroke-width="1"><path d="M5.5 7.5h5"/><path d="M5.5 9.5h5"/><path d="M5.5 11.5h3"/></g>
</svg>`

const plainUri = 'data:image/svg+xml;base64,' + Buffer.from(PLAIN_DOC, 'utf8').toString('base64')

const tab = (uri: string, label: string, dim = false) =>
  `<span class="tab${dim ? ' dim' : ''}"><img src="${uri}" alt="">${label}</span>`

test('出标签页成品图', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 420 })
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#fff;color:#1d1d1f;
      font:13px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
    h1{font-size:15px;margin:0 0 3px}
    p.sub{margin:0 0 18px;color:#6e6e73;font-size:12px}
    .strip{display:flex;align-items:flex-end;gap:6px;padding:8px 10px;border-radius:10px;margin-bottom:10px}
    .strip.light{background:#dee1e6}
    .strip.dark{background:#202124}
    .tab{display:flex;align-items:center;gap:7px;font-size:12.5px;padding:6px 12px;border-radius:8px 8px 0 0}
    .light .tab{background:#fff;color:#3c4043;box-shadow:0 -1px 2px #0000000d}
    .light .tab.dim{background:#f1f3f4;color:#5f6368}
    .dark .tab{background:#35363a;color:#e8eaed}
    .dark .tab.dim{background:#292a2d;color:#9aa0a6}
    .tab img{display:block;width:16px;height:16px;flex:none}
    .legend{font-size:11px;color:#6e6e73;margin:0 0 16px}
    .ladder{display:flex;align-items:stretch;gap:14px;margin-top:6px}
    .cell{width:96px;height:124px;display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:8px;font-size:10.5px;color:#6e6e73}
    .cell img{display:block}
    .cell.onlight{padding:8px;border-radius:8px;background:#dee1e6}
    .cell.ondark{padding:8px;border-radius:8px;background:#202124;color:#9aa0a6}

  </style></head><body>
    <h1>OffEarly 在浏览器标签页里的图标</h1>
    <p class="sub">左边是 OffEarly.html，右边是同一个窗口里没有设置图标的普通网页文件。</p>
    <div class="strip light">${tab(ICON, 'OffEarly - 早下班')}${tab(plainUri, '别的网页.html', true)}</div>
    <div class="strip dark">${tab(ICON, 'OffEarly - 早下班')}${tab(plainUri, '别的网页.html', true)}</div>
    <p class="legend">图标是不透明品牌底 + 白色表盘，所以浅色与深色标签条下都不用反色。</p>
    <div class="ladder">
      <div class="cell onlight"><img src="${ICON}" width="16" height="16">16px</div>
      <div class="cell onlight"><img src="${ICON}" width="32" height="32">32px</div>
      <div class="cell onlight"><img src="${ICON}" width="64" height="64">64px</div>
      <div class="cell ondark"><img src="${ICON}" width="16" height="16">16px</div>
      <div class="cell ondark"><img src="${ICON}" width="32" height="32">32px</div>
    </div>
  </body></html>`)

  await page.waitForTimeout(300)
  mkdirSync(join(ROOT, 'docs'), { recursive: true })
  await page.screenshot({ path: join(ROOT, 'docs', 't64-favicon.png'), fullPage: true })
})
