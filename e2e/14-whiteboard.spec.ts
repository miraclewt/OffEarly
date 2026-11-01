/**
 * T69 · 白板的真实链路（真 Chromium + file:// 上的单文件产物）。
 *
 * 三条承诺，每条都对着磁盘上的 vault.json 断言，因为「白板能用」的本质是
 * **用户摆的坐标真的存下来了**，而不是画在屏幕上：
 *  1. 新建白板 + 贴模板：一次动作落成 11 个图元 + 6 条连线，重开之后原样还在；
 *  2. 拖动改的是坐标、撤销把坐标放回去（撤销栈覆盖画布，才算真能放心乱拖）；
 *  3. 删框连带它的线一起消失，且导出能拿到文件。
 */
import { readFileSync } from 'node:fs'

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
  /** 图元正文（T76 起用来断言「打进去的字真的落盘了」） */
  text?: string
  /** 自定义色（T70），缺省表示用语义色 */
  fill?: string
  /** T74：图片图元的附件引用 */
  image?: string
  /** T75：字号。缺省表示用形状默认（便签 14、其余 13） */
  fontSize?: number
  /** T77：字效（缺省即不生效，键不出现） */
  bold?: boolean
  italic?: boolean
  /** T77：图片贴合方式，缺省 = contain */
  imageFit?: 'contain' | 'cover'
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

/**
 * 自定义色块（T70）。钉三件事：
 *  1. 用户挑的颜色**落盘**成 `#rrggbb`，重开还在；
 *  2. 字色是**算**出来的——深底必须换浅字（白底白字这种脏组合不能出现）；
 *  3. 自定义色一旦存在就**覆盖**语义色（不是两套配色并存）。
 */
test('自定义色块：选色落盘、字色跟着底色走、重开还在', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)
  await page.getByTestId('whiteboard-add-rect').click()
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(1)
  await waitSaved(page)

  const id = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes[0]?.id ?? ''
  expect(id).not.toBe('')

  await page.locator('[data-whiteboard-shape="rect"]').first().click()
  await page.getByTestId('whiteboard-color').click()
  await expect(page.getByTestId('whiteboard-color-panel')).toBeVisible()

  // 深底：字必须换白，否则整块字看不见
  await page.getByTestId('whiteboard-swatch-1d1d1f').click()
  await expect
    .poll(async () => parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes[0]?.fill ?? '', { timeout: 15_000 })
    .toBe('#1d1d1f')
  const dark = await page.evaluate((nodeId) => {
    const node = document.querySelector(`[data-testid="whiteboard-node-${nodeId}"]`) as HTMLElement
    const label = node.querySelector('span') as HTMLElement | null
    return {
      bg: getComputedStyle(node).backgroundColor,
      ink: label === null ? '' : getComputedStyle(label).color,
    }
  }, id)
  expect(dark.bg).toBe('rgb(29, 29, 31)')
  expect(dark.ink).toBe('rgb(255, 255, 255)')

  // 浅底：字换回近黑
  await page.getByTestId('whiteboard-swatch-fef3c7').click()
  await expect
    .poll(async () => parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes[0]?.fill ?? '', { timeout: 15_000 })
    .toBe('#fef3c7')
  const lightInk = await page.evaluate((nodeId) => {
    const node = document.querySelector(`[data-testid="whiteboard-node-${nodeId}"]`) as HTMLElement
    const label = node.querySelector('span') as HTMLElement | null
    return label === null ? '' : getComputedStyle(label).color
  }, id)
  expect(lightInk).toBe('rgb(29, 29, 31)')

  // 撤销回到上一个颜色（不是一路清空）
  await page.getByTestId('undo-button').click()
  await expect
    .poll(async () => parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes[0]?.fill ?? '', { timeout: 15_000 })
    .toBe('#1d1d1f')

  // 重开：颜色从磁盘回来
  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await connectWorkspace(page, { create: false })
  await openWhiteboard(page)
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(1)
  const reopened = await page.evaluate((nodeId) => {
    const node = document.querySelector(`[data-testid="whiteboard-node-${nodeId}"]`) as HTMLElement
    return getComputedStyle(node).backgroundColor
  }, id)
  expect(reopened).toBe('rgb(29, 29, 31)')
})

/**
 * T74 · 贴图。三条承诺：
 *  1. 截图粘贴走 `paste` 的 clipboardData，字节真的写进 `assets/`，vault 里只留引用；
 *  2. 画布上显示的是 blob URL（`file://` 下相对路径解析不到，笔记图片同一处境）；
 *  3. 导出的 SVG **内嵌**图片字节（自包含），且重开之后图还在。
 */

