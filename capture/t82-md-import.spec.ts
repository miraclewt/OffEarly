/**
 * T82 · Markdown 导入的证据图（真 Chromium）。
 *
 * 两张：
 *  · `docs/t82-md-import.png` —— 面板里两篇 md + 一个被跳过的 pdf，标题来源与跳过原因都在行上；
 *  · `docs/t82-tree-header.png` —— 1080 宽（用户常用的窗口）下文档树头部多了第三个图标之后
 *    仍然不裁切：宽度的数比截图更可信，所以同时断言 `scrollWidth - clientWidth ≤ 1`。
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith } from '../e2e/fixtures/app'
import { fromBase64 } from '../e2e/fixtures/fakeFs'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'
import type { FakeFsState } from '../e2e/fixtures/fakeFs'

mkdirSync('docs', { recursive: true })

test.use({ deviceScaleFactor: 2 })

function withNotebook(): FakeFsState {
  const fs = loadExampleVaultFs()
  const raw = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as Record<string, unknown>
  const now = '2026-11-02T09:00:00.000Z'
  raw.notebooks = [{ id: 'nb-md', name: 'AI 笔记', order: 'U', createdAt: now, updatedAt: now }]
  raw.noteDocs = []
  fs.files['vault.json'] = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64')
  return fs
}

const FILES = [
  {
    name: 'review.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      '---\ntitle: 支付对账方案评审\ntags: [工作, 评审]\n---\n\n## 结论\n\n- 先做对账口径\n- 再补对账文件\n',
      'utf8',
    ),
  },
  {
    name: 'quarter.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 季度复盘\n\n## 数据\n\n| 指标 | 值 |\n| --- | --- |\n| 完成率 | 82% |\n', 'utf8'),
  },
  {
    name: 'report.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('not really a pdf', 'utf8'),
  },
]

test('导入面板：标题来源与跳过原因都在行上', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openAppWith(page, withNotebook())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  await page.getByTestId('notebook-import-md').click()
  await expect(page.getByTestId('markdown-import')).toBeVisible()

  await page.getByTestId('markdown-import-file-input').setInputFiles(FILES)
  await expect(page.getByTestId('markdown-import-row')).toHaveCount(3)
  await page.screenshot({ path: 'docs/t82-md-import.png' })

  await page.getByTestId('markdown-import-confirm').click()
  await expect(page.getByTestId('notebook-export-notice')).toContainText('已导入 2 篇笔记')
})

test('1080 宽下文档树头部第三个图标不裁切', async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 640 })
  await openAppWith(page, withNotebook())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  await expect(page.getByTestId('notebook-import-md')).toBeVisible()

  const probe = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="notebook-tree-pane"]')
    const button = document.querySelector('[data-testid="notebook-import-md"]')
    if (pane === null || button === null) return null
    const paneRect = pane.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    return {
      overflow: pane.scrollWidth - pane.clientWidth,
      gapToEdge: Math.round(paneRect.right - buttonRect.right),
      buttonWidth: Math.round(buttonRect.width),
      buttonHeight: Math.round(buttonRect.height),
    }
  })
  console.log(`TREE-HEAD ${JSON.stringify(probe)}`)
  expect(probe).not.toBeNull()
  expect(probe!.overflow).toBeLessThanOrEqual(1)
  expect(probe!.gapToEdge).toBeGreaterThan(0)
  expect(probe!.buttonHeight).toBeGreaterThan(0)

  await page.screenshot({ path: 'docs/t82-tree-header.png' })
})
