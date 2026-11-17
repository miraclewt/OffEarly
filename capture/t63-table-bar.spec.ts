/**
 * T63 的成品图：光标停在表格里时浮出的行列工具条。
 *
 * 为什么非要用真 Chromium 拍：这一版修的两个问题（工具条压在表头边框上、
 * 框选单元格时整页蒙色）jsdom 一个都量不出来 —— 布局在 jsdom 里全是 0。
 * 图同时也用来做回归时的肉眼对照。
 *
 * 跑法：npm run build && npx playwright test --config playwright.capture.config.ts t63
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { ROOT } from '../playwright.config'
import { connectWorkspace, openAppWith } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'
import { toBase64, type FakeFsState } from '../e2e/fixtures/fakeFs'

const OUT = join(ROOT, 'docs')

const TABLE_DOC = [
  '## 本周排期',
  '',
  '下表是三方对齐后的结论，行是工作项、列是状态与负责人。',
  '改完记得回填到看板，周五站会按这张表过。',
  '',
  '| 工作项 | 状态 | 负责人 |',
  '| --- | --- | --- |',
  '| 登录页改版 | 进行中 | 陈默 |',
  '| 报表导出 | 已完成 | 林昭 |',
  '| 权限梳理 | 未开始 | 周野 |',
  '',
  '有异议的单元格直接改，改完记得回填到看板。',
  '',
].join('\n')

function withTableDoc(): FakeFsState {
  const fs = loadExampleVaultFs()
  const raw = JSON.parse(Buffer.from(fs.files['vault.json'] as string, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >
  const now = '2026-10-23T09:00:00.000Z'
  raw.notebooks = [{ id: 'nb-cap', name: '团队知识库', order: 'U', createdAt: now, updatedAt: now }]
  raw.noteDocs = [
    {
      id: 'doc-cap-1',
      notebookId: 'nb-cap',
      parentId: null,
      title: '本周排期',
      content: TABLE_DOC,
      order: 'U',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'doc-cap-2',
      notebookId: 'nb-cap',
      parentId: null,
      title: '会议纪要 · 10/21',
      content: '## 结论\n\n- 排期按上表推进\n',
      order: 'V',
      createdAt: now,
      updatedAt: now,
    },
  ]
  fs.files['vault.json'] = toBase64(JSON.stringify(raw))
  return fs
}

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
})

test('capture the table toolbar', async ({ page }) => {
  await openAppWith(page, withTableDoc())
  await connectWorkspace(page, { create: false })
  await expect(page.getByTestId('save-indicator')).toContainText('已保存')

  await page.getByTestId('view-notebook').click()
  await page.getByText('本周排期').first().click()

  const table = page.locator('.oe-prose table').first()
  await expect(table).toBeVisible()

  // 选中第二行第二格：既让工具条出现，也让「当前单元格」有一处可见的落点
  await table.locator('tr').nth(2).locator('td').first().click()
  await expect(page.getByTestId('note-table-bar')).toBeVisible()
  // 别在这里 blur：工具条的条件是「光标在表格里且编辑器有焦点」，失焦它会自己收起来。
  // 等一拍让入场动画（只有 opacity）走完，否则拍到半透明的一帧。
  await page.waitForTimeout(400)

  await page.screenshot({ path: join(OUT, 't63-table-toolbar.png') })

  // 框选两个格子：这一张是「整页蒙色」那个 bug 的对照图，蒙层必须关在单元格里
  await table.locator('tr').nth(1).locator('td').first().click()
  await page.keyboard.down('Shift')
  await table.locator('tr').nth(2).locator('td').nth(1).click()
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('note-table-bar')).toBeVisible()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 't63-table-selection.png') })
})
