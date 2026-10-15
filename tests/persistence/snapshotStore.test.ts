import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Task, Vault } from '../../src/domain/types'
import { createNewVault } from '../../src/persistence/vaultRepository'
import {
  AUTO_SNAPSHOT_INTERVAL_MS,
  BACKUP_DIR,
  DAILY_KEEP_DAYS,
  KEEP_RECENT,
  SnapshotError,
  createSnapshotStore,
  formatSnapshotStamp,
  parseSnapshotStamp,
  selectRetained,
  toLocalIso,
} from '../../src/persistence/snapshotStore'
import type { SnapshotInfo } from '../../src/persistence/snapshotStore'
import { asDirHandle, makeDir, makeFile } from './mockFs'
import type { MockDirHandle } from './mockFs'

const ENCODER = new TextEncoder()

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function makeTask(i: number, at: string): Task {
  return {
    id: `t-${i}`,
    topicId: 'topic-1',
    title: `Task ${i}`,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note: '',
    order: 'm',
    createdAt: at,
    updatedAt: at,
    archived: false,
  }
}

/** 带 n 条任务的库：list() 的「任务数」断言用。 */
function vaultWithTasks(n: number): Vault {
  const base = createNewVault(new Date(2026, 9, 15, 0, 0, 0))
  const at = base.updatedAt
  return { ...base, tasks: Array.from({ length: n }, (_, i) => makeTask(i, at)) }
}

/** 建一个含 vault.json 的数据文件夹。 */
function dirWithVault(n = 3): { dir: MockDirHandle; text: string } {
  const text = JSON.stringify(vaultWithTasks(n))
  const dir = makeDir('vault', { files: [makeFile('vault.json', { text })] })
  return { dir, text }
}

/** 直接把快照文件塞进 .backup/，用于构造保留策略样本。 */
function seedBackups(dir: MockDirHandle, stamps: Date[], taskCount = 2): void {
  let backup = dir.dirs.get(BACKUP_DIR)
  if (backup === undefined) {
    backup = makeDir(BACKUP_DIR)
    dir.dirs.set(BACKUP_DIR, backup)
  }
  for (const at of stamps) {
    const name = `vault-${formatSnapshotStamp(at)}.json`
    backup.files.set(name, makeFile(name, { text: JSON.stringify(vaultWithTasks(taskCount)) }))
  }
}

function backupOf(dir: MockDirHandle): MockDirHandle {
  const backup = dir.dirs.get(BACKUP_DIR)
  if (backup === undefined) throw new Error('.backup 不存在')
  return backup
}

function infoAt(at: Date, taskCount = 3): SnapshotInfo {
  return {
    id: `vault-${formatSnapshotStamp(at)}.json`,
    createdAt: toLocalIso(at),
    sizeBytes: 100,
    taskCount,
  }
}

const T = (d: number, h: number, m: number, s = 0): Date => new Date(2026, 9, d, h, m, s)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T(15, 9, 30, 12))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('snapshot()', () => {
  it('把当前 vault.json 逐字节复制为 .backup/vault-<YYYYMMDD-HHmmss>.json', async () => {
    const { dir, text } = dirWithVault(3)
    const store = createSnapshotStore(asDirHandle(dir))

    const info = await store.snapshot()

    expect(info.id).toBe('vault-20261015-093012.json')
    expect(info.taskCount).toBe(3)
    expect(info.createdAt).toBe(toLocalIso(T(15, 9, 30, 12)))
    // 内容是当前 vault.json 的副本，不是重新序列化的对象
    expect(backupOf(dir).files.get(info.id)?.bytes()).toEqual(ENCODER.encode(text))
  })

  it('文件名时间戳取自注入时钟的本地时间（换一个时刻换一个文件名）', async () => {
    const { dir } = dirWithVault(1)
    vi.setSystemTime(T(3, 0, 5, 7))
    const store = createSnapshotStore(asDirHandle(dir))

    const info = await store.snapshot()

    expect(info.id).toBe('vault-20261003-000507.json')
    expect(parseSnapshotStamp(info.id)?.getTime()).toBe(T(3, 0, 5, 7).getTime())
  })

  it('vault.json 不存在时抛 SnapshotError，且不产生空快照', async () => {
    const dir = makeDir('vault')
    const store = createSnapshotStore(asDirHandle(dir))

    await expect(store.snapshot()).rejects.toBeInstanceOf(SnapshotError)
    await expect(store.list()).resolves.toEqual([])
  })

  it('同一秒内重复快照不覆盖，追加序号', async () => {
    const { dir } = dirWithVault(1)
    const store = createSnapshotStore(asDirHandle(dir))

    const first = await store.snapshot()
    const second = await store.snapshot()

    expect(first.id).toBe('vault-20261015-093012.json')
    expect(second.id).toBe('vault-20261015-093012-2.json')
    expect(await store.list()).toHaveLength(2)
  })
})

