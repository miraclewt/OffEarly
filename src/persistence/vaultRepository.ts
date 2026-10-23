// VaultRepository：vault.json 的唯一读写入口（load / save / peekRevision / create）。
//
// 分层：文件系统原语全部来自 fsAdapter（T06，全项目唯一接触 File System API 的层），
// 本文件只做 JSON 解析、Zod 校验、schema 迁移与 revision 的轻量提取。
//
// peekRevision 的关键约束是「不加载全量」：30 秒轮询与冲突检测都会高频调用它，
// 而 vault.json 可能到数 MB，所以用 fsAdapter.readHead 只取文件头。
// 我们能这么读，是因为 save() 落盘时本仓库自己控制键序（revision 固定在第四位）。

import { nanoid } from 'nanoid'
import { ZodError } from 'zod'

import { CURRENT_SCHEMA_VERSION } from '../domain/types'
import type { Vault } from '../domain/types'
import { VaultSchema, VaultValidationError, migrate, needsMigration } from '../domain/schema'
import * as fsAdapter from './fsAdapter'

export const VAULT_FILE = 'vault.json'

/** spec 4.1：滚动备份目录。与 SnapshotStore 同名同义，此处就地声明以避开循环 import。 */
const BACKUP_DIR = '.backup'

/** peekRevision 只读文件头；文件头里没有 revision 时才退回全量解析。 */
const REVISION_HEAD_BYTES = 4096

const REVISION_PATTERN = /"revision"\s*:\s*(\d+)/

/**
 * 依赖注入的落盘面：缺省用 fsAdapter 原语，测试可以 spy 或替换，
 * 以断言「peekRevision 没碰 readText」这类分层约束。
 */
export interface VaultFs {
  readText(dir: FileSystemDirectoryHandle, path: string): Promise<string>
  writeText(dir: FileSystemDirectoryHandle, path: string, content: string): Promise<void>
  readHead(
    dir: FileSystemDirectoryHandle,
    path: string,
    maxBytes: number,
  ): Promise<{ text: string; whole: boolean }>
}

export interface VaultRepository {
  /** 读 vault.json → Zod 校验 → 迁移 → 返回 Vault；文件不存在返回 null；失败抛错不写盘。 */
  load(): Promise<Vault | null>
  /** 全量写回 vault.json（revision 管理在调用方，见 T08 autosave）。 */
  save(vault: Vault): Promise<void>
  /** 只读提取磁盘 revision，不加载全量；文件不存在返回 null。 */
  peekRevision(): Promise<number | null>
  /** 在空目录初始化新库：建 assets/ + .backup/，写 vault.json；已有库时拒绝覆盖。 */
  create(): Promise<Vault>
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'NotFoundError'
  )
}

