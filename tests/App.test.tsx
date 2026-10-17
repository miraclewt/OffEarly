// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/App'
import type { Session, StartupPorts } from '../src/App'
import { createNewVault, createVaultRepository } from '../src/persistence/vaultRepository'
import { asDirHandle, makeDir, makeFile } from './persistence/mockFs'
import type { MockDirHandle } from './persistence/mockFs'
import type { VaultDirHandle } from '../src/persistence/handleStore'
import type { Vault } from '../src/domain/types'

function vaultJson(): string {
  return JSON.stringify(createNewVault())
}

function dirWith(entries: { vault?: string; files?: string[] }): MockDirHandle {
  const files = entries.vault === undefined ? [] : [makeFile('vault.json', { text: entries.vault })]
  const dir = makeDir('vault', { files })
  for (const name of entries.files ?? []) {
    dir.dirs.set(name, makeDir(name))
  }
  return dir
}

/**
 * 只替掉「目录从哪来」，load/save/校验/写盘全走真实 VaultRepository 与 mock 文件系统，
 * 这样「不写盘」这类断言仍然落在字节上，而不是落在 spy 调用次数上。
 */
function ports(options: {
  stored?: VaultDirHandle | null
  dir?: MockDirHandle
  hasPermission?: boolean
  requestResult?: boolean
  /** 传进来就能让落盘按需失败，用来构造「保存失败 → 重试」链路。 */
  saveGate?: { failing: boolean }
}): StartupPorts {
  const dir = asDirHandle(options.dir ?? dirWith({}))
  return {
    loadStoredDir: vi.fn(async () => (options.stored === undefined ? dir : options.stored)),
    storeDir: vi.fn(async () => true),
    hasWritePermission: vi.fn(async () => options.hasPermission ?? true),
    requestWritePermission: vi.fn(async () => options.requestResult ?? true),
    pickDir: vi.fn(async () => dir),
    openRepository: vi.fn((handle: VaultDirHandle) => {
      const repository = createVaultRepository(handle)
      const gate = options.saveGate
      if (gate === undefined) return repository
      return {
        ...repository,
        save: async (vault: Vault) => {
          if (gate.failing) throw new Error('disk full')
          await repository.save(vault)
        },
      }
    }),
  }
}

async function renderApp(p: StartupPorts, onSession?: (session: Session) => void) {
  render(<App ports={p} onSession={onSession} />)
  return p
}

// 库打开前 locale 走 navigator.language；锁定为中文以断言启动屏中文案
beforeEach(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  cleanup()
})

describe('启动流程：连接数据文件夹', () => {
  it('没有已保存的目录句柄时，首屏要求连接数据文件夹', async () => {
    await renderApp(ports({ stored: null }))

    expect(await screen.findByText('连接数据文件夹')).toBeTruthy()
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeTruthy()
  })

  it('选中空目录时先问「在此创建新库？」，确认前不写盘', async () => {
    await renderApp(ports({ stored: null }))
    fireEvent.click(await screen.findByRole('button', { name: '选择文件夹' }))

    expect(await screen.findByText('在此创建新库？')).toBeTruthy()
    expect(screen.queryByText('待办')).toBeNull()
  })

  it('确认后初始化 vault.json 并进入应用', async () => {
    const dir = dirWith({ files: ['assets', '.backup'] })
    await renderApp(ports({ stored: null, dir }))
    fireEvent.click(await screen.findByRole('button', { name: '选择文件夹' }))
    fireEvent.click(await screen.findByRole('button', { name: '创建数据库' }))

    await waitFor(() => expect(screen.getByText('待办')).toBeTruthy())
    const written = dir.files.get('vault.json')
    expect(written && new TextDecoder().decode(written.bytes())).toContain('"vaultId"')
  })

  it('用户取消目录选择（AbortError）时留在连接屏，不显示错误', async () => {
    const abort = new Error('canceled')
    abort.name = 'AbortError'
    const p = ports({ stored: null })
    ;(p.pickDir as ReturnType<typeof vi.fn>).mockRejectedValue(abort)
    await renderApp(p)

    fireEvent.click(await screen.findByRole('button', { name: '选择文件夹' }))

    await waitFor(() => expect(p.pickDir).toHaveBeenCalled())
    expect(await screen.findByText('连接数据文件夹')).toBeTruthy()
    expect(screen.queryByText('无法打开数据文件夹')).toBeNull()
  })
})