describe('自动策略：每会话首存 1 份 + 距上次 ≥30min 1 份', () => {
  it('会话首次 autoSnapshot 打一份', async () => {
    const { dir } = dirWithVault(1)
    const store = createSnapshotStore(asDirHandle(dir))

    const info = await store.autoSnapshot()

    expect(info).not.toBeNull()
    expect(await store.list()).toHaveLength(1)
  })

  it('30 分钟内的第二次 autoSnapshot 跳过（不落盘）', async () => {
    const { dir } = dirWithVault(1)
    const store = createSnapshotStore(asDirHandle(dir))
    await store.autoSnapshot()

    vi.setSystemTime(new Date(T(15, 9, 30, 12).getTime() + AUTO_SNAPSHOT_INTERVAL_MS - 1))
    const skipped = await store.autoSnapshot()

    expect(skipped).toBeNull()
    expect(await store.list()).toHaveLength(1)
  })

  it('距上次快照满 30 分钟后再打一份', async () => {
    const { dir } = dirWithVault(1)
    const store = createSnapshotStore(asDirHandle(dir))
    await store.autoSnapshot()

    vi.setSystemTime(new Date(T(15, 9, 30, 12).getTime() + AUTO_SNAPSHOT_INTERVAL_MS))
    const second = await store.autoSnapshot()

    expect(second).not.toBeNull()
    expect(await store.list()).toHaveLength(2)
  })

  it('手动 snapshot() 也重置 30 分钟窗口（用户刚备份过就不用再自动备份）', async () => {
    const { dir } = dirWithVault(1)
    const store = createSnapshotStore(asDirHandle(dir))
    await store.snapshot()

    vi.setSystemTime(new Date(T(15, 9, 30, 12).getTime() + 60_000))
    const skipped = await store.autoSnapshot()

    expect(skipped).toBeNull()
  })
})

describe('保留策略：最近 20 份 + 每日首份保留 30 天', () => {
  it('最近 20 份之外的旧样本被删，当日首份被保护（25 份样本 → 留 21）', () => {
    const now = T(15, 12, 0)
    // 同日 00:00..00:24，共 25 份
    const entries = Array.from({ length: 25 }, (_, i) => infoAt(T(15, 0, i)))

    const kept = selectRetained(entries, now)

    expect(kept).toHaveLength(21)
    // 保留：当日首份 00:00 + 最近 20 份（00:05..00:24）；00:01..00:04 被删
    expect(kept.map((e) => e.createdAt.slice(14, 16))).toEqual([
      '00',
      '05',
      '06',
      '07',
      '08',
      '09',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20',
      '21',
      '22',
      '23',
      '24',
    ])
  })

  it('每日首份超过 30 天不再保护，窗口内的每日首份即便不在最近 20 份也保留', () => {
    const now = T(15, 12, 0)
    const tooOld = infoAt(new Date(2026, 8, 1, 0, 0, 0)) // 9 月 1 日，距 10-15 共 44 天，>30 天
    const withinWindow = infoAt(new Date(2026, 8, 20, 0, 0, 0)) // 9 月 20 日，<30 天
    const today = Array.from({ length: 20 }, (_, i) => infoAt(T(15, 0, i)))

    const kept = selectRetained([tooOld, withinWindow, ...today], now)
    const ids = kept.map((e) => e.id)

    expect(ids).not.toContain(tooOld.id)
    expect(ids).toContain(withinWindow.id)
    expect(kept).toHaveLength(21)
  })

  it('可直接配参数（keepRecent / dailyKeepDays）', () => {
    const entries = Array.from({ length: 5 }, (_, i) => infoAt(T(15, 0, i)))

    // 最近 2 份（00:03、00:04）+ 当日首份 00:00（1 天窗口内）
    expect(selectRetained(entries, T(15, 12, 0), { keepRecent: 2, dailyKeepDays: 1 })).toHaveLength(3)
  })

  it('snapshot() 落盘后按保留策略清理磁盘上的旧快照', async () => {
    const { dir } = dirWithVault(1)
    // 25 份同日旧样本（00:00..00:24），本次 snapshot 落在 12:00
    seedBackups(dir, Array.from({ length: 25 }, (_, i) => T(15, 0, i)))
    vi.setSystemTime(T(15, 12, 0))
    const store = createSnapshotStore(asDirHandle(dir))

    await store.snapshot()

    const list = await store.list()
    expect(list).toHaveLength(21)
    // 最早的那批 00:01..00:05 被删
    for (const m of ['000100', '000200', '000300', '000400', '000500']) {
      expect(backupOf(dir).files.has(`vault-20261015-${m}.json`)).toBe(false)
    }
    // 当日首份与最新的那份仍在
    expect(backupOf(dir).files.has('vault-20261015-000000.json')).toBe(true)
    expect(backupOf(dir).files.has('vault-20261015-120000.json')).toBe(true)
  })
})

