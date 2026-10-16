// backupIO（T28）：备份面板的导出 / 导入落盘面。
//
// 导出（spec 8.3 / T28）：把整个数据文件夹递归复制到用户选的目标目录——
// vault.json + assets/**（图片 sidecar 走独立文件，必须一起带走，否则笔记里的
// `![](assets/…)` 会悬空）。`.backup/` 是本地快照安全网，不随导出迁移。
//
// 导入（T28）：两条取文本的入口 + 复用 vaultRepository.parseVaultText 的校验/迁移。
// 分层：文件系统原语全部来自 fsAdapter（T06，全项目唯一接触 File System Access API 的层）。

import * as fsAdapter from './fsAdapter'

/** 导出完成后的统计：复制了多少个文件、共多少字节。 */
export interface ExportSummary {
  files: number
  bytes: number
}

/** 递归复制所需的落盘面（缺省用 fsAdapter，测试可整体替换或逐项 spy）。 */
export interface BackupIoFs {
  listEntries(
    dir: FileSystemDirectoryHandle,
    dirPath: string,
  ): Promise<{ name: string; kind: 'file' | 'directory' }[]>
  readBinary(dir: FileSystemDirectoryHandle, path: string): Promise<Uint8Array>
  writeBinary(dir: FileSystemDirectoryHandle, path: string, data: Uint8Array): Promise<void>
  ensureDir(dir: FileSystemDirectoryHandle, path: string): Promise<void>
}

/**
 * 递归复制数据目录到目标目录（导出库副本）。跳过 `.backup/`。
 * 文件逐字节复制（readBinary → writeBinary），不重编码——图片等二进制原样带走。
 */
export async function exportDataCopy(
  source: FileSystemDirectoryHandle,
  target: FileSystemDirectoryHandle,
  deps: { fs?: BackupIoFs } = {},
): Promise<ExportSummary> {
  const fs = deps.fs ?? (fsAdapter as unknown as BackupIoFs)
  const summary: ExportSummary = { files: 0, bytes: 0 }

  async function copyDir(relPath: string): Promise<void> {
    const entries = await fs.listEntries(source, relPath)
    for (const entry of entries) {
      // 只在根目录跳过 .backup/；子目录里不存在同名目录，无需再拦。
      if (relPath === '' && entry.name === '.backup') continue
      const rel = relPath === '' ? entry.name : `${relPath}/${entry.name}`
      if (entry.kind === 'file') {
        const bytes = await fs.readBinary(source, rel)
        await fs.writeBinary(target, rel, bytes)
        summary.files += 1
        summary.bytes += bytes.byteLength
      } else {
        await fs.ensureDir(target, rel)
        await copyDir(rel)
      }
    }
  }

  await copyDir('')
  return summary
}

type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>

/**
 * 弹系统目录选择器；用户取消返回 null（AbortError），环境不支持抛错。
 * mode：导出选 readwrite（要写文件），导入选 read（只读 vault.json）。
 */
export async function pickDirectory(
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<FileSystemDirectoryHandle | null> {
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
  if (typeof picker !== 'function') {
    throw new Error('showDirectoryPicker is unavailable in this browser')
  }
  try {
    return await picker.call(globalThis, { mode })
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return null
    throw e
  }
}
