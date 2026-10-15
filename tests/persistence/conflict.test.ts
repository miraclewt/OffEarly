// @vitest-environment jsdom
// T27：revision 冲突三选 + 30s 轮询。
//
// 覆盖面（对照 task.md T27 四条验收）：
//   1. save 前 peekRevision() > 内存基线 → 冲突报告（三选的触发条件）
//   2. 三条路径：以我为准（覆盖 + 旧版进 .backup）/ 以磁盘为准（重载 + 丢失条数）/ 导出副本
//   3. 30s 轮询两分支：不 dirty → 静默重载；dirty → 顶栏提示（假计时器）
//   4. ConflictDialog 组件可挂载、三按钮各自回调、展示丢失条数

import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Task, Vault } from '../../src/domain/types'
import {
  CONFLICT_POLL_MS,
  CONFLICT_EXPORT_PREFIX,
  VAULT_FILE,
  createConflictGuard,
  createNewVault,
  createRevisionWatcher,
  createVaultRepository,
} from '../../src/persistence/vaultRepository'
import type { ConflictReport } from '../../src/persistence/vaultRepository'
import { ConflictDialog } from '../../src/views/ConflictDialog'
import type { ConflictLabels } from '../../src/views/ConflictDialog'
import { asDirHandle, makeDir, makeFile } from './mockFs'
import type { MockDirHandle } from './mockFs'

const NOW = new Date('2026-10-15T09:30:12.000Z')
const BACKUP_DIR_NAME = '.backup'

// 组件用例与仓库用例同文件：每个用例后必须卸载，否则 DOM 叠加会命中多个节点。
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

function vaultWith(revision: number, titles: string[], vaultId = 'vault-1'): Vault {
  return {
    ...createNewVault(new Date('2026-10-15T08:00:00.000Z')),
    vaultId,
    revision,
    tasks: titles.map(mkTask),
    updatedAt: '2026-10-15T08:00:00.000Z',
  }
}

function dirWith(vault: Vault): MockDirHandle {
  return makeDir('vault', { files: [makeFile(VAULT_FILE, { text: JSON.stringify(vault) })] })
}

function textOfFile(dir: MockDirHandle, name: string): string | undefined {
  const file = dir.files.get(name)
  return file === undefined ? undefined : new TextDecoder().decode(file.bytes())
}

function backupNames(dir: MockDirHandle): string[] {
  return [...(dir.dirs.get(BACKUP_DIR_NAME)?.files.keys() ?? [])]
}

function harness(disk: Vault, opts: { now?: () => Date } = {}) {
  const dir = dirWith(disk)
  const handle = asDirHandle(dir)
  const repo = createVaultRepository(handle)
  const guard = createConflictGuard(handle, repo, { now: opts.now ?? (() => NOW) })
  return { dir, repo, guard }
}

/** 等价的「无冲突」基线：内存 revision == 磁盘 revision。 */
const CLEAN_DISK = vaultWith(7, ['A', 'B'])

/** 本文件必须是 .ts（产出清单固定），所以用 createElement 而不是 JSX 渲染组件。 */
function renderDialog(
  report: ConflictReport,
  overrides: {
    labels?: Partial<ConflictLabels>
    onKeepMine?: () => void | Promise<void>
    onTakeDisk?: () => void | Promise<void>
    onExportCopy?: () => void | Promise<void>
  } = {},
) {
  return render(
    createElement(ConflictDialog, {
      report,
      onKeepMine: overrides.onKeepMine ?? vi.fn(),
      onTakeDisk: overrides.onTakeDisk ?? vi.fn(),
      onExportCopy: overrides.onExportCopy ?? vi.fn(),
      ...(overrides.labels === undefined ? {} : { labels: overrides.labels }),
    }),
  )
}

describe('detect：save 前 peekRevision 与内存基线的比较', () => {
  it('磁盘 revision 高于内存基线 → 返回冲突报告（含磁盘版本与丢失条数）', async () => {
    const { guard } = harness(vaultWith(9, ['A', 'B', 'C']))
    const local = vaultWith(7, ['A', 'X', 'Y'])

    const report = await guard.detect(local)

    expect(report).not.toBeNull()
    expect(report?.diskRevision).toBe(9)
    expect(report?.diskTaskCount).toBe(3)
    expect(report?.localTaskCount).toBe(3)
    // X / Y 是磁盘上没有的本地任务，选「以磁盘为准」就会丢
    expect(report?.droppedTaskCount).toBe(2)
  })

  it('磁盘 revision 等于内存基线 → null（不弹窗）', async () => {
    const { guard } = harness(CLEAN_DISK)

    await expect(guard.detect(vaultWith(7, ['A', 'B']))).resolves.toBeNull()
  })

  it('vault.json 不存在 → null（新库首次落盘不算冲突）', async () => {
    const dir = makeDir('vault')
    const handle = asDirHandle(dir)
    const guard = createConflictGuard(handle, createVaultRepository(handle))

    await expect(guard.detect(vaultWith(0, ['A']))).resolves.toBeNull()
  })
})

