/**
 * T64 的成品图：展示模式浮层与回收站面板。
 *
 * 为什么必须用真 Chromium 拍：这两块都是「浮层 + 滚动容器 + 阅读宽度」的组合，
 * jsdom 里所有盒子都是 0，压字、溢出、遮罩没盖住这些毛病一个都量不出来。
 *
 * 跑法：npm run build && npx playwright test --config playwright.capture.config.ts t64-trash
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { ROOT } from '../playwright.config'
import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'
import { toBase64, type FakeFsState } from '../e2e/fixtures/fakeFs'

const OUT = join(ROOT, 'docs')

const DOC = [
  '这篇讲一次没有回滚预案的上线是怎么收场的：先出结论，再按阶段拆。',
  '',
  '## 结论：先能退，再能上',
  '',
  '发布的本质是一次可逆的变更。任何一步不可逆，就等于把可用性押在「不会出错」上。',
  '',
  '- 变更窗口固定在工作日 10:00–16:00',
  '- 每次发布都有回滚脚本，且**在预发跑过一遍**',
  '- 值班人必须在场，不在场就不发',
  '',
  '## 上线前：三张清单',
  '',
  '备份、通知、窗口，三张清单缺一不可。检查单不是形式，它是把「记性」外置。',
  '',
  '| 清单 | 负责人 | 完成 |',
  '| --- | --- | --- |',
  '| 数据备份 | 陈默 | 是 |',
  '| 客户通知 | 林昭 | 是 |',
  '| 变更窗口 | 周野 | 是 |',
  '',
  '## 上线后：看板与日志',
  '',
  '上线后 30 分钟是事故高发段，看板与日志要同时盯：错误率、P99、支付成功率三条线。',
  '',
  '## 复盘：把结论写回文档',
  '',
  '复盘不是为了追责，是为了让下一篇文档不再重复这一篇的结论。',
].join('\n')

function withDocs(): FakeFsState {
  const fs = loadExampleVaultFs()
  const raw = JSON.parse(Buffer.from(fs.files['vault.json'] as string, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >
  const now = '2026-10-28T09:00:00.000Z'
  raw.notebooks = [{ id: 'nb-cap', name: '团队知识库', order: 'U', createdAt: now, updatedAt: now }]
  raw.noteDocs = [
    {
      id: 'doc-cap-1',
      notebookId: 'nb-cap',
      parentId: null,
      title: '发布流程',
      content: DOC,
      order: 'U',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'doc-cap-2',
      notebookId: 'nb-cap',
      parentId: 'doc-cap-1',
      title: '回滚预案',
      content: '回滚三步：停流、切流量、验数据。\n\n## 停流\n\n先摘掉入口。\n\n## 切流量\n\n回上一个版本。',
      order: 'U',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'doc-cap-3',
      notebookId: 'nb-cap',
      parentId: null,
      title: '会议纪要 · 10/28',
      content: '## 结论\n\n- 本周只发一次\n- 回滚预案跟着一起发\n',
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

test('capture presentation + trash', async ({ page }) => {
  await openAppWith(page, withDocs())
  await connectWorkspace(page, { create: false })
  await waitSaved(page)

  await page.getByTestId('view-notebook').click()
  await page.getByText('发布流程').first().click()
  await expect(page.getByTestId('note-editor-content')).toContainText('结论')

  // 正文页眉：展示按钮与导出、大纲并排（三颗 12px 图标按钮，检查有没有把标题挤换行）
  await page.screenshot({ path: join(OUT, 't64-notebook-header.png'), clip: { x: 0, y: 0, width: 1440, height: 220 } })

  // ① 展示模式：停在第一页（导言）
  await page.getByTestId('notebook-present').click()
  await expect(page.getByTestId('note-present')).toBeVisible()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 't64-present-intro-1440.png') })

  // ② 翻到「上线前」那一页（带表格），看表格与页脚的关系
  await page.getByTestId('note-present-next').click()
  await page.getByTestId('note-present-next').click()
  await expect(page.getByTestId('note-present-section')).toHaveText('上线前：三张清单')
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 't64-present-table-1440.png') })

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-present')).toHaveCount(0)

  // ③ 窄一档：1024×768（应用外壳的最小宽度），浮层不该被裁
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.getByTestId('notebook-present').click()
  await page.getByTestId('note-present-next').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 't64-present-1024.png') })
  await page.keyboard.press('Escape')

  // ④ 更窄：768×600。外壳会横向滚（minWidth 1024），但浮层按 100vw 排版，必须完整
  await page.setViewportSize({ width: 768, height: 600 })
  await page.getByTestId('notebook-present').click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, 't64-present-768.png') })
  const box = await page.getByTestId('note-present').boundingBox()
  if (box === null) throw new Error('拿不到浮层几何')
  expect(box.width).toBeLessThanOrEqual(768)
  expect(box.height).toBeLessThanOrEqual(600)
  await page.keyboard.press('Escape')

  // ⑤ 回收站：先删一篇带子文档的笔记，再删一个任务
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('doc-row-doc-cap-1').hover()
  await page.getByTestId('doc-delete-doc-cap-1').click()
  await page.getByTestId('doc-delete-doc-cap-1').click()

  await page.getByTestId('view-board').click()
  await page.getByTestId('task-card-task-pay-01').click()
  await expect(page.getByTestId('task-drawer')).toBeVisible()
  await page.getByTestId('drawer-delete').click()
  await page.getByTestId('drawer-delete').click()
  await expect(page.getByTestId('task-drawer')).toHaveCount(0)
  await waitSaved(page)

  await page.getByTestId('sidebar-open-trash').click()
  await expect(page.getByTestId('trash-panel')).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, 't64-trash-1440.png') })

  // 点一次「彻底删除」进入确认态（红底），这一张用来核对手感与对比度
  await page.locator('[data-testid^="trash-purge-"]').first().click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(OUT, 't64-trash-confirm-1440.png') })

  // ⑥ 1024 宽下的回收站：两行元信息不该挤成竖排
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(OUT, 't64-trash-1024.png') })
})
