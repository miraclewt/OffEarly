import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  VaultSchema,
  VaultValidationError,
  applyMigrations,
  migrate,
  needsMigration,
  type MigrationChain,
  type MigrationStep,
} from '../../src/domain/schema'
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/types'
import type { Dependency, Milestone, Settings, Task, Topic, Vault } from '../../src/domain/types'

const NOW = '2026-10-15T01:00:00.000Z'

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 'topic-1',
    name: 'T03 领域基座',
    color: '#4F46E5',
    parentId: null,
    order: 'a0',
    archived: false,
    ...overrides,
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    topicId: 'topic-1',
    title: '写迁移管线',
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: ['domain'],
    note: '![](assets/a1f3c9.png)',
    order: 'a0',
    createdAt: NOW,
    updatedAt: NOW,
    archived: false,
    ...overrides,
  }
}

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return { id: 'ms-1', topicId: null, title: '基座可用', date: '2026-10-20', done: false, ...overrides }
}

function makeLink(overrides: Partial<Dependency> = {}): Dependency {
  return { id: 'dep-1', from: 'task-1', to: 'task-2', type: 'FS', lagDays: 0, ...overrides }
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    boardColumns: ['todo', 'doing', 'review', 'done'],
    calendar: { workdays: [1, 2, 3, 4, 5], holidays: ['2026-10-01'], extraWorkdays: ['2026-10-11'] },
    ganttScale: 'week',
    theme: 'light',
    locale: 'zh',
    lastFilter: null,

    noteFontSize: 13,
    ...overrides,
  }
}

function makeVault(overrides: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    vaultId: 'vault-01',
    appVersion: '0.1.0',
    revision: 3,
    updatedAt: NOW,
    settings: makeSettings(),
    topics: [makeTopic()],
    tasks: [makeTask(), makeTask({ id: 'task-2', title: '接线看板', status: 'doing', progress: 40 })],
    milestones: [makeMilestone()],
    links: [makeLink()],
    assets: [{ id: 'a1f3c9', filename: 'a1f3c9.png', sizeBytes: 20480, createdAt: NOW }],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    ...overrides,
  }
}

/** 深拷贝后再删字段，避免测试互相污染。 */
function without<K extends keyof Vault>(key: K): Vault & Record<string, unknown> {
  const raw = structuredClone(makeVault()) as Vault & Record<string, unknown>
  delete raw[key as string]
  return raw
}

describe('VaultSchema', () => {
  it('接受合法样本并原样往返', () => {
    const vault = makeVault()
    const parsed = VaultSchema.parse(JSON.parse(JSON.stringify(vault)))
    expect(parsed).toEqual(vault)
  })

  it('settings 整体缺失时补齐默认值', () => {
    const parsed = VaultSchema.parse(without('settings'))
    expect(parsed.settings).toEqual({
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'auto',
      lastFilter: null,

      noteFontSize: 13,
    })
  })

  it('缺少必填字段抛错并指出路径', () => {
    const raw = structuredClone(makeVault())
    delete (raw.tasks[0] as Partial<Task>).title

    expect(() => VaultSchema.parse(raw)).toThrow(z.ZodError)
    try {
      VaultSchema.parse(raw)
    } catch (error) {
      const issue = (error as z.ZodError).issues.find((i) => i.path.join('.') === 'tasks.0.title')
      expect(issue?.code).toBe('invalid_type')
    }
  })

  it('topics 数组整体缺失抛错', () => {
    expect(() => VaultSchema.parse(without('topics'))).toThrow(z.ZodError)
  })

  it('非法枚举值抛错', () => {
    expect(() => VaultSchema.parse(makeVault({ tasks: [makeTask({ status: 'blocked' as never })] }))).toThrow(
      z.ZodError,
    )
    expect(() => VaultSchema.parse(makeVault({ tasks: [makeTask({ priority: 'P5' as never })] }))).toThrow(
      z.ZodError,
    )
    expect(() => VaultSchema.parse(makeVault({ links: [makeLink({ type: 'XX' as never })] }))).toThrow(
      z.ZodError,
    )
    expect(() =>
      VaultSchema.parse(makeVault({ topics: [makeTopic({ parentId: '' as never })] })),
    ).toThrow(z.ZodError)
  })

  it('越界数值与伪日期抛错', () => {
    expect(() => VaultSchema.parse(makeVault({ tasks: [makeTask({ progress: 101 })] }))).toThrow(z.ZodError)
    expect(() => VaultSchema.parse(makeVault({ tasks: [makeTask({ due: '2026-02-30' })] }))).toThrow(z.ZodError)
    expect(() => VaultSchema.parse(makeVault({ revision: 1.5 }))).toThrow(z.ZodError)
    expect(() => VaultSchema.parse(makeVault({ appVersion: 7 as never }))).toThrow(z.ZodError)
  })

  it('可选字段留空即可，不接受空串日期', () => {
    const full = makeVault({
      tasks: [
        makeTask({
          assignee: '我自己',
          start: '2026-10-15',
          due: '2026-10-17',
          estimateHours: 3.5,
          baseline: { start: '2026-10-15', due: '2026-10-16' },
        }),
        makeTask({ id: 'task-2' }),
      ],
      links: [makeLink({ note: '等接口先好' })],
      milestones: [makeMilestone({ topicId: 'topic-1', color: '#DC2626', note: '见笔记' })],
    })
    expect(VaultSchema.parse(full).tasks[0]?.due).toBe('2026-10-17')
    expect(() => VaultSchema.parse(makeVault({ tasks: [makeTask({ due: '' })] }))).toThrow(z.ZodError)
  })

  it('settings.lastFilter 可承载完整筛选条件', () => {
    const parsed = VaultSchema.parse(
      makeVault({
        settings: makeSettings({
          lastFilter: {
            topicIds: ['topic-1'],
            includeDescendants: true,
            statuses: ['doing'],
            kinds: [],
            priorities: ['P0', 'P1'],
            tags: ['domain'],
            tagMode: 'all',
            assignees: [],
            dateRange: { from: '2026-10-01' },
            overdueOnly: true,
            upstreamDepth: 1,
            downstreamDepth: 2,
          },
        }),
      }),
    )
    expect(parsed.settings.lastFilter?.downstreamDepth).toBe(2)
  })
})

