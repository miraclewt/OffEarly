/**
 * T64 · 回收站与展示模式的真实链路。
 *
 * 三条承诺，都要求「重开之后仍然成立」，所以每条都对着磁盘上的 vault.json 断言：
 *  1. 删掉的笔记进回收站，且正文真的从 noteDocs 里消失（不是只从界面上藏起来）；
 *  2. 恢复把整棵子树放回原位，彻底删除后才真的只剩一条空 trash；
 *  3. 展示模式按二级标题分页，翻页不写库（vault.json 一个字节都不动）。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith, waitSaved } from './fixtures/app'
import { fromBase64, readFakeFs, seedFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'
import type { FakeFsState } from './fixtures/fakeFs'

interface StoredDoc {
  id: string
  title: string
  content: string
  parentId: string | null
}

interface StoredVault {
  noteDocs?: StoredDoc[]
  trash?: { id: string; kind: string; deletedAt: string }[]
}

function parseVault(fs: FakeFsState): StoredVault {
  return JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
}

/** 在 example 库上换成一棵「父 + 子」的文档树，其余任务数据保持不动。 */
function withDocTree(): FakeFsState {
  const fs = loadExampleVaultFs()
  const raw = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as Record<string, unknown>
  const now = '2026-10-28T09:00:00.000Z'
  raw.notebooks = [{ id: 'nb-e2e', name: '团队知识库', order: 'U', createdAt: now, updatedAt: now }]
  raw.noteDocs = [
    {
      id: 'doc-parent',
      notebookId: 'nb-e2e',
      parentId: null,
      title: '发布流程',
      content: '发布前先看检查单。',
      order: 'U',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'doc-child',
      notebookId: 'nb-e2e',
      parentId: 'doc-parent',
      title: '回滚预案',
      content: '回滚三步：停、切、验。',
      order: 'U',
      createdAt: now,
      updatedAt: now,
    },
  ]
  fs.files['vault.json'] = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64')
  return fs
}

/** 打开侧栏回收站。 */
async function openTrash(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('sidebar-open-trash').click()
  await expect(page.getByTestId('trash-panel')).toBeVisible()
}

test('删掉的笔记进回收站 → 重开还在 → 恢复回原位 → 彻底删除后消失', async ({ page }) => {
  await openAppWith(page, withDocTree())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  // ① 删父文档（连子树）：两段确认
  await page.getByTestId('doc-row-doc-parent').hover()
  await page.getByTestId('doc-delete-doc-parent').click()
  await page.getByTestId('doc-delete-doc-parent').click()

  await expect(page.getByTestId('doc-row-doc-parent')).toHaveCount(0)
  await waitSaved(page)

  // 磁盘口径：两篇都不在 noteDocs 里了，回收站里有一条
  await expect
    .poll(async () => (parseVault(await readFakeFs(page)).noteDocs ?? []).length, { timeout: 15_000 })
    .toBe(0)
  const afterDelete = parseVault(await readFakeFs(page))
  expect(afterDelete.trash).toHaveLength(1)
  expect(afterDelete.trash?.[0]?.kind).toBe('doc')

  // ② 重开：回收站里的条目还在（这是「持久化」与「只存在内存里」的区别）
  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await connectWorkspace(page, { create: false })
  await openTrash(page)
  await expect(page.locator('[data-testid^="trash-entry-title-"]')).toHaveText(['发布流程'])
  await expect(page.getByTestId('trash-list')).toContainText('含 1 篇子文档')
  await expect(page.getByTestId('trash-list')).toContainText('发布前先看检查单')

  // ③ 恢复：子树整棵回来
  await page.locator('[data-testid^="trash-restore-"]').click()
  await expect(page.getByTestId('trash-empty')).toBeVisible()
  await expect(page.getByTestId('trash-notice')).toContainText('已恢复')
  await page.getByTestId('trash-close').click()

  await page.getByTestId('view-notebook').click()
  await expect(page.getByTestId('doc-row-doc-parent')).toBeVisible()
  await expect(page.getByTestId('doc-row-doc-child')).toBeVisible()
  await waitSaved(page)
  await expect
    .poll(async () => (parseVault(await readFakeFs(page)).noteDocs ?? []).map((doc) => doc.id).join(','), {
      timeout: 15_000,
    })
    .toBe('doc-parent,doc-child')

  // ④ 再删一次，然后彻底删除；重开后回收站为空、文档也不在了
  await page.getByTestId('doc-row-doc-parent').hover()
  await page.getByTestId('doc-delete-doc-parent').click()
  await page.getByTestId('doc-delete-doc-parent').click()
  await waitSaved(page)

  await openTrash(page)
  const purge = page.locator('[data-testid^="trash-purge-"]')
  await purge.click()
  // 第一下只是进入确认态，条目仍在
  await expect(purge).toContainText('再点一次')
  await purge.click()
  await expect(page.getByTestId('trash-empty')).toBeVisible()
  await waitSaved(page)
  await expect
    .poll(async () => (parseVault(await readFakeFs(page)).trash ?? []).length, { timeout: 15_000 })
    .toBe(0)

  const finalSnapshot = await readFakeFs(page)
  await seedFakeFs(page, finalSnapshot)
  await page.reload()
  await connectWorkspace(page, { create: false })
  await openTrash(page)
  await expect(page.getByTestId('trash-empty')).toBeVisible()
})

