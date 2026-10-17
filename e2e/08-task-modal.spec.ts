/**
 * T36 · 任务详情弹窗（真实 Chromium over file://）
 *
 * 组件测试能钉住结构与事件，但 jsdom 不做布局——「居中」「遮罩真的盖住视口」
 * 「面板没有贴右边」这三条恰恰是本次改动的全部意义，只能在真浏览器里量一次。
 * 另外两条也只有真浏览器能证明：跨元素点击的落点（浏览器把 click 派发到共同祖先）、
 * 以及点击可聚焦元素后 document.activeElement 的真实走向。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { connectWorkspace, openAppWith } from './fixtures/app'
import { loadExampleVaultFs } from './fixtures/exampleVault'

const CARD = 'task-card-task-pay-01'

async function openTaskDialog(page: Page): Promise<void> {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId(CARD).click()
  await expect(page.getByTestId('task-drawer')).toBeVisible()
}

/** 当前焦点元素身上的 data-testid（没有则返回 null）。 */
function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)
}

test('弹窗几何：遮罩铺满视口，面板水平居中且不贴右（不再是侧栏）', async ({ page }) => {
  const viewport = page.viewportSize()
  if (viewport === null) throw new Error('viewport 未设置')
  await openTaskDialog(page)

  const overlay = await page.getByTestId('task-modal').boundingBox()
  const panel = await page.getByTestId('task-drawer').boundingBox()
  if (overlay === null || panel === null) throw new Error('拿不到弹层几何')

  // 遮罩 = 整个视口
  expect(overlay.x).toBe(0)
  expect(overlay.y).toBe(0)
  expect(overlay.width).toBe(viewport.width)
  expect(overlay.height).toBe(viewport.height)

  // 面板居中：左右留白相等（容 2px 亚像素）
  const leftGap = panel.x
  const rightGap = viewport.width - (panel.x + panel.width)
  expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2)
  // 不再是贴右的窄栏：左右都留出了遮罩的 24px 内边距
  expect(leftGap).toBeGreaterThanOrEqual(20)
  expect(panel.width).toBeLessThanOrEqual(762)
  expect(panel.height).toBeLessThanOrEqual(viewport.height)
})

test('dialog 语义与焦点：role/aria-modal 齐备，打开后焦点在面板内', async ({ page }) => {
  await openTaskDialog(page)
  const panel = page.getByTestId('task-drawer')
  await expect(panel).toHaveAttribute('role', 'dialog')
  await expect(panel).toHaveAttribute('aria-modal', 'true')
  await expect(panel).toHaveAttribute('aria-label', '任务详情')

  expect(await activeTestId(page)).toBe('task-drawer')
})

test('三条出路：Esc / 点遮罩空白 / 关闭按钮都能收起，且焦点还给卡片', async ({ page }) => {
  await openTaskDialog(page)
  // 点面板内部（面板自身的内边距区）不关——先确认这一条，否则下面的「点遮罩」可能只是碰巧过了
  await page.getByTestId('task-drawer').click({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('task-drawer')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('task-drawer')).toHaveCount(0)
  // 焦点还给打开它的那张卡片（键盘用户不会掉到 body）
  expect(await activeTestId(page)).toBe(CARD)

  await page.getByTestId(CARD).click()
  await expect(page.getByTestId('task-drawer')).toBeVisible()
  // 遮罩左上角 4,4 —— 面板是居中的 760 宽，这个点必定落在面板外
  await page.getByTestId('task-modal').click({ position: { x: 4, y: 4 } })
  await expect(page.getByTestId('task-drawer')).toHaveCount(0)

  await page.getByTestId(CARD).click()
  await page.getByTestId('drawer-close').click()
  await expect(page.getByTestId('task-drawer')).toHaveCount(0)
})

test('遮罩真的盖住背景：弹窗开着时卡片位置上的最上层元素属于遮罩', async ({ page }) => {
  await openTaskDialog(page)
  const card = await page.getByTestId(CARD).boundingBox()
  if (card === null) throw new Error('拿不到卡片几何')

  // 命中测试（不是「可见性」——被盖住的元素照样算 visible，只有 elementFromPoint 能证明遮挡）
  const coveredByModal = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="task-modal"]') !== null,
    { x: card.x + card.width / 2, y: card.y + card.height / 2 },
  )
  expect(coveredByModal).toBe(true)
})
