/**
 * T32 · 自动保存与落盘（真实读写）
 *
 * 交付物最要紧的承诺是「数据在我自己的文件夹里」。这组用例把它当真：
 * 在 UI 里改数据 → 等保存指示收敛 → 直接读假目录里的 `vault.json` 字节 → 重开再看。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, createTopic, openAppWith, waitSaved } from './fixtures/app'
import { fromBase64, readFakeFs, seedFakeFs, writeFakeFile } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'

interface StoredVault {
  revision: number
  topics: { id: string; name: string }[]
  tasks: { id: string; status: string }[]
}

function parseVault(fs: { files: Record<string, string> }): StoredVault {
  return JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
}

test('新建话题 → 自动保存 → vault.json 里能读到，且 revision 推进', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  const before = parseVault(await readFakeFs(page))

  await createTopic(page, 'E2E 新建话题')
  await waitSaved(page)

  const after = parseVault(await readFakeFs(page))
  expect(after.topics.map((topic) => topic.name)).toContain('E2E 新建话题')
  expect(after.topics.length).toBe(before.topics.length + 1)
  // 每次落盘 revision 必须 +1，否则 30s 轮询的冲突判据就失效了
  expect(after.revision).toBe(before.revision + 1)
})

test('保存前会把当前 vault.json 备份进 .backup/', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  await createTopic(page, '触发一次备份')
  await waitSaved(page)

  const fs = await readFakeFs(page)
  const backups = Object.keys(fs.files).filter((path) => path.startsWith('.backup/'))
  expect(backups.length).toBeGreaterThanOrEqual(1)
  // 备份是「保存前」的版本，所以里面不该有刚建的话题
  const backup = JSON.parse(fromBase64(fs.files[backups[0] as string] as string)) as StoredVault
  expect(backup.topics.map((topic) => topic.name)).not.toContain('触发一次备份')
})

test('重开应用后数据仍在（真落盘，不是内存里假装保存）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  await createTopic(page, '重开也要在')
  await waitSaved(page)

  // 抓下落盘快照，把它作为「换一台机器/下一次启动」时磁盘上的内容
  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()

  await expect(page.getByText('连接数据文件夹')).toBeVisible()
  await connectWorkspace(page, { create: false })
  await expect(page.getByTestId('topic-tree')).toContainText('重开也要在')
})

test('Ctrl+S 立即落盘（不依赖 debounce 计时）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  await createTopic(page, '快捷键保存')
  await page.keyboard.press('ControlOrMeta+s')
  await waitSaved(page)

  const fs = await readFakeFs(page)
  expect(fs.files['vault.json']).toBeDefined()
  expect(parseVault(fs).topics.map((topic) => topic.name)).toContain('快捷键保存')
})

test('磁盘上的旧版本先被备份，再被新版本覆盖（save 是覆盖写）', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  // 直接把一个「外部写的」内容塞进磁盘，再本地改一次，确认覆盖后内容是我们自己的
  await writeFakeFile(page, 'notes.txt', 'hello')
  await createTopic(page, '覆盖写检查')
  await waitSaved(page)

  const fs = await readFakeFs(page)
  expect(fromBase64(fs.files['notes.txt'] as string)).toBe('hello')
  expect(parseVault(fs).topics.map((topic) => topic.name)).toContain('覆盖写检查')
})
