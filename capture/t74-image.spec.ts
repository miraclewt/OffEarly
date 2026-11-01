/**
 * T74 · 贴图的成品图（真 Chromium）。
 *
 * 单测能证明「节点上有 image 字段、导出里有 dataURL」，但证明不了**看起来对不对**：
 * 图片有没有被 border 裁掉一圈、objectFit 之后是否留了奇怪的边、选中环会不会压住图。
 * 这类事只能截图人工看。
 *
 * 产出 docs/t74-whiteboard-image.png（贴了两张图的白板）与 docs/t74-image-selected.png（选中态）。
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

mkdirSync('docs', { recursive: true })

test.use({ deviceScaleFactor: 2 })

/** 在页面里画一张带内容的 PNG 再当剪贴板图片贴进去（纯色块看不出比例对不对）。 */
async function pasteGenerated(page: import('@playwright/test').Page, specs: { w: number; h: number; label: string }[]): Promise<void> {
  await page.evaluate(async (items: { w: number; h: number; label: string }[]) => {
    const make = (spec: { w: number; h: number; label: string }): Promise<File> =>
      new Promise((resolve) => {
        const canvas = document.createElement('canvas')
        canvas.width = spec.w
        canvas.height = spec.h
        const ctx = canvas.getContext('2d')
        if (ctx === null) throw new Error('no 2d context')
        const gradient = ctx.createLinearGradient(0, 0, spec.w, spec.h)
        gradient.addColorStop(0, '#dbeafe')
        gradient.addColorStop(1, '#fce7f3')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, spec.w, spec.h)
        ctx.strokeStyle = 'rgba(59,130,246,0.35)'
        ctx.lineWidth = 1
        for (let x = 40; x < spec.w; x += 40) {
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, spec.h)
          ctx.stroke()
        }
        for (let y = 40; y < spec.h; y += 40) {
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(spec.w, y)
          ctx.stroke()
        }
        ctx.fillStyle = '#1d1d1f'
        ctx.font = `600 ${Math.round(spec.w / 16)}px -apple-system, "PingFang SC", sans-serif`
        ctx.fillText(spec.label, 40, spec.h / 2)
        canvas.toBlob((blob) => {
          if (blob === null) throw new Error('toBlob failed')
          resolve(new File([blob], 'shot.png', { type: 'image/png' }))
        }, 'image/png')
      })

    const data = new DataTransfer()
    for (const item of items) data.items.add(await make(item))
    const target = document.querySelector('[data-testid="whiteboard"]')
    if (target === null) throw new Error('whiteboard not found')
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, specs)
}

test('白板贴图', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })

  // 一张横图（截图的典型比例）+ 一张竖图（验证高度卡住、不按宽度撑）
  await pasteGenerated(page, [
    { w: 1280, h: 720, label: '截图 1280×720' },
    { w: 360, h: 640, label: '竖图 360×640' },
  ])
  await expect(page.locator('img[data-testid^="whiteboard-image-"]')).toHaveCount(2, { timeout: 10_000 })
  await waitSaved(page)

  // 把两张并排放开一点，别叠在一起
  const boxes = await page.locator('[data-whiteboard-shape="image"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = (node as HTMLElement).getBoundingClientRect()
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
    }),
  )
  const [first, second] = boxes
  if (first !== undefined && second !== undefined) {
    await page.mouse.move(second.x + second.w / 2, second.y + second.h / 2)
    await page.mouse.down()
    await page.mouse.move(second.x + second.w / 2 + 420, second.y + second.h / 2, { steps: 12 })
    await page.mouse.up()
  }
  await page.keyboard.press('Escape')
  await waitSaved(page)
  await page.screenshot({ path: 'docs/t74-whiteboard-image.png' })

  // 选中态：把手与选中环是否压在图上看
  const target = await page.locator('[data-whiteboard-shape="image"]').first().boundingBox()
  if (target !== null) await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2)
  await page.screenshot({ path: 'docs/t74-image-selected.png' })

  // 探针：尺寸、src 协议、objectFit —— 「图是不是真的铺满了、有没有变形」只能这样量
  const probe = await page.evaluate(() =>
    [...document.querySelectorAll('img[data-testid^="whiteboard-image-"]')].map((node) => {
      const img = node as HTMLImageElement
      const rect = img.getBoundingClientRect()
      const host = img.parentElement?.getBoundingClientRect()
      return {
        src: img.src.slice(0, 5),
        natural: [img.naturalWidth, img.naturalHeight],
        display: [Math.round(rect.width), Math.round(rect.height)],
        host: host === undefined ? null : [Math.round(host.width), Math.round(host.height)],
        fit: getComputedStyle(img).objectFit,
        border: img.parentElement === null ? '' : getComputedStyle(img.parentElement).borderTopWidth,
      }
    }),
  )
  console.log('[t74-probe]', JSON.stringify(probe))
})
