/**
 * T49 · 知识库（笔记本）与图片缩放的真实落盘链路。
 *
 * 这一组回答两个具体承诺：
 *  1. 在笔记本里写下的 Markdown，真的进了 `vault.json` 的 `noteDocs`（不是内存里假装保存）；
 *  2. 图片宽度选择 50% 后，正文里留下的是 `<img … width="50%">`，重开还在。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith, waitSaved } from './fixtures/app'
import { fromBase64, readFakeFs, seedFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'
import type { FakeFsState } from './fixtures/fakeFs'

interface StoredVault {
  notebooks?: { id: string; name: string }[]
  noteDocs?: { id: string; title: string; content: string; parentId: string | null }[]
}

function parseVault(fs: FakeFsState): StoredVault {
  return JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
}

/** 落盘里全部文档的正文——轮询断言用，省得为「哪一篇」重复写路径。 */
function docContents(fs: FakeFsState): string[] {
  return (parseVault(fs).noteDocs ?? []).map((doc) => doc.content)
}

/** 在 example 库上追加一个笔记本与若干文档（其余任务数据保持不变）。 */
function withNotebooks(docs: { title: string; content: string }[]): FakeFsState {
  const fs = loadExampleVaultFs()
  const raw = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as Record<string, unknown>
  const now = '2026-10-22T09:00:00.000Z'
  raw.notebooks = [{ id: 'nb-e2e', name: '团队知识库', order: 'U', createdAt: now, updatedAt: now }]
  raw.noteDocs = docs.map((doc, index) => ({
    id: `doc-e2e-${index + 1}`,
    notebookId: 'nb-e2e',
    parentId: null,
    title: doc.title,
    content: doc.content,
    order: index === 0 ? 'U' : 'V',
    createdAt: now,
    updatedAt: now,
  }))
  fs.files['vault.json'] = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64')
  return fs
}

test('新建笔记本 → 新建文档 → 写 Markdown → 落盘 → 重开仍在', async ({ page }) => {
  await openAppWith(page, withNotebooks([]))
  await connectWorkspace(page, { create: false })

  await page.getByTestId('view-notebook').click()
  await expect(page.getByTestId('notebook')).toBeVisible()

  // 空笔记本已由夹具给出；直接建第一篇文档
  await page.getByTestId('notebook-new-doc').click()
  await expect(page.getByTestId('notebook-title-input')).toHaveValue('未命名文档')

  const title = page.getByTestId('notebook-title-input')
  await title.fill('发布流程')
  await title.press('Enter')

  await page.getByTestId('note-editor-content').click()
  await page.keyboard.type('# 发布流程')
  await page.keyboard.press('Enter')
  await page.keyboard.type('没有快照的发布不叫发布。')
  await waitSaved(page)

  // 写入链路是「编辑器 debounce 400ms → 命令 → autosave」，落盘晚于「已保存」文案，
  // 故对着磁盘内容轮询，而不是读一次就断言。
  await expect
    .poll(async () => docContents(await readFakeFs(page)).join('\n'), { timeout: 15_000 })
    .toContain('没有快照的发布不叫发布')

  const stored = parseVault(await readFakeFs(page))
  const doc = stored.noteDocs?.find((item) => item.title === '发布流程')
  expect(doc?.content).toContain('# 发布流程')

  // 文档 id 是运行时生成的：重开后按落盘里那个 id 点，才找得到同一篇
  const docId = doc?.id ?? ''
  expect(docId).not.toBe('')

  // 重开：把落盘快照当作「另一台机器上的磁盘」
  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await expect(page.getByText('连接数据文件夹')).toBeVisible()
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  await page.getByTestId(`doc-row-${docId}`).click()
  await expect(page.getByTestId('notebook-title-input')).toHaveValue('发布流程')
  await expect(page.getByTestId('note-editor-content')).toContainText('没有快照的发布不叫发布')
})

test('图片缩放：选 50% 后正文落成 <img width="50%">，重开尺寸还在', async ({ page }) => {
  await openAppWith(
    page,
    withNotebooks([{ title: '燃尽图', content: '![燃尽图](assets/asset-burndown.png)' }]),
  )
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  const image = page.getByTestId('note-image')
  await expect(image).toBeVisible()
  await image.hover()
  await page.getByTestId('note-image-width-50').click()
  await waitSaved(page)

  await expect
    .poll(async () => docContents(await readFakeFs(page)).join('\n'), { timeout: 15_000 })
    .toContain('width="50%"')

  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await expect(page.getByText('连接数据文件夹')).toBeVisible()
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  // 把手上的 aria-valuenow 就是当前百分比：比量 CSS 宽度稳，也不受界面尺度影响
  await expect(page.getByTestId('note-image-resize')).toHaveAttribute('aria-valuenow', '50')
  expect(docContents(await readFakeFs(page)).join('\n')).toContain('width="50%"')
})

/**
 * 这一条钉的是**百分比基准**——jsdom 没有布局，只有真浏览器能证明：
 * `width:50%` 必须相对编辑区正文宽度，而不是图片自身固有宽度。
 * 早前把百分比直接写在 <img> 上（包含块是 shrink-to-fit 的包装层），
 * 一张 480px 宽的图选 50% 只得到 240px（= 正文宽 602 的 40%），用户手感就是「比例不听话」。
 */
test('图片尺寸：百分比相对编辑区宽度；自适应档只限高不写宽度', async ({ page }) => {
  await openAppWith(
    page,
    withNotebooks([{ title: '燃尽图', content: '![燃尽图](assets/asset-burndown.png)' }]),
  )
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  const image = page.getByTestId('note-image')
  await expect(image).toBeVisible()

  // 自适应档：不写宽度，只给高度上限（长截图不该一插入就吃满一屏）
  const auto = await image.evaluate((el) => {
    const node = el as HTMLImageElement
    return { width: node.style.width, maxHeight: node.style.maxHeight }
  })
  expect(auto.width).toBe('')
  expect(auto.maxHeight).not.toBe('')

  await image.hover()
  await page.getByTestId('note-image-width-50').click()

  const ratio = await image.evaluate((el) => {
    const node = el as HTMLImageElement
    // 分母用编辑区本身：NodeViewWrapper 是内联 span（clientWidth 恒为 0），段落上一次性取不到
    const host = document.querySelector('[data-testid="note-editor-content"]') as HTMLElement | null
    return node.getBoundingClientRect().width / (host?.clientWidth ?? 1)
  })
  expect(ratio).toBeGreaterThan(0.45)
  expect(ratio).toBeLessThan(0.55)
})
