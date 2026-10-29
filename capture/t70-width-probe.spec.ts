/**
 * T68 的成品图 + 几何探针：27 寸（2560×1440）下知识库两栏占了多少、正文两侧空了多少。
 * 跑法：npm run build && npx playwright test --config playwright.capture.config.ts t70-width-probe
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

test('probe notebook widths', async ({ page }) => {
  for (const [w, h, tag] of [
    [2560, 1440, '2560'],
    [1920, 1080, '1920'],
    [1440, 900, '1440'],
  ] as const) {
    await page.setViewportSize({ width: w, height: h })
    await openAppWith(page, loadExampleVaultFs())
    await connectWorkspace(page, { create: false })
    await waitSaved(page)
    await page.getByTestId('view-notebook').click()
    await page.getByTestId('doc-row-doc-pay-retro').or(page.locator('[data-testid^="doc-row-"]').first()).first().click()
    await page.waitForTimeout(500)

    const m = await page.evaluate(() => {
      const box = (el: Element | null) => {
        if (el === null) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x), w: Math.round(r.width) }
      }
      const q = (sel: string) => box(document.querySelector(sel))
      const prose = document.querySelector('.oe-prose')
      const rowText = document.querySelector('[data-testid^="doc-row-"] span:nth-child(2)') as HTMLElement | null
      return {
        innerWidth: window.innerWidth,
        shell: q('#root > div'),
        sidebar: q('#root > div > div:first-child > aside'),
        books: q('[data-testid="notebook-books-pane"]'),
        tree: q('[data-testid="notebook-tree-pane"]'),
        main: q('[data-testid="notebook"] main'),
        outline: q('[data-testid="notebook-outline-panel"]'),
        prose: box(prose),
        docTitleClipped: rowText === null ? null : rowText.scrollWidth > rowText.clientWidth + 1,
        uiScale: getComputedStyle(document.documentElement).getPropertyValue('--oe-ui-scale').trim(),
      }
    })
    console.log(`[${tag}] ${JSON.stringify(m)}`)
    await page.screenshot({ path: join(OUT, `t68-notebook-${tag}.png`) })
  }
})