/** 1×1 的真实 PNG：能解码，所以 naturalWidth/Height 可量（贴图尺寸按它算）。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function assetPaths(page: import('@playwright/test').Page): Promise<string[]> {
  const fs = await readFakeFs(page)
  return Object.keys(fs.files).filter((path) => path.startsWith('assets/'))
}

test('粘贴截图：写进 assets/、画布显示、导出内嵌、重开还在', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  // 示例库自带几张图，所以基线现采一次，差值才是本用例的产物
  const baseline = await assetPaths(page)
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.evaluate((bytes: number[]) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' }))
    const target = document.querySelector('[data-testid="whiteboard"]')
    if (target === null) throw new Error('whiteboard not found')
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, [...PNG_1X1])

  await expect
    .poll(async () => (await assetPaths(page)).filter((path) => !baseline.includes(path)).length, { timeout: 15_000 })
    .toBe(1)
  const [assetPath] = (await assetPaths(page)).filter((path) => !baseline.includes(path))
  expect(assetPath ?? '').toMatch(/^assets\/[A-Za-z0-9_-]+\.png$/)

  await waitSaved(page)
  const saved = parseVault(await readFakeFs(page)).whiteboards?.[0]
  const imageNode = (saved?.nodes ?? []).find((node) => node.shape === 'image')
  expect(imageNode?.image).toBe(assetPath)
  // 尺寸按图片自然尺寸算过（1×1 会被抬到可点中的最小尺寸，绝不是 0）
  expect(imageNode?.width ?? 0).toBeGreaterThan(0)
  expect(imageNode?.height ?? 0).toBeGreaterThan(0)

  // 屏幕上必须是 blob URL：assets 相对路径在 file:// 下解析不到
  const shown = page.getByTestId(`whiteboard-image-${imageNode!.id}`)
  await expect(shown).toBeVisible()
  await expect(shown).toHaveAttribute('src', /^blob:/)

  // 导出内嵌：SVG 里是 dataURL，不是 assets/ 死链
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('whiteboard-export-svg').click(),
  ])
  const filePath = await download.path()
  const svg = readFileSync(filePath as string, 'utf8')
  expect(svg).toContain('<image')
  expect(svg).toContain('data:image/png;base64,')
  expect(svg).not.toContain(assetPath as string)

  // 重开：引用与图片都从磁盘回来
  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await connectWorkspace(page, { create: false })
  await openWhiteboard(page)
  const reopened = page.getByTestId(`whiteboard-image-${imageNode!.id}`)
  await expect(reopened).toBeVisible()
  await expect(reopened).toHaveAttribute('src', /^blob:/)
})

test('工具栏选文件贴图：与粘贴走同一条落盘路径', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  const baseline = await assetPaths(page)
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-image').click()
  await page.getByTestId('whiteboard-image-input').setInputFiles({
    name: 'diagram.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  })

  await expect
    .poll(async () => (await assetPaths(page)).filter((path) => !baseline.includes(path)).length, { timeout: 15_000 })
    .toBe(1)
  await expect(page.locator('img[data-testid^="whiteboard-image-"]')).toHaveCount(1)

  // 第三条入口：把文件拖进画布（落点跟随指针）
  const surface = await page.getByTestId('whiteboard-surface').boundingBox()
  expect(surface).not.toBeNull()
  await page.evaluate(
    ({ bytes, x, y }: { bytes: number[]; x: number; y: number }) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }))
      const target = document.querySelector('[data-testid="whiteboard-surface"]')
      if (target === null) throw new Error('surface not found')
      const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: x, clientY: y }
      target.dispatchEvent(new DragEvent('dragover', init))
      target.dispatchEvent(new DragEvent('drop', init))
    },
    { bytes: [...PNG_1X1], x: (surface?.x ?? 0) + 300, y: (surface?.y ?? 0) + 260 },
  )
  await expect(page.locator('img[data-testid^="whiteboard-image-"]')).toHaveCount(2, { timeout: 15_000 })

  // 图片节点不该被双击拉进文字编辑（它没有可编辑文字）
  await page.locator('[data-whiteboard-shape="image"]').first().dblclick()
  await expect(page.getByTestId('whiteboard-text-input')).toHaveCount(0)
})

/**
 * T75 · 字号。用户的口径是「文本无法调节大小」——所以这里测的是**真的能调**：
 *  1. 选中文本图元后工具栏出现字号控件（A− / 档位 / A+），默认 13；
 *  2. A+ 在档位表上走一格（13 → 14，不是 13 → 13.5 或 13 → 18）；
 *  3. 下拉直接选 32，文本图元的高度**跟着长**（它没有框，高度就是文字外廓）；
 *  4. 落盘的只有 fontSize 一个数字，导出 SVG 用的是同一个字号。
 */
