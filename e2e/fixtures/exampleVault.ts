/** T32 · 把仓库里真实的 example.vault 装进假目录——E2E 用的就是交付给用户的同一份样例。 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../playwright.config'
import type { FakeFsState } from './fakeFs'

export function loadExampleVaultFs(): FakeFsState {
  const dir = join(ROOT, 'example.vault')
  const files: Record<string, string> = {
    'vault.json': readFileSync(join(dir, 'vault.json')).toString('base64'),
  }
  for (const name of readdirSync(join(dir, 'assets'))) {
    files[`assets/${name}`] = readFileSync(join(dir, 'assets', name)).toString('base64')
  }
  // .backup/ 是保存时才写满的，这里只保证目录存在（真实库里首次保存前也是空的）
  return { files, dirs: ['assets', '.backup'] }
}
