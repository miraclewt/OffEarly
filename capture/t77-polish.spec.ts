/**
 * T77 · 白板「排版与手感」补丁的成品图（真 Chromium）。
 *
 * 单测能钉住「font-weight 是 700、object-fit 是 cover、编辑中高度变了」，钉不住三件事：
 *  1. 加粗 700 与 13 号字放在一起，层级是不是真的拉得开（会不会糊成一团）；
 *  2. 打字过程中框长高的**观感**——长高的速度跟不跟得上打字、文字会不会浮在框外；
 *  3. cover 与 contain 的差别：横图塞进竖框时，一个裁掉两边、一个上下留白，
 *     这件事只有出图才看得出（单测只能断言属性值）。
 *
 * 产出：
 *  - docs/t77-text-styles.png   字效四态 + 工具栏 B/I 按下态
 *  - docs/t77-live-height.png   编辑中实时长高（未提交）
 *  - docs/t77-image-fit.png     同尺寸框里的 contain / cover 对照
 */
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

import { connectWorkspace, openAppWith, waitSaved } from '../e2e/fixtures/app'
import type { FakeFsState } from '../e2e/fixtures/fakeFs'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'

mkdirSync('docs', { recursive: true })

test.use({ deviceScaleFactor: 2 })

const NOW = '2026-10-31T08:00:00.000Z'

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
  name: '字效与图片',
  order: 'U',
  createdAt: NOW,
  updatedAt: NOW,
  edges: [],
  nodes: [
    { id: 'n1', shape: 'text', x: 0, y: 0, width: 480, height: 56, text: '订单服务拆分的三个前提', tone: 'plain', fontSize: 32, bold: true },
    { id: 'n2', shape: 'text', x: 0, y: 72, width: 480, height: 32, text: '斜体用于引用别人的话、或者标注「待确认」', tone: 'plain', italic: true },
    { id: 'n3', shape: 'text', x: 0, y: 112, width: 480, height: 32, text: '粗 + 斜：强调一句还没定下来的结论', tone: 'plain', bold: true, italic: true },
    { id: 'n4', shape: 'text', x: 0, y: 152, width: 480, height: 32, text: '普通正文（13 号，与导出同一套字号）', tone: 'plain' },
    { id: 'n5', shape: 'rect', x: 0, y: 320, width: 240, height: 64, text: '粗体标题', tone: 'plain', fontSize: 16, bold: true },
    { id: 'n6', shape: 'note', x: 264, y: 320, width: 216, height: 96, text: '便签里也能加粗：\n这条今天必须发', tone: 'accent', bold: true },
  ],
}

test('字效四态与工具栏', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 })
  await openAppWith(page, withBoard(loadExampleVaultFs(), BOARD))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('whiteboard-fit').click()
  await page.keyboard.press('Escape')
  await waitSaved(page)

  // 选中粗体标题：工具栏要同时给出 B（按下）/ I（未按）/ A− A+ 与字号框
  const title = await page.locator('[data-whiteboard-shape="text"]').first().boundingBox()
  if (title !== null) await page.mouse.click(title.x + title.width / 2, title.y + title.height / 2)
  await page.screenshot({ path: 'docs/t77-text-styles.png' })

  const probe = await page.evaluate(() =>
    [...document.querySelectorAll('[data-whiteboard-shape]')].map((host) => {
      const element = host as HTMLElement
      const style = getComputedStyle(element)
      return {
        id: element.dataset.whiteboardShape,
        weight: style.fontWeight,
        fontStyle: style.fontStyle,
        fontSize: style.fontSize,
        height: Math.round(element.getBoundingClientRect().height),
      }
    }),
  )
  console.log('[t77-styles-probe]', JSON.stringify(probe))
})

