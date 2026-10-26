/**
 * T64 · 标签页图标必须是一个「独立、可辨」的图标。
 *
 * 为什么这条要落在真 Chromium 上：`<link rel="icon">` 在不在 DOM 里，跟浏览器把
 * 它渲染成什么完全无关。T31 的内联 favicon 用了 `stroke="currentColor"`，而 favicon
 * 是一张独立图片，没有可以继承 `color` 的祖先——`currentColor` 落到 black，16px 下
 * 只剩一道 1px 黑线，深色标签栏里几乎整块消失（实测不透明像素 31%、全部是 rgb(0,0,0)）。
 * DOM 断言对此一无所知，所以这里把 href 真的画进 16x16 canvas 数像素。
 *
 * 四条口径：实心底（不能是线稿）、品牌色底、浅色前景占一定面积、前景/底色亮度差够大。
 */
import { expect, test } from '@playwright/test'

import { APP_URL } from '../playwright.config'

const BRAND = { r: 0x4f, g: 0x46, b: 0xe5 }

test('标签页图标是实心底的品牌图标，而不是一道黑线', async ({ page }) => {
  // baseURL 指向具体文件，`goto('/')` 会解析到磁盘根目录，那里没有本应用的 head。
  await page.goto(APP_URL)

  await expect(page).toHaveTitle(/OffEarly/)

  const stats = await page.evaluate(async (brand) => {
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')]
    if (links.length !== 1) return { count: links.length } as const
    const link = links[0]
    if (link === undefined) return { count: 0 } as const
    const href = link.getAttribute('href') ?? ''
    if (!href.startsWith('data:image/svg+xml;base64,')) return { count: 1, href } as const

    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('favicon 解码失败'))
      img.src = href
    })

    // 标签页的真实尺寸就是 16px，这里按 16px 光栅化后再数。
    const size = 16
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data

    let opaque = 0
    let brandPixels = 0
    let lightPixels = 0
    let maxLum = 0
    let minLum = 255
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0
      const g = data[i + 1] ?? 0
      const b = data[i + 2] ?? 0
      const a = data[i + 3] ?? 0
      if (a < 200) continue
      opaque++
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      if (lum > maxLum) maxLum = lum
      if (lum < minLum) minLum = lum
      if (Math.abs(r - brand.r) <= 8 && Math.abs(g - brand.g) <= 8 && Math.abs(b - brand.b) <= 8) brandPixels++
      if (lum > 200) lightPixels++
    }
    const total = size * size
    return {
      count: 1 as const,
      opaquePct: +((opaque / total) * 100).toFixed(1),
      brandPct: +((brandPixels / total) * 100).toFixed(1),
      lightPct: +((lightPixels / total) * 100).toFixed(1),
      contrast: Math.round(maxLum - minLum),
      decodedBytes: atob(href.slice('data:image/svg+xml;base64,'.length)).length,
    }
  }, BRAND)

  expect(stats.count, '产物里应恰有一个 rel="icon"').toBe(1)
  if (!('opaquePct' in stats)) throw new Error(`favicon 不是内联 base64 SVG：${'href' in stats ? stats.href : ''}`)

  expect(stats.decodedBytes, 'favicon 应解码出非空 SVG').toBeGreaterThan(200)
  // 实心底：铺满整块才谈得上「和其他网页文件区分」，线稿只有三成
  expect(stats.opaquePct, `不透明像素占比过低（${stats.opaquePct}%），说明底色是透明的`).toBeGreaterThan(85)
  // 底色必须是品牌靛蓝，不能变成黑/白方块（圆角与抗锯齿会吃掉一圈，实测约 52%）
  expect(stats.brandPct, `品牌底色像素占比过低（${stats.brandPct}%）`).toBeGreaterThan(35)
  // 表盘线条要真的画出来，且和底色拉开对比（实测约 21 个像素 = 8.2%）
  expect(stats.lightPct, `浅色前景像素占比过低（${stats.lightPct}%），表盘可能没渲染`).toBeGreaterThan(5)
  expect(stats.contrast, `前景与底色亮度差过小（${stats.contrast}）`).toBeGreaterThan(150)
})

test('浅色与深色标签栏下图标都不依赖页面配色', async ({ page }) => {
  await page.goto(APP_URL)
  // favicon 是独立图片：页面切深色主题、换 accent，都不该改变它。
  // 这里只钉住「图标自身带底色」这一点，避免哪天又退回 currentColor 方案。
  const themed = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')!
    const svg = atob(link.getAttribute('href')!.slice('data:image/svg+xml;base64,'.length))
    return { usesCurrentColor: /currentColor/i.test(svg), hasRectFill: /<rect[^>]*fill="#[0-9A-Fa-f]{3,6}"/.test(svg) }
  })
  expect(themed.usesCurrentColor, 'favicon 不能依赖 currentColor（独立图片没有可继承的颜色）').toBe(false)
  expect(themed.hasRectFill, 'favicon 应有不透明底色的 <rect>').toBe(true)
})