describe('needsMigration', () => {
  it('当前版本无需迁移', () => {
    expect(needsMigration(makeVault())).toBe(false)
  })

  it('缺少或非法 schemaVersion 报 VaultValidationError', () => {
    expect(() => needsMigration(without('schemaVersion'))).toThrow(VaultValidationError)
    expect(() => needsMigration({ ...makeVault(), schemaVersion: 0 })).toThrow(VaultValidationError)
  })

  it('文件版本高于本程序时报错而不是降级写回', () => {
    expect(() => needsMigration({ ...makeVault(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 })).toThrow(
      /高于本版本/,
    )
  })

  it('非对象输入报错', () => {
    expect(() => needsMigration('[]')).toThrow(VaultValidationError)
    expect(() => needsMigration([makeVault()])).toThrow(VaultValidationError)
    expect(() => needsMigration(null)).toThrow(VaultValidationError)
  })
})

describe('applyMigrations', () => {
  it('以假迁移验证 v1 到 v2 的升级函数被调用', () => {
    const step = vi.fn<MigrationStep>((raw) => ({ ...raw, schemaVersion: 2 }))
    const chain: MigrationChain = { 1: step }
    const raw = { ...makeVault(), schemaVersion: 1 } as unknown as Record<string, unknown>

    const out = applyMigrations(raw, chain, 2)

    expect(step).toHaveBeenCalledTimes(1)
    expect(out.schemaVersion).toBe(2)
    expect(raw.schemaVersion).toBe(1)
  })

  it('链上多级按序执行并克隆隔离', () => {
    const order: number[] = []
    const chain: MigrationChain = {
      1: (raw) => {
        order.push(1)
        return { ...raw, schemaVersion: 2, renamed: raw.renamed ?? 'from-v1' }
      },
      2: (raw) => {
        order.push(2)
        return { ...raw, schemaVersion: 3 }
      },
    }

    const out = applyMigrations({ schemaVersion: 1, renamed: 'from-v1' }, chain, 3)

    expect(order).toEqual([1, 2])
    expect(out.renamed).toBe('from-v1')
  })

  it('迁移步骤没有推进版本号时报错', () => {
    const chain: MigrationChain = { 1: (raw) => ({ ...raw, schemaVersion: 1 }) }
    expect(() => applyMigrations({ schemaVersion: 1 }, chain, 2)).toThrow(/版本号/)
  })

  it('链上缺一级时报错', () => {
    const chain: MigrationChain = { 2: (raw) => ({ ...raw, schemaVersion: 3 }) }
    expect(() => applyMigrations({ schemaVersion: 1 }, chain, 3)).toThrow(/没有从 schemaVersion 1 升级的路径/)
  })
})

describe('migrate', () => {
  it('当前版本文件迁移后即原样通过校验', () => {
    expect(migrate(makeVault())).toEqual(makeVault())
  })

  it('迁移产物仍要过 Schema 校验，坏数据不放行', () => {
    const step = vi.fn<MigrationStep>((raw) => ({
      ...raw,
      schemaVersion: 2,
      tasks: [{ ...(raw.tasks as Record<string, unknown>[])[0], status: 'archived' }],
    }))

    const out = applyMigrations({ ...makeVault(), schemaVersion: 1 }, { 1: step }, 2)

    expect(step).toHaveBeenCalledTimes(1)
    expect(out.schemaVersion).toBe(2)
    expect(() => VaultSchema.parse(out)).toThrow(z.ZodError)
  })

  it('空 id 一类非法值直接被 migrate 拒绝', () => {
    expect(() => migrate({ ...makeVault(), vaultId: '' })).toThrow(z.ZodError)
  })

  it('旧库缺 mindmaps 键时补空数组（schemaVersion 保持 1）', () => {
    const raw = without('mindmaps')
    const vault = migrate(raw)
    expect(vault.mindmaps).toEqual([])
    expect(vault.schemaVersion).toBe(1)
  })

  it('mindmaps 递归节点树通过校验', () => {
    const vault = migrate({ ...makeVault(), mindmaps: [
      {
        id: 'm1',
        name: '图一',
        order: 'V',
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
        root: {
          id: 'r',
          text: '中心主题',
          order: 'V',
          folded: false,
          children: [{ id: 'a', text: '分支', order: 'V', folded: true, children: [] }],
        },
      },
    ] })
    expect(vault.mindmaps[0]!.root.children[0]!.folded).toBe(true)
  })
})