describe('启动流程：已记住的目录句柄', () => {
  it('有权限时不再要求选择文件夹，含 vault.json 的目录直接进入空看板', async () => {
    const dir = dirWith({ vault: vaultJson() })
    await renderApp(ports({ dir }))

    await waitFor(() => expect(screen.getByText('待办')).toBeTruthy())
    expect(screen.queryByText('连接数据文件夹')).toBeNull()
    expect(screen.getAllByText('0')).toHaveLength(4)
  })

  it('已存在但无写权限时，一次点击授权后进入', async () => {
    const dir = dirWith({ vault: vaultJson() })
    await renderApp(ports({ stored: asDirHandle(dir), hasPermission: false }))

    fireEvent.click(await screen.findByRole('button', { name: '授权并继续' }))

    await waitFor(() => expect(screen.getByText('待办')).toBeTruthy())
  })

  it('授权被拒时停在授权屏，不进入应用', async () => {
    const dir = dirWith({ vault: vaultJson() })
    await renderApp(ports({ stored: asDirHandle(dir), hasPermission: false, requestResult: false }))

    fireEvent.click(await screen.findByRole('button', { name: '授权并继续' }))

    await waitFor(() => expect(screen.queryByText('待办')).toBeNull())
    expect(screen.getByRole('button', { name: '授权并继续' })).toBeTruthy()
  })
})

describe('启动流程：损坏的库进入只读安全模式', () => {
  it('vault.json 语法坏时给出安全模式占位，且不写盘', async () => {
    const original = '{"schemaVersion":1,"vaultId":"abc"'
    const dir = dirWith({ vault: original })
    await renderApp(ports({ dir }))

    expect(await screen.findByText('只读安全模式')).toBeTruthy()
    expect(screen.queryByText('待办')).toBeNull()
    const file = dir.files.get('vault.json')
    expect(file && new TextDecoder().decode(file.bytes())).toBe(original)
  })

  it('vault.json 结构非法时同样只读，不覆盖原文件', async () => {
    const original = JSON.stringify({ schemaVersion: 1, vaultId: 'abc' })
    const dir = dirWith({ vault: original })
    await renderApp(ports({ dir }))

    expect(await screen.findByText('只读安全模式')).toBeTruthy()
    const file = dir.files.get('vault.json')
    expect(file && new TextDecoder().decode(file.bytes())).toBe(original)
  })

  it('schemaVersion 高于本版本时提示升级 OffEarly', async () => {
    const dir = dirWith({ vault: JSON.stringify({ ...JSON.parse(vaultJson()), schemaVersion: 2 }) })
    await renderApp(ports({ dir }))

    expect(await screen.findByText(/请升级 OffEarly/)).toBeTruthy()
  })
})

