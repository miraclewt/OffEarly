// T28 · backupPort：导出 / 导入端口（控制器）接线测试。
//
// 口径：导出端口 = 弹目标目录（注入 pickTarget）→ exportDataCopy 递归复制，取消返回 null；
// 导入端口 = parse 复用 vaultRepository.parseVaultText（校验/迁移同启动判据），
// fromDirectory 弹源目录（注入 pickSource）读 vault.json 文本，取消返回 null。

import { describe, expect, it, vi } from 'vitest'

import { createBackupExportPort, createBackupImportPort } from '../../src/controllers/backupPort'
import { createNewVault } from '../../src/persistence/vaultRepository'
import { asDirHandle, makeDir, makeFile } from '../persistence/mockFs'

const ENCODER = new TextEncoder()

describe('T28-导出端口 · createBackupExportPort', () => {
  it('复制源目录到 pickTarget 选中的目标目录，返回统计', async () => {
    const source = makeDir('vault', {
      files: [makeFile('vault.json', { text: '{"tasks":[]}' })],
      dirs: [makeDir('assets', { files: [makeFile('a.png', { bytes: new Uint8Array([1, 2, 3]) })] })],
    })
    const target = makeDir('target')
    const port = createBackupExportPort(asDirHandle(source), {
      pickTarget: vi.fn(async () => asDirHandle(target)),
    })

    const summary = await port.exportCopy()

    expect(summary).toEqual({ files: 2, bytes: ENCODER.encode('{"tasks":[]}').length + 3 })
    expect(target.files.get('vault.json')).toBeTruthy()
    expect(target.dirs.get('assets')?.files.get('a.png')).toBeTruthy()
  })

  it('用户取消（pickTarget 返回 null）→ 返回 null，不动目标', async () => {
    const source = makeDir('vault', { files: [makeFile('vault.json', { text: '{}' })] })
    const port = createBackupExportPort(asDirHandle(source), { pickTarget: vi.fn(async () => null) })

    expect(await port.exportCopy()).toBeNull()
  })
})

describe('T28-导入端口 · createBackupImportPort', () => {
  it('parse 校验 + 迁移文本 → Vault（与启动加载同一判据）', () => {
    const vault = createNewVault()
    const port = createBackupImportPort()

    const parsed = port.parse(JSON.stringify(vault))

    expect(parsed.tasks).toEqual([])
    expect(parsed.revision).toBe(0)
    expect(parsed.schemaVersion).toBe(vault.schemaVersion)
  })

  it('parse 非法 JSON 抛 VaultValidationError（不静默吞）', () => {
    const port = createBackupImportPort()
    expect(() => port.parse('{not json')).toThrow()
  })

  it('fromDirectory 读选中目录的 vault.json 文本', async () => {
    const source = makeDir('vault', { files: [makeFile('vault.json', { text: '{"tasks":[]}' })] })
    const port = createBackupImportPort({ pickSource: vi.fn(async () => asDirHandle(source)) })

    expect(await port.fromDirectory()).toBe('{"tasks":[]}')
  })

  it('fromDirectory 取消返回 null', async () => {
    const port = createBackupImportPort({ pickSource: vi.fn(async () => null) })
    expect(await port.fromDirectory()).toBeNull()
  })
})
