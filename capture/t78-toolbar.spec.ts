/**
 * T78 · 白板工具栏重排的成品图与几何探针（真 Chromium）。
 *
 * 用户的原话是「这个布局很差劲」——截图里工具栏挤成一行、右端「适应画布」被切掉半个。
 * 这类问题单测抓不到，只能量：每一行 scrollWidth 是否超过 clientWidth、右端按钮的
 * 右边缘是否越出视口。产出 docs/t78-toolbar-*.png。
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

mkdirSync('docs', { recursive: true })

test.use({ deviceScaleFactor: 2 })

interface RowProbe {
  row: string
  scrollWidth: number
  clientWidth: number
  overflow: number
  lastRight: number
  viewportWidth: number
  height: number
}

async function probeRows(page: import('@playwright/test').Page): Promise<RowProbe[]> {
  return page.evaluate(() => {
    // T81 起「选中态」单独成行；它只在有选中时存在，量不到就跳过而不是报 -1
    const rows = ['whiteboard-toolbar-doc', 'whiteboard-toolbar-tools', 'whiteboard-toolbar-selection']
    const probes: (RowProbe | null)[] = rows.map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
      if (el === null) return null
      // 行内最后一个可见控件的右边缘：越出视口就是「被切掉」
      const kids = [...el.querySelectorAll('button, select, input')] as HTMLElement[]
      const visible = kids.filter((node) => node.getBoundingClientRect().width > 0)
      const last = visible[visible.length - 1]
      return {
        row: id,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflow: el.scrollWidth - el.clientWidth,
        lastRight: last === undefined ? -1 : Math.round(last.getBoundingClientRect().right),
        viewportWidth: innerWidth,
        height: Math.round(el.getBoundingClientRect().height),
      }
    })
    return probes.filter((probe): probe is RowProbe => probe !== null)
  })
}

for (const width of [1080, 1280, 2560] as const) {
  test(`工具栏各行在 ${width} 宽下不溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await openAppWith(page, loadExampleVaultFs())
    await connectWorkspace(page, { create: false })
    await page.getByTestId('view-whiteboard').click()
    await page.getByTestId('whiteboard-create').click()
    await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })

    // 一张便签：进入板子时 fit 不该把 120×60 放到 300%
    await page.getByTestId('whiteboard-add-rect').click()
    await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(1)
    await waitSaved(page)

    const zoom = await page.getByTestId('whiteboard-zoom').innerText()
    expect(zoom).toBe('100%')

    // 空选：两行都必须装得下
    const idle = await probeRows(page)
    for (const row of idle) {
      expect(row.overflow, `${row.row} 在 ${width} 宽下溢出 ${row.overflow}px`).toBeLessThanOrEqual(0)
    }
    await page.screenshot({ path: `docs/t78-toolbar-${width}.png` })

    // 多选三个框：对齐图标 + 色块都出来，这是最挤的一种状态
    await page.getByTestId('whiteboard-add-round').click()
    await page.getByTestId('whiteboard-add-ellipse').click()
    await page.locator('[data-whiteboard-shape="rect"]').first().click()
    await page.keyboard.press('Control+a')
    await expect(page.getByTestId('whiteboard-align-left')).toBeVisible()

    const busy = await probeRows(page)
    for (const row of busy) {
      expect(row.overflow, `${row.row} 多选时在 ${width} 宽下溢出 ${row.overflow}px`).toBeLessThanOrEqual(0)
      expect(row.lastRight, `${row.row} 最右控件被切`).toBeLessThanOrEqual(row.viewportWidth)
    }
    if (width === 1080) await page.screenshot({ path: 'docs/t78-toolbar-multi.png' })

    // 字重 / 字号只在选中文本类图元时出现，也验一遍
    await page.getByTestId('whiteboard-add-text').click()
    await expect(page.getByTestId('whiteboard-bold')).toBeVisible()
    const textRow = await probeRows(page)
    for (const row of textRow) {
      expect(row.overflow, `${row.row} 选中文本时在 ${width} 宽下溢出 ${row.overflow}px`).toBeLessThanOrEqual(0)
    }
    if (width === 1080) await page.screenshot({ path: 'docs/t78-toolbar-text.png' })
  })
}

/** 与用户那张截图同尺寸（1080×534）、同场景：新建白板 → 加一个文本图元且选中。 */
test('1080×534 与用户截图同场景', async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 534 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('whiteboard-add-rect').click()
  await page.keyboard.press('Escape')
  await page.locator('[data-whiteboard-shape="rect"]').first().click()
  await waitSaved(page)
  await page.screenshot({ path: 'docs/t78-whiteboard-1080x534.png' })
})
