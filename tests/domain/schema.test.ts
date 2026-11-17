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
    trash: [],
    whiteboards: [],
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

describe('T73 · NoteDoc 的可选属性', () => {
  const doc = (extra: Record<string, unknown>) => ({
    id: 'doc-1',
    notebookId: 'nb-1',
    parentId: null,
    title: '周会纪要',
    content: '正文',
    order: 'U',
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  })

  it('tags / taskIds 缺省即可（老库不需要补这两个键）', () => {
    const vault = makeVault({ noteDocs: [doc({})] })
    const parsed = VaultSchema.parse(JSON.parse(JSON.stringify(vault)))
    expect(parsed.noteDocs[0]?.tags).toBeUndefined()
    expect(parsed.noteDocs[0]?.taskIds).toBeUndefined()
    // 关键：解析不会给老库塞默认值（否则「打开再保存」会让文件逐字节变化）
    expect(JSON.stringify(parsed.noteDocs[0])).not.toContain('"tags"')
  })

  it('给了就原样保留', () => {
    const vault = makeVault({ noteDocs: [doc({ tags: ['周会', '支付'], taskIds: ['task-1'] })] })
    const parsed = VaultSchema.parse(JSON.parse(JSON.stringify(vault)))
    expect(parsed.noteDocs[0]?.tags).toEqual(['周会', '支付'])
    expect(parsed.noteDocs[0]?.taskIds).toEqual(['task-1'])
  })

  it('taskIds 里的空串会被拒（那不是合法 id）', () => {
    expect(() =>
      VaultSchema.parse(makeVault({ noteDocs: [doc({ taskIds: [''] })] })),
    ).toThrow(z.ZodError)
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

// T74 · 白板的图片图元：`shape: 'image'` + `image: 'assets/<id>.<ext>'`。
// 两条红线：① 只放行 assets 根目录下的文件名（外链 / 子目录会让 gc 的引用扫描失效）；
// ② 没有图片的老节点解析后**不长出 image 键**，否则老库打开再保存就多出字段。
describe('T74 · 白板图片图元', () => {
  function boardWith(node: Record<string, unknown>): Vault {
    return makeVault({
      whiteboards: [
        {
          id: 'w1',
          name: '板',
          order: 'U',
          nodes: [node as never],
          edges: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    })
  }

  function imageNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'n1',
      shape: 'image',
      x: 0,
      y: 0,
      width: 320,
      height: 200,
      text: 'shot.png',
      tone: 'plain',
      image: 'assets/abc123.png',
      ...overrides,
    }
  }

  it('接受 image 形状与 assets 引用', () => {
    const parsed = VaultSchema.parse(boardWith(imageNode()))
    expect(parsed.whiteboards[0]!.nodes[0]!.image).toBe('assets/abc123.png')
    expect(parsed.whiteboards[0]!.nodes[0]!.shape).toBe('image')
  })

  it('外链与子目录被拒（引用扫描只认 assets/ 根目录）', () => {
    for (const bad of ['https://example.com/a.png', 'assets/sub/a.png', 'assets/', 'data:image/png;base64,xx']) {
      expect(() => VaultSchema.parse(boardWith(imageNode({ image: bad })))).toThrow()
    }
  })

  it('不带 image 的普通图元：解析后对象上没有这个键', () => {
    const parsed = VaultSchema.parse(boardWith({ id: 'n2', shape: 'rect', x: 0, y: 0, width: 120, height: 60, text: '', tone: 'plain' }))
    const node = parsed.whiteboards[0]!.nodes[0]!
    expect(Object.prototype.hasOwnProperty.call(node, 'image')).toBe(false)
    expect(JSON.stringify(node)).not.toContain('"image"')
  })
})

// T75 · 字号：可选、整数、8..96。范围比档位表（10..80）宽一点——手改过库的人写 17
// 该照原样画出来；小数一律拒（半像素字号会让同一批图元看起来「莫名不一致」）。
describe('T75 · 白板字号', () => {
  function boardWith(node: Record<string, unknown>): Vault {
    return makeVault({
      whiteboards: [
        {
          id: 'w1',
          name: '板',
          order: 'U',
          nodes: [node as never],
          edges: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    })
  }

  function nodeWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'n1', shape: 'rect', x: 0, y: 0, width: 120, height: 60, text: '服务', tone: 'plain', ...overrides }
  }

  it('接受范围内的整数，原样保留', () => {
    for (const size of [8, 13, 17, 32, 96]) {
      const parsed = VaultSchema.parse(boardWith(nodeWith({ fontSize: size })))
      expect(parsed.whiteboards[0]!.nodes[0]!.fontSize).toBe(size)
    }
  })

  it('拒绝小数、越界与非数字', () => {
    for (const bad of [13.5, 7, 97, '13', null]) {
      expect(() => VaultSchema.parse(boardWith(nodeWith({ fontSize: bad })))).toThrow()
    }
  })

  it('没写 fontSize 的图元：解析后对象上没有这个键（老库逐字节不变）', () => {
    const parsed = VaultSchema.parse(boardWith(nodeWith()))
    const node = parsed.whiteboards[0]!.nodes[0]!
    expect(Object.prototype.hasOwnProperty.call(node, 'fontSize')).toBe(false)
    expect(JSON.stringify(node)).not.toContain('fontSize')
  })
})

// T77 · 字效与图片贴合：三个字段都是可选、无 .default。
// 老库打开再保存必须逐字节不变，这一条由「键根本不出现」来保证，不是靠默认值补齐。
describe('T77 · 白板字效与图片贴合', () => {
  function boardWith(node: Record<string, unknown>): Vault {
    return makeVault({
      whiteboards: [
        { id: 'w1', name: '板', order: 'U', nodes: [node as never], edges: [], createdAt: NOW, updatedAt: NOW },
      ],
    })
  }

  function nodeWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'n1', shape: 'text', x: 0, y: 0, width: 120, height: 60, text: '标题', tone: 'plain', ...overrides }
  }

  it('bold / italic / imageFit 原样保留', () => {
    const parsed = VaultSchema.parse(boardWith(nodeWith({ bold: true, italic: true, imageFit: 'cover' })))
    const node = parsed.whiteboards[0]!.nodes[0]!
    expect(node.bold).toBe(true)
    expect(node.italic).toBe(true)
    expect(node.imageFit).toBe('cover')
  })

  it('只写一个也不影响另外两个', () => {
    const parsed = VaultSchema.parse(boardWith(nodeWith({ bold: false })))
    const node = parsed.whiteboards[0]!.nodes[0]!
    expect(node.bold).toBe(false)
    expect(node.italic).toBeUndefined()
    expect(node.imageFit).toBeUndefined()
  })

  it('imageFit 只认 contain / cover，其余一律拒', () => {
    for (const bad of ['fill', 'none', '', true, null]) {
      expect(() => VaultSchema.parse(boardWith(nodeWith({ imageFit: bad })))).toThrow()
    }
  })

  it('没写这三个字段的图元：解析后对象上连键都没有（老库逐字节不变）', () => {
    const node = VaultSchema.parse(boardWith(nodeWith())).whiteboards[0]!.nodes[0]!
    for (const key of ['bold', 'italic', 'imageFit']) {
      expect(Object.prototype.hasOwnProperty.call(node, key)).toBe(false)
    }
    const json = JSON.stringify(node)
    for (const key of ['bold', 'italic', 'imageFit']) expect(json).not.toContain(key)
  })
})
