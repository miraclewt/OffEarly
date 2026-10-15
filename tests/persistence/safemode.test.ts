// @vitest-environment jsdom
// T29：启动自愈 + 只读安全模式（spec 8.2 / 8.5）。
//
// 覆盖面（对照 task.md T29 四条验收）：
//   1. 解析/校验/迁移失败 → 不写盘，加载最近可用快照为只读视图
//   2. SafeModeBanner：恢复此快照 / 选择其他备份 / 导出当前
//   3. 只读模式下写操作全禁用（CommandBus 拒绝并提示 + 落盘拒绝）
//   4. 启动自愈：解析失败自动尝试最近快照一次，仍失败才进安全模式

import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCommandBus, createTaskCommand } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Task, Vault } from '../../src/domain/types'
import * as fsReal from '../../src/persistence/fsAdapter'
import {
  VAULT_FILE,
  createNewVault,
  createReadOnlyGuard,
  createSelfHealingLoader,
  createVaultRepository,
  guardCommandBus,
} from '../../src/persistence/vaultRepository'
import type { ConflictFs, SafeModeSnapshotRef } from '../../src/persistence/vaultRepository'
import { SafeModeBanner } from '../../src/views/SafeModeBanner'
import type { SafeModeLabels } from '../../src/views/SafeModeBanner'
import { asDirHandle, makeDir, makeFile } from './mockFs'
import type { MockDirHandle } from './mockFs'

const NOW = new Date('2026-10-15T09:30:12.000Z')
const BACKUP_DIR_NAME = '.backup'
const SNAP_NEW = 'vault-20261015-093000.json'
const SNAP_OLD = 'vault-20261014-180000.json'
const SNAP_BROKEN = 'vault-20261015-100000.json'

afterEach(() => {
  cleanup()
})

function mkTask(title: string, index: number): Task {
  return {
    id: `task-${title}`,
    topicId: 'topic-1',
    title,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note: '',
    order: `m${index}`,
    createdAt: '2026-10-15T08:00:00.000Z',
    updatedAt: '2026-10-15T08:00:00.000Z',
    archived: false,
  }
}

function vaultWith(titles: string[], revision = 3): Vault {
  return {
    ...createNewVault(new Date('2026-10-15T08:00:00.000Z')),
    revision,
    tasks: titles.map(mkTask),
    updatedAt: '2026-10-15T08:00:00.000Z',
  }
}

const BROKEN_JSON = '{"schemaVersion":1,"vaultId":"broken"'
const BROKEN_SHAPE = JSON.stringify({ schemaVersion: 1, vaultId: 'shape' })
const FUTURE_VERSION = JSON.stringify({ ...vaultWith([]), schemaVersion: 99 })

function dirWith(diskText: string, snapshots: { name: string; text: string }[] = []): MockDirHandle {
  return makeDir('vault', {
    files: [makeFile(VAULT_FILE, { text: diskText })],
    dirs: [
      makeDir(BACKUP_DIR_NAME, {
        files: snapshots.map((s) => makeFile(s.name, { text: s.text })),
      }),
    ],
  })
}

function spyFs(): ConflictFs {
  return {
    readText: vi.fn(fsReal.readText),
    writeText: vi.fn(fsReal.writeText),
    readHead: vi.fn(fsReal.readHead),
    list: vi.fn(fsReal.list),
    ensureSubdirs: vi.fn(fsReal.ensureSubdirs),
  }
}

function loaderOn(dir: MockDirHandle, options: { maxAttempts?: number } = {}) {
  const fs = spyFs()
  const handle = asDirHandle(dir)
  const repo = createVaultRepository(handle, fs)
  const loader = createSelfHealingLoader(handle, repo, {
    fs,
    now: () => NOW,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  })
  return { loader, fs, repo, dir }
}

function textOfFile(dir: MockDirHandle, name: string): string | undefined {
  const file = dir.files.get(name)
  return file === undefined ? undefined : new TextDecoder().decode(file.bytes())
}