test('展示模式：按二级标题分页，翻页不写库', async ({ page }) => {
  await openAppWith(page, withDocTree())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  // 把「发布流程」改成三段：导言 + 两个二级标题
  const editor = page.getByTestId('note-editor-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('发布前先看检查单。')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('## 上线前')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('备份、通知、窗口。')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('## 上线后')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('看板、日志、复盘。')
  await waitSaved(page)

  const before = fromBase64((await readFakeFs(page)).files['vault.json'] as string)

  await page.getByTestId('notebook-present').click()
  await expect(page.getByTestId('note-present')).toBeVisible()
  await expect(page.getByTestId('note-present-counter')).toContainText('1 / 3')
  await expect(page.getByTestId('note-present-body')).toContainText('发布前先看检查单')

  await page.getByTestId('note-present-next').click()
  await expect(page.getByTestId('note-present-counter')).toContainText('2 / 3')
  await expect(page.getByTestId('note-present-section')).toHaveText('上线前')
  await expect(page.getByTestId('note-present-body')).toContainText('备份、通知、窗口')

  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('note-present-counter')).toContainText('3 / 3')
  await expect(page.getByTestId('note-present-body')).toContainText('看板、日志、复盘')

  // 展示是只读派生：翻页期间正文一个字节都没被改写
  const after = fromBase64((await readFakeFs(page)).files['vault.json'] as string)
  expect(after).toBe(before)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-present')).toHaveCount(0)
  // 回到编辑态，全文仍在（展示模式没有把正文截断）
  await expect(page.getByTestId('note-editor-content')).toContainText('看板、日志、复盘')
})

test('标准 Markdown 链接：手打成链、落盘仍是 []()、展示态可点', async ({ page }) => {
  await openAppWith(page, withDocTree())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  const editor = page.getByTestId('note-editor-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('发布看 [官网](https://example.com) 这里')
  await waitSaved(page)

  // ① 编辑态：已经变成链接（a 带 href），而不是一段方括号文字
  const anchor = editor.locator('a[href="https://example.com"]')
  await expect(anchor).toHaveText('官网')

  // ② 落盘：仍是标准 Markdown，不是 HTML 标签
  await expect
    .poll(async () => (parseVault(await readFakeFs(page)).noteDocs ?? [])[0]?.content ?? '', { timeout: 15_000 })
    .toContain('[官网](https://example.com)')

  // ③ 展示态：链接可点（target=_blank），且分页没有把它拆坏
  await page.getByTestId('notebook-present').click()
  const presentLink = page.getByTestId('note-editor-readonly').locator('a[href="https://example.com"]')
  await expect(presentLink).toHaveAttribute('target', '_blank')
  await page.keyboard.press('Escape')
})
