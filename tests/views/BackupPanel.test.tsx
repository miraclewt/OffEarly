// @vitest-environment jsdom
//
// T26 · BackupPanel（最小版）的「清理未引用附件」入口。
//
// 口径：先「扫描」出只读清单、再「确认清理」才动 gc——两层之间必须隔一次确认。
// 组件是纯视图，gc 经 props 注入，这里用假端口验证「点了哪个、什么时候点、传给端口什么」。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Vault } from '../../src/domain/types'
import type { SnapshotInfo } from '../../src/persistence/snapshotStore'
import type { ExportSummary } from '../../src/persistence/backupIO'
import type { BackupGcPort } from '../../src/controllers/backupGc'
import type { BackupExportPort, BackupImportPort, BackupSnapshotPort } from '../../src/controllers/backupPort'
import { BackupPanel } from '../../src/views/BackupPanel'

function makePort(overrides: Partial<BackupGcPort> = {}): BackupGcPort {
  return {
    preview: vi.fn(async () => ({ totalCount: 0, referencedCount: 0, unreferenced: [], reclaimableBytes: 0 })),
    cleanup: vi.fn(async () => []),
    ...overrides,
  }
}

function setup(props: Partial<Parameters<typeof BackupPanel>[0]> = {}) {
  const gc = props.gc ?? makePort()
  render(<BackupPanel gc={gc} assetCount={props.assetCount} assetTotalBytes={props.assetTotalBytes} {...props} />)
  return { gc }
}

afterEach(cleanup)