describe('启动自愈：损坏 → 最近快照 → 只读', () => {
  it('磁盘正常时直接 healthy，不碰快照', async () => {
    const good = vaultWith(['A', 'B'])
    const { loader, fs } = loaderOn(dirWith(JSON.stringify(good)))

    const outcome = await loader.load()

    expect(outcome.status).toBe('healthy')
    expect(outcome.vault?.tasks.map((t) => t.title)).toEqual(['A', 'B'])
    expect(outcome.snapshot).toBeNull()
    expect(outcome.attempts).toEqual([])
    expect(loader.readOnly.isReadOnly()).toBe(false)
    expect(fs.writeText).not.toHaveBeenCalled()
  })

  it('vault.json 不存在 → empty（是否新建由启动流程决定，不进安全模式）', async () => {
    const { loader } = loaderOn(makeDir('vault', { dirs: [makeDir(BACKUP_DIR_NAME)] }))

    const outcome = await loader.load()

    expect(outcome.status).toBe('empty')
    expect(outcome.vault).toBeNull()
    expect(loader.readOnly.isReadOnly()).toBe(false)
  })

  it('JSON 语法损坏 → 自愈加载最近快照为只读视图，且不写盘', async () => {
    const snapVault = vaultWith(['S1', 'S2'])
    const dir = dirWith(BROKEN_JSON, [{ name: SNAP_NEW, text: JSON.stringify(snapVault) }])
    const before = dir.files.get(VAULT_FILE)!.bytes()
    const { loader, fs } = loaderOn(dir)

    const outcome = await loader.load()

    expect(outcome.status).toBe('readonly')
    expect(outcome.vault?.tasks.map((t) => t.title)).toEqual(['S1', 'S2'])
    expect(outcome.snapshot?.id).toBe(SNAP_NEW)
    expect(outcome.attempts).toEqual([SNAP_NEW])
    expect(outcome.reason).toBeTruthy()
    // 关键：损坏文件一个字节都不许动
    expect(dir.files.get(VAULT_FILE)!.bytes()).toEqual(before)
    expect(fs.writeText).not.toHaveBeenCalled()
    expect(loader.readOnly.isReadOnly()).toBe(true)
  })

  it('Zod 结构校验失败也走同一条自愈链路', async () => {
    const dir = dirWith(BROKEN_SHAPE, [{ name: SNAP_NEW, text: JSON.stringify(vaultWith(['S'])) }])
    const { loader } = loaderOn(dir)

    const outcome = await loader.load()

    expect(outcome.status).toBe('readonly')
    expect(outcome.snapshot?.id).toBe(SNAP_NEW)
  })

  it('schemaVersion 高于当前版本（迁移失败）同样进自愈', async () => {
    const dir = dirWith(FUTURE_VERSION, [{ name: SNAP_NEW, text: JSON.stringify(vaultWith(['S'])) }])
    const { loader } = loaderOn(dir)

    const outcome = await loader.load()

    expect(outcome.status).toBe('readonly')
    expect(outcome.reason).toContain('请升级 OffEarly')
  })
})

describe('启动自愈：一次尝试后仍失败才进安全模式', () => {
  it('最近快照也损坏 → safemode，只尝试一次，磁盘不动', async () => {
    const dir = dirWith(BROKEN_JSON, [
      { name: SNAP_BROKEN, text: '{not json' },
      { name: SNAP_OLD, text: JSON.stringify(vaultWith(['OLD'])) },
    ])
    const before = dir.files.get(VAULT_FILE)!.bytes()
    const { loader, fs } = loaderOn(dir)

    const outcome = await loader.load()

    // 默认 maxAttempts=1：只试过最新的那一份，更旧的那份这次不看
    expect(outcome.status).toBe('safemode')
    expect(outcome.vault).toBeNull()
    expect(outcome.attempts).toEqual([SNAP_BROKEN])
    expect(outcome.reason).toBeTruthy()
    expect(dir.files.get(VAULT_FILE)!.bytes()).toEqual(before)
    expect(fs.writeText).not.toHaveBeenCalled()
    expect(loader.readOnly.isReadOnly()).toBe(true)
  })

  it('无任何快照 → safemode（attempts 为空）', async () => {
    const { loader } = loaderOn(dirWith(BROKEN_JSON))

    const outcome = await loader.load()

    expect(outcome.status).toBe('safemode')
    expect(outcome.attempts).toEqual([])
  })

  it('放宽 maxAttempts 后退到更旧的可用快照（「最近可用」的完整语义）', async () => {
    const dir = dirWith(BROKEN_JSON, [
      { name: SNAP_BROKEN, text: '{not json' },
      { name: SNAP_OLD, text: JSON.stringify(vaultWith(['OLD'])) },
    ])
    const { loader } = loaderOn(dir, { maxAttempts: 2 })

    const outcome = await loader.load()

    expect(outcome.status).toBe('readonly')
    expect(outcome.attempts).toEqual([SNAP_BROKEN, SNAP_OLD])
    expect(outcome.vault?.tasks.map((t) => t.title)).toEqual(['OLD'])
  })
})

