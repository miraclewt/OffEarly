/**
 * T69 · 白板的真实链路（真 Chromium + file:// 上的单文件产物）。
 *
 * 三条承诺，每条都对着磁盘上的 vault.json 断言，因为「白板能用」的本质是
 * **用户摆的坐标真的存下来了**，而不是画在屏幕上：
 *  1. 新建白板 + 贴模板：一次动作落成 11 个图元 + 6 条连线，重开之后原样还在；
 *  2. 拖动改的是坐标、撤销把坐标放回去（撤销栈覆盖画布，才算真能放心乱拖）；
 *  3. 删框连带它的线一起消失，且导出能拿到文件。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith, waitSaved } from './fixtures/app'
import { fromBase64, readFakeFs, seedFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'
import type { FakeFsState } from './fixtures/fakeFs'

interface StoredNode {
  id: string
  shape: string
  x: number
  y: number
  width: number
  height: number
}

interface StoredWhiteboard {
  id: string
  name: string
  nodes: StoredNode[]
  edges: { id: string; from: string; to: string }[]
}

interface StoredVault {
  whiteboards?: StoredWhiteboard[]
}

function parseVault(fs: FakeFsState): StoredVault {
  return JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
}

async function openWhiteboard(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('view-whiteboard').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible()
}

test('新建白板 → 贴架构模板 → 重开原样还在', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()

  // 示例库没有白板：先给空态，再建一张
  await expect(page.getByTestId('whiteboard-empty')).toBeVisible()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-templates').selectOption('architecture')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(11)

  await waitSaved(page)
  await expect
    .poll(async () => (parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes.length ?? 0), { timeout: 15_000 })
    .toBe(11)
  const saved = parseVault(await readFakeFs(page)).whiteboards?.[0]
  expect(saved?.edges).toHaveLength(6)
  // 连线两端都真实存在（没有悬空边）
  const ids = new Set((saved?.nodes ?? []).map((node) => node.id))
  for (const edge of saved?.edges ?? []) {
    expect(ids.has(edge.from)).toBe(true)
    expect(ids.has(edge.to)).toBe(true)
  }

  // 重开：图元与坐标都从磁盘恢复。fake fs 活在页面里的 window 上，reload 会丢，
  // 所以先把磁盘快照读出来再种回去（13-trash-present 同一手法）。
  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await connectWorkspace(page, { create: false })
  await openWhiteboard(page)
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(11)
})

test('拖动改坐标，撤销放回原位', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)
  await page.getByTestId('whiteboard-templates').selectOption('flow')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(6)
  await waitSaved(page)

  const before = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes ?? []
  const target = before.find((node) => node.shape === 'rect')!
  const handle = page.getByTestId(`whiteboard-node-${target.id}`)
  const box = await handle.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 + 96, box!.y + box!.height / 2 + 64, { steps: 10 })
  await page.mouse.up()

  await expect
    .poll(
      async () => {
        const nodes = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes ?? []
        return nodes.find((node) => node.id === target.id)?.x ?? -1
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(target.x)

  const moved = (parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes ?? []).find(
    (node) => node.id === target.id,
  )!
  // 8px 网格吸附：**位移**是 8 的倍数（模板内的相对坐标另算，不参与对齐）
  expect((moved.x - target.x) % 8).toBe(0)

  await page.getByTestId('undo-button').click()
  await expect
    .poll(
      async () => {
        const nodes = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes ?? []
        return nodes.find((node) => node.id === target.id)?.x ?? -1
      },
      { timeout: 15_000 },
    )
    .toBe(target.x)
})

test('删框连带它的线 → 导出拿到文件', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)
  await page.getByTestId('whiteboard-templates').selectOption('architecture')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(11)
  await waitSaved(page)

  const before = parseVault(await readFakeFs(page)).whiteboards?.[0]!
  // 挑一个有线的服务框（模板里「任务服务」）
  const victim = before.nodes.find((node) => node.shape === 'rect')!
  const wired = before.edges.filter((edge) => edge.from === victim.id || edge.to === victim.id)
  expect(wired.length).toBeGreaterThan(0)

  await page.getByTestId(`whiteboard-node-${victim.id}`).click()
  await page.keyboard.press('Delete')

  await expect
    .poll(async () => (parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes.length ?? 0), { timeout: 15_000 })
    .toBe(10)
  const after = parseVault(await readFakeFs(page)).whiteboards?.[0]!
  expect(after.edges.some((edge) => edge.from === victim.id || edge.to === victim.id)).toBe(false)

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('whiteboard-export-svg').click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.svg$/)
})

/**
 * 视口几何 + 滚轮。这两件事都是**布局态**的：jsdom 里量不出来（全 0），单测也看不出，
 * 但错起来非常扎眼——模板贴着左边、滚轮推不动画布。
 *
 * 曾经的真 bug：空态时 surface 不在 DOM 上（surfaceRef 为 null），量尺寸与挂滚轮的两个
 * effect 在挂载那一次全部早退，而依赖里没有「surface 出现了」→ 之后再也不跑。
 * 于是视口宽度恒为默认 960，模板贴出来偏左；滚轮监听压根没挂上。
 */
test('模板落在视口正中，滚轮能推动画布', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)
  await page.getByTestId('whiteboard-templates').selectOption('architecture')
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(11)

  const layout = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="whiteboard-surface"]') as HTMLElement
    const frame = document.querySelector('[data-testid^="whiteboard-node-"]') as HTMLElement
    const world = document.querySelector('[data-testid="whiteboard-world"]') as HTMLElement
    const s = surface.getBoundingClientRect()
    const f = frame.getBoundingClientRect()
    return {
      surfaceWidth: Math.round(s.width),
      leftGap: Math.round(f.x - s.x),
      rightGap: Math.round(s.right - f.right),
      transform: world.style.transform,
    }
  })
  expect(layout.surfaceWidth).toBeGreaterThan(1200)
  // 两侧留白差 ≤ 一个网格（8px 吸附）+ 取整误差
  expect(Math.abs(layout.leftGap - layout.rightGap)).toBeLessThan(32)
  expect(layout.transform).toBe('translate(0px, 0px) scale(1)')

  await page.mouse.move(800, 600)
  await page.mouse.wheel(0, 160)
  await expect
    .poll(async () => page.evaluate(() => (document.querySelector('[data-testid="whiteboard-world"]') as HTMLElement).style.transform))
    .not.toBe('translate(0px, 0px) scale(1)')
})
