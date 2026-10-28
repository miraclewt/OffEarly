// T26 · backupGc：AssetStore.gc 与 VaultStore 之间的适配器。
//
// 用真的 VaultStore + 真的 AssetStore + mockFs。最容易错的两处——「cleanup 有没有把删成功的 id
// 从 assets 表摘掉」与「确认清单里若有人已重新被引用，能不能拦住不删」——用假件会验成空气。

import { describe, expect, it } from 'vitest'

import { createVaultStore } from '../../src/domain/store'
import type { Task, Vault } from '../../src/domain/types'
import { createBackupGcPort } from '../../src/controllers/backupGc'
import { createAssetStore } from '../../src/persistence/assetStore'
import { asDirHandle, makeDir, makeFile } from '../persistence/mockFs'

function makeTask(id: string, note: string): Task {
  return {
    id,
    topicId: 'topic-1',
    title: `任务 ${id}`,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note,
    order: 'm',
    createdAt: '2026-10-16T09:00:00.000Z',
    updatedAt: '2026-10-16T09:00:00.000Z',
    archived: false,
  }
}

function emptyVault(): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: '0.1.0',
    revision: 1,
    updatedAt: '2026-10-16T09:00:00.000Z',
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'auto',
      lastFilter: null,

      noteFontSize: 13,
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    trash: [],
  }
}

function setup() {
  const dir = makeDir('vault', {
    dirs: [
      makeDir('assets', {
        files: [makeFile('a1.png', { bytes: new Uint8Array([1]) }), makeFile('a2.png', { bytes: new Uint8Array([2]) })],
      }),
    ],
  })
  const assets = createAssetStore(asDirHandle(dir), {
    newId: () => 'a1',
    now: () => new Date('2026-10-16T09:00:00.000Z'),
    createObjectURL: () => 'blob:offearly/x',
    revokeObjectURL: () => undefined,
  })
  const vault: Vault = {
    ...emptyVault(),
    assets: [
      { id: 'a1', filename: 'assets/a1.png', sizeBytes: 1, createdAt: 'x' },
      { id: 'a2', filename: 'assets/a2.png', sizeBytes: 2, createdAt: 'x' },
    ],
    tasks: [makeTask('t1', '![](assets/a1.png)')],
  }
  const store = createVaultStore(vault)
  const port = createBackupGcPort(store, assets)
  return { dir, store, port }
}

describe('T26 · backupGc 端口', () => {
  it('preview 读当前 vault，返回未引用清单（a1 被引用、a2 未引用）', async () => {
    const { port } = setup()
    const preview = await port.preview()
    expect(preview.unreferenced.map((c) => c.id)).toEqual(['a2'])
    expect(preview.reclaimableBytes).toBe(2)
  })

  it('cleanup 删文件 + 摘 assets 表记录，返回删成功的 id', async () => {
    const { dir, store, port } = setup()
    const removed = await port.cleanup(['a2'])
    expect(removed).toEqual(['a2'])
    expect(dir.dirs.get('assets')?.files.has('a2.png')).toBe(false)
    expect(store.getVault().assets.map((a) => a.id)).toEqual(['a1'])
  })

  it('二次校验：确认清单里已重新被引用的 id 会被拦住，不误删', async () => {
    const { dir, store, port } = setup()
    // a1 在 note 里被引用，即使塞进确认清单也不该删
    const removed = await port.cleanup(['a1', 'a2'])
    expect(removed).toEqual(['a2'])
    expect(dir.dirs.get('assets')?.files.has('a1.png')).toBe(true)
    expect(store.getVault().assets.map((a) => a.id).sort()).toEqual(['a1'])
  })

  it('确认清单全被引用 → 不删任何文件，表也不动', async () => {
    const { dir, store, port } = setup()
    const removed = await port.cleanup(['a1'])
    expect(removed).toEqual([])
    expect(dir.dirs.get('assets')?.files.size).toBe(2)
    expect(store.getVault().assets).toHaveLength(2)
  })
})
