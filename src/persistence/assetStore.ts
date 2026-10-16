// AssetStore（T25）：笔记图片的落盘与显示。
//
// 为什么必须存在（spec D12 / 6.4）：图片走 sidecar 文件 `assets/<id>.<ext>`，
// note 里只存相对路径 `![](assets/<id>.png)`——base64 内嵌会让 vault.json 膨胀到数十 MB，
// 全量写盘与 OneDrive 同步都会卡；sidecar 还让整个数据文件夹能被 Obsidian 直读。
//
// 显示为什么必须经 blob URL：`file://` 下相对路径解析不到数据文件夹（它不是同源目录），
// 所以只能 FileSystemFileHandle.getFile() → Blob → URL.createObjectURL()。
// blob URL 会一直占着那块内存直到 revoke，故这里强制「一个 ref 一个 URL + 显式回收」：
//   · url(ref) 命中缓存则复用（同一张图在长笔记里出现十次也只创建一次）
//   · revoke(ref) 删单个（删除附件 / 图片从笔记里消失）
//   · dispose() 全收（组件卸载、换库、安全模式重载）
//
// 分层：文件系统原语全部来自 fsAdapter（T06，全项目唯一接触 File System Access API 的层）；
// 本模块不 import domain/store——**assets 表的写入归调用方**（`recordAsset` 是纯函数，
// 走 store.update，与 T14 topic / T18 milestone 同一先例：MutationType 里没有 asset.*）。

import { nanoid } from 'nanoid'

import * as fsAdapter from './fsAdapter'
import type { VaultDirHandle } from './handleStore'
import type { Asset, Vault } from '../domain/types'

/** spec 4.1 数据布局：图片目录。 */
export const ASSET_DIR = 'assets'
/** spec 6.4：单张 5 MB 上限。 */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024

/** spec 6.4 的六种格式；svg 只在 `<img>` 里渲染（不内联进 DOM，脚本不执行）。 */
const EXT_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

const MIME_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

export type AssetRejectReason = 'empty' | 'type' | 'size' | 'missing'

export class AssetError extends Error {
  readonly reason: AssetRejectReason
  constructor(reason: AssetRejectReason, message?: string) {
    super(message ?? `asset rejected: ${reason}`)
    this.name = 'AssetError'
    this.reason = reason
  }
}

