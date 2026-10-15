import { z } from 'zod'

import { CURRENT_SCHEMA_VERSION } from './types'
import type {
  Asset,
  Dependency,
  Filter,
  Milestone,
  Settings,
  Status,
  Task,
  Topic,
  Vault,
  WorkCalendar,
} from './types'

const id = z.string().min(1)
const dateOnly = z.iso.date()
const timestamp = z.iso.datetime({ offset: true })

const statusEnum = z.enum(['todo', 'doing', 'review', 'done'])
const kindEnum = z.enum(['feature', 'bug', 'chore', 'research', 'doc'])
const priorityEnum = z.enum(['P0', 'P1', 'P2', 'P3'])
const dependencyTypeEnum = z.enum(['FS', 'SS', 'FF', 'SF'])

export const WorkCalendarSchema = z.object({
  workdays: z.array(z.number().int().min(0).max(6)),
  holidays: z.array(dateOnly),
  extraWorkdays: z.array(dateOnly),
})

export const TopicSchema = z.object({
  id,
  name: z.string(),
  color: z.string(),
  parentId: id.nullable(),
  order: z.string(),
  archived: z.boolean(),
})

export const TaskSchema = z.object({
  id,
  topicId: id,
  title: z.string(),
  status: statusEnum,
  kind: kindEnum,
  priority: priorityEnum,
  assignee: z.string().optional(),
  start: dateOnly.optional(),
  due: dateOnly.optional(),
  estimateHours: z.number().positive().optional(),
  progress: z.number().min(0).max(100),
  tags: z.array(z.string()),
  note: z.string(),
  baseline: z.object({ start: dateOnly.optional(), due: dateOnly.optional() }).optional(),
  order: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archived: z.boolean(),
})

export const DependencySchema = z.object({
  id,
  from: id,
  to: id,
  type: dependencyTypeEnum,
  lagDays: z.number().int(),
  note: z.string().optional(),
})

export const MilestoneSchema = z.object({
  id,
  topicId: id.nullable(),
  title: z.string(),
  date: dateOnly,
  done: z.boolean(),
  color: z.string().optional(),
  note: z.string().optional(),
})

export const AssetSchema = z.object({
  id,
  filename: z.string(),
  sizeBytes: z.number().int().min(0),
  createdAt: timestamp,
})

export const FilterSchema = z.object({
  topicIds: z.array(id),
  includeDescendants: z.boolean(),
  statuses: z.array(statusEnum),
  kinds: z.array(kindEnum),
  priorities: z.array(priorityEnum),
  tags: z.array(z.string()),
  tagMode: z.enum(['any', 'all']),
  assignees: z.array(z.string()),
  dateRange: z.object({ from: dateOnly.optional(), to: dateOnly.optional() }).optional(),
  overdueOnly: z.boolean().optional(),
  blockedOnly: z.boolean().optional(),
  withNotesOnly: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
  text: z.string().optional(),
  upstreamDepth: z.number().int().min(0).optional(),
  downstreamDepth: z.number().int().min(0).optional(),
})

export const DEFAULT_BOARD_COLUMNS: Status[] = ['todo', 'doing', 'review', 'done']

export const DEFAULT_CALENDAR: WorkCalendar = {
  workdays: [1, 2, 3, 4, 5],
  holidays: [],
  extraWorkdays: [],
}

// settings 允许整体缺失或逐项缺失：用户手改 vault.json 时最典型的遗漏
export const SettingsSchema = z.object({
  boardColumns: z.array(statusEnum).default(DEFAULT_BOARD_COLUMNS),
  calendar: WorkCalendarSchema.default(DEFAULT_CALENDAR),
  ganttScale: z.enum(['day', 'week']).default('day'),
  theme: z.literal('light').default('light'),
  locale: z.enum(['zh', 'en', 'auto']).default('auto'),
  lastFilter: FilterSchema.nullable().default(null),
})