describe('T28 收尾：安全模式「选择其他备份」经备份面板挑快照恢复', () => {
  it('safe-mode 无会话时也能列 .backup/、恢复后重走启动流程回到可写', async () => {
    const snapshotText = vaultJson()
    const dir = dirWith({ vault: '{"schemaVersion":1,"vaultId":"abc"' })
    dir.dirs.set(
      '.backup',
      makeDir('.backup', {
        files: [makeFile('vault-20261015-093012.json', { text: snapshotText })],
      }),
    )
    await renderApp(ports({ dir }))

    expect(await screen.findByText('只读安全模式')).toBeTruthy()

    fireEvent.click(screen.getByTestId('safe-mode-choose-other'))
    await screen.findByTestId('backup-panel')
    await waitFor(() =>
      expect(screen.getByTestId('backup-snapshot-item-vault-20261015-093012.json')).toBeTruthy(),
    )

    fireEvent.click(screen.getByTestId('backup-snapshot-restore-vault-20261015-093012.json'))
    fireEvent.click(await screen.findByTestId('backup-snapshot-restore-confirm'))

    // 磁盘被快照覆盖 → 重新 openDir → 健康库 → 回到看板
    await waitFor(() => expect(screen.getByText('待办')).toBeTruthy())
    const file = dir.files.get('vault.json')
    expect(file && new TextDecoder().decode(file.bytes())).toBe(snapshotText)
  })
})

function decodeVault(dir: MockDirHandle): Vault {
  const file = dir.files.get('vault.json')
  if (file === undefined) throw new Error('vault.json 不存在')
  return JSON.parse(new TextDecoder().decode(file.bytes())) as Vault
}

/** 顶栏保存指示 / Ctrl+S / locale 源 —— T04、T07、T08 的接线在此收口（T10）。 */
describe('应用外壳：保存指示、Ctrl+S 与 locale 源', () => {
  async function openReady(options: { saveGate?: { failing: boolean }; locale?: 'en' } = {}) {
    const raw = JSON.parse(vaultJson()) as Vault
    if (options.locale !== undefined) raw.settings.locale = options.locale
    const dir = dirWith({ vault: JSON.stringify(raw) })
    const captured: Session[] = []
    await renderApp(ports({ dir, ...options }), (session) => captured.push(session))
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy())
    const session = captured[0]
    if (session === undefined) throw new Error('会话未建立')
    return { dir, session }
  }

  it('库打开后顶栏出现保存指示，初始为已保存', async () => {
    await openReady()

    const indicator = screen.getByTestId('save-indicator')
    expect(indicator.getAttribute('data-state')).toBe('saved')
    expect(screen.getByText('已保存')).toBeTruthy()
    // 顶栏确实在页面里，而不只是渲染到了游离节点
    expect(screen.getByTestId('topbar').contains(indicator)).toBe(true)
  })

  it('Ctrl+S 立即落盘：提示转已保存，磁盘 revision 递增', async () => {
    const { dir, session } = await openReady()
    expect(decodeVault(dir).revision).toBe(0)

    act(() => {
      session.store.update((vault) => ({ ...vault }))
    })
    expect(screen.getByText('未保存')).toBeTruthy()

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy())
    expect(decodeVault(dir).revision).toBe(1)
  })

  it('没有未保存变更时 Ctrl+S 不写盘', async () => {
    const { dir } = await openReady()
    const before = new TextDecoder().decode(dir.files.get('vault.json')?.bytes())

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy())

    expect(new TextDecoder().decode(dir.files.get('vault.json')?.bytes())).toBe(before)
  })

  it('保存失败时顶栏给出保存失败与重试，修好后点重试恢复已保存', async () => {
    const gate = { failing: true }
    const { dir, session } = await openReady({ saveGate: gate })

    act(() => {
      session.store.update((vault) => ({ ...vault }))
    })
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })

    await waitFor(() => expect(screen.getByText('保存失败')).toBeTruthy())
    expect(decodeVault(dir).revision).toBe(0)

    gate.failing = false
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy())
    expect(decodeVault(dir).revision).toBe(1)
  })

  it('locale 源是 VaultStore：库里是 en 就直接按英文渲染', async () => {
    await openReady({ locale: 'en' })

    expect(screen.getByText('To Do')).toBeTruthy()
    expect(screen.queryByText('待办')).toBeNull()
  })

  it('改 settings.locale 后整棵树跟着换语言（T04 接线收口）', async () => {
    const { session } = await openReady()
    expect(screen.getByText('待办')).toBeTruthy()

    act(() => {
      session.store.update((vault) => ({
        ...vault,
        settings: { ...vault.settings, locale: 'en' },
      }))
    })

    await waitFor(() => expect(screen.getByText('To Do')).toBeTruthy())
    expect(screen.queryByText('待办')).toBeNull()
  })
})

