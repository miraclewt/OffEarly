/**
 * T32 · revision 冲突三选
 *
 * 场景：另一端（同事 / 另一个窗口）改了磁盘上的 `vault.json`，本地还在拿着旧 revision。
 * 这时候**不许静默覆盖**——必须停下来让用户选。这组用例就是验证它真的会停。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, createTopic, openAppWith } from './fixtures/app'
import { fromBase64, readFakeFs, writeFakeFile } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'

interface StoredVault {
  revision: number
  topics: { id: string; name: string; [key: string]: unknown }[]
  tasks: unknown[]
}

/** 模拟「另一端」：把磁盘上的 revision 推高，并顺手加一个对方建的话题。 */
async function bumpDiskRevision(page: import('@playwright/test').Page, revision: number): Promise<void> {
  const fs = await readFakeFs(page)
  const vault = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault & {
    updatedAt: string
  }
  vault.revision = revision
  vault.updatedAt = new Date().toISOString()
  // 克隆一个已存在的合法话题再改名：手写对象很容易漏字段，
  // 而冲突检测里 repo.load() 会跑 Zod 校验——漏字段会让「报冲突」变成「解析失败」。
  const donor = vault.topics[0] as Record<string, unknown> | undefined
  vault.topics.push({
    ...(donor ?? {}),
    id: 'topic-from-other-side',
    name: '对方新建的话题',
  })
  await writeFakeFile(page, 'vault.json', JSON.stringify(vault))
}

test('磁盘 revision 被推进后，保存触发冲突弹窗并给出三选', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  const baseline = JSON.parse(
    fromBase64((await readFakeFs(page)).files['vault.json'] as string),
  ) as StoredVault
  await bumpDiskRevision(page, baseline.revision + 5)

  // 本地改一下，autosave 走到保存路径即应被冲突闸门拦下
  await createTopic(page, '本地未同步的改动')

  const dialog = page.getByTestId('conflict-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('文件已被另一端修改')
  // 弹窗必须反映**真实**的磁盘 revision（组件把它开在 data-disk-revision 上；
  // spec 8.3 只要求三选 + 丢失条数，未要求把版本号写进可见文案）
  await expect(dialog).toHaveAttribute('data-disk-revision', String(baseline.revision + 5))

  await expect(page.getByRole('button', { name: '以我为准' })).toBeVisible()
  await expect(page.getByRole('button', { name: '以磁盘为准' })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出我的副本' })).toBeVisible()

  // 「以磁盘为准」会丢东西，必须提前把代价说清楚
  await expect(page.getByTestId('conflict-drop-warning')).toBeVisible()
})

test('选「以磁盘为准」：本地未保存的改动被丢弃，磁盘上的对方改动被载入', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  const baseline = JSON.parse(
    fromBase64((await readFakeFs(page)).files['vault.json'] as string),
  ) as StoredVault
  await bumpDiskRevision(page, baseline.revision + 3)

  await createTopic(page, '会被丢掉的改动')
  await expect(page.getByTestId('conflict-dialog')).toBeVisible()

  await page.getByRole('button', { name: '以磁盘为准' }).click()
  await expect(page.getByTestId('conflict-dialog')).toHaveCount(0)

  // 载入的是磁盘版本：对方的改动在，我本地那条不在
  await expect(page.getByTestId('topic-tree')).toContainText('对方新建的话题')
  await expect(page.getByTestId('topic-tree')).not.toContainText('会被丢掉的改动')
})

test('选「导出我的副本」：我方版本被另存为独立文件', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  const baseline = JSON.parse(
    fromBase64((await readFakeFs(page)).files['vault.json'] as string),
  ) as StoredVault
  await bumpDiskRevision(page, baseline.revision + 2)

  await createTopic(page, '要保住的改动')
  await expect(page.getByTestId('conflict-dialog')).toBeVisible()

  await page.getByRole('button', { name: '导出我的副本' }).click()
  await expect(page.getByTestId('conflict-dialog')).toHaveCount(0)

  const fs = await readFakeFs(page)
  const exported = Object.keys(fs.files).filter((path) => path.startsWith('vault-conflict-'))
  expect(exported.length).toBeGreaterThanOrEqual(1)

  const mine = JSON.parse(fromBase64(fs.files[exported[0] as string] as string)) as StoredVault
  expect(mine.topics.map((topic) => topic.name)).toContain('要保住的改动')
})

test('选「以我为准」：我先被备份，然后覆盖磁盘', async ({ page }) => {
  await openAppWith(page, loadExampleVaultFs())
  await connectWorkspace(page, { create: false })

  const baseline = JSON.parse(
    fromBase64((await readFakeFs(page)).files['vault.json'] as string),
  ) as StoredVault
  await bumpDiskRevision(page, baseline.revision + 4)

  await createTopic(page, '我的版本说了算')
  await expect(page.getByTestId('conflict-dialog')).toBeVisible()

  await page.getByRole('button', { name: '以我为准' }).click()
  await expect(page.getByTestId('conflict-dialog')).toHaveCount(0)

  const fs = await readFakeFs(page)
  // 磁盘旧版（含对方的改动）先落到 .backup/，再被我的版本覆盖
  const backups = Object.keys(fs.files).filter((path) => path.startsWith('.backup/'))
  expect(backups.length).toBeGreaterThanOrEqual(1)

  const disk = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
  expect(disk.topics.map((topic) => topic.name)).toContain('我的版本说了算')
})
