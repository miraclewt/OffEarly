/**
 * T83 · 正文宽度三档（窄 / 适中 / 全宽）的成品图：27 寸（2560×1440）下各拍一张。
 * 跑法：npm run build && npx playwright test --config playwright.capture.config.ts t83-width-gears
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { test } from '@playwright/test'

import { APP_URL } from '../playwright.config'
import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

const OUT = join('docs')

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
})

test.use({ deviceScaleFactor: 1, baseURL: APP_URL, locale: 'zh-CN' })

test('T83 三档宽度成品图（2560）', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await waitSaved(page)
  await page.getByTestId('view-notebook').click()
  // 带 Mermaid 与燃尽图的周会纪要：三档差异在这类富文本上最直观
  await page.getByTestId('doc-row-doc-meeting').click()
  await page.waitForTimeout(500)

  await page.screenshot({ path: join(OUT, 't83-width-medium-2560.png') })

  await page.getByTestId('notebook-width').click()
  await page.getByTestId('notebook-width-narrow').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, 't83-width-narrow-2560.png') })

  await page.getByTestId('notebook-width').click()
  await page.getByTestId('notebook-width-full').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, 't83-width-full-2560.png') })

  // 顺带拍一张菜单展开态（核对三档文案与当前档高亮）
  await page.getByTestId('notebook-width').click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(OUT, 't83-width-menu-2560.png'), clip: { x: 1700, y: 0, width: 860, height: 500 } })
})
