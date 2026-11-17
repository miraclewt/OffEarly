/**
 * T80 · 文本图元可拖动的证据图（真 Chromium）。
 *
 * 用户贴图：「很差体验，很难拖动文本框」。旧行为是选中态上按下即进编辑，
 * 于是这个框永远拖不动。这里在按住拖动**中途**截一张，证明框真的跟着指针走。
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

mkdirSync('docs', { recursive: true })

test.use({ deviceScaleFactor: 2 })

test('按住文本图元拖动', async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 534 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })

  // 一个矩形 + 一个空文本图元（与用户截图同一幕：选中的空文本，只有占位字）
  await page.getByTestId('whiteboard-add-round').click()
  await page.getByTestId('whiteboard-add-text').click()
  await page.keyboard.press('Escape')
  await waitSaved(page)

  const text = page.locator('[data-whiteboard-shape="text"]').first()
  let box = await text.boundingBox()
  if (box === null) throw new Error('文本图元不在视口里')

  // 按下 → 拖 260 / 120 → 松手前截图（证明拖动生效，且没有冒出输入框）
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 })
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 6 })
  await expect(page.getByTestId('whiteboard-text-input')).toHaveCount(0)
  await page.screenshot({ path: 'docs/t80-drag-text.png' })
  await page.mouse.up()

  await waitSaved(page)
  const after = await text.boundingBox()
  if (after === null) throw new Error('拖完找不到了')
  console.log(`MOVED dx=${Math.round(after.x - box.x)} dy=${Math.round(after.y - box.y)}`)
  // 松手后位置真的变了，且仍然不在编辑态
  expect(Math.round(after.x - box.x)).toBeGreaterThan(60)
  await expect(page.getByTestId('whiteboard-text-input')).toHaveCount(0)
  box = after
})