test('调字号：档位步进、高度自适应、落盘与导出一致', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-add-text').click()
  const textNode = page.locator('[data-whiteboard-shape="text"]').first()
  await expect(textNode).toBeVisible()
  await textNode.click()

  // 默认字号 13（节点上还没有 fontSize 键，渲染时回到形状默认）
  const fontSelect = page.getByTestId('whiteboard-font-size')
  await expect(fontSelect).toBeVisible()
  await expect(fontSelect).toHaveValue('13')

  // A+ 走一格档位
  await page.getByTestId('whiteboard-font-up').click()
  await expect(fontSelect).toHaveValue('14')
  await page.getByTestId('whiteboard-font-down').click()
  await expect(fontSelect).toHaveValue('13')

  // 输入一段会长出第二行的文字：提交后高度必须跟着长（不再是新建时的 32）
  await textNode.dblclick()
  const input = page.getByTestId('whiteboard-text-input')
  await expect(input).toBeVisible()
  await input.fill('把「谁在什么时候改了什么」记下来')
  await page.keyboard.press('Control+Enter')
  await expect(input).toHaveCount(0)

  await waitSaved(page)
  const afterText = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(afterText?.height ?? 0).toBeGreaterThan(32)
  // 没调字号之前：节点上不该出现这个键
  expect(afterText?.fontSize).toBeUndefined()

  // 直接输 32（T77 起字号框可以敲数字，不必只从档位里挑）：字变大 → 行数更多 → 框更高
  await textNode.click()
  await fontSelect.fill('32')
  await fontSelect.press('Enter')
  await expect(fontSelect).toHaveValue('32')

  await waitSaved(page)
  const saved = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(saved?.fontSize).toBe(32)
  expect(saved?.height ?? 0).toBeGreaterThan(afterText?.height ?? 0)

  // 屏幕上真的是 32px（不是只把数字存起来）
  await expect(textNode).toHaveCSS('font-size', '32px')

  // 导出用同一个字号
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('whiteboard-export-svg').click(),
  ])
  const svg = readFileSync((await download.path()) as string, 'utf8')
  expect(svg).toContain('font-size="32"')
})

test('图片节点没有字号控件（它的「文字」只是文件名）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-image').click()
  await page.getByTestId('whiteboard-image-input').setInputFiles({
    name: 'diagram.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  })
  const imageNode = page.locator('img[data-testid^="whiteboard-image-"]').first()
  await expect(imageNode).toBeVisible()
  await page.locator('[data-whiteboard-shape="image"]').first().click()
  await expect(page.getByTestId('whiteboard-font-size')).toHaveCount(0)
})

/**
 * T76 · 文本编辑。用户口径是「点击文本的时候，没有出现文本输入框」，根因是三处叠加：
 *  ① 新建的文本图元既不选中也不进编辑态，而空的文本图元在画布上**完全不可见**
 *     （无边框、无底色、无文字）——点「文本」按钮像是没反应；
 *  ② 文本图元只有双击才能编辑，而它没有边框，单击选中几乎看不出变化；
 *  ③ 单击进入编辑时，浏览器在 mousedown 的默认处理里把焦点从刚挂载的 textarea
 *     抢回画布，`onBlur` 立刻提交并卸载它（实测生命周期 3ms），屏幕上什么都不留。
 * 前两条是入口缺失，第三条是真实 bug——所以这里连「焦点」一起断言。
 */
test('新建文本：直接出现输入框、能打字、落盘后仍选中', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-add-text').click()
  const input = page.getByTestId('whiteboard-text-input')
  await expect(input).toBeVisible()
  // 焦点必须真的落在 textarea 上：编辑器存在但焦点在画布上，打字是打不出来的
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe(
    'whiteboard-text-input',
  )

  // 故意超过一行：只有折行之后高度才必须重算（单行时 32 高本来也装得下）
  await input.fill('订单服务拆分的三个前提：先对齐数据模型，再拆接口')
  await page.keyboard.press('Control+Enter')
  await expect(input).toHaveCount(0)

  await waitSaved(page)
  const created = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(created?.text).toBe('订单服务拆分的三个前提：先对齐数据模型，再拆接口')
  // 文本图元没有框，高度就是文字外廓：打完字要长高，否则第二行掉到框外
  expect(created?.height ?? 0).toBeGreaterThan(32)
  // 新建后就选中：用户下一步通常是拖位置 / 调字号
  await expect(page.locator('[data-whiteboard-shape="text"]').first()).toHaveAttribute('data-whiteboard-selected', 'true')
})

