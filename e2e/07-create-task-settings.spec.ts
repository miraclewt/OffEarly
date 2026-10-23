/**
 * T34/T35 · 新建任务入口与设置面板（真实 file:// 交付形态）
 *
 * 这两项此前是明确的缺口：`createTaskCommand` 有命令、没有入口；侧栏「设置」只弹
 * 「… 面板尚未实现」。这组用例在真产物 + 假目录上把它们走一遍，并验到 vault.json 字节。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith, waitSaved } from './fixtures/app'
import { EMPTY_FS, fromBase64, readFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'

interface StoredVault {
  settings: {
    locale: string
    ganttScale: string
    calendar: { workdays: number[]; holidays: string[]; extraWorkdays: string[] }
  }
  topics: { id: string; name: string }[]
  tasks: { title: string; status: string; topicId: string }[]
}

function parseVault(fs: { files: Record<string, string> }): StoredVault {
  return JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
}

test('列内新建任务：立刻出现在看板，并随自动保存落盘', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  const before = parseVault(await readFakeFs(page))

  await page.getByTestId('board-add-task-doing').click()
  const input = page.getByTestId('board-new-task-input-doing')
  await expect(input).toBeVisible()
  await input.fill('E2E 列内新建任务')
  await input.press('Enter')

  // 卡片立刻出现在目标列
  await expect(page.getByTestId('board-column-doing')).toContainText('E2E 列内新建任务')
  await waitSaved(page)

  const after = parseVault(await readFakeFs(page))
  expect(after.tasks.length).toBe(before.tasks.length + 1)
  const created = after.tasks.find((task) => task.title === 'E2E 列内新建任务')
  expect(created?.status).toBe('doing')
  // 默认归属当前筛选的话题（example.vault 的 lastFilter 是支付重构）
  expect(created?.topicId).toBe(before.topics.find((topic) => topic.name === '支付重构')?.id)
})

test('空库：看板引导条一步建话题，之后就能在列内新建任务', async ({ page }) => {
  await openAppWith(page, EMPTY_FS)
  await connectWorkspace(page, { create: true })

  // 没有可用话题：列底不给入口，改由看板顶部的引导条给出路（T52）
  await expect(page.getByTestId('board-guide')).toContainText('还没有话题')
  await expect(page.getByTestId('board-guide')).toContainText('先建一个话题')
  await expect(page.getByTestId('board-add-task-todo')).toHaveCount(0)
  // 四列不再各重复一行灰字
  await expect(page.getByTestId('board-add-task-blocked-todo')).toHaveCount(0)

  // 引导条上的按钮是真能点的：一步之后列内入口就出现
  await page.getByTestId('board-create-topic').click()
  await expect(page.getByTestId('board-guide')).toHaveCount(0)
  await expect(page.getByTestId('board-add-task-todo')).toBeVisible()

  // 侧栏也看得到这个新话题（与侧栏新建走同一个写入口）
  await waitSaved(page)
  const created = parseVault(await readFakeFs(page))
  expect(created.topics.map((topic) => topic.name)).toEqual(['未命名话题'])

  await page.getByTestId('board-add-task-todo').click()
  const input = page.getByTestId('board-new-task-input-todo')
  await input.fill('第一条任务')
  await input.press('Enter')
  await expect(page.getByTestId('board-column-todo')).toContainText('第一条任务')

  await waitSaved(page)
  const vault = parseVault(await readFakeFs(page))
  expect(vault.tasks.map((task) => task.title)).toContain('第一条任务')
  expect(vault.tasks[0]?.topicId).toBe(vault.topics[0]?.id)
})

test('设置面板：入口打开真面板，改刻度与工作日历后落盘', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  await page.getByTestId('sidebar-open-settings').click()
  await expect(page.getByTestId('settings-panel')).toBeVisible()
  // 占位提示不再出现
  await expect(page.getByTestId('shell-notice')).toHaveCount(0)

  await page.getByTestId('settings-gantt-scale-week').click()
  await page.getByTestId('settings-workday-6').click()
  await page.getByTestId('settings-holidays-input').fill('2026-10-08')
  await page.getByTestId('settings-holidays-add').click()
  await expect(page.getByTestId('settings-holidays-item-2026-10-08')).toBeVisible()

  await waitSaved(page)
  const vault = parseVault(await readFakeFs(page))
  expect(vault.settings.ganttScale).toBe('week')
  expect(vault.settings.calendar.workdays).toEqual([1, 2, 3, 4, 5, 6])
  expect(vault.settings.calendar.holidays).toContain('2026-10-08')
})

test('设置面板：改语言即时生效并落盘，Esc 关闭', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  await page.getByTestId('sidebar-open-settings').click()
  await page.getByTestId('settings-locale-en').click()
  // 整棵树换语言：看板列头变英文
  await expect(page.getByText('To Do')).toBeVisible()

  // 换了语言，保存指示也是英文了（waitSaved 断言的是中文文案）
  await expect(page.getByTestId('save-indicator')).toHaveAttribute('data-state', 'saved')
  expect(parseVault(await readFakeFs(page)).settings.locale).toBe('en')

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-panel')).toHaveCount(0)
})
