// T25 · noteAssets：NoteEditor（视图）与 AssetStore（持久化）之间的适配器。
//
// 这里用**真的 VaultStore + 真的 AssetStore + mockFs**，只把 URL.createObjectURL 换成替身：
// 适配器最容易错的两处——「落盘后元数据有没有进 assets 表」与「异步读到后有没有通知重画」——
// 用假 store / 假 assetStore 都会验成空气。

import { describe, expect, it, vi } from 'vitest'

import { createVaultStore } from '../../src/domain/store'
import type { Vault } from '../../src/domain/types'
import { createNoteAssetsPort, noteAssetRefs } from '../../src/controllers/noteAssets'
import { createAssetStore } from '../../src/persistence/assetStore'
import { asDirHandle, makeDir, makeFile } from '../persistence/mockFs'

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
    notebooks: [],
    noteDocs: [],
  }
}

function fileOf(name: string, type = 'image/png', size = 4): File {
  return {
    name,
    type,
    size,
    async arrayBuffer() {
      return new Uint8Array(size).buffer
    },
  } as unknown as File
}

/** seed=true 时先往 assets/ 放一个已存在的 a1.png：用来验「异步读到后通知重画」那条路径。 */
function setup(seed = false) {
  const dir = makeDir(
    'vault',
    seed ? { dirs: [makeDir('assets', { files: [makeFile('a1.png', { bytes: new Uint8Array([1, 2, 3]) })] })] } : {},
  )
  const revokeObjectURL = vi.fn((_url: string) => undefined)
  const assets = createAssetStore(asDirHandle(dir), {
    newId: () => 'a1',
    now: () => new Date('2026-10-16T09:00:00.000Z'),
    createObjectURL: () => 'blob:offearly/a1',
    revokeObjectURL,
  })
  const store = createVaultStore(emptyVault())
  const port = createNoteAssetsPort(store, assets)
  return { dir, store, assets, port, revokeObjectURL }
}

describe('T25-1 · insert：落盘 + 记元数据 + 回 src', () => {
  it('成功时 assets 表多一条，返回的 src 就是 note 里要写的相对路径', async () => {
    const { store, port } = setup()
    const result = await port.insert(fileOf('shot.png'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.src).toBe('assets/a1.png')
    expect(store.getVault().assets).toHaveLength(1)
    expect(store.getVault().assets[0]?.filename).toBe('assets/a1.png')
  })

  it('被 AssetStore 拒（超限）时返回 ok=false + reason，且 assets 表不动', async () => {
    const { store, dir, port } = setup()
    const result = await port.insert(fileOf('big.png', 'image/png', 5 * 1024 * 1024 + 1))
    expect(result).toEqual({ ok: false, reason: 'size' })
    expect(store.getVault().assets).toHaveLength(0)
    expect(dir.dirs.get('assets')?.files.size ?? 0).toBe(0)
  })

  it('alt 取文件名（渲染与灯箱标题都用它）', async () => {
    const { port } = setup()
    const result = await port.insert(fileOf('截图.png'))
    expect(result.ok ? result.alt : '').toBe('截图.png')
  })
})

describe('T25-2 · resolve / subscribe：异步读到后通知重画', () => {
  it('未就绪返回 null，并**自己**发起读取（视图不必知道 I/O）', async () => {
    const { port } = setup(true)
    const listener = vi.fn()
    port.subscribe(listener)
    expect(port.resolve('assets/a1.png')).toBeNull()
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())
    expect(port.resolve('assets/a1.png')).toBe('blob:offearly/a1')
  })

  it('同一张图并发解析只读一次（inflight 去重）', async () => {
    const { assets, port } = setup(true)
    const spy = vi.spyOn(assets, 'url')
    port.resolve('assets/a1.png')
    port.resolve('assets/a1.png')
    port.resolve('assets/a1.png')
    await vi.waitFor(() => expect(port.resolve('assets/a1.png')).toBe('blob:offearly/a1'))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('取消订阅后不再收到通知', async () => {
    const { port } = setup(true)
    const listener = vi.fn()
    const unsubscribe = port.subscribe(listener)
    unsubscribe()
    port.resolve('assets/a1.png')
    await vi.waitFor(() => expect(port.resolve('assets/a1.png')).toBe('blob:offearly/a1'))
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('T25-3 · dispose 与引用解析', () => {
  it('dispose 回收全部 blob URL（换库 / 卸载不泄漏）', async () => {
    const { port, revokeObjectURL } = setup()
    await port.insert(fileOf('shot.png'))
    port.dispose()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:offearly/a1')
  })

  it('noteAssetRefs 解析 ![](assets/…) 且忽略外链（T26 gc 的同一口径）', () => {
    const markdown = [
      '![截图](assets/a1.png)',
      '![](assets/a2.jpg)',
      '![外链](https://a.bc/x.png)',
      '![相对子目录](assets/sub/a3.png)',
      '![同图第二次](assets/a1.png)',
      // T49：缩放过的图片写成 HTML img，同样要算引用（否则回收会误删）
      '<img src="assets/a4.png" alt="缩放" width="62%">',
    ].join('\n')
    expect(noteAssetRefs(markdown).sort()).toEqual(['assets/a1.png', 'assets/a2.jpg', 'assets/a4.png'])
  })
})
