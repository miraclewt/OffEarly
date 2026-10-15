/**
 * T32 · 甘特图渲染与刻度切换
 *
 * 甘特图是纯 SVG + 虚拟化（只渲染视口内的行列），最容易在真实浏览器里出偏差，
 * 所以这里不看内部状态，只数 DOM。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith } from './fixtures/app'
import { loadExampleVaultFs } from './fixtures/exampleVault'

async function openGantt(page: import('@playwright/test').Page): Promise<void> {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-gantt').click()
  await expect(page.getByTestId('gantt-view')).toBeVisible()
}

test('甘特图渲染出列、行、任务条、今日线与里程碑', async ({ page }) => {
  await openGantt(page)

  expect(await page.locator('[data-gantt-col]').count()).toBeGreaterThan(0)
  expect(await page.locator('[data-gantt-row]').count()).toBeGreaterThan(0)
  expect(await page.locator('[data-gantt-bar]').count()).toBeGreaterThan(0)
  expect(await page.locator('[data-gantt-today="line"]').count()).toBeGreaterThan(0)
  expect(await page.locator('[data-gantt-milestone]').count()).toBeGreaterThan(0)
  // example.vault 有 7 条依赖，箭头层必须画出来（虚拟化只裁行，不裁箭头层本身）
  expect(await page.locator('[data-gantt-layer="arrows"]').count()).toBe(1)
})

test('日 / 周刻度切换会改变列集合与按钮态', async ({ page }) => {
  await openGantt(page)

  const dayScale = page.getByTestId('gantt-scale-day')
  const weekScale = page.getByTestId('gantt-scale-week')
  await expect(dayScale).toHaveAttribute('aria-pressed', 'true')

  const dayColumns = await page.locator('[data-gantt-col]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-gantt-col')),
  )
  expect(dayColumns.length).toBeGreaterThan(0)

  await weekScale.click()
  await expect(weekScale).toHaveAttribute('aria-pressed', 'true')
  await expect(dayScale).toHaveAttribute('aria-pressed', 'false')

  const weekColumns = await page.locator('[data-gantt-col]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-gantt-col')),
  )
  expect(weekColumns.length).toBeGreaterThan(0)
  // 本模型里「列」恒为一天：刻度只改每天占的宽度（day 32px / week 14px，见 ganttModel.cellWidthOf），
  // 所以切到周刻度是**缩小**而不是合并——同一块画布装得下更多天，可见列数只增不减。
  expect(weekColumns.length).toBeGreaterThan(dayColumns.length)
  // 两者都从范围起点铺开（scrollLeft 仍为 0），周刻度是「同一段日程看得更远」
  expect(weekColumns[0]).toBe(dayColumns[0])
  expect(weekColumns).not.toEqual(dayColumns)
})

test('基线开关：关掉之后画面上不再有基线条', async ({ page }) => {
  await openGantt(page)

  const toggle = page.getByTestId('gantt-baseline-toggle')
  await expect(toggle).toBeVisible()

  // 先确认开着的时候确实画了基线（example.vault 里 task-pay-01 有 baseline）
  if (!(await toggle.isChecked())) await toggle.check()
  expect(await page.locator('[data-gantt-baseline]').count()).toBeGreaterThan(0)

  await toggle.uncheck()
  expect(await page.locator('[data-gantt-baseline]').count()).toBe(0)
})

test('缩放按钮改变缩放标签，重置后回到基准', async ({ page }) => {
  await openGantt(page)

  const label = page.getByTestId('gantt-zoom-label')
  const initial = await label.textContent()

  await page.getByTestId('gantt-zoom-in').click()
  await expect(label).not.toHaveText(initial ?? '')

  await page.getByTestId('gantt-zoom-out').click()
  await expect(label).toHaveText(initial ?? '')
})

test('未排期任务不画条（进折叠面板而非画布）', async ({ page }) => {
  await openGantt(page)

  // example.vault 的 task-report-14 / 15 没有日期，不该出现在画布的 row 里
  expect(await page.locator('[data-gantt-row="task-report-14"]').count()).toBe(0)
  expect(await page.locator('[data-gantt-row="task-report-15"]').count()).toBe(0)
})
