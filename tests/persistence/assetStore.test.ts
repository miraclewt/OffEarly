// T25 · AssetStore（图片落盘 / blob URL 缓存 / revoke）。
//
// 用 mockFs（T06 遗留的手写句柄）跑真实 fsAdapter 原语：断言落的是**字节**与**路径**，
// 而不是「调用过某个函数」。createObjectURL / revokeObjectURL 在 Node 与 jsdom 里都不保证存在，
// 故经 deps 注入可计数的替身——「缓存命中 = 只创建一次」「卸载 = 一定 revoke」这两条
// 是 spec 6.4 的硬要求，必须能数出来。

import { describe, expect, it, vi } from 'vitest'

import {
  ASSET_DIR,
  AssetError,
  MAX_ASSET_BYTES,
  assetIdOf,
  createAssetStore,
  isAssetRef,
  recordAsset,
} from '../../src/persistence/assetStore'
import type { AssetFileLike } from '../../src/persistence/assetStore'
import type { Asset, Vault } from '../../src/domain/types'
import { asDirHandle, makeDir } from './mockFs'

/** 最小的 File 替身：只保留 put() 真正读得动的三个字段 + arrayBuffer。 */
function fakeFile(parts: { name?: string; type?: string; bytes?: Uint8Array }): AssetFileLike {
  const bytes = parts.bytes ?? new Uint8Array([1, 2, 3, 4])
  return {
    name: parts.name,
    type: parts.type,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.slice().buffer
    },
  }
}

const PNG = fakeFile({ name: 'shot.png', type: 'image/png' })

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

function setup(overrides: Parameters<typeof createAssetStore>[1] = {}) {
  const dir = makeDir('vault')
  const createObjectURL = vi.fn((_blob: Blob) => `blob:mock/${Math.random().toString(36).slice(2)}`)
  const revokeObjectURL = vi.fn((_url: string) => undefined)
  const store = createAssetStore(asDirHandle(dir), {
    newId: () => 'asset-1',
    now: () => new Date('2026-10-16T09:00:00.000Z'),
    createObjectURL,
    revokeObjectURL,
    ...overrides,
  })
  return { dir, store, createObjectURL, revokeObjectURL }
}

// ── put：落盘路径与元数据 ────────────────────────────────────────────────

describe('T25-1 · put（写 assets/<id>.<ext> 并回元数据）', () => {
  it('落盘路径就是 note 里引用的相对路径 assets/<id>.<ext>，字节逐位相同', async () => {
    const { dir, store } = setup()
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])
    const { asset, path } = await store.put(fakeFile({ name: 'shot.png', type: 'image/png', bytes: payload }))

    expect(path).toBe(`${ASSET_DIR}/asset-1.png`)
    expect(asset.filename).toBe(path)
    expect(asset.sizeBytes).toBe(5)
    expect(asset.createdAt).toBe('2026-10-16T09:00:00.000Z')

    const assets = dir.dirs.get('assets')
    expect(assets).toBeDefined()
    expect(assets?.files.get('asset-1.png')?.bytes()).toEqual(payload)
  })

  it('扩展名先按文件名、再按 mime 推导；两者都没有则拒', async () => {
    const { store } = setup()
    expect((await store.put(fakeFile({ name: 'a.JPG', type: '' }))).path.endsWith('.jpg')).toBe(true)
    expect((await store.put(fakeFile({ type: 'image/webp' }))).path.endsWith('.webp')).toBe(true)
    await expect(store.put(fakeFile({ name: 'no-ext', type: '' }))).rejects.toBeInstanceOf(AssetError)
  })

  it('白名单外的类型（如 image/bmp / 文本）一律拒，且**不写盘**', async () => {
    const { dir, store } = setup()
    const err = await store.put(fakeFile({ name: 'x.bmp', type: 'image/bmp' })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AssetError)
    expect((err as AssetError).reason).toBe('type')
    expect(dir.dirs.get('assets')?.files.size ?? 0).toBe(0)
  })

  it('超过 5MB 拒（reason=size）且不写盘；恰好 5MB 放行', async () => {
    const { dir, store } = setup()
    const tooBig = new Uint8Array(MAX_ASSET_BYTES + 1)
    const err = await store.put(fakeFile({ name: 'big.png', type: 'image/png', bytes: tooBig })).catch((e: unknown) => e)
    expect((err as AssetError).reason).toBe('size')
    expect(dir.dirs.get('assets')?.files.size ?? 0).toBe(0)

    const exact = new Uint8Array(MAX_ASSET_BYTES)
    await expect(store.put(fakeFile({ name: 'ok.png', type: 'image/png', bytes: exact }))).resolves.toBeTruthy()
  })

  it('file.size 撒谎时按**真实字节数**拦截（读出来超限才算超）', async () => {
    const { store } = setup()
    const liar = {
      name: 'liar.png',
      type: 'image/png',
      size: 10,
      async arrayBuffer() {
        return new Uint8Array(MAX_ASSET_BYTES + 1).buffer
      },
    }
    const err = await store.put(liar).catch((e: unknown) => e)
    expect((err as AssetError).reason).toBe('size')
  })

  it('空文件拒（reason=empty）——0 字节图片是拖错了的产物，不该留垃圾', async () => {
    const { store } = setup()
    const err = await store.put(fakeFile({ name: 'e.png', type: 'image/png', bytes: new Uint8Array(0) })).catch((e: unknown) => e)
    expect((err as AssetError).reason).toBe('empty')
  })

  it('落盘前先确保 assets 目录存在（新库首图也不炸）', async () => {
    const { dir, store } = setup()
    expect(dir.dirs.has('assets')).toBe(false)
    await store.put(PNG)
    expect(dir.dirs.has('assets')).toBe(true)
  })
})