test('编辑中实时长高', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 })
  await openAppWith(page, withBoard(loadExampleVaultFs(), BOARD))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('whiteboard-fit').click()
  await page.keyboard.press('Escape')

  const input = page.getByTestId('whiteboard-text-input')
  // 双击最下面那行普通正文，改成一段长文本：框要在**打字过程中**长起来
  const target = page.locator('[data-whiteboard-shape="text"]').nth(3)
  await target.dblclick()
  await expect(input).toBeVisible()
  const before = (await target.boundingBox())?.height ?? 0

  await input.fill('普通正文（13 号，与导出同一套字号）\n第二行：拆接口之前先把数据模型对齐\n第三行：否则两边各写一套，最后还得合并\n第四行：这一步没有捷径')
  await expect.poll(async () => (await target.boundingBox())?.height ?? 0, { timeout: 3000 }).toBeGreaterThan(before)

  const after = (await target.boundingBox())?.height ?? 0
  await page.screenshot({ path: 'docs/t77-live-height.png' })
  console.log('[t77-live-height-probe]', JSON.stringify({ before: Math.round(before), after: Math.round(after) }))

  // 光标落到最后一行可见即可（textarea 不该需要内部滚动才能看到刚写的那行）
  const scroll = await input.evaluate((area) => {
    const element = area as HTMLTextAreaElement
    return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }
  })
  console.log('[t77-live-height-scroll]', JSON.stringify(scroll))

  await page.keyboard.press('Control+Enter')
  await waitSaved(page)
})

test('图片 contain 与 cover 的差别', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 620 })
  await openAppWith(page, withBoard(loadExampleVaultFs(), { ...BOARD, nodes: [] }))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-whiteboard').click()
  await expect(page.getByTestId('whiteboard')).toBeVisible({ timeout: 15_000 })

  // 造两张比例相反的图：横图（3:1）与竖图（1:3）。
  // 只有「框的比例与图不一致」时 cover 与 contain 才看得出区别，
  // 而真实场景正是这样出现的：换了一张不同比例的新图，框还是原来那个（替换保留尺寸）。
  const makeImage = async (width: number, height: number, label: string, from: string, to: string): Promise<Buffer> => {
    const base64 = await page.evaluate(
      ({ width, height, label, from, to }) => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (ctx === null) return ''
        const gradient = ctx.createLinearGradient(0, 0, width, height)
        gradient.addColorStop(0, from)
        gradient.addColorStop(1, to)
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, width, height)
        ctx.fillStyle = 'rgba(255,255,255,0.94)'
        ctx.font = 'bold 48px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, width / 2, height / 2)
        return canvas.toDataURL('image/png').split(',')[1] ?? ''
      },
      { width, height, label, from, to },
    )
    return Buffer.from(base64, 'base64')
  }

  const wide = await makeImage(600, 200, 'WIDE 3:1', '#2563eb', '#0ea5e9')
  const tall = await makeImage(200, 600, 'TALL 1:3', '#f59e0b', '#ef4444')

  // 先贴横图（框按 3:1 生成），再**把图换成竖图**——框的尺寸原样保留，
  // 于是「框 3:1、图 1:3」，正是 cover / contain 的分歧点
  await page.getByTestId('whiteboard-image').click()
  await page.getByTestId('whiteboard-image-input').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: wide })
  const imageNode = page.locator('[data-whiteboard-shape="image"]').first()
  await expect(imageNode).toBeVisible()
  await imageNode.click()

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('whiteboard-image-replace').click(),
  ])
  await chooser.setFiles({ name: 'tall.png', mimeType: 'image/png', buffer: tall })
  await expect(page.locator('img[data-testid^="whiteboard-image-"]').first()).toHaveAttribute('alt', 'tall.png')
  await waitSaved(page)

  await page.keyboard.press('Escape')
  await page.getByTestId('whiteboard-fit').click()
  await page.keyboard.press('Escape')
  // 留白（缺省）：竖图完整显示，左右各留一大块空
  await page.screenshot({ path: 'docs/t77-image-contain.png' })

  await imageNode.click()
  await page.getByTestId('whiteboard-image-fit').click()
  await expect(page.locator('img[data-testid^="whiteboard-image-"]').first()).toHaveCSS('object-fit', 'cover')
  await waitSaved(page)
  await page.keyboard.press('Escape')
  // 铺满：图放大到盖住整个框，两侧被裁掉
  await page.screenshot({ path: 'docs/t77-image-cover.png' })

  const probe = await page.evaluate(() => {
    const host = document.querySelector('[data-whiteboard-shape="image"]')
    if (host === null) return null
    const image = host.querySelector('img')
    const rect = host.getBoundingClientRect()
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      objectFit: image === null ? null : getComputedStyle(image).objectFit,
      alt: image?.getAttribute('alt') ?? null,
    }
  })
  console.log('[t77-image-fit-probe]', JSON.stringify(probe))
})