describe('list()', () => {
  it('返回时间 / 大小 / 任务数，按时间倒序', async () => {
    const { dir } = dirWithVault(3)
    seedBackups(dir, [T(14, 9, 0), T(15, 8, 0)])
    const store = createSnapshotStore(asDirHandle(dir))

    const list = await store.list()

    expect(list.map((s) => s.id)).toEqual([
      'vault-20261015-080000.json',
      'vault-20261014-090000.json',
    ])
    expect(list[0]?.taskCount).toBe(2)
    expect(list[0]?.sizeBytes).toBeGreaterThan(0)
    expect(list[0]?.createdAt).toBe(toLocalIso(T(15, 8, 0)))
  })

  it('.backup 目录不存在时返回空数组（不抛错）', async () => {
    const { dir } = dirWithVault(1)
    const store = createSnapshotStore(asDirHandle(dir))

    await expect(store.list()).resolves.toEqual([])
  })

  it('忽略非快照命名的文件', async () => {
    const { dir } = dirWithVault(1)
    const backup = makeDir(BACKUP_DIR)
    backup.files.set('notes.txt', makeFile('notes.txt', { text: 'hello' }))
    backup.files.set('vault-20261014-090000.json', makeFile('vault-20261014-090000.json', { text: '{}' }))
    dir.dirs.set(BACKUP_DIR, backup)
    const store = createSnapshotStore(asDirHandle(dir))

    const list = await store.list()

    expect(list.map((s) => s.id)).toEqual(['vault-20261014-090000.json'])
  })
})

describe('restore()', () => {
  it('恢复前先对当前版本再打一份快照，再覆盖 vault.json', async () => {
    const currentText = JSON.stringify(vaultWithTasks(5))
    const snapshotText = JSON.stringify(vaultWithTasks(1))
    const dir = makeDir('vault', { files: [makeFile('vault.json', { text: currentText })] })
    const backup = makeDir(BACKUP_DIR, {
      files: [makeFile('vault-20261014-090000.json', { text: snapshotText })],
    })
    dir.dirs.set(BACKUP_DIR, backup)
    const store = createSnapshotStore(asDirHandle(dir))

    const safety = await store.restore('vault-20261014-090000.json')

    // 恢复动作本身产生了防误操作快照，且内容是恢复前的当前版本（5 条任务）
    expect(safety.taskCount).toBe(5)
    expect(backupOf(dir).files.get(safety.id)?.bytes()).toEqual(ENCODER.encode(currentText))
    // vault.json 已被覆盖为所选快照的内容（1 条任务）
    expect(decode(dir.files.get('vault.json')!.bytes())).toBe(snapshotText)
  })

  it('快照不存在时抛错，且不覆盖 vault.json', async () => {
    const { dir, text } = dirWithVault(2)
    const store = createSnapshotStore(asDirHandle(dir))

    await expect(store.restore('vault-19990101-000000.json')).rejects.toBeInstanceOf(SnapshotError)
    expect(decode(dir.files.get('vault.json')!.bytes())).toBe(text)
  })
})

describe('autoSnapshotter()：桥接 T08 autosave 的写前快照端口', () => {
  it('首次保存打一份快照；30 分钟内再调用是 no-op（不刷备份）', async () => {
    const { dir } = dirWithVault(2)
    const store = createSnapshotStore(asDirHandle(dir))

    await store.autoSnapshotter().snapshot()
    await store.autoSnapshotter().snapshot()

    expect(await store.list()).toHaveLength(1)
  })
})

describe('常量与工具', () => {
  it('保留策略参数与 spec 8.4 一致', () => {
    expect(KEEP_RECENT).toBe(20)
    expect(DAILY_KEEP_DAYS).toBe(30)
    expect(AUTO_SNAPSHOT_INTERVAL_MS).toBe(30 * 60 * 1000)
  })

  it('parseSnapshotStamp 对非快照命名返回 null', () => {
    expect(parseSnapshotStamp('vault-20261015-093012.json')).not.toBeNull()
    expect(parseSnapshotStamp('vault-20261015-093012-3.json')).not.toBeNull()
    expect(parseSnapshotStamp('note.md')).toBeNull()
    expect(parseSnapshotStamp('vault.json')).toBeNull()
  })
})