/**
 * T34/T35：新建任务入口与设置面板在**真实会话**里的接线。
 * 用真 VaultStore + 真 VaultRepository + mock 文件系统，因此「能不能创建」「设置改没改」
 * 一路验到磁盘字节上（而不是验某个回调被调了几次）。
 */
describe('应用外壳：新建任务与设置面板', () => {
  async function openBoard() {
    const dir = dirWith({ vault: vaultJson() })
    const captured: Session[] = []
    await renderApp(ports({ dir }), (session) => captured.push(session))
    await waitFor(() => expect(screen.getByTestId('board')).toBeTruthy())
    const session = captured[0]
    if (session === undefined) throw new Error('会话未建立')
    return { dir, session }
  }

  it('无话题时列底给提示；建话题后可在列内新建任务，并随 Ctrl+S 落盘', async () => {
    const { dir } = await openBoard()

    // 新库没有话题：topicId 是必填字段，此时不提供可点的入口
    expect(screen.getByTestId('board-add-task-blocked-todo').textContent).toBe('先建一个话题，再新建任务')
    expect(screen.queryByTestId('board-add-task-todo')).toBeNull()

    // 侧栏建一个话题
    fireEvent.click(screen.getByTestId('topic-add-root'))
    const nameInput = screen.getByTestId('topic-name-input')
    fireEvent.change(nameInput, { target: { value: '支付重构' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })

    // 入口出现 → 列内新建
    fireEvent.click(await screen.findByTestId('board-add-task-doing'))
    const input = screen.getByTestId('board-new-task-input-doing')
    fireEvent.change(input, { target: { value: '接入支付回调' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // 立刻出现在看板：卡片 + 列计数
    await waitFor(() => expect(screen.getByText('接入支付回调')).toBeTruthy())
    expect(screen.getByTestId('board-column-count-doing').textContent).toBe('1')

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy())

    const saved = decodeVault(dir)
    expect(saved.tasks.map((task) => task.title)).toEqual(['接入支付回调'])
    expect(saved.tasks[0]?.status).toBe('doing')
    expect(saved.tasks[0]?.topicId).toBe(saved.topics[0]?.id)
  })

  it('侧栏「设置」打开真面板（不再是「面板尚未实现」占位），改语言即时生效并落盘', async () => {
    const { dir } = await openBoard()

    fireEvent.click(screen.getByTestId('sidebar-open-settings'))
    expect(await screen.findByTestId('settings-panel')).toBeTruthy()
    // 占位提示不再出现
    expect(screen.queryByTestId('shell-notice')).toBeNull()

    fireEvent.click(screen.getByTestId('settings-locale-en'))
    await waitFor(() => expect(screen.getByText('To Do')).toBeTruthy())

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())
    expect(decodeVault(dir).settings.locale).toBe('en')
  })

  it('设置面板改工作日历：工作日与假期都写进 vault.json', async () => {
    const { dir } = await openBoard()

    fireEvent.click(screen.getByTestId('sidebar-open-settings'))
    await screen.findByTestId('settings-panel')

    fireEvent.click(screen.getByTestId('settings-workday-6'))
    fireEvent.change(screen.getByTestId('settings-holidays-input'), { target: { value: '2026-10-01' } })
    fireEvent.click(screen.getByTestId('settings-holidays-add'))
    expect(screen.getByTestId('settings-holidays-item-2026-10-01')).toBeTruthy()

    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy())

    const saved = decodeVault(dir)
    expect(saved.settings.calendar.workdays).toEqual([1, 2, 3, 4, 5, 6])
    expect(saved.settings.calendar.holidays).toEqual(['2026-10-01'])
  })
})
