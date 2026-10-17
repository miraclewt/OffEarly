// T26 · AssetStore 的 gc（gcPreview / gc / 纯函数）。
//
// 安全模型决定测试重点：gcPreview 必须**只读**（磁盘一个字节都不能少），gc 必须**只删
// 确认清单里的文件**（清单外的、被引用的、磁盘上根本不存在的都不能碰）。全用 mockFs 跑
// 真实 fsAdapter 原语，断言落在「文件在不在 / 字节多少」，而不是「调用过某个函数」。

import { describe, expect, it, vi } from 'vitest'

import {
  ASSET_DIR,
  assetRefsIn,
  createAssetStore,
  referencedAssetIds,
  removeAssets,
} from '../../src/persistence/assetStore'
import type { Asset, Task, Vault } from '../../src/domain/types'
import { asDirHandle, makeDir, makeFile } from './mockFs'

function makeTask(id: string, note: string): Task {
  return {
    id,
    topicId: 'topic-1',
    title: `任务 ${id}`,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note,
    order: 'm',
    createdAt: '2026-10-16T09:00:00.000Z',
    updatedAt: '2026-10-16T09:00:00.000Z',
    archived: false,
  }
}

function emptyVault(): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'v1',
    appVersion: '0.1.0',
    revision: 1,
    updatedAt: '2026-10-16T09:00:00.000Z',
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'auto',
      lastFilter: null,
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
  }
}

function asset(id: string, sizeBytes: number, filename?: string): Asset {
  return { id, filename: filename ?? `assets/${id}.png`, sizeBytes, createdAt: '2026-10-16T09:00:00.000Z' }
}

/** 造一份带附件表 + 任务/里程碑笔记的 vault（笔记里的 `![](assets/…)` 就是引用来源）。 */
function vaultWith(parts: {
  assets?: Asset[]
  taskNotes?: string[]
  milestoneNotes?: string[]
}): Vault {
  return {
    ...emptyVault(),
    assets: parts.assets ?? [],
    tasks: (parts.taskNotes ?? []).map((note, i) => makeTask(`t${i}`, note)),
    milestones: (parts.milestoneNotes ?? []).map((note, i) => ({
      id: `m${i}`,
      topicId: null,
      title: `m${i}`,
      date: '2026-10-16',
      done: false,
      note,
    })),
  }
}

function setup(files: string[] = []) {
  const dir = makeDir(
    'vault',
    files.length > 0 ? { dirs: [makeDir('assets', { files: files.map((n) => makeFile(n, { bytes: new Uint8Array([1, 2, 3]) })) })] } : {},
  )
  const revokeObjectURL = vi.fn((_url: string) => undefined)
  const store = createAssetStore(asDirHandle(dir), {
    newId: () => 'a1',
    now: () => new Date('2026-10-16T09:00:00.000Z'),
    createObjectURL: () => 'blob:offearly/x',
    revokeObjectURL,
  })
  return { dir, store, revokeObjectURL }
}

// ── 引用集合解析（纯函数） ──────────────────────────────────────────────

describe('T26-1 · 引用集合（assetRefsIn / referencedAssetIds）', () => {
  it('assetRefsIn 只认 ![](assets/…) 图片语法，外链 / 子目录不算', () => {
    const markdown = [
      '![截图](assets/a1.png)',
      '![](assets/a2.jpg)',
      '![外链](https://a.bc/x.png)',
      '![子目录](assets/sub/a3.png)',
      '![同图再来](assets/a1.png)',
    ].join('\n')
    expect(assetRefsIn(markdown).sort()).toEqual(['assets/a1.png', 'assets/a2.jpg'])
  })

  it('referencedAssetIds 把任务与里程碑的 note 都扫进去，并去重', () => {
    const vault = vaultWith({
      taskNotes: ['![](assets/a1.png)', '![](assets/a1.png) 与 ![](assets/a2.png)'],
      milestoneNotes: ['![](assets/a2.png) 和 ![](assets/a3.png)'],
    })
    expect([...referencedAssetIds(vault)].sort()).toEqual(['a1', 'a2', 'a3'])
  })

  it('只有里程碑引用也算被引用（安全侧：宁可多认，不可误删）', () => {
    const vault = vaultWith({ milestoneNotes: ['![](assets/only-m.png)'] })
    expect(referencedAssetIds(vault).has('only-m')).toBe(true)
  })

  it('空 note / 无图片的 note 不产生引用', () => {
    const vault = vaultWith({ taskNotes: ['', '# 纯文本，没有图'] })
    expect(referencedAssetIds(vault).size).toBe(0)
  })
})

// ── gcPreview：只读清单 ─────────────────────────────────────────────────

