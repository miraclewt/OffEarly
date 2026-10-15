// SnapshotStore（T09）：滚动备份与恢复。
//
// 分层：本模块只做「什么时候打快照、存成什么名字、留下哪几份、怎么恢复」，
// 文件系统原语全部来自 fsAdapter（T06，全项目唯一接触 File System API 的层）。
//
// 为什么需要它：File System Access API 没有原子 rename（spec 8.2），
// createWritable() 是截断写。写中断就可能把一个好文件截成半个，
// 所以「写前必有快照 + 启动自愈」是数据安全的唯一保障——本模块是这条链的前半段。
//
// 快照的口径是「复制当前的 vault.json」，不是把内存对象重新序列化：
// 写盘前的那一份磁盘文件就是上一版已知good状态，逐字节保下来才是可回滚的基线。

import * as fsAdapter from './fsAdapter'
import { VAULT_FILE } from './vaultRepository'

/** spec 4.1：滚动快照目录。 */
export const BACKUP_DIR = '.backup'
/** spec 8.4：始终保留最近 20 份。 */
export const KEEP_RECENT = 20
/** spec 8.4：每日首份额外保留 30 天。 */
export const DAILY_KEEP_DAYS = 30
/** spec 8.2 / 8.4：自动快照的最小间隔。 */
export const AUTO_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1000

const MS_PER_DAY = 24 * 60 * 60 * 1000
const ENCODER = new TextEncoder()

/** 无法快照时的显式错误：调用方（autosave）据此判定「不写盘」。 */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotError'
  }
}

export interface SnapshotInfo {
  /** 文件名，同时作为 restore() 的 id，如 vault-20261015-093012.json。 */
  id: string
  /** 本地时间 ISO8601（带时区偏移），切片前 10 位即本地日期。 */
  createdAt: string
  sizeBytes: number
  taskCount: number
}

/** 依赖注入的落盘面：缺省用 fsAdapter，测试可整体替换或逐项 spy。 */
export interface SnapshotFs {
  readText(dir: FileSystemDirectoryHandle, path: string): Promise<string>
  writeText(dir: FileSystemDirectoryHandle, path: string, content: string): Promise<void>
  remove(dir: FileSystemDirectoryHandle, path: string): Promise<boolean>
  list(dir: FileSystemDirectoryHandle, dirPath: string): Promise<string[]>
  ensureSubdirs(dir: FileSystemDirectoryHandle): Promise<void>
}

export interface RetentionOptions {
  keepRecent?: number
  dailyKeepDays?: number
}

export interface SnapshotStoreDeps {
  fs?: SnapshotFs
  now?: () => Date
  keepRecent?: number
  dailyKeepDays?: number
}

export interface SnapshotStore {
  /** 立即快照（手动「立即快照」/ restore 前防误操作）；复制当前 vault.json。 */
  snapshot(): Promise<SnapshotInfo>
  /** 按自动策略打快照：会话首存或距上次 ≥30min 时落一份，否则返回 null。 */
  autoSnapshot(): Promise<SnapshotInfo | null>
  /** 列出全部快照（时间 / 大小 / 任务数），按时间倒序。 */
  list(): Promise<SnapshotInfo[]>
  /** 用某份快照覆盖 vault.json；恢复前先对当前版本再打一份快照，返回该安全快照。 */
  restore(id: string): Promise<SnapshotInfo>
  /** 给 T08 autosave 的写前快照端口用：每次都走自动策略闸门。 */
  autoSnapshotter(): { snapshot(): Promise<void> }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** 本地时间戳，如 20261015-093012（spec 4.1 的备份文件名口径，取本地时间）。 */
export function formatSnapshotStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

const SNAPSHOT_RE = /^vault-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.json$/

/** 从备份文件名解析本地时间；非快照命名返回 null。 */
export function parseSnapshotStamp(name: string): Date | null {
  const m = SNAPSHOT_RE.exec(name)
  if (m === null) return null
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  )
}

/** 带本地时区偏移的 ISO8601，避免「本地日期」在跨 UTC 边界时被串到前一天。 */
export function toLocalIso(d: Date): string {
  const offset = -d.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * 保留策略（spec 8.4）：最近 keepRecent 份 + 每日首份保留 dailyKeepDays 天，其余删除。
 * 返回应保留的条目（保持入参顺序）。纯函数，便于用构造样本直接单测。
 */
export function selectRetained(
  entries: readonly SnapshotInfo[],
  now: Date,
  options: RetentionOptions = {},
): SnapshotInfo[] {
  const keepRecent = options.keepRecent ?? KEEP_RECENT
  const dailyKeepDays = options.dailyKeepDays ?? DAILY_KEEP_DAYS
  const asc = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const keep = new Set<string>()
  if (keepRecent > 0) {
    for (const e of asc.slice(-keepRecent)) keep.add(e.id)
  }

  // 每日首份：按本地日期分组，最早的一份；仅当该日仍在窗口内才保留。
  const cutoff = now.getTime() - dailyKeepDays * MS_PER_DAY
  const seenDay = new Set<string>()
  for (const e of asc) {
    const day = e.createdAt.slice(0, 10)
    if (seenDay.has(day)) continue
    seenDay.add(day)
    if (Date.parse(e.createdAt) >= cutoff) keep.add(e.id)
  }

  return entries.filter((e) => keep.has(e.id))
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'NotFoundError'
  )
}

