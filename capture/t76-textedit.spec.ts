/**
 * T76 · 文本编辑的成品图（真 Chromium）。
 *
 * 单测钉得住「有没有描边、占位在不在」，钉不住「看起来是不是一个能写字的框」：
 * 描边 2px 在缩放的画布上会不会细得看不见、占位文字会不会淡到看不出、空文本图元
 * 到底占多大一块地方。这些只能出图人工核对。
 *
 * 产出：
 *  - docs/t76-text-edit.png    点「文本」之后立刻出现的输入框（空文本 + accent 描边）
 *  - docs/t76-text-placeholder.png  空文本图元在非编辑态的占位（画布上唯一的可见形态）
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import type { FakeFsState } from '../e2e/fixtures/fakeFs'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

mkdirSync('docs', { recursive: true })

test.use({ deviceScaleFactor: 2 })

const NOW = '2026-10-31T04:00:00.000Z'

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

const BOARD = {
  id: 'wb1',
  name: '文本编辑',
  order: 'U',
  createdAt: NOW,
  updatedAt: NOW,
  edges: [],
  nodes: [
    { id: 'n1', shape: 'text', x: 0, y: 0, width: 420, height: 56, text: '订单服务拆分的三个前提', tone: 'plain', fontSize: 32 },
    { id: 'n2', shape: 'rect', x: 0, y: 96, width: 360, height: 96, text: '把「谁在什么时候改了什么」记下来，比讨论出什么更要紧。', tone: 'plain' },
    { id: 'n3', shape: 'note', x: 420, y: 96, width: 220, height: 140, text: '这里要加缓存', tone: 'accent' },
    // 空文本图元：T76 之前它在画布上是**完全看不见**的
    { id: 'n4', shape: 'text', x: 0, y: 232, width: 260, height: 32, text: '', tone: 'plain' },
  ],
}

test('空文本图元的占位', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 })
  await openAppWith(page, withBoard(loadExampleVaultFs(), BOARD))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('whiteboard-fit').click()
  await page.keyboard.press('Escape')
  await waitSaved(page)

  // 选中空文本图元：占位 + 选中环同时在，看它是否像「可以点进去写字的地方」
  await page.locator('[data-whiteboard-shape="text"]').last().click()
  await page.screenshot({ path: 'docs/t76-text-placeholder.png' })

  const probe = await page.evaluate(() => {
    const host = [...document.querySelectorAll('[data-whiteboard-shape="text"]')].pop() as HTMLElement | undefined
    if (host === undefined) return null
    const placeholder = host.querySelector('[data-testid^="whiteboard-placeholder-"]')
    const rect = host.getBoundingClientRect()
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      fontSize: getComputedStyle(host).fontSize,
      placeholder: placeholder?.textContent ?? null,
      placeholderColor: placeholder === null ? null : getComputedStyle(placeholder).color,
    }
  })
  console.log('[t76-placeholder-probe]', JSON.stringify(probe))
})

test('点「文本」之后立刻能写字', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 })
  await openAppWith(page, withBoard(loadExampleVaultFs(), BOARD))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('whiteboard-fit').click()
  await page.keyboard.press('Escape')

  await page.getByTestId('whiteboard-add-text').click()
  const input = page.getByTestId('whiteboard-text-input')
  await expect(input).toBeVisible()
  // 空输入框先截一张：这时屏幕上除了描边什么都没有，正是用户抱怨「没有输入框」的现场
  await page.screenshot({ path: 'docs/t76-text-edit.png' })
  // 再单独放大那个框（元素级截图），用来看圆角与描边粗细
  await page.locator('[data-whiteboard-selected="true"]').screenshot({ path: 'docs/tmp-t76-node.png' })

  await input.fill('这里补一句：先对齐数据模型')
  await page.keyboard.press('Control+Enter')
  await waitSaved(page)

  const probe = await page.evaluate(() => {
    const area = document.querySelector('[data-testid="whiteboard-text-input"]')
    void area
    const selected = document.querySelector('[data-whiteboard-selected="true"]') as HTMLElement | null
    if (selected === null) return null
    const rect = selected.getBoundingClientRect()
    const style = getComputedStyle(selected)
    return {
      shape: selected.dataset.whiteboardShape,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text: selected.textContent ?? '',
      radius: style.borderRadius,
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      zoom: (document.querySelector('[data-testid="whiteboard-world"]') as HTMLElement | null)?.dataset.zoom ?? null,
    }
  })
  console.log('[t76-created-probe]', JSON.stringify(probe))
})
