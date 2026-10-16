/**
 * T25 · 笔记图片（真实 Chromium over file://）
 *
 * 单测能证明 AssetStore 的字节与缓存，但证明不了三件事，只有真浏览器能证明：
 *  ① `file://` 下 blob URL 真的能把 assets/ 里的图显示出来（相对路径在此解析不到）；
 *  ② 粘贴路径走的是 `paste` 事件的 clipboardData——T01 R4 在企业 Edge 实测通过的那条机制，
 *     而不是 `navigator.clipboard.read()`（后者要前台焦点 + clipboard-read 权限）；
 *  ③ 落盘真的写到用户选的那个目录里（假 FS 的 `assets/<id>.png` 与 vault.json 的 assets 表）。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

import { connectWorkspace, openAppWith, waitSaved } from './fixtures/app'
import { fromBase64, readFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'

/** 最小合法 PNG（8 字节签名 + 若干字节内容）：只为走通字节通道，不追求可解码。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])

/** 示例库自带的那张燃尽图不算「新插入的附件」。 */
const PRE_EXISTING = 'assets/asset-burndown.png'

async function newAssetPaths(page: Page): Promise<string[]> {
  const fs = await readFakeFs(page)
  return Object.keys(fs.files).filter((path) => path.startsWith('assets/') && path !== PRE_EXISTING)
}

async function openNote(page: Page): Promise<void> {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('task-card-task-pay-01').click()
  await expect(page.getByTestId('task-drawer')).toBeVisible()
  await expect(page.getByTestId('note-editor-content')).toBeVisible()
}

test('已有附件：note 里的 ![](assets/…) 经 blob URL 真的显示出来', async ({ page }) => {
  await openNote(page)
  // 图片是异步读出来的：先读到字节 → createObjectURL → 节点视图重画
  const image = page.getByTestId('note-image').first()
  await expect(image).toBeVisible({ timeout: 5000 })
  await expect(image).toHaveAttribute('src', /^blob:/)
  await expect(image).toHaveAttribute('data-note-image', PRE_EXISTING)
})

test('工具栏选文件：写进 assets/ 并进 vault.json 的 assets 表', async ({ page }) => {
  await openNote(page)
  await page.getByTestId('note-tool-image').click()
  await page.getByTestId('note-image-input').setInputFiles({
    name: 'shot.png',
    mimeType: 'image/png',
    buffer: PNG_BYTES,
  })

  await expect
    .poll(async () => (await newAssetPaths(page)).length, { timeout: 5000 })
    .toBe(1)
  const [path] = await newAssetPaths(page)
  expect(path ?? '').toMatch(/^assets\/[A-Za-z0-9_-]+\.png$/)

  // 自动保存后 vault.json 里既有 note 的相对路径引用，也有 assets 表的元数据
  await waitSaved(page)
  const fs = await readFakeFs(page)
  const vault = JSON.parse(fromBase64(fs.files['vault.json'] ?? '')) as {
    tasks: Array<{ id: string; note: string }>
    assets: Array<{ filename: string; sizeBytes: number }>
  }
  const task = vault.tasks.find((item) => item.id === 'task-pay-01')
  // alt 取文件名（灯箱标题与无障碍都用它），所以断言只钉路径那一段
  expect(task?.note ?? '').toContain(`](${path})`)
  expect(vault.assets.some((asset) => asset.filename === path)).toBe(true)
})

test('粘贴图片：走 paste 事件的 clipboardData，落盘后点开灯箱可关闭', async ({ page }) => {
  await openNote(page)
  await page.evaluate(async (bytes: number[]) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(bytes)], 'paste.png', { type: 'image/png' }))
    const target = document.querySelector('[data-testid="note-editor-content"]')
    if (target === null) throw new Error('note editor content not found')
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, [...PNG_BYTES])

  await expect
    .poll(async () => (await newAssetPaths(page)).length, { timeout: 5000 })
    .toBe(1)

  // 点图片开灯箱 → 关闭（原图 src 仍是 blob URL，下载名取文件名）
  await page.getByTestId('note-image').last().click()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await expect(page.getByTestId('lightbox-image')).toHaveAttribute('src', /^blob:/)
  await expect(page.getByTestId('lightbox-download')).toHaveAttribute('download', /\.png$/)
  await page.getByTestId('lightbox-close').click()
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
})