function byteLength(text: string): number {
  return ENCODER.encode(text).length
}

/** 从快照文本里数任务；解析失败（损坏快照）按 0 计，不阻断 list()。 */
function countTasks(text: string): number {
  try {
    const raw = JSON.parse(text) as { tasks?: unknown }
    return Array.isArray(raw.tasks) ? raw.tasks.length : 0
  } catch {
    return 0
  }
}

export function createSnapshotStore(
  dir: FileSystemDirectoryHandle,
  deps: SnapshotStoreDeps = {},
): SnapshotStore {
  const fs = deps.fs ?? fsAdapter
  const now = deps.now ?? (() => new Date())
  const keepRecent = deps.keepRecent ?? KEEP_RECENT
  const dailyKeepDays = deps.dailyKeepDays ?? DAILY_KEEP_DAYS

  /** null = 本会话尚未打过快照（「每会话首存 1 份」的判据）。 */
  let lastSnapshotAt: Date | null = null

  const backupPath = (name: string): string => `${BACKUP_DIR}/${name}`

  async function backupNames(): Promise<Set<string>> {
    try {
      return new Set(await fs.list(dir, BACKUP_DIR))
    } catch (e) {
      if (isNotFound(e)) return new Set()
      throw e
    }
  }

  async function readVault(): Promise<string> {
    try {
      return await fs.readText(dir, VAULT_FILE)
    } catch (e) {
      if (isNotFound(e)) throw new SnapshotError('vault.json 不存在，无可快照内容')
      throw e
    }
  }

  async function list(): Promise<SnapshotInfo[]> {
    const names = await backupNames()
    const infos: SnapshotInfo[] = []
    for (const name of names) {
      const at = parseSnapshotStamp(name)
      if (at === null) continue
      let text: string
      try {
        text = await fs.readText(dir, backupPath(name))
      } catch {
        // 并发删除 / 读取失败：跳过这一条，不影响其余快照
        continue
      }
      infos.push({
        id: name,
        createdAt: toLocalIso(at),
        sizeBytes: byteLength(text),
        taskCount: countTasks(text),
      })
    }
    infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return infos
  }

  async function prune(): Promise<void> {
    const entries = await list()
    const keep = new Set(
      selectRetained(entries, now(), { keepRecent, dailyKeepDays }).map((e) => e.id),
    )
    for (const e of entries) {
      if (!keep.has(e.id)) await fs.remove(dir, backupPath(e.id))
    }
  }

  /** 同秒内重复快照会撞名，追加序号避免覆盖。 */
  async function uniqueName(at: Date): Promise<string> {
    const base = `vault-${formatSnapshotStamp(at)}`
    const names = await backupNames()
    if (!names.has(`${base}.json`)) return `${base}.json`
    for (let i = 2; ; i += 1) {
      const candidate = `${base}-${i}.json`
      if (!names.has(candidate)) return candidate
    }
  }

  async function writeSnapshot(at: Date): Promise<SnapshotInfo> {
    await fs.ensureSubdirs(dir)
    const text = await readVault()
    const id = await uniqueName(at)
    await fs.writeText(dir, backupPath(id), text)
    lastSnapshotAt = at
    await prune()
    return { id, createdAt: toLocalIso(at), sizeBytes: byteLength(text), taskCount: countTasks(text) }
  }

  function shouldAutoSnapshot(at: Date): boolean {
    if (lastSnapshotAt === null) return true
    return at.getTime() - lastSnapshotAt.getTime() >= AUTO_SNAPSHOT_INTERVAL_MS
  }

  async function runAutoSnapshot(): Promise<SnapshotInfo | null> {
    const at = now()
    if (!shouldAutoSnapshot(at)) return null
    return writeSnapshot(at)
  }

  return {
    snapshot() {
      return writeSnapshot(now())
    },
    autoSnapshot: runAutoSnapshot,
    list,
    async restore(id) {
      // 先把内容读出来再打安全快照：prune 有可能正好清掉这份旧快照。
      let content: string
      try {
        content = await fs.readText(dir, backupPath(id))
      } catch (e) {
        if (isNotFound(e)) throw new SnapshotError(`快照不存在：${id}`)
        throw e
      }
      const safety = await writeSnapshot(now())
      await fs.writeText(dir, VAULT_FILE, content)
      return safety
    },
    autoSnapshotter() {
      return {
        async snapshot(): Promise<void> {
          await runAutoSnapshot()
        },
      }
    },
  }
}
