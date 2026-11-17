/**
 * T64 · 终选放大：只有 16px 才是验收场景，把 D / B2 的真实 16px 位图放大到 180px 裁决。
 * 出图：docs/t64-favicon-final.png
 */
import { test } from '@playwright/test'
import { join } from 'node:path'

import { ROOT } from '../playwright.config'

const D = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <rect width="24" height="24" rx="5.4" fill="#4F46E5"/>
  <g fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13.9 16.4 A5.6 5.6 0 1 1 13.9 7.6"/>
    <path d="M8.9 12 V8.6"/>
    <path d="M8.9 12 L10.3 14.4"/>
    <path d="M16.2 12 H20"/>
    <path d="M18.3 10.2 L20.1 12 L18.3 13.8"/>
  </g>
</svg>`

const B = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <rect width="24" height="24" rx="5.4" fill="#4F46E5"/>
  <g fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="7"/>
    <path d="M12 12 V7.6"/>
    <path d="M12 12 L15 14.2"/>
  </g>
</svg>`

const B2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <rect width="24" height="24" rx="5.4" fill="#4F46E5"/>
  <g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16.9 15.8 A6.5 6.5 0 1 1 16.9 8.2"/>
    <path d="M11 12 V8"/>
    <path d="M11 12 L12.6 14.8"/>
  </g>
</svg>`

const uri = (svg: string) => 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')

test('D / B2 / B 的 16px 放大裁决图', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 380 })
  const cols = [
    { label: 'D 开口环 + 粗箭头', svg: D },
    { label: 'B2 开口环 + 指针', svg: B2 },
    { label: 'B 闭合环 + 指针', svg: B },
  ]
    .map(
      (c) => `<div class="col">
        <div class="label">${c.label}</div>
        <div class="box light"><img src="${uri(c.svg)}" alt=""></div>
        <div class="box dark"><img src="${uri(c.svg)}" alt=""></div>
      </div>`,
    )
    .join('')

  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:20px;background:#fff;font:13px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1d1d1f}
    h1{font-size:14px;margin:0 0 2px}
    p{margin:0 0 16px;color:#6e6e73;font-size:11px}
    .row{display:flex;gap:22px}
    .label{font-weight:600;margin-bottom:8px}
    .box{padding:6px;border-radius:10px;margin-bottom:10px;width:180px;display:flex;justify-content:center}
    .box.light{background:#dee1e6}
    .box.dark{background:#202124}
    .box img{display:block;width:180px;height:180px;image-rendering:pixelated}
  </style></head><body>
    <h1>T64 16px 真实位图放大（180x，image-rendering: pixelated）</h1>
    <p>上排 = 浅色标签条底，下排 = 深色标签条底。这是浏览器里唯一会看到的尺寸。</p>
    <div class="row">${cols}</div>
  </body></html>`)

  await page.waitForTimeout(300)
  await page.screenshot({ path: join(ROOT, 'docs', 't64-favicon-final.png'), fullPage: true })
})