test('再点一下已选中的文本就能编辑（不必知道要双击）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-add-text').click()
  await page.getByTestId('whiteboard-text-input').fill('订单服务')
  await page.keyboard.press('Control+Enter')

  // 点空白处取消选中，再走用户的真实动作：第一下选中、第二下进编辑
  const surface = await page.getByTestId('whiteboard-surface').boundingBox()
  await page.mouse.click((surface?.x ?? 0) + 60, (surface?.y ?? 0) + 60)
  const textNode = page.locator('[data-whiteboard-shape="text"]').first()
  await expect(textNode).not.toHaveAttribute('data-whiteboard-selected', 'true')

  await textNode.click()
  await expect(page.getByTestId('whiteboard-text-input')).toHaveCount(0)
  await textNode.click()
  const input = page.getByTestId('whiteboard-text-input')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('订单服务')
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe(
    'whiteboard-text-input',
  )

  // 编辑态必须是「看得见的输入框」：实描边 + 实底（透明 textarea 等于没有输入框）
  const outline = await textNode.evaluate((host) => {
    const style = getComputedStyle(host)
    return { style: style.outlineStyle, width: style.outlineWidth, background: style.backgroundColor }
  })
  expect(outline.style).toBe('solid')
  expect(outline.width).toBe('2px')
  expect(outline.background).not.toBe('rgba(0, 0, 0, 0)')

  await input.fill('订单服务（改）')
  await page.keyboard.press('Control+Enter')
  await waitSaved(page)
  expect(parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]?.text).toBe('订单服务（改）')
})

test('空文本图元有占位提示（否则它在画布上是一片真正的空白）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-add-text').click()
  await expect(page.getByTestId('whiteboard-text-input')).toBeVisible()
  // Esc = 取消这次编辑，节点留下来但仍是空文本
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('whiteboard-text-input')).toHaveCount(0)

  const placeholder = page.locator('[data-testid^="whiteboard-placeholder-"]')
  await expect(placeholder).toHaveCount(1)
  await expect(placeholder).toHaveText('输入文字…')
  // 有尺寸才点得中：占位是它唯一的可见形态，不能塌成 0 高
  const box = await page.locator('[data-whiteboard-shape="text"]').first().boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(16)
})

test('连点两次「文本」不会叠成一张（否则看起来只加了一个）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-add-text').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('whiteboard-add-text').click()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-whiteboard-shape="text"]')).toHaveCount(2)

  const boxes = await page.locator('[data-whiteboard-shape="text"]').evaluateAll((hosts) =>
    hosts.map((host) => {
      const rect = host.getBoundingClientRect()
      return { x: Math.round(rect.x), y: Math.round(rect.y) }
    }),
  )
  // 两个都不在同一个落点：完全重叠时第二个的占位/输入框盖住第一个
  expect(boxes[0]).not.toEqual(boxes[1])
})

/**
 * T77 · 字效（加粗 / 斜体）。用户的用法是「选中一段文字 → 点 B」，
 * 所以要钉三件事：屏幕上真的更粗、落盘的只有一个 bold 键、再点一次键**消失**（不是 false）。
 */
test('加粗与斜体：屏幕生效、落盘成布尔、再点一次删键', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-add-text').click()
  await page.getByTestId('whiteboard-text-input').fill('订单服务')
  await page.keyboard.press('Control+Enter')

  const textNode = page.locator('[data-whiteboard-shape="text"]').first()
  await textNode.click()
  await page.getByTestId('whiteboard-bold').click()
  await page.getByTestId('whiteboard-italic').click()

  await expect(textNode).toHaveCSS('font-weight', '700')
  await expect(textNode).toHaveCSS('font-style', 'italic')
  await expect(page.getByTestId('whiteboard-bold')).toHaveAttribute('aria-pressed', 'true')

  await waitSaved(page)
  const bolded = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(bolded?.bold).toBe(true)
  expect(bolded?.italic).toBe(true)

  // 再点一次 B：取消加粗。键要消失，不能留一个 bold: false
  await page.getByTestId('whiteboard-bold').click()
  await expect(page.getByTestId('whiteboard-bold')).toHaveAttribute('aria-pressed', 'false')
  await waitSaved(page)
  const unbolded = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(Object.prototype.hasOwnProperty.call(unbolded ?? {}, 'bold')).toBe(false)
  expect(unbolded?.italic).toBe(true)

  // 撤销能干净地退回「加粗」这一态
  await page.keyboard.press('Control+z')
  await waitSaved(page)
  expect(parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]?.bold).toBe(true)
})

/**
 * T77 · 字号可以直接输数字。档位表只有 16 格（10..80），但 schema 收 8..96——
 * 只能挑档位等于把能存的范围藏起来一半；手改过库的 17 也没法复现。
 */