export const VaultSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  vaultId: id,
  appVersion: z.string(),
  revision: z.number().int().min(0),
  updatedAt: timestamp,
  settings: SettingsSchema.default({
    boardColumns: DEFAULT_BOARD_COLUMNS,
    calendar: DEFAULT_CALENDAR,
    ganttScale: 'day',
    theme: 'light',
    locale: 'auto',
    lastFilter: null,
  }),
  topics: z.array(TopicSchema),
  tasks: z.array(TaskSchema),
  milestones: z.array(MilestoneSchema),
  links: z.array(DependencySchema),
  assets: z.array(AssetSchema),
})

// 编译期防漂移：schema 推导出的类型必须与 types.ts 完全一致，
// 任何一方改动字段都会在 tsc 阶段失败，而不是等到运行时。
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

export type SchemaAlignment = [
  Assert<Equal<Vault, z.infer<typeof VaultSchema>>>,
  Assert<Equal<Settings, z.infer<typeof SettingsSchema>>>,
  Assert<Equal<Topic, z.infer<typeof TopicSchema>>>,
  Assert<Equal<Task, z.infer<typeof TaskSchema>>>,
  Assert<Equal<Dependency, z.infer<typeof DependencySchema>>>,
  Assert<Equal<Milestone, z.infer<typeof MilestoneSchema>>>,
  Assert<Equal<Asset, z.infer<typeof AssetSchema>>>,
  Assert<Equal<Filter, z.infer<typeof FilterSchema>>>,
  Assert<Equal<WorkCalendar, z.infer<typeof WorkCalendarSchema>>>,
]

/**
 * vault.json 不是用户可信输入：校验失败必须显式抛出，让启动流程把「文件损坏」
 * 与「需要迁移」区分开呈现，绝不静默修补。
 */
export class VaultValidationError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message)
    this.name = 'VaultValidationError'
  }
}

/** 从 schemaVersion N 升到 N+1 的一步。迁移只做结构改写，不做校验。 */
export type MigrationStep = (raw: Record<string, unknown>) => Record<string, unknown>
export type MigrationChain = Readonly<Record<number, MigrationStep>>

/** 版本 1 即当前版本，尚无升级步骤；未来的 v1→v2 在此登记。 */
export const migrations: MigrationChain = {}

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new VaultValidationError('vault 文件必须是一个 JSON 对象')
  }
  return raw as Record<string, unknown>
}

function readVersion(raw: Record<string, unknown>): number {
  const version = raw.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new VaultValidationError('vault 文件缺少合法的 schemaVersion 字段')
  }
  return version
}

/**
 * 迁移前调用：为 true 表示磁盘上的文件会被改写成新格式，
 * 必须在首次写入前留一份快照（spec 8 的备份策略）。
 */
export function needsMigration(raw: unknown): boolean {
  const object = asRecord(raw)
  const version = readVersion(object)
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new VaultValidationError(
      `vault 文件的 schemaVersion ${version} 高于本版本支持的 ${CURRENT_SCHEMA_VERSION}，请升级 OffEarly`,
    )
  }
  return version < CURRENT_SCHEMA_VERSION
}

/** 沿链逐级升级并检查每一跳的版本号，返回未校验的原始对象。 */
export function applyMigrations(
  raw: unknown,
  chain: MigrationChain,
  target: number = CURRENT_SCHEMA_VERSION,
): Record<string, unknown> {
  const object = asRecord(raw)
  let version = readVersion(object)
  let current: Record<string, unknown> = object

  while (version < target) {
    const step = chain[version]
    if (step === undefined) {
      throw new VaultValidationError(`没有从 schemaVersion ${version} 升级的路径`)
    }
    current = asRecord(step(structuredClone(current)))
    const advanced = readVersion(current)
    if (advanced !== version + 1) {
      throw new VaultValidationError(
        `从 schemaVersion ${version} 迁移后版本号必须推进到 ${version + 1}`,
        [`实际为 ${advanced}`],
      )
    }
    version = advanced
  }

  return current
}

/** 读取任意版本的 vault 原始数据，迁移到当前版本并校验。 */
export function migrate(raw: unknown): Vault {
  return VaultSchema.parse(applyMigrations(raw, migrations))
}
