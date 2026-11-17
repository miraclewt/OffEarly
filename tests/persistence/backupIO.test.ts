// T28 · backupIO：导出库副本（递归复制）的持久化层。
//
// 口径：exportDataCopy 递归复制数据目录到目标目录，跳过 `.backup/`（快照是本地
// 安全网，不是要迁移的数据本体）；返回复制了多少文件 / 多少字节。
// 底层走 fsAdapter 原语，这里用 mock 句柄（已支持 values()/getDirectoryHandle(create)）
// 直接跑真实实现，断言目标目录树与字节统计。

import { describe, expect, it } from 'vitest'

import { exportDataCopy } from '../../src/persistence/backupIO'
import { asDirHandle, makeDir, makeFile } from './mockFs'

const ENCODER = new TextEncoder()

function vaultText(text: string): number {
  return ENCODER.encode(text).length
}

describe('T28-导出 · exportDataCopy', () => {
  it('复制 vault.json 与 assets/ 文件到目标目录，返回文件数与字节数', async () => {
    const source = makeDir('vault', {
      files: [makeFile('vault.json', { text: '{"tasks":[]}' })],
      dirs: [makeDir('assets', { files: [makeFile('a.png', { bytes: new Uint8Array([1, 2, 3]) })] })],
    })
    const target = makeDir('target')

    const summary = await exportDataCopy(asDirHandle(source), asDirHandle(target))

    expect(summary).toEqual({ files: 2, bytes: vaultText('{"tasks":[]}') + 3 })
    expect(target.files.get('vault.json')).toBeTruthy()
    expect(target.dirs.get('assets')?.files.get('a.png')).toBeTruthy()
  })

  it('跳过 .backup/ 目录（快照不随导出迁移）', async () => {
    const source = makeDir('vault', {
      files: [makeFile('vault.json', { text: '{}' })],
      dirs: [makeDir('.backup', { files: [makeFile('vault-20261015-093012.json', { text: '{}' })] })],
    })
    const target = makeDir('target')

    const summary = await exportDataCopy(asDirHandle(source), asDirHandle(target))

    expect(summary.files).toBe(1)
    expect(target.dirs.get('.backup')).toBeUndefined()
  })

  it('递归复制嵌套子目录', async () => {
    const source = makeDir('vault', {
      files: [makeFile('vault.json', { text: '{}' })],
      dirs: [
        makeDir('assets', {
          dirs: [makeDir('sub', { files: [makeFile('b.png', { bytes: new Uint8Array([9]) })] })],
        }),
      ],
    })
    const target = makeDir('target')

    await exportDataCopy(asDirHandle(source), asDirHandle(target))

    expect(target.dirs.get('assets')?.dirs.get('sub')?.files.get('b.png')).toBeTruthy()
  })

  it('只有 vault.json 的空库也能导出（files=1）', async () => {
    const source = makeDir('vault', { files: [makeFile('vault.json', { text: '{}' })] })
    const target = makeDir('target')

    const summary = await exportDataCopy(asDirHandle(source), asDirHandle(target))

    expect(summary).toEqual({ files: 1, bytes: vaultText('{}') })
  })

  it('文件字节逐字节复制（不重编码），断言目标内容等于源内容', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253])
    const source = makeDir('vault', {
      files: [makeFile('vault.json', { text: '{}' })],
      dirs: [makeDir('assets', { files: [makeFile('bin.dat', { bytes })] })],
    })
    const target = makeDir('target')

    await exportDataCopy(asDirHandle(source), asDirHandle(target))

    const copied = target.dirs.get('assets')?.files.get('bin.dat')?.bytes()
    expect(copied).toEqual(bytes)
  })
})