test('字号可以直接输任意整数（不必只从档位里挑）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-add-text').click()
  await page.getByTestId('whiteboard-text-input').fill('订单服务')
  await page.keyboard.press('Control+Enter')

  const textNode = page.locator('[data-whiteboard-shape="text"]').first()
  await textNode.click()
  const fontInput = page.getByTestId('whiteboard-font-size')

  // 17 不在档位表里，但它是一个合法的字号
  await fontInput.fill('17')
  await fontInput.press('Enter')
  await expect(fontInput).toHaveValue('17')
  await expect(textNode).toHaveCSS('font-size', '17px')

  await waitSaved(page)
  expect(parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]?.fontSize).toBe(17)

  // 越界输入被夹住：写 200 得到 96（schema 的上限），不是写进一个打不开的库
  await fontInput.fill('200')
  await fontInput.press('Enter')
  await expect(fontInput).toHaveValue('96')
  await waitSaved(page)
  expect(parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]?.fontSize).toBe(96)

  // 胡输：不写库，框里复原成当前值
  await fontInput.fill('abc')
  await fontInput.press('Enter')
  await expect(fontInput).toHaveValue('96')
})

/**
 * T77 · 打字过程中框要跟着长。以前只在提交时重算，多打两行会看到 textarea 内部滚动、
 * 框还是那么高，用户没法判断「现在到底写了多少行」。
 */
test('文本图元在打字过程中实时长高（不用等提交）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-add-text').click()
  const input = page.getByTestId('whiteboard-text-input')
  const host = page.locator('[data-whiteboard-shape="text"]').first()

  const heightOf = async (): Promise<number> => (await host.boundingBox())?.height ?? 0
  const single = await heightOf()

  // 还没提交，只是把内容填进去（fill 触发一次 input）
  await input.fill('第一行\n第二行\n第三行\n第四行')
  await expect
    .poll(async () => heightOf(), { timeout: 3000 })
    .toBeGreaterThan(single)

  const typed = await heightOf()
  await page.keyboard.press('Control+Enter')
  await expect(input).toHaveCount(0)

  // 提交后的高度与打字过程中看到的一致（同一个 fitTextHeight，不该提交时又跳一下）
  expect(Math.abs((await heightOf()) - typed)).toBeLessThanOrEqual(1)
  await waitSaved(page)
  expect(parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]?.height ?? 0).toBeGreaterThan(single)
})

/**
 * T77 · 图片的替换与铺满。
 *  1. 换图保留位置与尺寸（用户已经摆好了，换一张不该跳）；
 *  2. 「铺满」把 object-fit 从 contain 换成 cover，落盘只写 imageFit: 'cover'；
 *  3. 再点一次回到 contain —— 键消失，不是写 contain。
 */
test('替换图片保留尺寸；铺满 / 留白可切换且不写冗余字段', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-image').click()
  await page.getByTestId('whiteboard-image-input').setInputFiles({
    name: 'first.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  })
  const imageNode = page.locator('[data-whiteboard-shape="image"]').first()
  await expect(imageNode).toBeVisible()
  await waitSaved(page)
  const before = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(before?.text).toBe('first.png')

  // 先用四角把手把它拉大一点，好确认「换图不动尺寸」
  const box = (await imageNode.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width + 60, box.y + box.height + 40, { steps: 6 })
  await page.mouse.up()
  await waitSaved(page)
  const resized = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]

  await imageNode.click()
  // 「替换」是带着目标节点的：必须先点按钮（它把目标 id 放进 ref），
  // 直接往 input 里塞文件的话 onChange 不知道要换哪一个
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('whiteboard-image-replace').click(),
  ])
  await chooser.setFiles({ name: 'second.png', mimeType: 'image/png', buffer: PNG_1X1 })
  // alt 就是 node.text：它变了才说明 patch 已经落到 vault（贴图是异步读字节的，
  // 只等「已保存」有可能等到的是上一次保存完的状态）
  await expect(page.locator('img[data-testid^="whiteboard-image-"]').first()).toHaveAttribute('alt', 'second.png')
  await waitSaved(page)
  const replaced = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(replaced?.text).toBe('second.png')
  expect(replaced?.image).not.toBe(before?.image)
  // 位置与尺寸原样保留
  expect([replaced?.x, replaced?.y, replaced?.width, replaced?.height]).toEqual([
    resized?.x,
    resized?.y,
    resized?.width,
    resized?.height,
  ])

  // 铺满
  const fit = page.getByTestId('whiteboard-image-fit')
  await expect(fit).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('img[data-testid^="whiteboard-image-"]').first()).toHaveCSS('object-fit', 'contain')
  await fit.click()
  await expect(fit).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('img[data-testid^="whiteboard-image-"]').first()).toHaveCSS('object-fit', 'cover')
  await waitSaved(page)
  expect(parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]?.imageFit).toBe('cover')

  // 再点一次回到留白：键消失（不是写 contain）
  await fit.click()
  await waitSaved(page)
  const back = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(Object.prototype.hasOwnProperty.call(back ?? {}, 'imageFit')).toBe(false)
})

