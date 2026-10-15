import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Vault } from '../../src/domain/types'
import { createNewVault } from '../../src/persistence/vaultRepository'
import {
  AUTOSAVE_DEBOUNCE_MS,
  createAutosave,
} from '../../src/persistence/autosave'
import type {
  AutosaveSink,
  AutosaveSnapshotter,
  AutosaveStore,
  SaveState,
} from '../../src/persistence/autosave'

const T0 = new Date('2026-10-15T08:00:00.000Z')
const T1 = new Date('2026-10-15T09:30:00.000Z')

/**
 * 假 Store：模拟 Zustand 的「immutable 更新 + 同步通知」，
 * markSaved 也照真实实现那样通知订阅者——autosave 必须能屏蔽掉这次自通知，否则会自激成写盘死循环。
 */
function fakeStore(initial: Vault = createNewVault(T0)) {
  let vault = initial
  const listeners = new Set<() => void>()
  function emit() {
    for (const listener of [...listeners]) listener()
  }
  return {
    current: () => vault,
    /** 用户操作：改内容并通知（revision 属于保存元数据，用户改动不碰它） */
    edit(change: (v: Vault) => Vault) {
      vault = change(vault)
      emit()
    },
    store: {
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      getVault: () => vault,
      markSaved(revision: number, updatedAt: string) {
        vault = { ...vault, revision, updatedAt }
        emit()
        return vault
      },
    } satisfies AutosaveStore,
  }
}

function fakeSink() {
  const writes: Vault[] = []
  let failure: unknown = null
  let gate: Promise<void> | null = null
  let openGate: (() => void) | null = null
  let entered: Promise<void> = Promise.resolve()
  let markEntered: (() => void) | null = null
  return {
    writes,
    /** 让之后的写盘卡在半途，直到 release()。 */
    block() {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
      entered = new Promise<void>((resolve) => {
        markEntered = resolve
      })
    },
    /** 等到写盘真的开始（已进入 save、尚未落盘），用来构造「写盘途中的编辑」。 */
    waitEntered: () => entered,
    release() {
      const resolve = openGate
      gate = null
      openGate = null
      resolve?.()
    },
    failWith(e: unknown) {
      failure = e
    },
    sink: {
      async save(vault: Vault) {
        markEntered?.()
        markEntered = null
        if (failure !== null) throw failure
        if (gate !== null) await gate
        writes.push(vault)
      },
    } satisfies AutosaveSink,
  }
}

function addTask(vault: Vault, title: string): Vault {
  return {
    ...vault,
    tasks: [
      ...vault.tasks,
      {
        id: `t-${title}`,
        topicId: 'topic-1',
        title,
        status: 'todo',
        kind: 'feature',
        priority: 'P1',
        progress: 0,
        tags: [],
        note: '',
        order: 'm',
        createdAt: T0.toISOString(),
        updatedAt: T0.toISOString(),
        archived: false,
      },
    ],
  }
}

function setup(options: { snapshotter?: AutosaveSnapshotter; initial?: Vault } = {}) {
  const fs = fakeStore(options.initial)
  const io = fakeSink()
  const autosave = createAutosave({
    store: fs.store,
    sink: io.sink,
    ...(options.snapshotter === undefined ? {} : { snapshotter: options.snapshotter }),
    now: () => T1,
  })
  autosave.start()
  return { fs, io, autosave }
}

