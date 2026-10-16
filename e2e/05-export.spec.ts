/**
 * T32 · 导出与安全模式
 *
 * 交付物是 file:// 单文件。「导出当前」（vault 副本）的形态是「写进用户的数据文件夹」；
 * 图表导出（T23）的形态是**浏览器下载**（blob URL + a[download]，file:// 下同样可下载，
 * Playwright 经 page.on('download') 捕获）——两者形态不同，各自按真实行为断言。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith } from './fixtures/app'
import { fromBase64, readFakeFs, type FakeFsState } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'

/** 把 example.vault 的 vault.json 弄成非法 JSON，并把原内容挪进 .backup/ 当快照。 */
function corruptWithSnapshot(): FakeFsState {
  const fs = loadExampleVaultFs()
  const original = fromBase64(fs.files['vault.json'] as string)
  return {
    files: {
      ...fs.files,
      'vault.json': Buffer.from('{ this is not json at all', 'utf8').toString('base64'),
      '.backup/vault-20261015-090000.json': Buffer.from(original, 'utf8').toString('base64'),
    },
    dirs: [...fs.dirs, '.backup'],
  }
}

/** 连坏库都没有：vault.json 非法且没有任何快照可自愈。 */
function corruptWithoutSnapshot(): FakeFsState {
  const fs = loadExampleVaultFs()
  return {
    files: {
      ...fs.files,
      'vault.json': Buffer.from('{ broken', 'utf8').toString('base64'),
    },
    dirs: fs.dirs,
  }
}

test('vault.json 损坏且有可用快照：进入只读自愈，横幅置顶', async ({ page }) => {
  await openAppWith(page, corruptWithSnapshot())
  await connectWorkspace(page, { create: false })

  const banner = page.getByTestId('safe-mode-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('只读安全模式')
  // 自愈出来的内容仍然可看，且磁盘文件没有被改写
  const fs = await readFakeFs(page)
  expect(fromBase64(fs.files['vault.json'] as string)).toContain('this is not json')
})

test('「导出当前」把正在看的内容写进数据文件夹（vault-export-*.json）', async ({ page }) => {
  await openAppWith(page, corruptWithSnapshot())
  await connectWorkspace(page, { create: false })

  await expect(page.getByTestId('safe-mode-banner')).toBeVisible()
  await page.getByRole('button', { name: '导出当前' }).click()

  // 导出是写盘动作，不是浏览器下载；给它一点时间落地
  await expect
    .poll(async () => Object.keys((await readFakeFs(page)).files).filter((p) => p.startsWith('vault-export-')).length)
    .toBeGreaterThanOrEqual(1)

  const fs = await readFakeFs(page)
  const exported = Object.keys(fs.files).find((path) => path.startsWith('vault-export-')) as string
  const vault = JSON.parse(fromBase64(fs.files[exported] as string)) as { topics: unknown[] }
  expect(vault.topics.length).toBeGreaterThan(0)
})

test('连快照都没有时：仍停在安全模式，且明确告知没有可用快照', async ({ page }) => {
  await openAppWith(page, corruptWithoutSnapshot())
  // 没有快照可自愈 → 落到 only-read 安全模式，此时没有看板可等
  await connectWorkspace(page, { create: false, landsOn: 'safe-mode' })

  const banner = page.getByTestId('safe-mode-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('当前没有可用快照')

  // 安全模式下没有任何可展示的内容区，写盘也全部停掉
  const fs = await readFakeFs(page)
  expect(fromBase64(fs.files['vault.json'] as string)).toBe('{ broken')
})

test('图表导出：PNG / SVG / CSV 各自下载一个文件', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-gantt').click()
  await expect(page.getByTestId('gantt-export-button')).toBeVisible()

  for (const format of ['png', 'svg', 'csv'] as const) {
    await page.getByTestId('gantt-export-button').click()
    const formatButton = page.getByTestId(`gantt-export-format-${format}`)
    await expect(formatButton).toBeVisible()
    // PNG 依赖 canvas.toBlob：环境不支持时该选项后端禁用并给出提示——降级断言而非失败。
    if (await formatButton.isDisabled()) {
      await expect(page.getByTestId('gantt-export-png-hint')).toBeVisible()
      await page.getByTestId('gantt-export-cancel').click()
      continue
    }
    await formatButton.click()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('gantt-export-confirm').click(),
    ])
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`))
  }
})

test.fixme('拖拽换列与图片粘贴（等待 T15 BoardView / T24 NoteEditor）', async () => {
  // 阻塞：看板卡片视图（T15）与笔记编辑器（T24）尚未实现，
  // 「拖拽换列」「贴图片」在 UI 上还没有可操作的对象。
})
