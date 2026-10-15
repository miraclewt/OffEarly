/**
 * T32 · 导出与安全模式
 *
 * 交付物是 file:// 单文件，**没有下载目录可写**——所以「导出」在本项目里的形态是
 * 「写进用户的数据文件夹」，而不是浏览器下载。这里按真实行为断言。
 *
 * 图表导出（PNG / SVG / CSV）属 T23，尚未实现，故保留 fixme 占位而不是删掉用例——
 * 删掉会让「没测」看起来像「测过了」。
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

test.fixme('图表导出：PNG / SVG / CSV 各自产生一个文件（等待 T23 GanttExporter）', async () => {
  // 阻塞：T23 未实现，甘特图目前没有任何导出入口。
  // 依赖落地后这里的步骤应为：打开甘特 → 点导出 → 选格式 → 断言数据文件夹里多出对应文件。
})

test.fixme('拖拽换列与图片粘贴（等待 T15 BoardView / T24 NoteEditor）', async () => {
  // 阻塞：看板卡片视图（T15）与笔记编辑器（T24）尚未实现，
  // 「拖拽换列」「贴图片」在 UI 上还没有可操作的对象。
})
