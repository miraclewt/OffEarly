import { describe, expect, it, vi } from 'vitest'

import { migrate } from '../../src/domain/schema'
import type { Vault } from '../../src/domain/types'
import * as fsReal from '../../src/persistence/fsAdapter'
import {
  VAULT_FILE,
  createNewVault,
  createVaultRepository,
} from '../../src/persistence/vaultRepository'
import type { VaultFs } from '../../src/persistence/vaultRepository'
import { asDirHandle, makeDir, makeFile } from './mockFs'
import type { MockDirHandle } from './mockFs'

const ENCODER = new TextEncoder()

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function dirWithVault(text: string): MockDirHandle {
  return makeDir('vault', { files: [makeFile(VAULT_FILE, { text })] })
}

function fsSpies(): VaultFs {
  return {
    readText: vi.fn(fsReal.readText),
    writeText: vi.fn(fsReal.writeText),
    readHead: vi.fn(fsReal.readHead),
  }
}

describe('load', () => {
  it('读取合法 vault.json，经 Zod 校验与迁移后返回 Vault', async () => {
    const created = createNewVault(new Date('2026-10-15T08:00:00.000Z'))
    const dir = dirWithVault(JSON.stringify(created))

    const vault = await createVaultRepository(asDirHandle(dir)).load()

    expect(vault).not.toBeNull()
    expect(vault?.vaultId).toBe(created.vaultId)
    expect(vault?.schemaVersion).toBe(1)
    expect(vault?.settings.boardColumns).toEqual(['todo', 'doing', 'review', 'done'])
  })

  it('settings 缺失时按默认补齐（用户手改 vault.json 最常见遗漏）', async () => {
    const dir = dirWithVault(
      JSON.stringify({ ...createNewVault(), settings: undefined }),
    )

    const vault = await createVaultRepository(asDirHandle(dir)).load()

    expect(vault?.settings.locale).toBe('auto')
  })

  it('vault.json 不存在时返回 null', async () => {
    const dir = makeDir('vault')

    await expect(createVaultRepository(asDirHandle(dir)).load()).resolves.toBeNull()
  })

  it('JSON 语法损坏时抛 VaultValidationError 且原文件字节不变', async () => {
    const original = '{"schemaVersion":1,"vaultId":"abc"'
    const dir = dirWithVault(original)

    await expect(createVaultRepository(asDirHandle(dir)).load()).rejects.toMatchObject({
      name: 'VaultValidationError',
      message: 'vault.json 不是合法的 JSON',
    })
    expect(dir.files.get(VAULT_FILE)?.bytes()).toEqual(ENCODER.encode(original))
  })

  it('结构非法（缺 tasks 等必填数组）时抛校验错且不写盘', async () => {
    const original = JSON.stringify({ schemaVersion: 1, vaultId: 'abc' })
    const dir = dirWithVault(original)

    await expect(createVaultRepository(asDirHandle(dir)).load()).rejects.toMatchObject({
      name: 'VaultValidationError',
      message: 'vault.json 未通过结构校验',
    })
    expect(dir.files.get(VAULT_FILE)?.bytes()).toEqual(ENCODER.encode(original))
  })

  it('schemaVersion 高于当前版本时拒绝加载', async () => {
    const dir = dirWithVault(
      JSON.stringify({ ...createNewVault(), schemaVersion: 2 }),
    )

    await expect(createVaultRepository(asDirHandle(dir)).load()).rejects.toThrow(/请升级 OffEarly/)
  })
})

describe('save', () => {
  it('把 Vault 序列化写回 vault.json', async () => {
    const dir = makeDir('vault')
    const repo = createVaultRepository(asDirHandle(dir))
    const vault = createNewVault(new Date('2026-10-15T08:00:00.000Z'))

    await repo.save(vault)

    const written = dir.files.get(VAULT_FILE)
    expect(written).toBeDefined()
    const roundTripped = migrate(JSON.parse(decode(written!.bytes())))
    expect(roundTripped.vaultId).toBe(vault.vaultId)
    expect(roundTripped.revision).toBe(0)
  })
})

