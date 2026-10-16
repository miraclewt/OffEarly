// T26 · backupGc：把 AssetStore 的 gc 能力接到 VaultStore（集成车道的接线件）。
//
// 为什么要这一层：AssetStore 是纯持久化（知道文件、不认识 store），VaultStore 是纯状态
// （知道 vault、不认识文件）。gc 必须同时做两件事——删磁盘文件 + 摘 assets 表记录——
// 所以要有人把这两半接起来：
//   · preview() 读 store 当前 vault，转成「哪些附件没人引用」的只读清单；
//   · cleanup(ids) 先让 AssetStore.gc 删文件，再把删成功的 id 从 assets 表摘掉（store.update）。
//
// 摘表走纯函数 removeAssets + store.update，与 T14 topic / T18 milestone / T25 recordAsset
// 同一先例：MutationType 里没有 asset.*，故不走 CommandBus。

import type { VaultStore } from '../domain/store'
import type { AssetGcPreview, AssetStore } from '../persistence/assetStore'
import { removeAssets } from '../persistence/assetStore'

/** BackupPanel 需要的 gc 面：只暴露「预览」与「确认后清理」，删什么由面板先展示再拍板。 */
export interface BackupGcPort {
  preview(): Promise<AssetGcPreview>
  cleanup(ids: readonly string[]): Promise<readonly string[]>
}

export function createBackupGcPort(store: VaultStore, assets: AssetStore): BackupGcPort {
  return {
    async preview() {
      return assets.gcPreview(store.getVault())
    },

    async cleanup(ids) {
      // 二次校验（TOCTOU 防御）：用户在「扫描」和「确认」之间可能又往某条笔记里插了张图，
      // 让先前判定的「未引用」变得被引用。删除不可逆，这里用**当前** vault 再扫一遍，
      // 只放行「仍未被引用」且「在确认清单里」的 id——宁可少删，不可错删。
      const stillUnreferenced = new Set(assets.gcPreview(store.getVault()).unreferenced.map((c) => c.id))
      const safeIds = ids.filter((id) => stillUnreferenced.has(id))
      if (safeIds.length === 0) return []
      const removed = await assets.gc(safeIds)
      if (removed.length > 0) {
        store.update((vault) => removeAssets(vault, removed))
      }
      return removed
    },
  }
}