/** 跑完 debounce 窗口（同时把挂起的 promise 微任务冲洗干净）。 */
async function advance(ms = AUTOSAVE_DEBOUNCE_MS) {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('dirty 标记与 debounce', () => {
  it('Store 变更立即标记 dirty，未到 debounce 窗口不写盘', async () => {
    const { fs, io, autosave } = setup()

    fs.edit((v) => addTask(v, 'A'))

    expect(autosave.isDirty()).toBe(true)
    expect(autosave.getState()).toBe('dirty')
    await advance(AUTOSAVE_DEBOUNCE_MS - 1)
    expect(io.writes).toHaveLength(0)
  })

  it('debounce 窗口到期（默认 1200ms）后自动落盘一次', async () => {
    const { fs, io, autosave } = setup()

    fs.edit((v) => addTask(v, 'A'))
    await advance()

    expect(autosave.getState()).toBe('saved')
    expect(io.writes).toHaveLength(1)
    expect(io.writes[0]?.tasks.map((t) => t.title)).toEqual(['A'])
  })

  it('窗口内的连续改动合并为一次写盘，且写的是最新内容', async () => {
    const { fs, io } = setup()

    fs.edit((v) => addTask(v, 'A'))
    await advance(700)
    fs.edit((v) => addTask(v, 'B'))
    await advance(700)
    expect(io.writes).toHaveLength(0)
    await advance(600)

    expect(io.writes).toHaveLength(1)
    expect(io.writes[0]?.tasks.map((t) => t.title)).toEqual(['A', 'B'])
  })
})

describe('Ctrl+S 立即保存', () => {
  it('不等 debounce 直接落盘，且取消已排队的自动保存', async () => {
    const { fs, io, autosave } = setup()

    fs.edit((v) => addTask(v, 'A'))
    await autosave.saveNow()

    expect(io.writes).toHaveLength(1)
    await advance(5000)
    expect(io.writes).toHaveLength(1)
  })

  it('无未保存变更时是 no-op，不白白抬高 revision', async () => {
    const { io, autosave } = setup()

    await autosave.saveNow()

    expect(io.writes).toHaveLength(0)
    expect(autosave.getState()).toBe('saved')
  })
})

describe('revision 与 updatedAt', () => {
  it('保存时 revision++ 并把 updatedAt 刷新为当前时间', async () => {
    const { fs, io } = setup()
    expect(fs.current().revision).toBe(0)

    fs.edit((v) => addTask(v, 'A'))
    await advance()

    expect(io.writes[0]?.revision).toBe(1)
    expect(io.writes[0]?.updatedAt).toBe(T1.toISOString())
    // 写回的 revision 必须跟着走，否则下次保存会原地踏步、冲突检测失效
    expect(fs.current().revision).toBe(1)
    expect(fs.current().updatedAt).toBe(T1.toISOString())
  })

  it('多次保存 revision 递增', async () => {
    const { fs, io } = setup()

    fs.edit((v) => addTask(v, 'A'))
    await advance()
    fs.edit((v) => addTask(v, 'B'))
    await advance()

    expect(io.writes.map((w) => w.revision)).toEqual([1, 2])
    expect(fs.current().revision).toBe(2)
  })

  it('markSaved 触发的 Store 通知不被当成用户改动（否则自激成写盘死循环）', async () => {
    const { fs, io, autosave } = setup()

    fs.edit((v) => addTask(v, 'A'))
    await advance()

    await advance(10_000)
    expect(io.writes).toHaveLength(1)
    expect(autosave.getState()).toBe('saved')
    expect(autosave.isDirty()).toBe(false)
  })
})

describe('保存失败与重试', () => {
  it('失败置 error 态、内存数据不丢、不写盘', async () => {
    const { fs, io, autosave } = setup()
    io.failWith(new Error('disk full'))
    fs.edit((v) => addTask(v, 'A'))

    await advance()

    expect(autosave.getState()).toBe('error')
    expect(autosave.getLastError()).toBeInstanceOf(Error)
    expect(io.writes).toHaveLength(0)
    // 内存里的编辑原样保留，dirty 不因失败被清掉
    expect(fs.current().tasks.map((t) => t.title)).toEqual(['A'])
    expect(autosave.isDirty()).toBe(true)
  })

  it('重试成功后恢复 saved，并落盘失败期间的全部编辑', async () => {
    const { fs, io, autosave } = setup()
    io.failWith(new Error('disk full'))
    fs.edit((v) => addTask(v, 'A'))
    await advance()
    expect(autosave.getState()).toBe('error')

    io.failWith(null)
    fs.edit((v) => addTask(v, 'B'))
    await autosave.retry()

    expect(autosave.getState()).toBe('saved')
    expect(autosave.getLastError()).toBeNull()
    expect(io.writes).toHaveLength(1)
    expect(io.writes[0]?.tasks.map((t) => t.title)).toEqual(['A', 'B'])
    expect(io.writes[0]?.revision).toBe(1)
  })

  it('失败后新编辑仍在 debounce 窗口到期时再试一次', async () => {
    const { fs, io, autosave } = setup()
    io.failWith(new Error('boom'))
    fs.edit((v) => addTask(v, 'A'))
    await advance()
    expect(autosave.getState()).toBe('error')

    io.failWith(null)
    fs.edit((v) => addTask(v, 'B'))
    await advance()

    expect(autosave.getState()).toBe('saved')
    expect(io.writes).toHaveLength(1)
  })
})

describe('保存期间的并发改动', () => {
  it('写盘途中发生的编辑会在本轮写完后补一次，不丢最后的改动', async () => {
    const { fs, io, autosave } = setup()
    fs.edit((v) => addTask(v, 'A'))
    io.block()

    const first = autosave.saveNow()
    await io.waitEntered()
    fs.edit((v) => addTask(v, 'B'))
    io.release()
    await first

    expect(io.writes[0]?.tasks.map((t) => t.title)).toEqual(['A'])
    expect(autosave.isDirty()).toBe(true)

    await advance()
    expect(io.writes).toHaveLength(2)
    expect(io.writes[1]?.tasks.map((t) => t.title)).toEqual(['A', 'B'])
    expect(autosave.getState()).toBe('saved')
  })
})

describe('写前快照（T09 接入点）', () => {
  it('快照在写盘之前调用，且拿到的是写盘前的版本（旧 revision）', async () => {
    const order: string[] = []
    const seen: Vault[] = []
    const snapshotter: AutosaveSnapshotter = {
      async snapshot(vault) {
        order.push('snapshot')
        seen.push(vault)
      },
    }
    const { fs, io } = setup({ snapshotter })
    const spiedSave = vi.spyOn(io.sink, 'save')
    spiedSave.mockImplementation(async (vault: Vault) => {
      order.push('save')
      io.writes.push(vault)
    })

    fs.edit((v) => addTask(v, 'A'))
    await advance()

    expect(order).toEqual(['snapshot', 'save'])
    expect(seen[0]?.revision).toBe(0)
    // 快照拿到的是 Store 里那份（内容相同），不是备份用的新对象
    expect(seen[0]?.tasks.map((t) => t.title)).toEqual(['A'])
  })

  it('快照失败则不写盘：宁可留着 dirty 重试，也不在无备份的情况下覆盖数据', async () => {
    const snapshotter: AutosaveSnapshotter = {
      async snapshot() {
        throw new Error('backup dir missing')
      },
    }
    const { fs, io, autosave } = setup({ snapshotter })

    fs.edit((v) => addTask(v, 'A'))
    await advance()

    expect(io.writes).toHaveLength(0)
    expect(autosave.getState()).toBe('error')
    expect(fs.current().tasks.map((t) => t.title)).toEqual(['A'])
  })

  it('未注入 snapshotter 时保存照常进行（T09 落地前的默认）', async () => {
    const { fs, io } = setup()

    fs.edit((v) => addTask(v, 'A'))
    await advance()

    expect(io.writes).toHaveLength(1)
  })
})

describe('订阅与生命周期', () => {
  it('三态变化逐次通知订阅者', async () => {
    const { fs, io, autosave } = setup()
    const states: SaveState[] = []
    autosave.subscribe(() => states.push(autosave.getState()))

    fs.edit((v) => addTask(v, 'A'))
    await advance()

    expect(states).toEqual(['dirty', 'saved'])
    expect(io.writes).toHaveLength(1)
  })

  it('退订后不再收到通知', async () => {
    const { fs, autosave } = setup()
    let notified = 0
    const off = autosave.subscribe(() => {
      notified += 1
    })
    off()

    fs.edit((v) => addTask(v, 'A'))
    await advance()

    expect(notified).toBe(0)
  })

  it('stop() 后不再跟随 Store，也不再自动落盘', async () => {
    const { fs, io, autosave } = setup()
    fs.edit((v) => addTask(v, 'A'))
    await advance(500)
    autosave.stop()

    await advance(5000)

    expect(io.writes).toHaveLength(0)
  })

  it('start() 幂等，重复调用不会重复挂订阅导致翻倍写盘', async () => {
    const { fs, io, autosave } = setup()
    autosave.start()

    fs.edit((v) => addTask(v, 'A'))
    await advance()

    expect(io.writes).toHaveLength(1)
  })
})