// ── url：blob URL 与缓存 ────────────────────────────────────────────────

describe('T25-2 · url（getFile → createObjectURL，Map 缓存，revoke）', () => {
  it('file:// 下相对路径解析不到，显示必须走 blob URL', async () => {
    const { store, createObjectURL } = setup()
    const ref = (await store.put(PNG)).path
    const url = await store.url(ref)
    expect(url.startsWith('blob:')).toBe(true)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('同一附件重复取只创建一次（Map<assetId, objectURL> 命中）', async () => {
    const { store, createObjectURL } = setup()
    const ref = (await store.put(PNG)).path
    const first = await store.url(ref)
    const second = await store.url(ref)
    expect(second).toBe(first)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('blob 带上正确的 mime（svg 可显示、下载后缀也对）', async () => {
    const { store, createObjectURL } = setup()
    const svg = fakeFile({ name: 'd.svg', type: 'image/svg+xml', bytes: new TextEncoder().encode('<svg/>') })
    const ref = (await store.put(svg)).path
    await store.url(ref)
    const blob = createObjectURL.mock.calls[0]?.[0] as unknown as Blob
    expect(blob.type).toBe('image/svg+xml')
    expect(blob.size).toBe(6)
  })

  it('peek 是同步读缓存：未就绪返回 null，不触发任何 I/O', async () => {
    const { store } = setup()
    const ref = (await store.put(PNG)).path
    expect(store.peek(ref)).toBeNull()
    const url = await store.url(ref)
    expect(store.peek(ref)).toBe(url)
  })

  it('revoke 单个：URL 被回收且缓存失效（下次重新创建）', async () => {
    const { store, createObjectURL, revokeObjectURL } = setup()
    const ref = (await store.put(PNG)).path
    const url = await store.url(ref)
    store.revoke(ref)
    expect(revokeObjectURL).toHaveBeenCalledWith(url)
    expect(store.peek(ref)).toBeNull()
    await store.url(ref)
    expect(createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('dispose 全部回收（组件卸载 / 换库时不得泄漏 blob）', async () => {
    const { store, revokeObjectURL } = setup()
    const a = await store.url((await store.put(PNG)).path)
    const b = await store.url((await store.put(fakeFile({ name: 'b.jpg', type: 'image/jpeg' }))).path)
    store.dispose()
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL.mock.calls.map((c) => c[0]).sort()).toEqual([a, b].sort())
    expect(store.peek(`assets/asset-1.png`)).toBeNull()
  })

  it('文件已不在磁盘（被外部删掉）时报 missing，不静默返回空 URL', async () => {
    const { store } = setup()
    const err = await store.url(`${ASSET_DIR}/gone.png`).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AssetError)
    expect((err as AssetError).reason).toBe('missing')
  })
})

// ── 引用解析与 assets 表 ────────────────────────────────────────────────

describe('T25-3 · 引用解析与 assets 表元数据', () => {
  it('isAssetRef / assetIdOf 只认 assets/ 下的相对路径', () => {
    expect(isAssetRef('assets/abc.png')).toBe(true)
    expect(isAssetRef('https://a.bc/x.png')).toBe(false)
    expect(isAssetRef('assets/sub/x.png')).toBe(false)
    expect(assetIdOf('assets/abc.png')).toBe('abc')
  })

  it('recordAsset 记元数据且同 id 覆盖（重复插入不留两条）', () => {
    const vault = emptyVault()
    const asset: Asset = { id: 'a1', filename: 'assets/a1.png', sizeBytes: 10, createdAt: 'x' }
    const once = recordAsset(vault, asset)
    const twice = recordAsset(once, { ...asset, sizeBytes: 99 })
    expect(twice.assets).toHaveLength(1)
    expect(twice.assets[0]?.sizeBytes).toBe(99)
    expect(twice.tasks).toBe(vault.tasks)
  })

  it('put 出来的 asset 直接进 assets 表后，note 引用与表能对上', async () => {
    const { store } = setup()
    const { asset, path } = await store.put(PNG)
    const vault = recordAsset(emptyVault(), asset)
    expect(vault.assets[0]?.filename).toBe(path)
    expect(isAssetRef(path)).toBe(true)
  })
})
