/**
 * T48 · 思维导图编辑落盘与导出
 *
 * 照 04-gantt / 05-export 的手法：file:// 单文件 + 假目录（真实读写走产品代码），
 * 选择器只认视图随包发布的 data-testid。图表导出的形态是**浏览器下载**
 * （blob URL + a[download]），经 page.on('download') 捕获；PNG 依赖 canvas.toBlob，
 * 环境不支持时选项禁用并提示——降级断言而非失败（与 05-export 同口径）。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith, waitSaved } from './fixtures/app'
import { fromBase64, readFakeFs, seedFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'

interface StoredVault {
  mindmaps: { name: string; root: { text: string } }[]
}

/** 进导图空态并新建一张图（example.vault 的 mindmaps 为空数组）。 */
async function createMap(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('view-mindmap').click()
  await expect(page.getByTestId('mindmap-empty')).toBeVisible()
  await page.getByTestId('mindmap-create').click()
  await expect(page.getByTestId('mindmap-canvas')).toBeVisible()
}

test('双击改名 → 自动落盘 → 重开还在（真实 autosave 全链路）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await createMap(page)

  // 唯一节点 = 中心主题（根）；双击进就地编辑
  const root = page.locator('[data-mindmap-node]').first()
  await expect(root).toContainText('中心主题')
  await root.dblclick()

  const input = page.getByTestId('mindmap-input')
  await expect(input).toBeVisible()
  await input.fill('改名分支')
  await input.press('Enter')

  // 画布上出现新名字（模型 text 未截断、原样渲染）
  await expect(page.locator('[data-mindmap-label]').first()).toContainText('改名分支')
  await waitSaved(page)

  // 落盘断言：不是内存里假装保存
  const fs = await readFakeFs(page)
  const vault = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
  expect(vault.mindmaps).toHaveLength(1)
  expect(vault.mindmaps[0]?.root.text).toBe('改名分支')

  // 重开同一 fixture 目录：把落盘快照作为「下一次启动」的磁盘内容
  await seedFakeFs(page, fs)
  await page.reload()
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-mindmap').click()
  await expect(page.getByTestId('mindmap-toolbar')).toBeVisible()
  await expect(page.locator('[data-mindmap-label]').first()).toContainText('改名分支')
})

test('导出菜单：PNG / SVG 各自下载一个文件（格式 × 范围弹层）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await createMap(page)

  const button = page.getByTestId('mindmap-export-button')
  await expect(button).toBeVisible()

  for (const format of ['png', 'svg'] as const) {
    await button.click()
    const menu = page.getByTestId('mindmap-export-menu')
    await expect(menu).toBeVisible()

    const formatButton = page.getByTestId(`mindmap-export-format-${format}`)
    await expect(formatButton).toBeVisible()
    // PNG 管线不可用（R3 前提被破坏）时该选项禁用并提示：降级断言，不算失败
    if (await formatButton.isDisabled()) {
      await expect(page.getByTestId('mindmap-export-png-hint')).toBeVisible()
      await page.getByTestId('mindmap-export-cancel').click()
      await expect(menu).toHaveCount(0)
      continue
    }
    await formatButton.click()
    // 范围切到「全图」再导——可见区与全图共用同一弹层，范围钮必须可点
    await page.getByTestId('mindmap-export-range-full').click()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('mindmap-export-confirm').click(),
    ])
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`))
    await expect(menu).toHaveCount(0)
  }
})