describe('只读视图的快照入口', () => {
  it('listSnapshots 按时间倒序列出，含条数与大小', async () => {
    const dir = dirWith(BROKEN_JSON, [
      { name: SNAP_OLD, text: JSON.stringify(vaultWith(['A', 'B'])) },
      { name: SNAP_NEW, text: JSON.stringify(vaultWith(['C'])) },
    ])
    const { loader } = loaderOn(dir)

    const snapshots = await loader.listSnapshots()

    expect(snapshots.map((s) => s.id)).toEqual([SNAP_NEW, SNAP_OLD])
    expect(snapshots[0]?.taskCount).toBe(1)
    expect(snapshots[1]?.taskCount).toBe(2)
    expect(snapshots[0]?.sizeBytes).toBeGreaterThan(0)
  })

  it('loadSnapshot 载入指定快照为只读视图（「选择其他备份」的载体）', async () => {
    const dir = dirWith(BROKEN_JSON, [
      { name: SNAP_NEW, text: JSON.stringify(vaultWith(['NEW'])) },
      { name: SNAP_OLD, text: JSON.stringify(vaultWith(['OLD'])) },
    ])
    const { loader } = loaderOn(dir)
    await loader.load()

    const outcome = await loader.loadSnapshot(SNAP_OLD)

    expect(outcome.status).toBe('readonly')
    expect(outcome.snapshot?.id).toBe(SNAP_OLD)
    expect(outcome.vault?.tasks.map((t) => t.title)).toEqual(['OLD'])
    expect(loader.readOnly.isReadOnly()).toBe(true)
  })

  it('loadSnapshot 遇损坏快照时保持安全模式并给原因', async () => {
    const dir = dirWith(BROKEN_JSON, [{ name: SNAP_BROKEN, text: '{not json' }])
    const { loader } = loaderOn(dir)

    const outcome = await loader.loadSnapshot(SNAP_BROKEN)

    expect(outcome.status).toBe('safemode')
    expect(outcome.reason).toBeTruthy()
    expect(loader.readOnly.isReadOnly()).toBe(true)
  })

  it('restoreSnapshot：先保留当前（损坏）文件，再覆盖写盘并解除只读', async () => {
    const snapshot = vaultWith(['S1'], 5)
    const dir = dirWith(BROKEN_JSON, [{ name: SNAP_NEW, text: JSON.stringify(snapshot) }])
    const { loader, repo } = loaderOn(dir)
    await loader.load()

    const result = await loader.restoreSnapshot(SNAP_NEW)

    expect(result.vault.tasks.map((t) => t.title)).toEqual(['S1'])
    expect(loader.readOnly.isReadOnly()).toBe(false)
    // 损坏的原文件进 .backup/，可追溯
    const backups = [...(dir.dirs.get(BACKUP_DIR_NAME)?.files.keys() ?? [])].filter(
      (name) => name !== SNAP_NEW,
    )
    expect(backups).toHaveLength(1)
    const preserved = dir.dirs.get(BACKUP_DIR_NAME)!.files.get(backups[0]!)!
    expect(new TextDecoder().decode(preserved.bytes())).toBe(BROKEN_JSON)
    // 覆盖写盘，且写回后能正常 load
    expect(result.safetySnapshotId).toBe(backups[0])
    await expect(repo.load()).resolves.toMatchObject({ revision: 5 })
  })

  it('exportCurrent：把当前只读视图导出成独立文件，不覆盖 vault.json', async () => {
    const dir = dirWith(BROKEN_JSON, [{ name: SNAP_NEW, text: JSON.stringify(vaultWith(['S1'])) }])
    const before = dir.files.get(VAULT_FILE)!.bytes()
    const { loader } = loaderOn(dir)
    const outcome = await loader.load()

    const exported = await loader.exportCurrent(outcome.vault!)

    expect(exported.filename.startsWith('vault-export-')).toBe(true)
    expect(dir.files.get(exported.filename)).toBeDefined()
    expect(
      JSON.parse(textOfFile(dir, exported.filename)!),
    ).toMatchObject({ revision: 3 })
    expect(dir.files.get(VAULT_FILE)!.bytes()).toEqual(before)
  })
})