describe('T26-2 · gcPreview（返回未引用清单 + 可释放字节，不删除）', () => {
  it('全未引用：清单列出全部附件，可释放字节 = 各 sizeBytes 之和', () => {
    const { store } = setup()
    const vault = vaultWith({ assets: [asset('a1', 10), asset('a2', 20), asset('a3', 30)] })
    const preview = store.gcPreview(vault)
    expect(preview.totalCount).toBe(3)
    expect(preview.referencedCount).toBe(0)
    expect(preview.unreferenced.map((c) => c.id).sort()).toEqual(['a1', 'a2', 'a3'])
    expect(preview.reclaimableBytes).toBe(60)
  })

  it('全被引用：清单为空，可释放字节为 0', () => {
    const { store } = setup()
    const vault = vaultWith({
      assets: [asset('a1', 10), asset('a2', 20)],
      taskNotes: ['![](assets/a1.png)'],
      milestoneNotes: ['![](assets/a2.png)'],
    })
    const preview = store.gcPreview(vault)
    expect(preview.totalCount).toBe(2)
    expect(preview.referencedCount).toBe(2)
    expect(preview.unreferenced).toHaveLength(0)
    expect(preview.reclaimableBytes).toBe(0)
  })

  it('混合：只有未被任何 note 引用的进清单', () => {
    const { store } = setup()
    const vault = vaultWith({
      assets: [asset('a1', 10), asset('a2', 20), asset('a3', 30)],
      taskNotes: ['![](assets/a1.png)'],
      milestoneNotes: ['![](assets/a3.png)'],
    })
    const preview = store.gcPreview(vault)
    expect(preview.unreferenced.map((c) => c.id)).toEqual(['a2'])
    expect(preview.reclaimableBytes).toBe(20)
  })

  it('filename 保留表里原样（可能不带 assets/ 前缀，example.vault 即如此）', () => {
    const { store } = setup()
    const vault = vaultWith({ assets: [asset('asset-burndown', 1940, 'asset-burndown.png')] })
    const preview = store.gcPreview(vault)
    expect(preview.unreferenced[0]?.filename).toBe('asset-burndown.png')
  })

  it('gcPreview 是只读的：跑完后磁盘文件一个不少', () => {
    const { dir, store } = setup(['a1.png'])
    store.gcPreview(vaultWith({ assets: [asset('a1', 10)] }))
    expect(dir.dirs.get('assets')?.files.get('a1.png')).toBeDefined()
  })
})

// ── gc：只删确认清单内的文件 ───────────────────────────────────────────

describe('T26-3 · gc（只删 ids 对应的磁盘文件）', () => {
  it('只删清单里的文件，清单外 / 被引用的原样保留', async () => {
    const { dir, store } = setup(['a1.png', 'a2.png', 'keep.png'])
    const removed = await store.gc(['a1', 'a2'])
    expect(removed.sort()).toEqual(['a1', 'a2'])
    const assets = dir.dirs.get('assets')
    expect(assets?.files.has('a1.png')).toBe(false)
    expect(assets?.files.has('a2.png')).toBe(false)
    expect(assets?.files.has('keep.png')).toBe(true)
  })

  it('磁盘上不存在的 id 静默跳过，不进返回值', async () => {
    const { store } = setup(['a1.png'])
    const removed = await store.gc(['a1', 'ghost'])
    expect(removed).toEqual(['a1'])
  })

  it('空清单直接返回空数组，不碰磁盘', async () => {
    const { dir, store } = setup(['a1.png'])
    expect(await store.gc([])).toEqual([])
    expect(dir.dirs.get('assets')?.files.has('a1.png')).toBe(true)
  })

  it('删除后回收对应 blob URL（revoke 不遗漏）', async () => {
    const { store, revokeObjectURL } = setup(['a1.png'])
    await store.url('assets/a1.png') // 先建立缓存
    await store.gc(['a1'])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:offearly/x')
    expect(store.peek('assets/a1.png')).toBeNull()
  })

  it('id 前缀精确匹配：删 a1 不会误伤 a10.png', async () => {
    const { dir, store } = setup(['a1.png', 'a10.png'])
    await store.gc(['a1'])
    const assets = dir.dirs.get('assets')
    expect(assets?.files.has('a1.png')).toBe(false)
    expect(assets?.files.has('a10.png')).toBe(true)
  })
})

// ── removeAssets：落表 ─────────────────────────────────────────────────

describe('T26-4 · removeAssets（摘 assets 表记录）', () => {
  it('摘掉给定 id，保留其余', () => {
    const vault = vaultWith({ assets: [asset('a1', 10), asset('a2', 20), asset('a3', 30)] })
    const next = removeAssets(vault, ['a1', 'a3'])
    expect(next.assets.map((a) => a.id)).toEqual(['a2'])
  })

  it('空清单 / 全未命中返回原对象（不制造无谓的新引用）', () => {
    const vault = vaultWith({ assets: [asset('a1', 10)] })
    expect(removeAssets(vault, [])).toBe(vault)
    expect(removeAssets(vault, ['nope'])).toBe(vault)
  })

  it('未传资产时安全幂等', () => {
    const vault = vaultWith({})
    expect(removeAssets(vault, ['x'])).toBe(vault)
  })
})

// 确保 ASSET_DIR 常量被引用（避免 tree-shake 误伤，测试里显式断言目录名）
describe('T26-5 · 口径钉死', () => {
  it('gc 操作的目录就是 assets/（与 put / listFiles 同源）', () => {
    expect(ASSET_DIR).toBe('assets')
  })
})