describe('saveGuarded：干净则落盘，冲突则不写盘', () => {
  it('无冲突时直接写盘', async () => {
    const { dir, guard } = harness(CLEAN_DISK)
    const local = vaultWith(7, ['A', 'B', 'C'])

    await expect(guard.saveGuarded(local)).resolves.toBeNull()

    expect(JSON.parse(textOfFile(dir, VAULT_FILE)!)).toMatchObject({ revision: 7 })
  })

  it('有冲突时返回报告且原文件字节不变', async () => {
    const { dir, guard } = harness(vaultWith(9, ['A']))
    const before = dir.files.get(VAULT_FILE)!.bytes()

    const report = await guard.saveGuarded(vaultWith(7, ['A', 'Z']))

    expect(report?.diskRevision).toBe(9)
    expect(dir.files.get(VAULT_FILE)!.bytes()).toEqual(before)
  })
})

describe('冲突三选', () => {
  it('以我为准：磁盘旧版先进 .backup，再覆盖写盘，revision 抬到 diskRevision+1', async () => {
    const disk = vaultWith(9, ['A', 'B'])
    const { dir, guard } = harness(disk)
    const local = vaultWith(7, ['A', 'Z'])

    const result = await guard.keepMine(local)

    // 旧版进 .backup（内容与覆盖前的磁盘逐字节一致）
    const backups = backupNames(dir)
    expect(backups).toHaveLength(1)
    const backedUp = textOfFile(dir.dirs.get(BACKUP_DIR_NAME)!, backups[0]!)
    expect(JSON.parse(backedUp!)).toEqual(disk)
    expect(result.backupId).toBe(backups[0])
    // 覆盖写盘 + revision 单调抬升，避免下一次 save 又判成冲突
    const written = JSON.parse(textOfFile(dir, VAULT_FILE)!)
    expect(written.revision).toBe(10)
    expect(written.tasks.map((t: Task) => t.title)).toEqual(['A', 'Z'])
  })

  it('以磁盘为准：重载磁盘版，并回报丢掉的本地任务条数', async () => {
    const disk = vaultWith(9, ['A', 'B'])
    const { guard } = harness(disk)
    const local = vaultWith(7, ['A', 'X', 'Y'])

    const result = await guard.takeDisk(local)

    expect(result.vault.revision).toBe(9)
    expect(result.vault.tasks.map((t) => t.title)).toEqual(['A', 'B'])
    expect(result.droppedTaskCount).toBe(2)
  })

  it('导出副本：写 vault-conflict-<ts>.json 存下内存版本，然后重载磁盘版', async () => {
    const disk = vaultWith(9, ['A', 'B'])
    const { dir, guard } = harness(disk)
    const local = vaultWith(7, ['A', 'Z'])

    const result = await guard.exportMine(local)

    expect(result.filename.startsWith(CONFLICT_EXPORT_PREFIX)).toBe(true)
    expect(result.filename.endsWith('.json')).toBe(true)
    expect(
      dir.files.get(result.filename),
      '副本应落在数据文件夹根目录，便于手动合并',
    ).toBeDefined()
    expect(JSON.parse(textOfFile(dir, result.filename)!)).toEqual(local)
    // 之后重载磁盘版
    expect(result.vault.revision).toBe(9)
    expect(result.vault.tasks.map((t) => t.title)).toEqual(['A', 'B'])
    expect(result.droppedTaskCount).toBe(1)
  })

  it('三条路径可由 ConflictDialog 的 props 直接驱动（组件不碰文件系统）', async () => {
    const report: ConflictReport = {
      diskRevision: 9,
      localTaskCount: 3,
      diskTaskCount: 3,
      droppedTaskCount: 2,
    }
    const keepMine = vi.fn()
    const takeDisk = vi.fn()
    const exportCopy = vi.fn()
    const view = renderDialog(report, { onKeepMine: keepMine, onTakeDisk: takeDisk, onExportCopy: exportCopy })

    await act(async () => {
      view.getByTestId('conflict-keep-mine').click()
    })
    await act(async () => {
      view.getByTestId('conflict-take-disk').click()
    })
    await act(async () => {
      view.getByTestId('conflict-export-copy').click()
    })

    expect(keepMine).toHaveBeenCalledTimes(1)
    expect(takeDisk).toHaveBeenCalledTimes(1)
    expect(exportCopy).toHaveBeenCalledTimes(1)
  })
})