describe('只读模式下写操作全禁用', () => {
  function readOnlyBus() {
    const store = createVaultStore(vaultWith(['A']))
    const bus = createCommandBus(store)
    const guard = createReadOnlyGuard()
    const notices: string[] = []
    const guarded = guardCommandBus(bus, guard, (message) => notices.push(message))
    return { store, bus, guard, guarded, notices }
  }

  it('只读时 CommandBus.apply 被拒并提示，Store 不被改动', () => {
    const { store, guard, guarded, notices } = readOnlyBus()
    guard.enter('vault.json 解析失败')
    const task = mkTask('NEW', 9)

    expect(() => guarded.apply(createTaskCommand(task))).toThrowError(
      expect.objectContaining({ name: 'ReadOnlyError' }),
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('只读')
    expect(notices[0]).toContain('vault.json 解析失败')
    expect(store.getVault().tasks.map((t) => t.title)).toEqual(['A'])
  })

  it('只读时 undo/redo 同样被拒，按钮态取 false', () => {
    const { bus, guarded, guard, notices } = readOnlyBus()
    guarded.apply(createTaskCommand(mkTask('NEW', 9)))
    expect(guarded.canUndo?.()).toBe(true)

    guard.enter('校验失败')

    // 三个写入口行为一致：一律拒绝并提示（按钮已由 canUndo/canRedo 置灰）
    expect(() => guarded.undo()).toThrowError(
      expect.objectContaining({ name: 'ReadOnlyError' }),
    )
    expect(() => guarded.redo()).toThrowError(
      expect.objectContaining({ name: 'ReadOnlyError' }),
    )
    expect(notices).toHaveLength(2)
    expect(guarded.canUndo?.()).toBe(false)
    expect(guarded.canRedo?.()).toBe(false)
    // 底层 bus 未被牵连：守卫只是挡在门口
    expect(bus.undoDepth()).toBe(1)
  })

  it('解除只读后写入恢复', () => {
    const { store, guard, guarded } = readOnlyBus()
    guard.enter('损坏')
    expect(() => guarded.apply(createTaskCommand(mkTask('X', 1)))).toThrow()

    guard.exit()

    expect(() => guarded.apply(createTaskCommand(mkTask('X', 1)))).not.toThrow()
    expect(store.getVault().tasks.map((t) => t.title)).toEqual(['A', 'X'])
  })

  it('只读时落盘被拒：saveGuarded 抛 ReadOnlyError 且磁盘不变', async () => {
    const dir = dirWith(BROKEN_JSON, [{ name: SNAP_NEW, text: JSON.stringify(vaultWith(['S1'])) }])
    const before = dir.files.get(VAULT_FILE)!.bytes()
    const { loader } = loaderOn(dir)
    const outcome = await loader.load()

    await expect(loader.saveGuarded(outcome.vault!)).rejects.toMatchObject({
      name: 'ReadOnlyError',
    })
    expect(dir.files.get(VAULT_FILE)!.bytes()).toEqual(before)
  })

  it('非只读时落盘正常（守卫不误伤正常路径）', async () => {
    const { loader, dir } = loaderOn(dirWith(JSON.stringify(vaultWith(['A']))))
    await loader.load()

    await loader.saveGuarded(vaultWith(['A', 'B'], 4))

    expect(JSON.parse(textOfFile(dir, VAULT_FILE)!)).toMatchObject({ revision: 4 })
  })
})

describe('SafeModeBanner', () => {
  const snapshot: SafeModeSnapshotRef = {
    id: SNAP_NEW,
    createdAt: '2026-10-15T09:30:00+08:00',
    sizeBytes: 2048,
    taskCount: 12,
  }

  function renderBanner(overrides: {
    labels?: Partial<SafeModeLabels>
    onRestore?: () => void | Promise<void>
    onChooseOther?: () => void | Promise<void>
    onExportCurrent?: () => void | Promise<void>
    snapshot?: SafeModeSnapshotRef | null
  } = {}) {
    return render(
      createElement(SafeModeBanner, {
        reason: 'vault.json 未通过结构校验',
        snapshot: overrides.snapshot === undefined ? snapshot : overrides.snapshot,
        onRestore: overrides.onRestore ?? vi.fn(),
        onChooseOther: overrides.onChooseOther ?? vi.fn(),
        onExportCurrent: overrides.onExportCurrent ?? vi.fn(),
        ...(overrides.labels === undefined ? {} : { labels: overrides.labels }),
      }),
    )
  }

  it('顶部横幅三按钮齐全，并展示失败原因与当前快照', () => {
    const view = renderBanner()

    const banner = view.getByTestId('safe-mode-banner')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.getAttribute('data-snapshot')).toBe(SNAP_NEW)
    expect(view.getByText(/vault\.json 未通过结构校验/)).toBeDefined()
    expect(view.getByTestId('safe-mode-snapshot').textContent).toContain(SNAP_NEW)
    expect(view.getByRole('button', { name: '恢复此快照' })).toBeDefined()
    expect(view.getByRole('button', { name: '选择其他备份' })).toBeDefined()
    expect(view.getByRole('button', { name: '导出当前' })).toBeDefined()
  })

  it('三按钮各自只触发对应回调（「选择其他备份」只做回调，不 import 备份面板）', async () => {
    const onRestore = vi.fn()
    const onChooseOther = vi.fn()
    const onExportCurrent = vi.fn()
    const view = renderBanner({ onRestore, onChooseOther, onExportCurrent })

    await act(async () => {
      view.getByTestId('safe-mode-restore').click()
    })
    await act(async () => {
      view.getByTestId('safe-mode-choose-other').click()
    })
    await act(async () => {
      view.getByTestId('safe-mode-export').click()
    })

    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onChooseOther).toHaveBeenCalledTimes(1)
    expect(onExportCurrent).toHaveBeenCalledTimes(1)
  })

  it('没有可用快照时禁用「恢复此快照」并说明原因', () => {
    const view = renderBanner({ snapshot: null })

    expect(view.getByTestId('safe-mode-restore')).toHaveProperty('disabled', true)
    expect(view.getByTestId('safe-mode-snapshot').textContent).toContain('没有可用快照')
    expect(view.getByTestId('safe-mode-choose-other')).toHaveProperty('disabled', false)
  })

  it('labels 可覆盖以接 locales', () => {
    const view = renderBanner({
      labels: {
        restore: 'Restore this snapshot',
        chooseOther: 'Choose another backup',
        exportCurrent: 'Export current',
      },
    })

    expect(view.getByRole('button', { name: 'Restore this snapshot' })).toBeDefined()
    expect(view.getByRole('button', { name: 'Choose another backup' })).toBeDefined()
    expect(view.getByRole('button', { name: 'Export current' })).toBeDefined()
  })

  it('处理中禁用三按钮，失败时展示原因', async () => {
    let release: (() => void) | undefined
    const view = renderBanner({
      onRestore: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      onExportCurrent: async () => {
        throw new Error('permission denied')
      },
    })

    await act(async () => {
      view.getByTestId('safe-mode-restore').click()
    })
    expect(view.getByTestId('safe-mode-restore')).toHaveProperty('disabled', true)
    expect(view.getByTestId('safe-mode-export')).toHaveProperty('disabled', true)

    await act(async () => {
      release?.()
    })
    expect(view.getByTestId('safe-mode-status')).toBeDefined()

    await act(async () => {
      view.getByTestId('safe-mode-export').click()
    })
    expect(view.getByTestId('safe-mode-error').textContent).toContain('permission denied')
  })
})
