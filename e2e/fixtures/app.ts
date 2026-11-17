/** 用例共用的动作封装。选择器尽量走 role / testid，不用样式或文案位置。 */
import { expect, type Page } from '@playwright/test'

import { APP_URL } from '../../playwright.config'
import { installFakeDirectoryPicker, seedFakeFs, type FakeFsState } from './fakeFs'

/**
 * 冻结「今天」。example.vault 的日期是围绕 2026-10-15 编的，而甘特图的今天线、
 * 逾期判定都读系统时间——不钉死的话，这套回归用例过几个月就会自己变红。
 * 用 setFixedTime 而不是 install：前者只替换 Date，**不动定时器**，
 * autosave 的 debounce 与 30s 轮询照常跑。
 */
export const FROZEN_NOW = new Date('2026-10-15T09:00:00+08:00')

/** 打开单文件产物，停在首屏。 */
export async function openApp(page: Page): Promise<void> {
  await page.clock.setFixedTime(FROZEN_NOW)
  await page.goto(APP_URL)
  await expect(page.getByText('连接数据文件夹')).toBeVisible()
}

/** 装好假目录 + 预置磁盘内容，然后打开应用。 */
export async function openAppWith(page: Page, fs: FakeFsState): Promise<void> {
  await installFakeDirectoryPicker(page)
  await seedFakeFs(page, fs)
  await openApp(page)
}

/**
 * 点「选择文件夹」；create=true 时顺带确认建库；最后等外壳出现。
 *
 * `landsOn` 默认 `board`；库损坏且无快照时会落到只读安全模式——那时没有看板可等，
 * 断言的目标换成 `safe-mode`（主内容区的兜底壳）。
 */
export async function connectWorkspace(
  page: Page,
  options: { create: boolean; landsOn?: 'board' | 'safe-mode' },
): Promise<void> {
  await page.getByRole('button', { name: '选择文件夹' }).click()
  if (options.create) {
    const confirm = page.getByRole('button', { name: '创建数据库' })
    await expect(confirm).toBeVisible()
    await confirm.click()
  }
  await expect(page.getByTestId(options.landsOn ?? 'board')).toBeVisible()
}

/** 等自动保存收敛到「已保存」。 */
export async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-indicator')).toContainText('已保存')
}

/** 走侧栏建一个根话题，返回它最终落在磁盘上的名字。 */
export async function createTopic(page: Page, name: string): Promise<void> {
  await page.getByTestId('topic-add-root').click()
  const input = page.getByTestId('topic-name-input')
  await expect(input).toBeVisible()
  await input.fill(name)
  await input.press('Enter')
  await expect(page.getByTestId('topic-tree')).toContainText(name)
}
