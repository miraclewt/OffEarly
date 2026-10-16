// T28 · backupPort：把快照 / 导出 / 导入能力接到 BackupPanel 的端口（集成车道接线件）。
//
// 三个端口各自收窄 BackupPanel 真正需要的面，视图层不 import 持久化模块：
//   · snapshot —— 直接透传 SnapshotStore 的 list/snapshot/restore（restore 内部已保证
//     「恢复前对当前版本再打一份快照」，面板不用自己再兜）；
//   · export —— 弹目录选择器 → exportDataCopy 递归复制；
//   · import —— 弹目录选择器读 vault.json 文本（文件路径由面板的 file input 走 parse），
//     解析统一复用 vaultRepository.parseVaultText，与启动加载同一条判据。

import type { Vault } from '../domain/types'
import { parseVaultText, VAULT_FILE } from '../persistence/vaultRepository'
import type { SnapshotInfo } from '../persistence/snapshotStore'
import { exportDataCopy, pickDirectory } from '../persistence/backupIO'
import type { BackupIoFs, ExportSummary } from '../persistence/backupIO'
import * as fsAdapter from '../persistence/fsAdapter'

/** 快照端口：面板只需要这三招，restore 的「恢复前打快照」由 SnapshotStore 保证。 */
export interface BackupSnapshotPort {
  list(): Promise<SnapshotInfo[]>
  /**
   * 立即快照 / 恢复。返回值一律**不被消费**（面板只关心成功与否、随后重新 list），
   * 故用 `unknown`：只读相位的恢复走 `loader.restoreSnapshot`，它返回的是
   * `{ vault, safetySnapshotId }` 而非 SnapshotInfo，接口不该逼调用方造假对象。
   */
  snapshot(): Promise<unknown>
  restore(id: string): Promise<unknown>
}

/** 导出端口：弹选目标目录 → 递归复制 → 返回统计；用户取消返回 null。 */
export interface BackupExportPort {
  exportCopy(): Promise<ExportSummary | null>
}

/** 导入端口：parse 校验/迁移文本；fromDirectory 弹选文件夹读 vault.json 文本。 */
export interface BackupImportPort {
  parse(text: string): Vault
  fromDirectory(): Promise<string | null>
}

export function createBackupExportPort(
  dir: FileSystemDirectoryHandle,
  deps: {
    pickTarget?: () => Promise<FileSystemDirectoryHandle | null>
    fs?: BackupIoFs
  } = {},
): BackupExportPort {
  const pickTarget = deps.pickTarget ?? (() => pickDirectory('readwrite'))
  return {
    async exportCopy() {
      const target = await pickTarget()
      if (target === null) return null
      return exportDataCopy(dir, target, { fs: deps.fs })
    },
  }
}

export function createBackupImportPort(
  deps: {
    pickSource?: () => Promise<FileSystemDirectoryHandle | null>
    readText?: (dir: FileSystemDirectoryHandle, path: string) => Promise<string>
  } = {},
): BackupImportPort {
  const pickSource = deps.pickSource ?? (() => pickDirectory('read'))
  const readText = deps.readText ?? fsAdapter.readText
  return {
    parse(text) {
      return parseVaultText(text)
    },
    async fromDirectory() {
      const source = await pickSource()
      if (source === null) return null
      return readText(source, VAULT_FILE)
    },
  }
}