/**
 * 工具栏布局（T78，T81 起三行）。用户在 1080 宽的窗口里贴了一张截图：一行塞了二十多个控件，
 * 右端「适应画布」被切掉半个。这里钉四件事：
 *  1. 工具栏是「文档行 + 工具行 + 选中行」三行，**每行都只有一行高**（不折行、不裁切）；
 *  2. 最右控件（导出的 PNG）完整落在视口内；
 *  3. 单张便签进板时 fit 只到 100%，不会怼成 300%；
 *  4. 选中行只在有选中时出现（T81：等距分布与视野居中进来之后，属性条已经挤不进工具行了）。
 */
test('工具栏各行在 1080 宽下不折行、不裁切，进板缩放只到 100%', async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 720 })
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })

  // 一张便签 → 进板 fit 的上限是 100%（120×60 的框在 818 高的画布上算出来是 300%）
  await page.getByTestId('whiteboard-add-rect').click()
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(1)
  await expect(page.getByTestId('whiteboard-zoom')).toHaveText('100%')
  await waitSaved(page)

  // 多选三个框：字重 / 字号 / 色块 / 对齐 / 分布 / 视野居中全出来，这是选中行最挤的状态
  await page.getByTestId('whiteboard-add-round').click()
  await page.getByTestId('whiteboard-add-ellipse').click()
  await page.locator('[data-whiteboard-shape="rect"]').first().click()
  await page.keyboard.press('Control+a')
  await expect(page.getByTestId('whiteboard-align-left')).toBeVisible()
  await expect(page.getByTestId('whiteboard-distribute-horizontal')).toBeVisible()
  await expect(page.getByTestId('whiteboard-center-view-horizontal')).toBeVisible()

  const layout = await page.evaluate(() => {
    const read = (id: string): { height: number; right: number } | null => {
      const row = document.querySelector(`[data-testid="${id}"]`) as HTMLElement
      if (row === null) return null
      const controls = [...row.querySelectorAll('button, select, input')] as HTMLElement[]
      const visible = controls.filter((node) => node.getBoundingClientRect().width > 0)
      const last = visible[visible.length - 1]
      return {
        height: Math.round(row.getBoundingClientRect().height),
        right: last === undefined ? -1 : Math.round(last.getBoundingClientRect().right),
      }
    }
    return { doc: read('whiteboard-toolbar-doc'), tools: read('whiteboard-toolbar-tools'), selection: read('whiteboard-toolbar-selection'), width: innerWidth }
  })

  // 每行都是 36px 上下（行高上限 44 = 还没折行）；折行会变成 60+
  expect(layout.doc).not.toBeNull()
  expect(layout.tools).not.toBeNull()
  expect(layout.selection).not.toBeNull()
  expect(layout.doc!.height).toBeLessThanOrEqual(44)
  expect(layout.tools!.height).toBeLessThanOrEqual(44)
  expect(layout.selection!.height).toBeLessThanOrEqual(44)
  // 右端不被切：最后一个控件完整落在视口内
  expect(layout.doc!.right).toBeLessThanOrEqual(layout.width)
  expect(layout.tools!.right).toBeLessThanOrEqual(layout.width)
  expect(layout.selection!.right).toBeLessThanOrEqual(layout.width)
  // 缩放在文档行、导出在右端——「适应画布」还在，且导出按钮可见
  await expect(page.getByTestId('whiteboard-fit')).toBeVisible()
  await expect(page.getByTestId('whiteboard-export-png')).toBeVisible()
})

/**
 * 编辑框必须与图元严丝合缝（T79）。用户贴图：编辑矩形时右下角多出一个浅色矩形框。
 * 两个来源各钉一条：
 *  ① `<textarea>` 默认 content-box，`width/height: 100%` 再叠内边距就溢出 20×16；
 *  ② theme.css 的 `textarea:focus` 会加一圈光晕，正好把这圈溢出勾成「多出来的框」。
 */
