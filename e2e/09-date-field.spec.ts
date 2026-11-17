/**
 * T54 · 日期输入（F10）：全站统一 `YYYY-MM-DD`。
 *
 * 为什么这件事只能在真浏览器里收尾：原生 `<input type="date">` 的 **DOM 值恒为 ISO**，
 * 但**显示格式**由浏览器区域设置决定——`value` 对得上，用户看到的却是 `10/05/2026`。
 * 所以 jsdom 里只能测「提交的值对不对」，「看见的是什么」必须落在真 Chromium 上：
 * 这里同时钉住 `type="text"`（不再交给原生控件）、全站零 `input[type=date]`、
 * 以及切换语言后显示不变。
 *
 * 弹层位置也顺手量一次：日历用 `position: fixed` 是因为 FilterBar 面板
 * `overflow-y: auto` 会把绝对定位的浮层裁掉，这条只有真浏览器看得出。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { connectWorkspace, openAppWith, waitSaved } from './fixtures/app'
import { loadExampleVaultFs } from './fixtures/exampleVault'
import { fromBase64, readFakeFs } from './fixtures/fakeFs'

const CARD = 'task-card-task-pay-01'
const ISO = /^\d{4}-\d{2}-\d{2}$/

interface StoredVault {
  tasks: { id: string; start?: string; due?: string }[]
}

async function readVault(page: Page): Promise<StoredVault> {
  const fs = await readFakeFs(page)
  return JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
}

function findTask(vault: StoredVault, id: string) {
  const task = vault.tasks.find((candidate) => candidate.id === id)
  if (task === undefined) throw new Error(`找不到任务 ${id}`)
  return task
}

async function openTaskDialog(page: Page): Promise<void> {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId(CARD).click()
  await expect(page.getByTestId('task-drawer')).toBeVisible()
}

test('全站不再有原生 date 控件，日期框显示恒为 YYYY-MM-DD', async ({ page }) => {
  await openTaskDialog(page)

  const start = page.getByTestId('drawer-start-input')
  // 这是 F10 的根因所在：类型是 text，格式化权在应用手上
  expect(await start.getAttribute('type')).toBe('text')

  const startValue = await start.inputValue()
  expect(startValue === '' || ISO.test(startValue)).toBe(true)

  const dueValue = await page.getByTestId('drawer-due-input').inputValue()
  expect(dueValue === '' || ISO.test(dueValue)).toBe(true)

  // 弹窗、筛选、里程碑三处入口都换成同一个控件
  expect(await page.locator('input[type="date"]').count()).toBe(0)

  await page.keyboard.press('Escape')
  await page.getByTestId('sidebar-open-filters').click()
  await expect(page.getByTestId('filter-date-from')).toBeVisible()
  expect(await page.getByTestId('filter-date-from').getAttribute('type')).toBe('text')
  expect(await page.locator('input[type="date"]').count()).toBe(0)
})

test('键入 8 位数字自动分组，落盘为 ISO', async ({ page }) => {
  await openTaskDialog(page)

  // 先清掉到期日：开始日若晚于到期日会被「结束不能早于开始」拦下（那不是本用例要测的）
  const due = page.getByTestId('drawer-due-input')
  await due.click()
  await due.press('ControlOrMeta+a')
  await due.press('Backspace')
  await expect(due).toHaveValue('')

  const start = page.getByTestId('drawer-start-input')
  await start.click()
  await start.press('ControlOrMeta+a')
  await start.press('Backspace')
  await start.pressSequentially('20261103')

  await expect(start).toHaveValue('2026-11-03')

  // 自动保存是 400ms 防抖，`waitSaved` 只等指示器文案 → 落盘要轮询
  await waitSaved(page)
  await expect
    .poll(async () => findTask(await readVault(page), 'task-pay-01').start)
    .toBe('2026-11-03')
})

test('伪日期不写库：原文留着并就地报错', async ({ page }) => {
  await openTaskDialog(page)

  const before = await readVault(page)
  const previousStart = findTask(before, 'task-pay-01').start

  const start = page.getByTestId('drawer-start-input')
  await start.click()
  await start.press('ControlOrMeta+a')
  await start.pressSequentially('20260230')

  await expect(start).toHaveValue('2026-02-30')
  await expect(page.getByTestId('drawer-start-input-invalid')).toBeVisible()

  await waitSaved(page)
  expect(findTask(await readVault(page), 'task-pay-01').start).toBe(previousStart)
})

test('日历浮层不被容器裁掉，选一天即提交并落盘', async ({ page }) => {
  await openTaskDialog(page)

  const due = page.getByTestId('drawer-due-input')
  await page.getByTestId('drawer-due-input-calendar').click()
  const popover = page.getByTestId('drawer-due-input-popover')
  await expect(popover).toBeVisible()

  // fixed 定位 + 视口钳制：浮层必须整个落在视口内（贴边也不会被切掉）
  const box = await popover.boundingBox()
  const viewport = page.viewportSize()
  if (box === null || viewport === null) throw new Error('拿不到几何')
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)

  // 取当前显示月份，点这个月的 15 号（每个月都有）
  const month = (await page.getByTestId('drawer-due-input-month').textContent()) ?? ''
  const target = `${month}-15`
  await page.getByTestId(`drawer-due-input-day-${target}`).click()

  await expect(due).toHaveValue(target)
  await expect(popover).toHaveCount(0)

  await waitSaved(page)
  await expect
    .poll(async () => findTask(await readVault(page), 'task-pay-01').due)
    .toBe(target)
})

test('贴着视口底部打开时浮层向上翻，不溢出屏幕', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('sidebar-open-filters').click()

  const to = page.getByTestId('filter-date-to')
  await to.scrollIntoViewIfNeeded()
  await page.getByTestId('filter-date-to-calendar').click()
  const popover = page.getByTestId('filter-date-to-popover')
  await expect(popover).toBeVisible()

  // 外壳的 backdrop-filter 会给 fixed 造包含块：浮层若不挂到 body，这里会整体下移并溢出
  const box = await popover.boundingBox()
  const inputBox = await to.boundingBox()
  const viewport = page.viewportSize()
  if (box === null || inputBox === null || viewport === null) throw new Error('拿不到几何')
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  // 翻到上方：浮层底边不压住输入框
  expect(box.y + box.height).toBeLessThanOrEqual(inputBox.y)
})

test('切到英文界面后，同一条日期仍然显示成 YYYY-MM-DD', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  await page.getByTestId('sidebar-open-settings').click()
  await expect(page.getByTestId('settings-panel')).toBeVisible()
  await page.getByTestId('settings-locale-en').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-panel')).toHaveCount(0)

  await page.getByTestId(CARD).click()
  const start = page.getByTestId('drawer-start-input')
  const value = await start.inputValue()
  expect(value === '' || ISO.test(value)).toBe(true)
  // 英文界面里字段标签变了，值写法不变——这正是 F10 要的结果
  await expect(page.getByTestId('drawer-start-input-calendar')).toHaveAttribute(
    'aria-label',
    'Open calendar',
  )
})