/** put() 真正读得动的部分：`File` 结构兼容即可（测试用替身，浏览器用真 File）。 */
export interface AssetFileLike {
  name?: string
  type?: string
  size?: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface AssetPutResult {
  /** 待记进 vault.assets 的元数据。 */
  asset: Asset
  /** note 里引用的相对路径，形如 `assets/<id>.<ext>`。 */
  path: string
}

export interface AssetFs {
  writeBinary(dir: VaultDirHandle, path: string, data: Uint8Array): Promise<void>
  readBinary(dir: VaultDirHandle, path: string): Promise<Uint8Array>
  remove(dir: VaultDirHandle, path: string): Promise<boolean>
  list(dir: VaultDirHandle, dirPath: string): Promise<string[]>
  ensureSubdirs(dir: VaultDirHandle): Promise<void>
}

export interface AssetStoreDeps {
  fs?: AssetFs
  /** 默认 nanoid（spec 4.1：`<nanoid>.<ext>`）。 */
  newId?: () => string
  now?: () => Date
  /** jsdom 与 Node 都不保证有 URL.createObjectURL，故注入（默认走全局，缺失则抛）。 */
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

export interface AssetStore {
  /** 只判不写：返回 null 表示放行，否则是被拒原因。 */
  validate(file: AssetFileLike, bytes?: Uint8Array): AssetRejectReason | null
  put(file: AssetFileLike): Promise<AssetPutResult>
  /** 读文件 → Blob → objectURL（带缓存）。ref 形如 `assets/<id>.<ext>`。 */
  url(ref: string): Promise<string>
  /** 同步读缓存；未就绪 null。渲染层用它避免首帧空白。 */
  peek(ref: string): string | null
  /** 回收单个（省略则无操作）；回收后下次 url() 重新创建。 */
  revoke(ref: string): void
  /** 回收全部（卸载 / 换库）。 */
  dispose(): void
  /** assets 目录里的实际文件名列表（T26 gc 用）。 */
  listFiles(): Promise<string[]>
  /** 删除单个文件（T26 gc 用）。 */
  removeFile(ref: string): Promise<boolean>
}

export function isAssetRef(src: string): boolean {
  if (!src.startsWith(`${ASSET_DIR}/`)) return false
  const rest = src.slice(ASSET_DIR.length + 1)
  return rest !== '' && !rest.includes('/')
}

/** `assets/abc.png` → `abc`；非 assets 引用返回 null。 */
export function assetIdOf(src: string): string | null {
  if (!isAssetRef(src)) return null
  const name = src.slice(ASSET_DIR.length + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? null : name.slice(0, dot)
}

export function extOfPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function mimeOfExt(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] ?? 'application/octet-stream'
}

/** 扩展名先按文件名取（保留用户原本的 png/jpg），取不到再按 mime 推。 */
function resolveExt(file: AssetFileLike): string {
  const fromName = typeof file.name === 'string' ? extOfPath(file.name) : ''
  if (fromName !== '' && fromName in EXT_MIME) return fromName
  const mime = typeof file.type === 'string' ? file.type.split(';')[0]?.trim() ?? '' : ''
  const fromMime = MIME_EXT[mime]
  return fromMime ?? ''
}

/** 纯函数：把 asset 元数据记进 assets 表（同 id 覆盖，其余引用不变）。 */
export function recordAsset(vault: Vault, asset: Asset): Vault {
  const rest = vault.assets.filter((entry) => entry.id !== asset.id)
  return { ...vault, assets: [...rest, asset] }
}

function defaultCreateObjectURL(blob: Blob): string {
  const impl = (URL as { createObjectURL?: (b: Blob) => string }).createObjectURL
  if (typeof impl !== 'function') {
    throw new AssetError('missing', 'URL.createObjectURL is unavailable')
  }
  return impl.call(URL, blob)
}

function defaultRevokeObjectURL(url: string): void {
  const impl = (URL as { revokeObjectURL?: (u: string) => void }).revokeObjectURL
  if (typeof impl === 'function') impl.call(URL, url)
}

export function createAssetStore(dir: VaultDirHandle, deps: AssetStoreDeps = {}): AssetStore {
  const fs = deps.fs ?? (fsAdapter as unknown as AssetFs)
  const newId = deps.newId ?? (() => nanoid())
  const now = deps.now ?? (() => new Date())
  const createObjectURL = deps.createObjectURL ?? defaultCreateObjectURL
  const revokeObjectURL = deps.revokeObjectURL ?? defaultRevokeObjectURL

  /** Map<ref, objectURL>：key 用 note 里的相对路径，与引用一一对应。 */
  const cache = new Map<string, string>()

  function validate(file: AssetFileLike, bytes?: Uint8Array): AssetRejectReason | null {
    if (resolveExt(file) === '') return 'type'
    const size = bytes?.byteLength ?? file.size ?? 0
    if (size <= 0) return 'empty'
    if (size > MAX_ASSET_BYTES) return 'size'
    return null
  }

  return {
    validate,

    async put(file) {
      const ext = resolveExt(file)
      const bytes = new Uint8Array(await file.arrayBuffer())
      // file.size 可能与真实字节数不一致（剪贴板/拖入的构造差异），一律按读出来的字节判。
      const reason = validate(file, bytes)
      if (reason !== null) throw new AssetError(reason, `asset rejected: ${reason}`)

      await fs.ensureSubdirs(dir)
      const id = newId()
      const path = `${ASSET_DIR}/${id}.${ext}`
      await fs.writeBinary(dir, path, bytes)

      const asset: Asset = {
        id,
        filename: path,
        sizeBytes: bytes.byteLength,
        createdAt: now().toISOString(),
      }
      return { asset, path }
    },

    async url(ref) {
      const cached = cache.get(ref)
      if (cached !== undefined) return cached
      let bytes: Uint8Array
      try {
        bytes = await fs.readBinary(dir, ref)
      } catch (e) {
        if ((e as { name?: string }).name === 'NotFoundError') {
          throw new AssetError('missing', `asset not found: ${ref}`)
        }
        throw e
      }
      const blob = new Blob([bytes as BlobPart], { type: mimeOfExt(extOfPath(ref)) })
      const objectURL = createObjectURL(blob)
      cache.set(ref, objectURL)
      return objectURL
    },

    peek(ref) {
      return cache.get(ref) ?? null
    },

    revoke(ref) {
      const cached = cache.get(ref)
      if (cached === undefined) return
      cache.delete(ref)
      revokeObjectURL(cached)
    },

    dispose() {
      for (const objectURL of cache.values()) revokeObjectURL(objectURL)
      cache.clear()
    },

    listFiles() {
      return fs.list(dir, ASSET_DIR)
    },

    async removeFile(ref) {
      const ok = await fs.remove(dir, ref)
      if (ok) this.revoke(ref)
      return ok
    },
  }
}
