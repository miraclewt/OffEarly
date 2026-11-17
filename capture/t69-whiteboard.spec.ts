/**
 * T69 · 白板成品图 + 几何探针。
 *
 * 产出 docs/t69-whiteboard-{empty,architecture,flow,quadrant,selected}.png 与 2560 宽屏一张。
 * 探针打印的几何（节点矩形、栏宽、缩放档）用于核对「看起来对不对」——单测与 e2e 都只看行为，
 * 看不出「字被剪断」「把手压在文字上」这类问题。
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

mkdirSync('docs', { recursive: true })

async function openWhiteboard(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('view-whiteboard').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })
}

test('白板成品图与几何', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()

  // 空态
  await expect(page.getByTestId('whiteboard-empty')).toBeVisible()
  await page.screenshot({ path: 'docs/t69-whiteboard-empty.png' })

  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  // 架构分层
  await page.getByTestId('whiteboard-templates').selectOption('architecture')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(11)
  await waitSaved(page)
  await page.screenshot({ path: 'docs/t69-whiteboard-architecture.png' })

  const geometry = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="whiteboard-surface"]') as HTMLElement | null
    const world = document.querySelector('[data-testid="whiteboard-world"]') as HTMLElement | null
    const nodes = [...document.querySelectorAll('[data-testid^="whiteboard-node-"]')].map((node) => {
      const rect = node.getBoundingClientRect()
      return {
        shape: node.getAttribute('data-board-shape') ?? node.getAttribute('data-whiteboard-shape'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        text: node.textContent?.slice(0, 12) ?? '',
      }
    })
    return {
      surface: surface === null ? null : { width: Math.round(surface.clientWidth), height: Math.round(surface.clientHeight) },
      world: world === null ? null : world.style.transform,
      nodes,
    }
  })
  console.log('[whiteboard-geometry]', JSON.stringify(geometry, null, 0))

  // 选中态：四角把手 + 四边锚点
  const firstRect = page.locator('[data-whiteboard-shape="rect"]').first()
  await firstRect.click()
  await expect(page.getByTestId('whiteboard-handle-nw')).toBeVisible()
  await expect(page.getByTestId('whiteboard-anchor-right')).toBeVisible()
  await page.screenshot({ path: 'docs/t69-whiteboard-selected.png' })

  // 流程图：另起一张，避免叠在一起
  await page.getByTestId('whiteboard-create').click()
  await page.getByTestId('whiteboard-templates').selectOption('flow')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(6)
  await page.screenshot({ path: 'docs/t69-whiteboard-flow.png' })

  await page.getByTestId('whiteboard-create').click()
  await page.getByTestId('whiteboard-templates').selectOption('quadrant')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(4)
  await page.screenshot({ path: 'docs/t69-whiteboard-quadrant.png' })

  await page.getByTestId('whiteboard-create').click()
  await page.getByTestId('whiteboard-templates').selectOption('radial')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(7)
  await page.screenshot({ path: 'docs/t69-whiteboard-radial.png' })
})

test('27 寸宽屏下的白板', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)
  await page.getByTestId('whiteboard-templates').selectOption('architecture')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(11)
  await page.screenshot({ path: 'docs/t69-whiteboard-2560.png' })
})