describe('ConflictDialog 结构', () => {
  const report: ConflictReport = {
    diskRevision: 12,
    localTaskCount: 5,
    diskTaskCount: 4,
    droppedTaskCount: 3,
  }

  it('三选文案齐全，并明确警告会丢掉的条数', () => {
    const view = renderDialog(report)

    expect(view.getByTestId('conflict-dialog').getAttribute('role')).toBe('dialog')
    expect(view.getByTestId('conflict-dialog').getAttribute('data-disk-revision')).toBe('12')
    expect(view.getByRole('button', { name: '以我为准' })).toBeDefined()
    expect(view.getByRole('button', { name: '以磁盘为准' })).toBeDefined()
    expect(view.getByRole('button', { name: '导出我的副本' })).toBeDefined()
    // 丢失条数必须出现在确认文案里（spec 8.3 的「明确警告」）
    expect(view.getByTestId('conflict-drop-warning').textContent).toContain('3')
  })

  it('labels 可整体覆盖，供集成车道接 locales 使用', () => {
    const view = renderDialog(report, {
      labels: {
        keepMine: 'Use mine',
        takeDisk: 'Use disk',
        exportCopy: 'Export my copy',
        droppedWarning: '{n} tasks will be lost',
      },
    })

    expect(view.getByRole('button', { name: 'Use mine' })).toBeDefined()
    expect(view.getByRole('button', { name: 'Use disk' })).toBeDefined()
    expect(view.getByRole('button', { name: 'Export my copy' })).toBeDefined()
    expect(view.getByTestId('conflict-drop-warning').textContent).toBe('3 tasks will be lost')
  })

  it('处理中禁用按钮，失败时展示原因且可重选', async () => {
    let resolve: (() => void) | undefined
    const onKeepMine = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r
        }),
    )
    const view = renderDialog(report, {
      onKeepMine,
      onTakeDisk: vi.fn(async () => {
        throw new Error('disk gone')
      }),
    })

    await act(async () => {
      view.getByTestId('conflict-keep-mine').click()
    })
    expect(view.getByTestId('conflict-keep-mine')).toHaveProperty('disabled', true)

    await act(async () => {
      resolve?.()
    })
    expect(view.getByTestId('conflict-status')).toBeDefined()

    await act(async () => {
      view.getByTestId('conflict-take-disk').click()
    })
    expect(view.getByTestId('conflict-error').textContent).toContain('disk gone')
  })
})

describe('30s 轮询', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function watcherOn(opts: {
    diskRevision: number | null
    memoryRevision: number
    dirty: boolean
    intervalMs?: number
  }) {
    const reload = vi.fn(async () => {})
    const notify = vi.fn()
    const peekRevision = vi.fn(async () => opts.diskRevision)
    const watcher = createRevisionWatcher({
      peekRevision,
      getMemoryRevision: () => opts.memoryRevision,
      isDirty: () => opts.dirty,
      reload,
      notify,
      intervalMs: opts.intervalMs ?? CONFLICT_POLL_MS,
    })
    return { watcher, reload, notify, peekRevision }
  }

  it('磁盘变了且本地不 dirty → 静默重载', async () => {
    const h = watcherOn({ diskRevision: 9, memoryRevision: 7, dirty: false })

    await expect(h.watcher.check()).resolves.toBe('reloaded')

    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('磁盘变了但本地 dirty → 只提示，不重载', async () => {
    const h = watcherOn({ diskRevision: 9, memoryRevision: 7, dirty: true })

    await expect(h.watcher.check()).resolves.toBe('notified')

    expect(h.notify).toHaveBeenCalledWith({ diskRevision: 9, memoryRevision: 7 })
    expect(h.reload).not.toHaveBeenCalled()
  })

  it('磁盘没变 → 什么都不做', async () => {
    const h = watcherOn({ diskRevision: 7, memoryRevision: 7, dirty: false })

    await expect(h.watcher.check()).resolves.toBe('unchanged')

    expect(h.reload).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('start() 后每 30s 轮询一次，stop() 即停', async () => {
    const h = watcherOn({ diskRevision: 9, memoryRevision: 7, dirty: false })

    h.watcher.start()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFLICT_POLL_MS)
    })
    expect(h.peekRevision).toHaveBeenCalledTimes(1)
    expect(h.reload).toHaveBeenCalledTimes(1)

    h.watcher.stop()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFLICT_POLL_MS * 3)
    })
    expect(h.peekRevision).toHaveBeenCalledTimes(1)
  })

  it('start() 幂等，重复调用不会挂出两个定时器', async () => {
    const h = watcherOn({ diskRevision: 9, memoryRevision: 7, dirty: false })

    h.watcher.start()
    h.watcher.start()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONFLICT_POLL_MS)
    })

    expect(h.peekRevision).toHaveBeenCalledTimes(1)
    h.watcher.stop()
  })

  it('peekRevision 失败不冒泡（轮询不该把应用打断）', async () => {
    const reload = vi.fn(async () => {})
    const notify = vi.fn()
    const watcher = createRevisionWatcher({
      peekRevision: async () => {
        throw new Error('permission revoked')
      },
      getMemoryRevision: () => 7,
      isDirty: () => false,
      reload,
      notify,
    })

    await expect(watcher.check()).resolves.toBe('failed')
    expect(reload).not.toHaveBeenCalled()
  })
})
