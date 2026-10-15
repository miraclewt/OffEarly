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
import * as fs from './fsAdapter'

export const VAULT_FILE = 'vault.json'

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

export function createVaultRepository(
  dir: FileSystemDirectoryHandle,
  deps: VaultFs = fs,
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
        await fs.ensureSubdirs(dir)
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
    appVersion: 'OffEarly 0.1.0',
    revision: 0,
    updatedAt: now.toISOString(),
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
  })
}
