/**
 * T75 · 字号的成品图（真 Chromium）。
 *
 * 单测能证明「节点上有 fontSize、导出里有同一个数字」，但证明不了**看起来对不对**：
 * 32 号的字在 168 宽里断成几行、行高有没有把字挤出选中环、A−/档位/A+ 这组控件在工具栏上
 * 是不是和邻居一样高、便签调到 28 号会不会顶到便签边缘。这类事只能截图人工看。
 *
 * 产出：
 *  - docs/t75-whiteboard-font.png  一张有字号层次的板（大标题 / 小标题 / 正文 / 28 号便签）
 *  - docs/t75-font-toolbar.png     选中大标题后的工具栏（字号控件与色板并列）
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import type { FakeFsState } from '../e2e/fixtures/fakeFs'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

mkdirSync('docs', { recursive: true })

test.use({ deviceScaleFactor: 2 })

const NOW = '2026-10-31T04:00:00.000Z'

/** 把一块白板塞进样例库（白板在夹具里被清空过，直接用 UI 建会慢且位置不可控）。 */
function withBoard(state: FakeFsState, board: unknown): FakeFsState {
  const vault = JSON.parse(Buffer.from(state.files['vault.json'] as string, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >
  vault.whiteboards = [board]
  return {
    ...state,
    files: { ...state.files, 'vault.json': Buffer.from(JSON.stringify(vault), 'utf8').toString('base64') },
  }
}

function node(shape: string, id: string, x: number, y: number, width: number, height: number, text: string, extra = {}) {
  return { id, shape, x, y, width, height, text, tone: 'plain', ...extra }
}

const BOARD = {
  id: 'wb1',
  name: '字号',
  order: 'U',
  createdAt: NOW,
  updatedAt: NOW,
  edges: [
    { id: 'e1', from: 'n2', to: 'n3', fromAnchor: 'auto', toAnchor: 'auto', route: 'ortho', arrow: 'end', dashed: false, label: '' },
  ],
  nodes: [
    // 大标题：32 号。168 宽装不下，撑到 420 宽看它是不是稳稳一行
    node('text', 'n1', 0, -20, 420, 56, '订单服务拆分的三个前提', { fontSize: 32 }),
    // 小标题：20 号
    node('text', 'n2', 0, 72, 300, 36, '一、先对齐数据模型', { fontSize: 20 }),
    // 正文：默认 13 号（节点上没有 fontSize 键）
    node('rect', 'n3', 0, 132, 360, 80, '把「谁在什么时候改了什么」记下来，比讨论出什么更要紧。'),
    // 便签：28 号，看字会不会顶到便签边缘
    node('note', 'n4', 420, 132, 220, 140, '这里要加缓存', { fontSize: 28, tone: 'accent' }),
    // 一个 10 号的极小组：确认小字仍可读
    node('text', 'n5', 0, 240, 360, 32, '备注：灰度期间双写，回滚只删读路径', { fontSize: 10 }),
  ],
}

test('白板字号', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openAppWith(page, withBoard(loadExampleVaultFs(), BOARD))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })

  // 让画布把内容摆到视口中间（打开时已经自动 fit，这里点一次更稳）
  await page.getByTestId('whiteboard-fit').click()
  await page.keyboard.press('Escape')
  await waitSaved(page)
  await page.screenshot({ path: 'docs/t75-whiteboard-font.png' })

  // 选中大标题：工具栏应出现 A− / 档位 / A+
  const title = await page.locator('[data-whiteboard-shape="text"]').first().boundingBox()
  if (title !== null) await page.mouse.click(title.x + title.width / 2, title.y + title.height / 2)
  await expect(page.getByTestId('whiteboard-font-size')).toHaveValue('32')

  // 只截工具栏那条，省得人工在图里找
  await page.locator('[data-testid="whiteboard"]').locator('xpath=..').locator('xpath=..').screenshot({
    path: 'docs/t75-font-toolbar.png',
  })

  // 探针：每个节点的实际字号、行数（高度 / 行高）、有没有溢出容器
  const probe = await page.evaluate(() =>
    [...document.querySelectorAll('[data-whiteboard-shape]')].map((host) => {
      const element = host as HTMLElement
      const rect = element.getBoundingClientRect()
      const label = element.querySelector('[data-testid^="whiteboard-label-"]')
      const row = label === null ? null : label.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        id: element.dataset.testid,
        fontSize: style.fontSize,
        height: Math.round(rect.height),
        labelHeight: row === null ? null : Math.round(row.height),
        overflow: row === null ? null : Math.round(row.height - rect.height),
      }
    }),
  )
  console.log('[t75-probe]', JSON.stringify(probe))
})
