/**
 * T70 · 自定义色块的成品图与配色探针（真 Chromium）。
 *
 * 产出 docs/t70-color-panel.png（面板展开 + 选中态）与 docs/t70-color-canvas.png（上过色的白板）。
 * 探针打印每个图元的底色与字色——「深底是否换了浅字」只有真的量 computed style 才知道，
 * 单测只能钉几何算法，钉不到浏览器到底把哪一层颜色画上去了。
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

mkdirSync('docs', { recursive: true })

test.use({ deviceScaleFactor: 2 })

test('白板自定义色块', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('whiteboard-templates').selectOption('architecture')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(11)
  await waitSaved(page)

  /** 点图元的左上角：frame 的中心常被里面的框盖住，点几何中心会打到子节点上。 */
  async function pickByIndex(selector: string, index: number): Promise<void> {
    const box = await page.locator(selector).nth(index).boundingBox()
    if (box === null) throw new Error(`找不到 ${selector} 第 ${index} 个`)
    await page.mouse.click(box.x + 24, box.y + 12)
  }

  async function paint(selector: string, index: number, hex: string): Promise<void> {
    await pickByIndex(selector, index)
    await page.getByTestId('whiteboard-color').click()
    await page.getByTestId(`whiteboard-swatch-${hex.replace('#', '')}`).click()
    await page.keyboard.press('Escape')
  }

  // 面板展开的样子（先选中一个框，再打开面板）
  await pickByIndex('[data-whiteboard-shape="frame"]', 0)
  await page.getByTestId('whiteboard-color').click()
  await expect(page.getByTestId('whiteboard-color-panel')).toBeVisible()
  await page.screenshot({ path: 'docs/t70-color-panel.png' })

  // 浅底三档铺给三层框，深底一格给一个服务框（验证字色翻转）
  await page.getByTestId('whiteboard-swatch-dceefe').click()
  await page.keyboard.press('Escape')
  await paint('[data-whiteboard-shape="frame"]', 1, '#e3f7e8')
  await paint('[data-whiteboard-shape="frame"]', 2, '#ede9fe')
  await paint('[data-whiteboard-shape="rect"]', 0, '#fef3c7')
  await paint('[data-whiteboard-shape="rect"]', 3, '#3b82f6')
  await waitSaved(page)
  await page.keyboard.press('Escape')
  await page.screenshot({ path: 'docs/t70-color-canvas.png' })

  const probe = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="whiteboard-node-"]')].map((node) => {
      const el = node as HTMLElement
      const label = el.querySelector('span')
      return {
        shape: el.getAttribute('data-whiteboard-shape'),
        text: (label?.textContent ?? '').slice(0, 8),
        bg: getComputedStyle(el).backgroundColor,
        ink: label === null ? '' : getComputedStyle(label).color,
      }
    }),
  )
  console.log('[color-probe]', JSON.stringify(probe))
})