test('编辑框贴着图元走：不溢出、不叠第二圈焦点环', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  // 矩形（有内边距 + 有底色）是最容易露馅的形状
  await page.getByTestId('whiteboard-add-rect').click()
  await page.locator('[data-whiteboard-shape="rect"]').first().dblclick()
  const input = page.getByTestId('whiteboard-text-input')
  await expect(input).toBeVisible()
  await page.keyboard.type('5')

  const box = await page.evaluate(() => {
    const node = document.querySelector('[data-testid^="whiteboard-node-"]') as HTMLElement
    const area = document.querySelector('[data-testid="whiteboard-text-input"]') as HTMLElement
    const n = node.getBoundingClientRect()
    const a = area.getBoundingClientRect()
    const cs = getComputedStyle(area)
    return {
      overRight: Math.round(a.right - n.right),
      overBottom: Math.round(a.bottom - n.bottom),
      inLeft: Math.round(a.left - n.left),
      inTop: Math.round(a.top - n.top),
      shadow: cs.boxShadow,
      sizing: cs.boxSizing,
    }
  })

  // 编辑框落在节点的边框内侧（1px 边框），绝不越出去
  expect(box.overRight).toBeLessThanOrEqual(1)
  expect(box.overBottom).toBeLessThanOrEqual(1)
  expect(box.inLeft).toBeLessThanOrEqual(1)
  expect(box.inTop).toBeLessThanOrEqual(1)
  // 焦点环归节点自己画（编辑态描边 + 光晕），输入框不再叠一圈
  expect(box.shadow).toBe('none')
  expect(box.sizing).toBe('border-box')
})

/**
 * 文本图元必须拖得动（T80）。用户贴图：「很差体验，很难拖动文本框」。
 *
 * 根因是 T76 的「已选中的文本再点一下就进编辑」把 pointerdown 直接吃掉了：
 * 一按下就换成 textarea，而 textarea 自己又 stopPropagation，于是**这个框永远拖不动**。
 * 现在改成「按下只登记、抬起看是否移动」：拖了就是移动，没拖才是点击进编辑。
 */
test('文本图元：按住拖动就移动，轻点才进编辑', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  // 新建文本 → 打字 → Ctrl+Enter 提交（此时它仍是选中态，正好复现用户截图那一幕）
  await page.getByTestId('whiteboard-add-text').click()
  await page.getByTestId('whiteboard-text-input').fill('拖我一下')
  await page.keyboard.press('Control+Enter')
  await expect(page.getByTestId('whiteboard-text-input')).toHaveCount(0)
  await waitSaved(page)

  const before = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(before?.shape).toBe('text')

  const box = await page.locator('[data-whiteboard-shape="text"]').first().boundingBox()
  if (box === null) throw new Error('文本图元不在视口里')
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  // ① 在选中态上直接按住往右下拖 64 / 32 —— 必须变成「移动」，绝不能变成「编辑」
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 32, start.y + 16, { steps: 5 })
  await page.mouse.move(start.x + 64, start.y + 32, { steps: 5 })
  await page.mouse.up()

  // 拖动过程中不该冒出输入框（旧行为是按下即进编辑）
  await expect(page.getByTestId('whiteboard-text-input')).toHaveCount(0)
  await expect
    .poll(async () => parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]?.x ?? 0, { timeout: 15_000 })
    .toBe((before?.x ?? 0) + 64)
  const moved = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  expect(moved?.y).toBe((before?.y ?? 0) + 32)

  // ② 原地轻点（不移动）：仍然是「进编辑」，一次 Ctrl+Z 也把拖动收回去
  const after = await page.locator('[data-whiteboard-shape="text"]').first().boundingBox()
  if (after === null) throw new Error('拖完找不到了')
  await page.mouse.click(after.x + after.width / 2, after.y + after.height / 2)
  const input = page.getByTestId('whiteboard-text-input')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('拖我一下')
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe(
    'whiteboard-text-input',
  )

  // ③ 按在选中环上（框外 3px）也必须能拖动：文本图元唯一的「实体」就是那圈画在框外的环，
  //    按在环上原本会落到画布上、变成框选并清掉选中——这才是「怎么都抓不住」的另一半。
  await page.keyboard.press('Escape')
  await expect(input).toHaveCount(0)
  const ring = await page.locator('[data-whiteboard-shape="text"]').first().boundingBox()
  if (ring === null) throw new Error('退出编辑后找不到图元')
  const baseline = parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]
  await page.mouse.move(ring.x + ring.width * 0.25, ring.y - 3)
  await page.mouse.down()
  await page.mouse.move(ring.x + ring.width * 0.25 + 40, ring.y - 3 + 24, { steps: 6 })
  await page.mouse.up()
  await expect
    .poll(async () => parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes?.[0]?.x ?? 0, { timeout: 15_000 })
    .toBe((baseline?.x ?? 0) + 40)
  await expect(page.getByTestId('whiteboard-text-input')).toHaveCount(0)
})

/**
 * T81 · 对齐 / 等距分布 / 移到视野中心。
 *
 * 用户的原话是「白板是否应该支持对齐功能」。六种对齐 T78 就有了，真正缺的是两件：
 * ① 排成一列/一行时**间距相等**（六个对齐按钮只能把图元推到一条线上，管不了空隙）；
 * ② 单枚图元「摆到视野中间」（白板是无限画布，没有页面可对齐，参照物只能是视野）。
 *
 * 这里钉四件事：
 *  - 分布首尾不动、中间空隙相等；
 *  - 左对齐后三枚贴同一条 x；
 *  - 视野居中幂等：已经在中心时再点一次，vault 逐字节不变（不攒空撤销项）；
 *  - 一次点击 = 一条撤销项；单选时只剩「视野居中」（对齐与分布都需要「互相」）。
 */