describe('T26-1 · 附件概况与入口', () => {
  it('展示附件总数与总字节（人类可读单位）', () => {
    setup({ assetCount: 2, assetTotalBytes: 2048 })
    expect(screen.getByTestId('backup-panel').textContent).toContain('附件：2 个')
    expect(screen.getByTestId('backup-panel').textContent).toContain('2.0 KB')
  })

  it('没有附件时给一句空态，不给扫描入口', () => {
    setup({ assetCount: 0, assetTotalBytes: 0 })
    expect(screen.getByTestId('backup-panel').textContent).toContain('当前库还没有附件')
  })

  it('未注入 gc 端口时扫描按钮置灰', () => {
    setup({ gc: undefined, assetCount: 1, assetTotalBytes: 10 })
    expect((screen.getByTestId('backup-gc-scan') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('T26-2 · 扫描 → 展示预览（先看清再确认）', () => {
  it('点扫描调用 preview，展示未引用清单 + 可释放字节', async () => {
    const gc = makePort({
      preview: vi.fn(async () => ({
        totalCount: 3,
        referencedCount: 1,
        unreferenced: [
          { id: 'a2', filename: 'assets/a2.png', sizeBytes: 2048 },
          { id: 'a3', filename: 'assets/a3.png', sizeBytes: 1024 },
        ],
        reclaimableBytes: 3072,
      })),
    })
    setup({ gc, assetCount: 3, assetTotalBytes: 3072 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    expect(gc.preview).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('backup-gc-preview')).toBeTruthy()
    expect(screen.getByTestId('backup-gc-item-a2').textContent).toContain('assets/a2.png')
    expect(screen.getByTestId('backup-gc-reclaim').textContent).toContain('3.0 KB')
    // 扫描阶段不得触碰 cleanup
    expect(gc.cleanup).not.toHaveBeenCalled()
  })

  it('没有未引用附件 → 提示空态，不给确认按钮', async () => {
    const gc = makePort({
      preview: vi.fn(async () => ({ totalCount: 1, referencedCount: 1, unreferenced: [], reclaimableBytes: 0 })),
    })
    setup({ gc, assetCount: 1, assetTotalBytes: 10 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    expect(await screen.findByTestId('backup-gc-preview')).toBeTruthy()
    expect(screen.getByTestId('backup-gc-preview').textContent).toContain('没有可回收的附件')
    expect(screen.queryByTestId('backup-gc-confirm')).toBeNull()
  })

  it('preview 失败时展示错误，不进确认态', async () => {
    const gc = makePort({ preview: vi.fn(async () => { throw new Error('boom') }) })
    setup({ gc, assetCount: 1, assetTotalBytes: 10 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    expect(await screen.findByTestId('backup-gc-error')).toBeTruthy()
    expect(screen.queryByTestId('backup-gc-preview')).toBeNull()
  })
})

describe('T26-3 · 确认清理（第二次点击才真删）', () => {
  it('确认后把清单里的 id 全部交给 cleanup，并展示释放量', async () => {
    const gc = makePort({
      preview: vi.fn(async () => ({
        totalCount: 2,
        referencedCount: 0,
        unreferenced: [
          { id: 'a1', filename: 'assets/a1.png', sizeBytes: 100 },
          { id: 'a2', filename: 'assets/a2.png', sizeBytes: 200 },
        ],
        reclaimableBytes: 300,
      })),
      cleanup: vi.fn(async (ids) => [...ids]),
    })
    setup({ gc, assetCount: 2, assetTotalBytes: 300 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    fireEvent.click(await screen.findByTestId('backup-gc-confirm'))
    await screen.findByTestId('backup-gc-status')
    expect(gc.cleanup).toHaveBeenCalledWith(['a1', 'a2'])
    expect(screen.getByTestId('backup-gc-status').textContent).toContain('已清理 2 个附件')
  })

  it('cleanup 失败展示错误，不误报成功', async () => {
    const gc = makePort({
      preview: vi.fn(async () => ({
        totalCount: 1,
        referencedCount: 0,
        unreferenced: [{ id: 'a1', filename: 'assets/a1.png', sizeBytes: 10 }],
        reclaimableBytes: 10,
      })),
      cleanup: vi.fn(async () => { throw new Error('boom') }),
    })
    setup({ gc, assetCount: 1, assetTotalBytes: 10 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    fireEvent.click(await screen.findByTestId('backup-gc-confirm'))
    expect(await screen.findByTestId('backup-gc-error')).toBeTruthy()
    expect(screen.queryByTestId('backup-gc-status')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T28 · 快照列表 / 恢复 / 导出库副本 / 导入（端口注入，纯视图验证「点了哪个、传了什么」）
// ─────────────────────────────────────────────────────────────────────────────

function makeSnapshotPort(overrides: Partial<BackupSnapshotPort> = {}): BackupSnapshotPort {
  return {
    list: vi.fn(async () => []),
    snapshot: vi.fn(async () => snapshotInfo('vault-20261015-093012.json')),
    restore: vi.fn(async () => snapshotInfo('vault-20261015-093012.json')),
    ...overrides,
  }
}

function makeExportPort(overrides: Partial<BackupExportPort> = {}): BackupExportPort {
  return { exportCopy: vi.fn(async () => ({ files: 2, bytes: 100 }) as ExportSummary), ...overrides }
}

function makeImportPort(overrides: Partial<BackupImportPort> = {}): BackupImportPort {
  return {
    parse: vi.fn(() => ({ tasks: [], milestones: [], assets: [] }) as unknown as Vault),
    fromDirectory: vi.fn(async () => null),
    ...overrides,
  }
}

function snapshotInfo(id: string): SnapshotInfo {
  return { id, createdAt: '2026-10-15T09:30:12+08:00', sizeBytes: 2048, taskCount: 5 }
}

const importVault = { tasks: [{}, {}], milestones: [{}], assets: [{}, {}, {}] } as unknown as Vault

function chooseVaultFile(): void {
  const file = new File(['{"tasks":[]}'], 'vault.json', { type: 'application/json' })
  fireEvent.change(screen.getByTestId('backup-import-file-input'), { target: { files: [file] } })
}

describe('T28-1 · 快照列表 / 立即快照', () => {
  it('挂载即加载列表，展示时间 / 大小 / 任务数', async () => {
    const snapshots = makeSnapshotPort({ list: vi.fn(async () => [snapshotInfo('vault-20261015-093012.json')]) })
    setup({ snapshots })
    const item = await screen.findByTestId('backup-snapshot-item-vault-20261015-093012.json')
    expect(snapshots.list).toHaveBeenCalledTimes(1)
    expect(item.textContent).toContain('2026-10-15 09:30')
    expect(item.textContent).toContain('2.0 KB')
    expect(item.textContent).toContain('5 个任务')
  })

  it('没有快照时显示空态', async () => {
    setup({ snapshots: makeSnapshotPort({ list: vi.fn(async () => []) }) })
    await waitFor(() => expect(screen.getByTestId('backup-panel').textContent).toContain('还没有快照'))
  })

  it('点「立即快照」调 snapshot()，随后刷新列表', async () => {
    const snapshots = makeSnapshotPort({
      list: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([snapshotInfo('vault-1.json')]),
      snapshot: vi.fn(async () => snapshotInfo('vault-1.json')),
    })
    setup({ snapshots })
    fireEvent.click(screen.getByTestId('backup-snapshot-now'))
    await waitFor(() => expect(snapshots.snapshot).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('backup-snapshot-item-vault-1.json')).toBeTruthy()
  })

  it('未注入快照端口时「立即快照」置灰', () => {
    setup({ snapshots: undefined })
    expect((screen.getByTestId('backup-snapshot-now') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('T28-2 · 恢复（先确认再动）', () => {
  it('点「恢复」进入确认态，不立即调 restore', async () => {
    const snapshots = makeSnapshotPort({ list: vi.fn(async () => [snapshotInfo('vault-1.json')]) })
    setup({ snapshots })
    fireEvent.click(await screen.findByTestId('backup-snapshot-restore-vault-1.json'))
    expect(await screen.findByTestId('backup-snapshot-restore-confirm')).toBeTruthy()
    expect(snapshots.restore).not.toHaveBeenCalled()
  })

  it('确认恢复调 restore(id)，刷新列表并触发 onRestored', async () => {
    const snapshots = makeSnapshotPort({ list: vi.fn(async () => [snapshotInfo('vault-1.json')]) })
    const onRestored = vi.fn()
    setup({ snapshots, onRestored })
    fireEvent.click(await screen.findByTestId('backup-snapshot-restore-vault-1.json'))
    fireEvent.click(await screen.findByTestId('backup-snapshot-restore-confirm'))
    await waitFor(() => expect(snapshots.restore).toHaveBeenCalledWith('vault-1.json'))
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1))
  })

  it('取消恢复回到未确认态，不调 restore', async () => {
    const snapshots = makeSnapshotPort({ list: vi.fn(async () => [snapshotInfo('vault-1.json')]) })
    setup({ snapshots })
    fireEvent.click(await screen.findByTestId('backup-snapshot-restore-vault-1.json'))
    fireEvent.click(await screen.findByTestId('backup-snapshot-restore-cancel'))
    await waitFor(() => expect(screen.queryByTestId('backup-snapshot-restore-confirm')).toBeNull())
    expect(snapshots.restore).not.toHaveBeenCalled()
  })
})

describe('T28-3 · 导出库副本', () => {
  it('点导出调 exportCopy，展示文件数与字节', async () => {
    const exporter = makeExportPort({ exportCopy: vi.fn(async () => ({ files: 3, bytes: 5120 })) })
    setup({ exporter })
    fireEvent.click(screen.getByTestId('backup-export'))
    await waitFor(() => expect(exporter.exportCopy).toHaveBeenCalledTimes(1))
    await screen.findByTestId('backup-export-result')
    expect(screen.getByTestId('backup-export-result').textContent).toContain('3 个文件')
    expect(screen.getByTestId('backup-export-result').textContent).toContain('5.0 KB')
  })

  it('导出取消（返回 null）不显示结果', async () => {
    const exporter = makeExportPort({ exportCopy: vi.fn(async () => null) })
    setup({ exporter })
    fireEvent.click(screen.getByTestId('backup-export'))
    await waitFor(() => expect(exporter.exportCopy).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('backup-export-result')).toBeNull()
  })

  it('未注入导出端口时按钮置灰', () => {
    setup({ exporter: undefined })
    expect((screen.getByTestId('backup-export') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('T28-4 · 导入（文件 / 文件夹 → 预览 → 二次确认）', () => {
  it('选择 vault.json 文件 → parse → 展示导入预览', async () => {
    const importer = makeImportPort({ parse: vi.fn(() => importVault) })
    setup({ importer, onImported: vi.fn() })
    fireEvent.click(screen.getByTestId('backup-import-file'))
    chooseVaultFile()
    const preview = await screen.findByTestId('backup-import-preview')
    expect(importer.parse).toHaveBeenCalledWith('{"tasks":[]}')
    expect(preview.textContent).toContain('2 个任务')
    expect(preview.textContent).toContain('1 个里程碑')
    expect(preview.textContent).toContain('3 个附件')
  })

  it('确认导入调 onImported(vault)', async () => {
    const importer = makeImportPort({ parse: vi.fn(() => importVault) })
    const onImported = vi.fn()
    setup({ importer, onImported, currentTaskCount: 10 })
    fireEvent.click(screen.getByTestId('backup-import-file'))
    chooseVaultFile()
    fireEvent.click(await screen.findByTestId('backup-import-confirm'))
    expect(onImported).toHaveBeenCalledWith(importVault)
    await screen.findByTestId('backup-import-status')
  })

  it('取消导入不调 onImported', async () => {
    const importer = makeImportPort({ parse: vi.fn(() => importVault) })
    const onImported = vi.fn()
    setup({ importer, onImported })
    fireEvent.click(screen.getByTestId('backup-import-file'))
    chooseVaultFile()
    fireEvent.click(await screen.findByTestId('backup-import-cancel'))
    expect(onImported).not.toHaveBeenCalled()
    expect(screen.queryByTestId('backup-import-preview')).toBeNull()
  })

  it('parse 失败展示错误，不进预览', async () => {
    const importer = makeImportPort({
      parse: vi.fn(() => {
        throw new Error('bad vault')
      }),
    })
    setup({ importer, onImported: vi.fn() })
    fireEvent.click(screen.getByTestId('backup-import-file'))
    chooseVaultFile()
    await screen.findByTestId('backup-import-error')
    expect(screen.queryByTestId('backup-import-preview')).toBeNull()
  })

  it('从文件夹导入 → fromDirectory → parse → 预览', async () => {
    const importer = makeImportPort({
      fromDirectory: vi.fn(async () => '{"tasks":[]}'),
      parse: vi.fn(() => importVault),
    })
    setup({ importer, onImported: vi.fn() })
    fireEvent.click(screen.getByTestId('backup-import-dir'))
    await waitFor(() => expect(importer.fromDirectory).toHaveBeenCalledTimes(1))
    await screen.findByTestId('backup-import-preview')
  })

  it('未注入导入端口时按钮置灰', () => {
    setup({ importer: undefined })
    expect((screen.getByTestId('backup-import-file') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('backup-import-dir') as HTMLButtonElement).disabled).toBe(true)
  })
})
