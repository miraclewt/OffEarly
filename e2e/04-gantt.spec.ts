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
  // T52：切换刻度保持「左边缘是哪一天」不变（日→周列宽差 7 倍，沿用像素偏移会跳到半个月外），
  // 所以首列仍是同一天，只是同一块画布装得下更多天。
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

test('任务名画在条上，文字与左侧任务表同源', async ({ page }) => {
  await openGantt(page)

  expect(await page.locator('[data-gantt-label]').count()).toBeGreaterThan(0)

  // 条内标签逐条比对：去掉省略号后的文本必须是左表同一行文字的开头
  // （两边的文本都来自 GanttRow.label，标签只是按估宽截断）
  const inside = page.locator('[data-gantt-label][data-placement="inside"]')
  const count = Math.min(await inside.count(), 5)
  expect(count).toBeGreaterThan(0)
  for (let index = 0; index < count; index += 1) {
    const label = inside.nth(index)
    const id = await label.getAttribute('data-gantt-label')
    const text = ((await label.textContent()) ?? '').replace(/…$/, '')
    const rowText = (await page.locator(`[data-gantt-table-row="${id}"]`).textContent()) ?? ''
    expect(text.length).toBeGreaterThan(0)
    expect(rowText.startsWith(text)).toBe(true)
  }

  // 标签不吃事件：条体的 hover 命中不能被它挡住
  expect(await inside.first().evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none')
})

test('左侧任务表可折叠，收起后画布真的变宽', async ({ page }) => {
  await openGantt(page)

  const toggle = page.getByTestId('gantt-table-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('gantt-table')).toBeVisible()

  // 注意量的必须是**滚动视口**而不是 svg 本身：svg 宽度等于内容宽（model.width × zoom），
  // 内容比视口宽时它不随容器变宽，只有外层滚动容器会。
  const before = await page.getByTestId('gantt-canvas-scroll').boundingBox()
  expect(before).not.toBeNull()
  const columnsBefore = await page.locator('[data-gantt-col]').count()

  await toggle.click()
  await expect(page.getByTestId('gantt-table')).toHaveCount(0)
  await expect(page.getByTestId('gantt-table-rail')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  const after = await page.getByTestId('gantt-canvas-scroll').boundingBox()
  expect(after).not.toBeNull()
  // 让出的宽度 = 任务表宽 − 竖轨宽
  expect(after!.width - before!.width).toBeGreaterThanOrEqual(280)

  // 视口变宽 → 列窗口确实多装了列（虚拟化的列数由视口宽决定）
  const columnsAfter = await page.locator('[data-gantt-col]').count()
  expect(columnsAfter).toBeGreaterThanOrEqual(columnsBefore)

  await toggle.click()
  await expect(page.getByTestId('gantt-table')).toBeVisible()
  await expect(page.getByTestId('gantt-table-rail')).toHaveCount(0)
})

test('未排期面板：有未排期任务时默认展开，点一下收成竖轨', async ({ page }) => {
  await openGantt(page)

  const panel = page.getByTestId('gantt-unscheduled-panel')
  // example.vault 里确实有未排期任务（上面那条用例刚验过），所以默认必须是展开的
  await expect(panel).toHaveAttribute('data-open', 'true')

  await page.getByTestId('gantt-unscheduled-toggle').click()
  await expect(panel).toHaveAttribute('data-open', 'false')
})
