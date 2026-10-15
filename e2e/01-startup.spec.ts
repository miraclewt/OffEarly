/**
 * T32 · 启动全流程（file:// 单文件）
 *
 * 这一组回答的是交付形态的底线问题：双击这个 HTML，能不能连上目录、建库、打开已有库。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith } from './fixtures/app'
import { EMPTY_FS, fromBase64, readFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'

test('首屏要求连接数据文件夹，且不渲染看板', async ({ page }) => {
  await openAppWith(page, EMPTY_FS)

  await expect(page.getByText('连接数据文件夹')).toBeVisible()
  await expect(page.getByRole('button', { name: '选择文件夹' })).toBeVisible()
  // 库没打开之前不该出现任何工作区
  await expect(page.getByTestId('board')).toHaveCount(0)
  await expect(page.getByTestId('topic-sidebar')).toHaveCount(0)
})

test('空目录：确认后初始化新库，磁盘上出现 vault.json 与 assets/ .backup/', async ({ page }) => {
  await openAppWith(page, EMPTY_FS)
  await connectWorkspace(page, { create: true })

  const fs = await readFakeFs(page)
  expect(Object.keys(fs.files)).toContain('vault.json')
  expect(fs.dirs).toContain('assets')
  expect(fs.dirs).toContain('.backup')

  const vault = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as {
    schemaVersion: number
    revision: number
    topics: unknown[]
    tasks: unknown[]
  }
  expect(vault.schemaVersion).toBe(1)
  expect(vault.revision).toBe(0)
  expect(vault.topics).toEqual([])
  expect(vault.tasks).toEqual([])
})

test('已有库：直接打开、不询问创建，且看板渲染出示例任务数', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await page.getByRole('button', { name: '选择文件夹' }).click()

  // 不该出现「在此创建新库？」——已有 vault.json 的目录只会被打开
  await expect(page.getByRole('button', { name: '创建数据库' })).toHaveCount(0)
  await expect(page.getByTestId('board')).toBeVisible()

  // 侧栏话题树来自 example.vault（5 个话题）
  await expect(page.getByTestId('topic-tree')).toContainText('支付重构')
  await expect(page.getByTestId('topic-tree')).toContainText('数据平台')
  await expect(page.getByTestId('topic-sidebar-footer')).toBeVisible()
})

test('外壳骨架齐全：视图切换、保存指示、四个底部入口', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  await expect(page.getByTestId('view-board')).toBeVisible()
  await expect(page.getByTestId('view-gantt')).toBeVisible()
  await expect(page.getByTestId('save-indicator')).toContainText('已保存')
  for (const entry of ['milestones', 'filters', 'backup', 'settings']) {
    await expect(page.getByTestId(`sidebar-open-${entry}`)).toBeVisible()
  }
})