describe('peekRevision', () => {
  it('从文件头提取 revision，不加载全量（不触碰 readText）', async () => {
    const padding = 'x'.repeat(6000)
    // revision 固定在第四位（save 自己控制键序），必然落在文件头内
    const text = `{"schemaVersion":1,"vaultId":"v","appVersion":"a","revision":41,"updatedAt":"2026-10-15T00:00:00.000Z","pad":"${padding}"}`
    const dir = dirWithVault(text)
    const spies = fsSpies()

    const revision = await createVaultRepository(asDirHandle(dir), spies).peekRevision()

    expect(revision).toBe(41)
    expect(spies.readHead).toHaveBeenCalledTimes(1)
    expect(spies.readText).not.toHaveBeenCalled()
  })

  it('文件小于读取上限时直接整读并标记 whole', async () => {
    const vault = createNewVault()
    const dir = dirWithVault(JSON.stringify(vault))

    await expect(createVaultRepository(asDirHandle(dir)).peekRevision()).resolves.toBe(0)
  })

  it('vault.json 不存在时返回 null', async () => {
    const dir = makeDir('vault')

    await expect(createVaultRepository(asDirHandle(dir)).peekRevision()).resolves.toBeNull()
  })

  it('revision 不在文件头时退回全量解析取真实值', async () => {
    // 键序被打乱：revision 挪到超大字段之后，4096 字节头里抓不到
    const vault = createNewVault(new Date('2026-10-15T08:00:00.000Z'))
    const text =
      '{"pad":"' + 'y'.repeat(6000) + '",' + JSON.stringify(vault).slice(1)
    const dir = dirWithVault(text)

    await expect(createVaultRepository(asDirHandle(dir)).peekRevision()).resolves.toBe(0)
  })

  it('文件存在但没有 revision 字段时抛 VaultValidationError', async () => {
    const dir = dirWithVault('{"note":"hello"}')

    await expect(createVaultRepository(asDirHandle(dir)).peekRevision()).rejects.toMatchObject({
      name: 'VaultValidationError',
    })
  })
})

describe('create', () => {
  it('初始化新库：vaultId 为 nanoid、revision=0、schemaVersion=1、settings 带默认值', async () => {
    const dir = makeDir('vault')

    const vault = await createVaultRepository(asDirHandle(dir)).create()

    expect(vault.schemaVersion).toBe(1)
    expect(vault.revision).toBe(0)
    expect(vault.vaultId).toMatch(/^[A-Za-z0-9_-]{21}$/)
    expect(vault.appVersion).toContain('OffEarly')
    expect(vault.topics).toEqual([])
    expect(vault.tasks).toEqual([])
    expect(vault.settings.calendar.workdays).toEqual([1, 2, 3, 4, 5])
    // 已落盘：重新 load 能读回同一个库
    await expect(createVaultRepository(asDirHandle(dir)).load()).resolves.toMatchObject({
      vaultId: vault.vaultId,
    })
  })

  it('建库时补齐 assets/ 与 .backup/ 子目录', async () => {
    const dir = makeDir('vault')

    await createVaultRepository(asDirHandle(dir)).create()

    expect(dir.dirs.has('assets')).toBe(true)
    expect(dir.dirs.has('.backup')).toBe(true)
  })

  it('已有 vault.json 时拒绝覆盖并保留原内容', async () => {
    const original = JSON.stringify(createNewVault())
    const dir = dirWithVault(original)

    await expect(createVaultRepository(asDirHandle(dir)).create()).rejects.toMatchObject({
      name: 'VaultValidationError',
    })
    expect(decode(dir.files.get(VAULT_FILE)!.bytes())).toBe(original)
  })
})

describe('createNewVault', () => {
  it('每次生成不同的 vaultId', () => {
    expect(createNewVault().vaultId).not.toBe(createNewVault().vaultId)
  })

  it('updatedAt 使用 ISO 时间戳', () => {
    const vault: Vault = createNewVault(new Date('2026-10-15T08:30:00.000Z'))
    expect(vault.updatedAt).toBe('2026-10-15T08:30:00.000Z')
  })
})
