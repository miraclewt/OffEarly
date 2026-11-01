/**
 * T73 的成品图：`/` 斜杠命令菜单（全量 / 过滤后两态），用于人工核对位置与配色。
 * 跑法：npm run build && npx playwright test --config playwright.capture.config.ts t73-slash
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

test('capture slash menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await waitSaved(page)
  await page.getByTestId('view-notebook').click()
  await page
    .getByTestId('doc-row-doc-pay-retro')
    .or(page.locator('[data-testid^="doc-row-"]').first())
    .first()
    .click()
  await page.waitForTimeout(400)

  const body = page.getByTestId('note-editor-content')
  await body.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(' /')
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, 't73-slash-menu.png') })

  await page.keyboard.type('表')
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, 't73-slash-filter.png') })

  // Esc 关菜单、删掉残留的「/表」，再给这篇文档挂一个任务与两个标签，拍属性行
  await page.keyboard.press('Escape')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(200)
  await page.getByTestId('note-prop-add-task').click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(OUT, 't73-prop-task-menu.png') })
  await page.getByTestId('note-prop-task-option-0').click()

  for (const tag of ['周会', '支付']) {
    await page.getByTestId('note-prop-add-tag').click()
    await page.keyboard.type(tag)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(300)
  await page.getByTestId('notebook-breadcrumb').click()
  await page.screenshot({ path: join(OUT, 't73-prop-row.png'), clip: { x: 430, y: 60, width: 720, height: 200 } })
})
