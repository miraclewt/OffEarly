// T33 · example.vault 的验收断言。
//
// 这一层的意义：example.vault 是给首次使用者「开箱即见」的样例库，它坏了比没有更糟
// ——用户第一次连接就吃一个校验错误。所以这里用**真实的 schema 与领域引擎**去跑它，
// 而不是人眼看 JSON。写死 TODAY 是为了确定化（示例数据是按 2026-10-15 编的）。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createDependencyGraph } from '../../src/domain/dependencyGraph'
import { buildGanttModel } from '../../src/domain/ganttModel'
import { createEmptyFilter, createQueryEngine } from '../../src/domain/queryEngine'
import { migrate } from '../../src/domain/schema'
import type { Filter, Status, Task, Vault } from '../../src/domain/types'

const VAULT_DIR = fileURLToPath(new URL('../../example.vault/', import.meta.url))
const TODAY = '2026-10-15'

function readRaw(): unknown {
  return JSON.parse(readFileSync(join(VAULT_DIR, 'vault.json'), 'utf8')) as unknown
}

function loadVault(): Vault {
  return migrate(readRaw())
}

function isOverdue(task: Task): boolean {
  return task.due !== undefined && task.status !== 'done' && task.due < TODAY
}

describe('T33 · example.vault', () => {
  it('通过 VaultSchema 校验与迁移（连接时不报错）', () => {
    expect(() => loadVault()).not.toThrow()
  })

  it('文件与资产落在预期位置', () => {
    expect(existsSync(join(VAULT_DIR, 'vault.json'))).toBe(true)
    expect(existsSync(join(VAULT_DIR, 'assets'))).toBe(true)
  })

  it('覆盖规模：≥3 话题、≥12 任务、≥2 里程碑', () => {
    const vault = loadVault()
    expect(vault.topics.length).toBeGreaterThanOrEqual(3)
    expect(vault.tasks.length).toBeGreaterThanOrEqual(12)
    expect(vault.milestones.length).toBeGreaterThanOrEqual(2)
  })

  it('话题含嵌套层级（用于演示树形侧栏）', () => {
    const vault = loadVault()
    const roots = vault.topics.filter((topic) => topic.parentId === null)
    const children = vault.topics.filter((topic) => topic.parentId !== null)
    expect(roots.length).toBeGreaterThanOrEqual(3)
    expect(children.length).toBeGreaterThanOrEqual(1)
    for (const child of children) {
      expect(vault.topics.some((topic) => topic.id === child.parentId)).toBe(true)
    }
  })

  it('四状态全覆盖，且每种状态都有任务', () => {
    const vault = loadVault()
    const statuses: Status[] = ['todo', 'doing', 'review', 'done']
    for (const status of statuses) {
      expect(vault.tasks.filter((task) => task.status === status).length).toBeGreaterThan(0)
    }
  })

  it('含逾期任务（due 早于今天且未完成）', () => {
    const overdue = loadVault().tasks.filter(isOverdue)
    expect(overdue.length).toBeGreaterThanOrEqual(1)
  })

  it('含被阻塞任务、且含未排期任务', () => {
    const vault = loadVault()
    const graph = createDependencyGraph(vault.links, vault.tasks)
    expect(vault.tasks.filter((task) => graph.isBlocked(task.id)).length).toBeGreaterThanOrEqual(1)

    // 未排期的判据与甘特图一致：start / due 缺一即进右侧折叠面板
    const unscheduled = vault.tasks.filter((task) => !task.start || !task.due)
    expect(unscheduled.length).toBeGreaterThanOrEqual(1)
  })

  it('依赖不成环，且存在长度 ≥3 的环外依赖链', () => {
    const vault = loadVault()
    const graph = createDependencyGraph(vault.links, vault.tasks)
    expect(graph.hasCycle()).toBe(false)
    expect(graph.cycles()).toEqual([])

    // 沿 blockedBy 回溯，找最长链（visited 兜底，即使数据出错也不会死循环）
    let longest = 0
    for (const task of vault.tasks) {
      let depth = 1
      let frontier = [task.id]
      const visited = new Set(frontier)
      while (frontier.length > 0) {
        const next: string[] = []
        for (const id of frontier) {
          for (const predecessor of graph.blockedBy(id)) {
            if (visited.has(predecessor)) continue
            visited.add(predecessor)
            next.push(predecessor)
          }
        }
        if (next.length > 0) depth += 1
        frontier = next
      }
      longest = Math.max(longest, depth)
    }
    expect(longest).toBeGreaterThanOrEqual(3)
  })

  it('看板有内容：空筛选下每个状态列都有任务', () => {
    const vault = loadVault()
    const engine = createQueryEngine(vault.topics, vault.tasks, vault.links, { today: TODAY })
    const matched = engine.query(createEmptyFilter())
    expect(matched.length).toBeGreaterThanOrEqual(12)
    for (const status of ['todo', 'doing', 'review', 'done'] as Status[]) {
      expect(matched.filter((task) => task.status === status).length).toBeGreaterThan(0)
    }
  })

  it('甘特图有内容：已排期任务进 rows、未排期任务进 unscheduled，且无依赖环降级', () => {
    const vault = loadVault()
    const model = buildGanttModel(vault, createEmptyFilter(), 'day', { today: TODAY })
    expect(model.cycles).toEqual([])
    expect(model.unscheduled.length).toBeGreaterThanOrEqual(1)

    const taskRows = model.rows.filter((row) => row.kind === 'task')
    expect(taskRows.length).toBeGreaterThanOrEqual(10)
    // 排期任务必须有条；有 start+due 的任务不许落到未排期里
    expect(taskRows.every((row) => row.bar !== null)).toBe(true)

    const milestoneRows = model.rows.filter((row) => row.kind === 'milestone')
    expect(milestoneRows.length).toBeGreaterThanOrEqual(2)
    expect(model.arrows.length).toBe(vault.links.length)
  })

  it('筛选可命中示例内容：逾期 / 被阻塞 / 有笔记', () => {
    const vault = loadVault()
    const engine = createQueryEngine(vault.topics, vault.tasks, vault.links, { today: TODAY })
    const withFlag = (patch: Partial<Filter>): Task[] =>
      engine.query({ ...createEmptyFilter(), ...patch })

    expect(withFlag({ overdueOnly: true }).length).toBeGreaterThanOrEqual(1)
    expect(withFlag({ blockedOnly: true }).length).toBeGreaterThanOrEqual(1)
    expect(withFlag({ withNotesOnly: true }).length).toBeGreaterThan(0)
  })

  it('含带图片的笔记，且图片资产真实存在、体积一致', () => {
    const vault = loadVault()
    const imageRefs: { task: Task; filename: string }[] = []
    for (const task of vault.tasks) {
      for (const match of task.note.matchAll(/!\[[^\]]*\]\(assets\/([^)]+)\)/g)) {
        imageRefs.push({ task, filename: match[1] as string })
      }
    }
    expect(imageRefs.length).toBeGreaterThanOrEqual(1)

    for (const { task, filename } of imageRefs) {
      const asset = vault.assets.find((candidate) => candidate.filename === filename)
      expect(asset, `任务 ${task.id} 引用的 ${filename} 未登记在 assets[]`).toBeDefined()

      const path = join(VAULT_DIR, 'assets', filename)
      expect(existsSync(path), `资产文件缺失：${filename}`).toBe(true)
      // sizeBytes 必须等于磁盘真实体积，否则后续「清理未引用附件」会误判
      expect(statSync(path).size).toBe(asset?.sizeBytes)
    }
  })

  it('资产是合法的 PNG（不能被当成乱码文件塞进 assets/）', () => {
    const vault = loadVault()
    for (const asset of vault.assets) {
      const bytes = readFileSync(join(VAULT_DIR, 'assets', asset.filename))
      expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR')
    }
  })

  it('话题配色取自 12 色调色板', () => {
    const vault = loadVault()
    expect(new Set(vault.topics.map((topic) => topic.color)).size).toBe(vault.topics.length)
    for (const topic of vault.topics) {
      expect(topic.color).toMatch(/^#[0-9A-F]{6}$/)
    }
  })
})