test('等距分布首尾不动、左对齐贴同一条边、视野居中幂等', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await page.getByTestId('whiteboard-create').click()
  await openWhiteboard(page)

  await page.getByTestId('whiteboard-add-rect').click()
  await page.getByTestId('whiteboard-add-round').click()
  await page.getByTestId('whiteboard-add-ellipse').click()
  await expect(page.locator('[data-testid^="whiteboard-node-"]')).toHaveCount(3)
  await page.keyboard.press('Escape')

  const readNodes = async (): Promise<StoredNode[]> => {
    await waitSaved(page)
    return parseVault(await readFakeFs(page)).whiteboards?.[0]?.nodes ?? []
  }

  // 把椭圆往左拖 40px：让三枚的间距明显不等，否则「等距」与「本来就等距」分不开
  const ellipse = page.locator('[data-whiteboard-shape="ellipse"]').first()
  const ellipseBox = await ellipse.boundingBox()
  if (ellipseBox === null) throw new Error('椭圆不在视口里')
  const grabX = ellipseBox.x + ellipseBox.width / 2
  const grabY = ellipseBox.y + ellipseBox.height / 2
  await page.mouse.move(grabX, grabY)
  await page.mouse.down()
  await page.mouse.move(grabX - 40, grabY, { steps: 5 })
  await page.mouse.up()

  await page.keyboard.press('Control+a')
  await expect(page.getByTestId('whiteboard-distribute-horizontal')).toBeVisible()
  await expect(page.getByTestId('whiteboard-center-view-horizontal')).toBeVisible()

  const sortX = (list: StoredNode[]): StoredNode[] => [...list].sort((left, right) => left.x - right.x)
  /** 相邻两枚之间的空隙（按 x 排序后）。 */
  const gapOf = (list: StoredNode[]): number[] => {
    const sorted = sortX(list)
    return sorted.slice(1).map((node, index) => node.x - (sorted[index]!.x + sorted[index]!.width))
  }

  // ① 横向等距分布：首尾不动，中间空隙相等
  const before = sortX(await readNodes())
  await page.getByTestId('whiteboard-distribute-horizontal').click()
  const distributed = sortX(await readNodes())
  expect(gapOf(distributed)[0]).toBe(gapOf(distributed)[1])
  expect(distributed[0]!.x).toBe(before[0]!.x)
  expect(distributed[2]!.x + distributed[2]!.width).toBe(before[2]!.x + before[2]!.width)
  // 真的挪过东西（不是「本来就等距」蒙对了）
  expect(distributed.some((node, index) => node.x !== before[index]!.x)).toBe(true)

  // ② 左对齐：三枚贴同一条 x，且都等于原包围盒的 minX
  await page.getByTestId('whiteboard-align-left').click()
  const aligned = await readNodes()
  expect(new Set(aligned.map((node) => node.x)).size).toBe(1)
  expect(Math.min(...aligned.map((node) => node.x))).toBe(distributed[0]!.x)

  // ③ 视野居中：先挪动一次，再点一次必须逐字节不变（已经在中心 = 不写命令）
  await page.getByTestId('whiteboard-center-view-horizontal').click()
  const centered = await readNodes()
  expect(centered).not.toEqual(aligned)
  await page.getByTestId('whiteboard-center-view-horizontal').click()
  expect(await readNodes()).toEqual(centered)

  // ④ 撤销一次回到「对齐态」：第二次点击没有产生命令，所以撤掉的就是那次居中
  await page.keyboard.press('Control+z')
  expect(await readNodes()).toEqual(aligned)

  // ⑤ 单选：只剩「视野居中」（对齐与分布都需要「互相」，不该在这种时候给按钮）
  // 左对齐之后三枚可能叠在同一处，点谁都是「选中一枚」——`force` 只是绕过可点性检查，
  // 事件照样派发到最上层那个节点，不影响这里要验的门槛。
  await page.keyboard.press('Escape')
  await page.locator('[data-whiteboard-shape="rect"]').first().click({ force: true })
  await expect(page.getByTestId('whiteboard-center-view-vertical')).toBeVisible()
  await expect(page.getByTestId('whiteboard-align-left')).toHaveCount(0)
  await expect(page.getByTestId('whiteboard-distribute-horizontal')).toHaveCount(0)
  await expect(page.getByTestId('whiteboard-distribute-vertical')).toHaveCount(0)
})
