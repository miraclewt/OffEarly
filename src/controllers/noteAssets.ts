// T25 · noteAssets：NoteEditor 与 AssetStore 之间的适配器（集成车道的接线件）。
//
// 为什么要有这一层：NoteEditor 是纯视图（不碰文件系统、不碰 store），
// AssetStore 是纯持久化（不知道 vault、也不认识 React）。两边要接上，得有人负责：
//  · 落盘后把元数据写进 `vault.assets`（走 store.update，与 T14 topic / T18 milestone 同一先例）；
//  · 把 `assets/<id>.<ext>` 翻成 blob URL，并在**还没读出来时自己发起异步读取**；
//  · 读完后通知所有在等的图片节点重画。
//
// 「发起异步读取」放在 resolve 里是关键取舍：编辑器是同步渲染的，
// 但 blob URL 必须 getFile() 之后才有；让 resolve 顺手把读取挂上、完成后回调通知，
// 节点视图就只需「读 → 订阅 → 重画」三步，不必知道任何 I/O 细节。

import type { VaultStore } from '../domain/store'
import { isAssetRef, recordAsset } from '../persistence/assetStore'
import type { AssetStore } from '../persistence/assetStore'
import type { NoteAssetsPort } from '../views/NoteEditor'

/** note 里 `![](assets/<id>.<ext>)` 的引用集合（T26 的 gc 也用这一份口径）。 */
export function noteAssetRefs(markdown: string): string[] {
  const refs = new Set<string>()
  const pattern = /!\[[^\]]*\]\(([^)\s]+)\)/g
  for (const match of markdown.matchAll(pattern)) {
    const src = match[1] ?? ''
    if (isAssetRef(src)) refs.add(src)
  }
  return [...refs]
}

/** 适配器造出来的端口一定有 subscribe（视图侧是可选的，这里补成必填便于接线直接用）。 */
export interface NoteAssetsPortHandle extends Omit<NoteAssetsPort, 'subscribe'> {
  subscribe(listener: () => void): () => void
  /** 会话结束 / 换库：回收全部 blob URL（不 revoke 就会一直占着内存）。 */
  dispose(): void
}

export function createNoteAssetsPort(store: VaultStore, assets: AssetStore): NoteAssetsPortHandle {
  const listeners = new Set<() => void>()
  /** 正在读取的引用：同一张图被多处引用时只读一次。 */
  const inflight = new Set<string>()

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function load(ref: string): void {
    if (assets.peek(ref) !== null || inflight.has(ref)) return
    inflight.add(ref)
    void assets
      .url(ref)
      .then(() => {
        inflight.delete(ref)
        notify()
      })
      .catch(() => {
        // 读不到（文件被外部删了/权限没了）：撤出 inflight 即可，
        // 节点视图会一直停在灰底 chip——总比渲染碎图或抛错强。
        inflight.delete(ref)
      })
  }

  return {
    async insert(file) {
      try {
        const { asset, path } = await assets.put(file)
        // 元数据进 assets 表（T26 的 gc 靠它算「哪些文件没人引用」）；
        // 不走 CommandBus——MutationType 没有 asset.*，沿用 T14/T18 的 store.update 先例。
        store.update((vault) => recordAsset(vault, asset))
        // 立刻拿一次 URL：刚从 File 落盘的图，用户下一帧就该看到
        await assets.url(path).catch(() => undefined)
        notify()
        return { ok: true, src: path, alt: file.name }
      } catch (e) {
        const reason = (e as { reason?: string }).reason
        return {
          ok: false,
          reason:
            reason === 'type' || reason === 'size' || reason === 'empty' || reason === 'missing'
              ? reason
              : 'failed',
        }
      }
    },

    resolve(ref) {
      const cached = assets.peek(ref)
      if (cached !== null) return cached
      load(ref)
      return null
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      listeners.clear()
      inflight.clear()
      assets.dispose()
    },
  }
}
