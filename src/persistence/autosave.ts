// Autosave controller（T08）：dirty 标记 + debounce + Ctrl+S + 三态保存指示。
//
// 分层与接缝：本模块只做「什么时候写、写什么、失败了怎么办」的时序状态机。
// 三个外部面全部注入——
//   store      ：Store 变更订阅与快照读取（T10 的 VaultStore 即实现，与 T04 的 LocaleSource 同一手法）
//   sink       ：落盘（VaultRepository.save 的签名即此）
//   snapshotter：写前快照（T09 SnapshotStore；「每会话首存 / 距上次 ≥30min」的判定留在实现方）
// 因此自动保存的全部时序都能脱离浏览器与真实文件系统单测。
//
// dirty 由本控制器持有：spec 8.2 把它定义为「保存循环」的状态，而不是数据的一部分。

import type { Vault } from '../domain/types'

export type SaveState = 'saved' | 'dirty' | 'error'

/** spec 8.2：Store 变更后等 1200ms 再落盘，把连续敲键合并成一次写。 */
export const AUTOSAVE_DEBOUNCE_MS = 1200

/**
 * Autosave 需要 Store 提供的最小面。
 *
 * markSaved 之所以要求返回 Store 当前持有的 Vault：保存成功那一刻，控制器要能认出
 * 「接下来这条通知是我自己写回 revision 造成的，不是用户改动」，否则会自激成写盘死循环。
 * 同步通知由内部抑制位挡掉，异步/延迟通知由这个引用相等判断挡掉，两条路径都要覆盖。
 */
export interface AutosaveStore {
  subscribe(listener: () => void): () => void
  getVault(): Vault
  markSaved(revision: number, updatedAt: string): Vault
}

/** 落盘面：`VaultRepository.save` 即此形。 */
export interface AutosaveSink {
  save(vault: Vault): Promise<void>
}

/** 写前快照（T09）。失败即视为保存失败——宁可留 dirty 重试，也不在无备份的情况下覆盖。 */
export interface AutosaveSnapshotter {
  snapshot(vault: Vault): Promise<void>
}

export interface AutosaveDeps {
  store: AutosaveStore
  sink: AutosaveSink
  snapshotter?: AutosaveSnapshotter
  debounceMs?: number
  now?: () => Date
}

export interface Autosave {
  /** 顶栏指示器订阅用（配 useSyncExternalStore）。 */
  subscribe(listener: () => void): () => void
  getState(): SaveState
  isDirty(): boolean
  /** error 态下的失败原因；其余时候为 null。 */
  getLastError(): unknown
  /** Ctrl+S：跳过 debounce 立即落盘；无变更时是 no-op。 */
  saveNow(): Promise<void>
  /** 保存失败后的手动重试。 */
  retry(): Promise<void>
  /** 挂上 Store 订阅开始自动保存；幂等。 */
  start(): void
  stop(): void
}

export function createAutosave(deps: AutosaveDeps): Autosave {
  const debounceMs = deps.debounceMs ?? AUTOSAVE_DEBOUNCE_MS
  const now = deps.now ?? (() => new Date())

  const listeners = new Set<() => void>()
  let dirty = false
  let lastError: unknown = null
  /** 每次真实 Store 变更 +1；用来判断「写盘途中用户又改了」需要补一次。 */
  let edits = 0
  let lastAccepted: Vault | null = null
  /** 屏蔽 markSaved 引发的同步自通知。 */
  let applying = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  /** 串行化写盘：并发调用（Ctrl+S + debounce 同时到）不会交错写同一个文件。 */
  let chain: Promise<void> = Promise.resolve()

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, debounceMs)
  }

  function cancelTimer(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function onStoreChange(): void {
    if (applying) return
    const vault = deps.store.getVault()
    if (vault === lastAccepted) return
    edits += 1
    dirty = true
    notify()
    schedule()
  }

  async function doFlush(): Promise<void> {
    if (!dirty) return
    const seen = edits
    const vault = deps.store.getVault()
    const next: Vault = { ...vault, revision: vault.revision + 1, updatedAt: now().toISOString() }
    try {
      if (deps.snapshotter !== undefined) await deps.snapshotter.snapshot(vault)
      await deps.sink.save(next)
    } catch (e) {
      // 内存数据不动、dirty 不清：用户看得见失败，可重试，也可导出兜底
      lastError = e
      notify()
      return
    }
    lastError = null
    applying = true
    try {
      lastAccepted = deps.store.markSaved(next.revision, next.updatedAt)
    } finally {
      applying = false
    }
    if (edits === seen) {
      dirty = false
    } else {
      // 写盘期间用户又改了：留着 dirty，再排一次
      schedule()
    }
    notify()
  }

  function flush(): Promise<void> {
    chain = chain.then(() => doFlush())
    return chain
  }

  function saveNow(): Promise<void> {
    cancelTimer()
    return flush()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getState() {
      if (lastError !== null) return 'error'
      return dirty ? 'dirty' : 'saved'
    },
    isDirty: () => dirty,
    getLastError: () => lastError,
    saveNow,
    retry: saveNow,
    start() {
      if (unsubscribe !== null) return
      lastAccepted = deps.store.getVault()
      dirty = false
      lastError = null
      edits = 0
      unsubscribe = deps.store.subscribe(onStoreChange)
    },
    stop() {
      cancelTimer()
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
