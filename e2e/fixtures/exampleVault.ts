/**
 * T32 · 把仓库里真实的 example.vault 装进假目录——E2E 用的就是交付给用户的同一份样例。
 *
 * T36 补的一层归一：`example.vault/vault.json` 是**活文件**——用户手册第 11 项就叫用户
 * 「连接 example.vault 看看有数据长什么样」，于是它一定会被应用真的打开、真的保存，
 * 里面就带上了那次使用留下的 UI 状态（locale 被切成 en、留了个筛选、刻度改成周…）。
 * 这些是**用户数据**，不是夹具数据：夹具要的是那 5 个话题 / 15 个任务，而 UI 相位必须确定化。
 * 所以这里覆写 settings 的四个相位字段（locale / theme / ganttScale / lastFilter），
 * 其余内容（任务、依赖、笔记、附件）原样照搬。
 *
 * 不复位磁盘上的文件：那是用户的库，测试不该也不能改它。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../playwright.config'
import type { FakeFsState } from './fakeFs'

/** 覆写进夹具的 UI 相位：与 playwright.config 钉的 zh-CN / 浅色主题一致。 */
const PINNED_SETTINGS = {
  locale: 'zh',
  theme: 'light',
  ganttScale: 'day',
  lastFilter: null,
} as const

export function loadExampleVaultFs(): FakeFsState {
  const dir = join(ROOT, 'example.vault')
  const raw = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')) as {
    settings?: Record<string, unknown>
  }
  const vault = { ...raw, settings: { ...raw.settings, ...PINNED_SETTINGS } }

  const files: Record<string, string> = {
    'vault.json': Buffer.from(JSON.stringify(vault), 'utf8').toString('base64'),
  }
  for (const name of readdirSync(join(dir, 'assets'))) {
    files[`assets/${name}`] = readFileSync(join(dir, 'assets', name)).toString('base64')
  }
  // .backup/ 是保存时才写满的，这里只保证目录存在（真实库里首次保存前也是空的）
  return { files, dirs: ['assets', '.backup'] }
}
