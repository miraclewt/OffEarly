/**
 * T79 · 文本编辑态「多出来的框」修复后的成品图（真 Chromium）。
 *
 * 用户贴图：编辑矩形时，蓝色圆角框右下角外面多出一个浅色矩形。根因两条：
 *  `<textarea>` 默认 content-box（100% + 内边距 → 溢出 20×16）、
 *  theme.css 的 `textarea:focus` 光晕把这圈溢出勾了轮廓。
 * 这里出三种形状的编辑态特写，并打印编辑框相对图元的溢出量。
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

mkdirSync('docs', { recursive: true })

test.use({ deviceScaleFactor: 2 })

async function shotEditing(
  page: import('@playwright/test').Page,
  shape: 'rect' | 'round' | 'note' | 'text',
  name: string,
): Promise<void> {
  const node = page.locator(`[data-whiteboard-shape="${shape}"]`).last()
  await node.dblclick()
  await expect(page.getByTestId('whiteboard-text-input')).toBeVisible()
  await page.keyboard.type('5')
  await page.keyboard.press('Enter')
  await page.keyboard.type('6')

  const probe = await page.evaluate((shapeName) => {
    const node = document.querySelector(`[data-whiteboard-shape="${shapeName}"]`) as HTMLElement
    const area = document.querySelector('[data-testid="whiteboard-text-input"]') as HTMLElement
    const n = node.getBoundingClientRect()
    const a = area.getBoundingClientRect()
    const cs = getComputedStyle(area)
    const contentCenter = a.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + area.clientWidth / 2
    return {
      shape: shapeName,
      over: [Math.round(a.right - n.right), Math.round(a.bottom - n.bottom)],
      inside: [Math.round(a.left - n.left), Math.round(a.top - n.top)],
      shadow: cs.boxShadow,
      overflow: cs.overflow,
      areaW: Math.round(a.width),
      clientW: area.clientWidth,
      pad: cs.padding,
      nodeCenter: Math.round((n.left + n.right) / 2),
      contentCenter: Math.round(contentCenter),
    }
  }, shape)
  console.log(`EDIT ${JSON.stringify(probe)}`)

  const box = await node.boundingBox()
  if (box !== null) {
    await page.screenshot({
      path: `docs/t79-edit-${name}.png`,
      clip: { x: box.x - 30, y: box.y - 30, width: box.width + 70, height: box.height + 70 },
    })
  }
  await page.keyboard.press('Escape')
}

test('三种形状的编辑态都贴着图元', async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 720 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })

  await page.getByTestId('whiteboard-add-rect').click()
  await page.getByTestId('whiteboard-add-note').click()
  await page.getByTestId('whiteboard-add-text').click()
  await waitSaved(page)

  await shotEditing(page, 'rect', 'rect')
  await shotEditing(page, 'note', 'note')
  await shotEditing(page, 'text', 'text')
})