/** 把 migrate/Zod/JSON 的异质错误统一成 VaultValidationError，启动流程只需认一种。 */
function asValidationError(e: unknown): VaultValidationError {
  if (e instanceof VaultValidationError) return e
  if (e instanceof ZodError) {
    return new VaultValidationError(
      'vault.json 未通过结构校验',
      e.issues.map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`),
    )
  }
  return new VaultValidationError(e instanceof Error ? e.message : String(e))
}

/**
 * 「文本 → Vault」的唯一解析语义：JSON 语法 → schemaVersion 方向 → 迁移 → Zod 校验。
 * `load()`（磁盘）与 T29 的快照恢复共用它，避免两条链路的判据漂移。
 * T28 的导入也复用同一解析，保证「导入校验」与「启动加载」判据一致。
 */
export function parseVaultText(text: string): Vault {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new VaultValidationError('vault.json 不是合法的 JSON')
  }
  try {
    needsMigration(raw) // 版本高于当前时在此抛错（T03 语义）
    return migrate(raw)
  } catch (e) {
    throw asValidationError(e)
  }
}

export function createVaultRepository(
  dir: FileSystemDirectoryHandle,
  deps: VaultFs = fsAdapter,
): VaultRepository {
  return {
    async load() {
      let text: string
      try {
        text = await deps.readText(dir, VAULT_FILE)
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
      return parseVaultText(text)
    },

    async save(vault) {
      await deps.writeText(dir, VAULT_FILE, JSON.stringify(vault))
    },

    async peekRevision() {
      let head: { text: string; whole: boolean }
      try {
        head = await deps.readHead(dir, VAULT_FILE, REVISION_HEAD_BYTES)
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
      const match = REVISION_PATTERN.exec(head.text)
      if (match !== null) return Number(match[1])
      // 键序被打乱（用户手改/外部格式化）时头里没有 revision，退回全量解析
      let raw: unknown
      try {
        raw = JSON.parse(await deps.readText(dir, VAULT_FILE))
      } catch {
        throw new VaultValidationError('vault.json 不是合法的 JSON')
      }
      if (
        typeof raw !== 'object' ||
        raw === null ||
        !Number.isInteger((raw as { revision?: unknown }).revision)
      ) {
        throw new VaultValidationError('vault.json 缺少合法的 revision 字段')
      }
      return (raw as { revision: number }).revision
    },

    async create() {
      try {
        await deps.readText(dir, VAULT_FILE)
      } catch (e) {
        if (!isNotFound(e)) throw e
        // 不存在才继续初始化；存在则走下面拒绝分支
        await fsAdapter.ensureSubdirs(dir)
        const vault = createNewVault()
        await this.save(vault)
        return vault
      }
      throw new VaultValidationError('该文件夹已存在 vault.json，拒绝覆盖')
    },
  }
}

/** 新建库的字段是 spec 8.1「初始化」的验收面：vaultId/revision/schemaVersion 固定值。 */
export function createNewVault(now: Date = new Date()): Vault {
  return VaultSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    vaultId: nanoid(),
    appVersion: 'OffEarly 0.3.0',
    revision: 0,
    updatedAt: now.toISOString(),
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
  })
}

// ---------------------------------------------------------------------------
// T27 · 冲突检测（spec 8.2 save 前置检查 / 8.3 三选 / 30s 轮询）
//
// 全部逻辑集中在此，原因有二：
//   1. 冲突的判据是「磁盘 revision vs 内存基线 revision」，而 revision 归本仓库所有；
//   2. 三条出路（以我为准 / 以磁盘为准 / 导出副本）都要读写 vault.json 与 .backup/，
//      只有这里握有正确的路径与键序约定。
// 视图（ConflictDialog）只拿结果渲染，不碰文件系统（spec 3 硬规则 1）。
// ---------------------------------------------------------------------------

/** spec 8.3：30 秒轮询磁盘 revision。 */
export const CONFLICT_POLL_MS = 30_000

/** spec 8.3：导出本地副本的文件名前缀（vault-conflict-<ts>.json）。 */
export const CONFLICT_EXPORT_PREFIX = 'vault-conflict-'

/** 冲突报告：既是弹窗的输入，也是「以磁盘为准」丢失量的预告。 */
export interface ConflictReport {
  /** 磁盘上的 revision（即另一端写入后的版本）。 */
  diskRevision: number
  localTaskCount: number
  diskTaskCount: number
  /** 磁盘上没有的本地任务数 —— 选「以磁盘为准」就会丢掉这么多条。 */
  droppedTaskCount: number
}

/** 冲突路径用到的文件面（比 VaultFs 多出 list/ensureSubdirs，备份要写进 .backup/）。 */
export interface ConflictFs extends VaultFs {
  list(dir: FileSystemDirectoryHandle, dirPath: string): Promise<string[]>
  ensureSubdirs(dir: FileSystemDirectoryHandle): Promise<void>
}

export interface ConflictGuardDeps {
  fs?: ConflictFs
  now?: () => Date
}

export interface ConflictGuard {
  /**
   * save 前的闸门：磁盘 revision > 内存基线 → 返回报告（UI 弹三选）；
   * 无冲突返回 null（可安全落盘）；vault.json 不存在同样算无冲突。
   */
  detect(local: Vault): Promise<ConflictReport | null>
  /** 干净则落盘，冲突则原样返回报告且**不写盘**。 */
  saveGuarded(local: Vault): Promise<ConflictReport | null>
  /**
   * 以我为准：磁盘旧版先进 .backup/（可回滚），再覆盖写盘。
   * 写回的 revision = max(本地, 磁盘+1) —— 否则下一次 save 会再次判成冲突。
   */
  keepMine(local: Vault): Promise<{ backupId: string | null; revision: number }>
  /** 以磁盘为准：丢弃本地未保存变更并重载磁盘版，回报丢失条数。 */
  takeDisk(local: Vault): Promise<{ vault: Vault; droppedTaskCount: number }>
  /** 导出我的副本：内存版本写成 vault-conflict-<ts>.json，然后重载磁盘版。 */
  exportMine(
    local: Vault,
  ): Promise<{ filename: string; vault: Vault; droppedTaskCount: number }>
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 与 SnapshotStore 同格式的本地时间戳（vault-YYYYMMDD-HHmmss）：
 * 冲突备份落进 .backup/ 后要能被 SnapshotStore.list() 认出来（T28 的备份面板）。
 */
export function formatConflictStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  )
}

/** 磁盘上有而内存里没有的任务数（「以磁盘为准」的丢失量预告）。 */
function countDropped(local: Vault, disk: Vault): number {
  const onDisk = new Set(disk.tasks.map((task) => task.id))
  return local.tasks.filter((task) => !onDisk.has(task.id)).length
}

/**
 * 逐字节把当前 vault.json 复制进 .backup/，返回备份文件名；文件不存在时返回 null。
 * 冲突（T27「以我为准」）与恢复（T29「恢复此快照」）共用：两处都必须在覆盖前留底。
 */
async function writeBackupCopy(
  dir: FileSystemDirectoryHandle,
  fs: ConflictFs,
  now: () => Date,
): Promise<string | null> {
  let text: string
  try {
    text = await fs.readText(dir, VAULT_FILE)
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
  await fs.ensureSubdirs(dir)
  const base = `vault-${formatConflictStamp(now())}`
  let names: Set<string>
  try {
    names = new Set(await fs.list(dir, BACKUP_DIR))
  } catch (e) {
    if (isNotFound(e)) names = new Set()
    else throw e
  }
  let id = `${base}.json`
  for (let i = 2; names.has(id); i += 1) id = `${base}-${i}.json`
  await fs.writeText(dir, `${BACKUP_DIR}/${id}`, text)
  return id
}

export function createConflictGuard(
  dir: FileSystemDirectoryHandle,
  repo: VaultRepository,
  deps: ConflictGuardDeps = {},
): ConflictGuard {
  const fs = deps.fs ?? fsAdapter
  const now = deps.now ?? (() => new Date())

  async function readDisk(): Promise<Vault | null> {
    return repo.load()
  }

  /** 逐字节复制当前 vault.json 进 .backup/；文件不存在时返回 null（无从备份）。 */
  async function backupDisk(): Promise<string | null> {
    return writeBackupCopy(dir, fs, now)
  }

  async function report(local: Vault): Promise<ConflictReport | null> {
    const diskRevision = await repo.peekRevision()
    if (diskRevision === null || diskRevision <= local.revision) return null
    const disk = await readDisk()
    if (disk === null) return null
    return {
      diskRevision,
      localTaskCount: local.tasks.length,
      diskTaskCount: disk.tasks.length,
      droppedTaskCount: countDropped(local, disk),
    }
  }

  async function takeDisk(local: Vault) {
    const disk = await readDisk()
    if (disk === null) throw new VaultValidationError('磁盘上的 vault.json 已不存在')
    return { vault: disk, droppedTaskCount: countDropped(local, disk) }
  }

  return {
    detect: report,

    async saveGuarded(local) {
      const conflict = await report(local)
      if (conflict !== null) return conflict
      await repo.save(local)
      return null
    },

    async keepMine(local) {
      // 先备份再覆盖：顺序反了就再也拿不回磁盘旧版
      const backupId = await backupDisk()
      const diskRevision = await repo.peekRevision()
      const revision = Math.max(local.revision, (diskRevision ?? local.revision) + 1)
      await repo.save({ ...local, revision, updatedAt: now().toISOString() })
      return { backupId, revision }
    },

    async exportMine(local) {
      const filename = `${CONFLICT_EXPORT_PREFIX}${formatConflictStamp(now())}.json`
      await fs.writeText(dir, filename, JSON.stringify(local))
      const disk = await takeDisk(local)
      return { filename, ...disk }
    },

    takeDisk,
  }
}

/** 轮询结果：集成车道据此决定要不要刷新视图 / 顶栏。 */
export type PollOutcome = 'unchanged' | 'reloaded' | 'notified' | 'failed'

export interface RevisionWatcherDeps {
  /** 便宜地读磁盘 revision（VaultRepository.peekRevision）。 */
  peekRevision: () => Promise<number | null>
  /** 内存基线（VaultStore 当前 revision）。 */
  getMemoryRevision: () => number
  /** 本地是否有未保存改动（Autosave.isDirty）。 */
  isDirty: () => boolean
  /** 磁盘变且本地不 dirty：静默重载。 */
  reload: () => Promise<void>
  /** 磁盘变但本地 dirty：顶栏提示「另一端已更新，保存时将询问」（spec 8.3）。 */
  notify: (info: { diskRevision: number; memoryRevision: number }) => void
  intervalMs?: number
}

export interface RevisionWatcher {
  /** 单次判定的结果；start() 每次触发都会走这条路径。 */
  check(): Promise<PollOutcome>
  start(): void
  stop(): void
}

/**
 * spec 8.3 的 30s 轮询。判定口径是「磁盘 revision > 内存 revision」——
 * 自己保存后 Store 的 revision 会跟着抬升，因此自己的写不会被误判成外部变更。
 */
export function createRevisionWatcher(deps: RevisionWatcherDeps): RevisionWatcher {
  const intervalMs = deps.intervalMs ?? CONFLICT_POLL_MS
  let timer: ReturnType<typeof setInterval> | null = null

  async function check(): Promise<PollOutcome> {
    let diskRevision: number | null
    try {
      diskRevision = await deps.peekRevision()
    } catch {
      // 读不到不算「外部更新」：权限被撤或文件损坏由 T29 的安全模式路径处理，
      // 轮询只负责发现变更，不该把应用打断。
      return 'failed'
    }
    if (diskRevision === null) return 'unchanged'
    const memoryRevision = deps.getMemoryRevision()
    if (diskRevision <= memoryRevision) return 'unchanged'
    if (deps.isDirty()) {
      deps.notify({ diskRevision, memoryRevision })
      return 'notified'
    }
    await deps.reload()
    return 'reloaded'
  }

  return {
    check,
    start() {
      if (timer !== null) return
      timer = setInterval(() => {
        void check()
      }, intervalMs)
    },
    stop() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },
  }
}

// ---------------------------------------------------------------------------
// T29 · 启动自愈与只读安全模式（spec 8.2 写中断 / 8.5 迁移与只读安全模式）
//
// 不变量：**解析/校验/迁移失败时一个字节都不许写回磁盘。**
// File System Access API 没有原子 rename，写中断会把好文件截成半个（spec 8.2），
// 因此「磁盘坏了」的正确反应是加载 `.backup/` 里最近可用的快照、以只读方式呈现，
// 把决定权交回用户 —— 绝不静默覆盖，也绝不静默修补。
//
// 三条出路由视图（SafeModeBanner）触发、由本模块执行：
//   恢复此快照 → restoreSnapshot()：先给当前（可能已损坏的）文件留底，再逐字节覆盖
//   选择其他备份 → loadSnapshot()：把指定快照载入只读视图（打开备份面板是 T28 的活）
//   导出当前 → exportCurrent()：把正在看的只读内容导出成独立文件
// ---------------------------------------------------------------------------

/** 只读下的写尝试：CommandBus 与落盘面都抛这个，UI 据此提示。 */
export class ReadOnlyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadOnlyError'
  }
}

/**
 * 只读开关。做成独立对象而不是散落的布尔标志，是为了让「谁在判、判什么」
 * 只有一个入口：CommandBus 守卫与落盘守卫共享同一个实例。
 */
export interface ReadOnlyGuard {
  isReadOnly(): boolean
  /** 进入只读的原因（提示文案用）；非只读时为 null。 */
  reason(): string | null
  enter(reason: string): void
  exit(): void
}

export function createReadOnlyGuard(): ReadOnlyGuard {
  let reason: string | null = null
  return {
    isReadOnly: () => reason !== null,
    reason: () => reason,
    enter(next) {
      reason = next
    },
    exit() {
      reason = null
    },
  }
}

/** 只读提示的文案口径（本车道不碰 locales，故与组件一样自带中文兜底）。 */
export function readOnlyMessage(reason: string | null): string {
  return reason === null
    ? '只读安全模式：写操作已禁用'
    : `只读安全模式：写操作已禁用（${reason}）`
}

/** CommandBus 的结构面：只认这三个写入口，不 import domain 层（spec 3 硬规则 1）。 */
export interface CommandBusLike<C> {
  apply(command: C): void
  undo(): boolean
  redo(): boolean
  canUndo?(): boolean
  canRedo?(): boolean
}

/**
 * spec 8.5 的「所有写操作禁用」在 CommandBus 一侧的落点：
 * 守卫包在原 bus 外面，只读时 apply/undo/redo 一律抛 ReadOnlyError 并回调提示，
 * canUndo/canRedo 取 false 让按钮同时置灰。底层 bus 与撤销栈原样保留 ——
 * 解除只读（恢复快照后）即可继续使用，不需要重建。
 */
export function guardCommandBus<C>(
  bus: CommandBusLike<C>,
  guard: ReadOnlyGuard,
  onRejected?: (message: string) => void,
): CommandBusLike<C> {
  function blocked(): never {
    const message = readOnlyMessage(guard.reason())
    onRejected?.(message)
    throw new ReadOnlyError(message)
  }
  return {
    apply(command) {
      if (guard.isReadOnly()) blocked()
      bus.apply(command)
    },
    undo() {
      if (guard.isReadOnly()) blocked()
      return bus.undo()
    },
    redo() {
      if (guard.isReadOnly()) blocked()
      return bus.redo()
    },
    canUndo: () => !guard.isReadOnly() && (bus.canUndo?.() ?? false),
    canRedo: () => !guard.isReadOnly() && (bus.canRedo?.() ?? false),
  }
}

/** 快照条目的只读视图（SafeModeBanner「选择其他备份」的候选行）。 */
export interface SafeModeSnapshotRef {
  id: string
  createdAt: string
  sizeBytes: number
  taskCount: number
}

export type StartupStatus = 'healthy' | 'readonly' | 'safemode' | 'empty'

export interface StartupOutcome {
  status: StartupStatus
  /** healthy 与 readonly 有值；safemode / empty 为 null。 */
  vault: Vault | null
  /** 失败原因（readonly / safemode 有值）。 */
  reason: string | null
  /** readonly 时命中的快照。 */
  snapshot: SafeModeSnapshotRef | null
  /** 自愈过程中尝试过的快照 id（按新→旧），用于说明「试过了什么」。 */
  attempts: string[]
}

export interface SelfHealingLoaderDeps {
  fs?: ConflictFs
  now?: () => Date
  /**
   * 启动自愈最多尝试几份快照。默认 1 —— spec 8.2/8.5 的口径是
   * 「自动从 .backup/ 最近快照恢复一次，仍失败才进安全模式」；
   * 传更大的值即退化为「从新到旧找最近可用」（供「选择其他备份」这类显式操作使用）。
   */
  maxAttempts?: number
}

export interface SelfHealingLoader {
  readOnly: ReadOnlyGuard
  /** 启动主入口：先试磁盘，失败则自愈，再失败才 safemode。 */
  load(): Promise<StartupOutcome>
  /** 列出 `.backup/` 里的快照（时间倒序）。 */
  listSnapshots(): Promise<SafeModeSnapshotRef[]>
  /** 把指定快照载入只读视图（不写盘）。 */
  loadSnapshot(id: string): Promise<StartupOutcome>
  /** 恢复指定快照：先留底再覆盖写盘，成功后解除只读。 */
  restoreSnapshot(id: string): Promise<{ vault: Vault; safetySnapshotId: string | null }>
  /** 导出当前（只读）内容为独立文件，不动 vault.json。 */
  exportCurrent(vault: Vault): Promise<{ filename: string }>
  /** 带只读闸门的落盘：只读时抛 ReadOnlyError。 */
  saveGuarded(vault: Vault): Promise<void>
}

export const SNAPSHOT_PREFIX = 'vault-'
export const EXPORT_PREFIX = 'vault-export-'

const SNAPSHOT_NAME_RE = /^vault-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.json$/

/** 从备份文件名解析本地时间；非快照命名返回 null（拒掉 vault-conflict-* 等外来文件）。 */
function parseSnapshotName(name: string): Date | null {
  const m = SNAPSHOT_NAME_RE.exec(name)
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

/** 与 SnapshotStore.toLocalIso 同形（带偏移），供横幅显示。 */
function toLocalIso(d: Date): string {
  const offset = -d.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
}

function countTasksIn(text: string): number {
  try {
    const raw = JSON.parse(text) as { tasks?: unknown }
    return Array.isArray(raw.tasks) ? raw.tasks.length : 0
  } catch {
    return 0
  }
}

export function createSelfHealingLoader(
  dir: FileSystemDirectoryHandle,
  repo: VaultRepository,
  deps: SelfHealingLoaderDeps = {},
): SelfHealingLoader {
  const fs = deps.fs ?? fsAdapter
  const now = deps.now ?? (() => new Date())
  const maxAttempts = deps.maxAttempts ?? 1
  const readOnly = createReadOnlyGuard()
  const encoder = new TextEncoder()

  /** 首次失败的原始原因：只读视图整个生命周期都挂着，横幅据此说明「为什么只读」。 */
  let failureReason: string | null = null

  function reasonOf(e: unknown): string {
    if (e instanceof VaultValidationError) {
      return e.issues.length > 0 ? `${e.message}（${e.issues.join('；')}）` : e.message
    }
    return e instanceof Error ? e.message : String(e)
  }

  async function backupNames(): Promise<string[]> {
    try {
      return await fs.list(dir, BACKUP_DIR)
    } catch (e) {
      if (isNotFound(e)) return []
      throw e
    }
  }

  const backupPath = (id: string): string => `${BACKUP_DIR}/${id}`

  async function listSnapshots(): Promise<SafeModeSnapshotRef[]> {
    const refs: SafeModeSnapshotRef[] = []
    for (const name of await backupNames()) {
      const at = parseSnapshotName(name)
      if (at === null) continue
      let text: string
      try {
        text = await fs.readText(dir, backupPath(name))
      } catch {
        // 并发删除 / 读失败：跳过这一条，不影响其余候选
        continue
      }
      refs.push({
        id: name,
        createdAt: toLocalIso(at),
        sizeBytes: encoder.encode(text).length,
        taskCount: countTasksIn(text),
      })
    }
    // 文件名即 YYYYMMDD-HHmmss，倒序 = 新→旧；同秒撞名时按文件名再定序
    refs.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    return refs
  }

  async function readSnapshotText(id: string): Promise<string> {
    try {
      return await fs.readText(dir, backupPath(id))
    } catch (e) {
      if (isNotFound(e)) throw new VaultValidationError(`快照不存在：${id}`)
      throw e
    }
  }

  function enterReadOnly(reason: string): void {
    failureReason = reason
    readOnly.enter(reason)
  }

  /** 把快照内容解析成 Vault；解析失败抛 VaultValidationError（不自愈、不写盘）。 */
  async function snapshotVault(id: string): Promise<Vault> {
    return parseVaultText(await readSnapshotText(id))
  }

  async function toReadOnlyOutcome(attempts: string[]): Promise<StartupOutcome> {
    const candidates = await listSnapshots()
    for (const ref of candidates.slice(0, maxAttempts)) {
      attempts.push(ref.id)
      try {
        const vault = await snapshotVault(ref.id)
        return {
          status: 'readonly',
          vault,
          reason: failureReason,
          snapshot: ref,
          attempts,
        }
      } catch {
        // 换下一份候选（若还有额度）；全部落空则由调用方转向 safemode
      }
    }
    return { status: 'safemode', vault: null, reason: failureReason, snapshot: null, attempts }
  }

  return {
    readOnly,

    async load() {
      try {
        const vault = await repo.load()
        if (vault === null) {
          return {
            status: 'empty',
            vault: null,
            reason: null,
            snapshot: null,
            attempts: [],
          }
        }
        failureReason = null
        readOnly.exit()
        return { status: 'healthy', vault, reason: null, snapshot: null, attempts: [] }
      } catch (e) {
        enterReadOnly(reasonOf(e))
        return toReadOnlyOutcome([])
      }
    },

    listSnapshots,

    async loadSnapshot(id) {
      try {
        const vault = await snapshotVault(id)
        const refs = await listSnapshots()
        return {
          status: 'readonly',
          vault,
          reason: failureReason,
          snapshot: refs.find((ref) => ref.id === id) ?? null,
          attempts: [id],
        }
      } catch (e) {
        // 选到坏快照：不升级也不降级，留在安全模式并换一条原因
        enterReadOnly(reasonOf(e))
        return {
          status: 'safemode',
          vault: null,
          reason: failureReason,
          snapshot: null,
          attempts: [id],
        }
      }
    },

    async restoreSnapshot(id) {
      const text = await readSnapshotText(id)
      // 先校验再覆盖：坏快照绝不能盖掉磁盘
      const vault = parseVaultText(text)
      // 当前（可能已损坏的）文件先进 .backup/，恢复错了也能追回来
      const safetySnapshotId = await writeBackupCopy(dir, fs, now)
      await fs.writeText(dir, VAULT_FILE, text)
      failureReason = null
      readOnly.exit()
      return { vault, safetySnapshotId }
    },

    async exportCurrent(vault) {
      const filename = `${EXPORT_PREFIX}${formatConflictStamp(now())}.json`
      await fs.writeText(dir, filename, JSON.stringify(vault))
      return { filename }
    },

    async saveGuarded(vault) {
      if (readOnly.isReadOnly()) throw new ReadOnlyError(readOnlyMessage(readOnly.reason()))
      await repo.save(vault)
    },
  }
}

