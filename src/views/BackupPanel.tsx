// BackupPanel（T26 最小版）：备份面板的「清理未引用附件」入口（spec 6.4 / T26）。
//
// T28 会把快照列表 / 恢复 / 导出库副本 / 导入一并扩进来，这里先只交付 gc 那一段：
//   先「扫描未引用附件」出只读清单（gc.preview），用户看清了再点「确认清理」才真删（gc.cleanup）。
// 两层之间隔着一次确认——回收是不可逆的破坏性操作，宁可多一步。
//
// 分层：本组件是纯视图——不碰文件系统、不碰 store，一切 I/O 都经注入的 `gc` 端口
// （由 controllers/backupGc.ts 的 createBackupGcPort 接线，与 ConflictDialog 同一手法）。
// 文案不写进 src/locales/*（本任务车窗不碰该目录），自带中文兜底 + labels 覆盖位。

import { useState } from 'react'
import type { CSSProperties } from 'react'

import type { AssetGcPreview } from '../persistence/assetStore'
import type { BackupGcPort } from '../controllers/backupGc'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'
const INDIGO = 'var(--oe-accent)'
const AMBER = 'var(--oe-blocked)'

export interface BackupPanelLabels {
  title: string
  attachments: string
  noAssets: string
  scan: string
  scanHint: string
  scanning: string
  unreferenced: string
  reclaimable: string
  empty: string
  confirm: string
  confirmHint: string
  cleaning: string
  cleaned: string
  failed: string
}

export const BACKUP_LABELS_ZH: BackupPanelLabels = {
  title: '备份与清理',
  attachments: '附件：{count} 个，共 {bytes}',
  noAssets: '当前库还没有附件',
  scan: '扫描未引用附件',
  scanHint: '找出笔记里不再引用的图片，确认后再删除',
  scanning: '正在扫描…',
  unreferenced: '未引用附件：{count} 个',
  reclaimable: '可释放 {bytes}',
  empty: '没有可回收的附件',
  confirm: '确认清理 {count} 个附件',
  confirmHint: '删除后不可恢复，请确认这些图片确实不再需要',
  cleaning: '正在清理…',
  cleaned: '已清理 {count} 个附件，释放 {bytes}',
  failed: '操作失败',
}

/** `{count}` / `{bytes}` 插值：与 ConflictDialog 的 fill 同语义，不依赖消息表。 */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(count|bytes)\}/g, (_, key: string) => String(vars[key] ?? ''))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const ROW: CSSProperties = {
  padding: '8px 12px',
  background: 'var(--oe-surface)',
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
}

const BUTTON: CSSProperties = {
  padding: '6px 14px',
  fontSize: 13,
  fontWeight: 600,
  color: INDIGO,
  background: 'var(--oe-surface)',
  border: `1px solid ${INDIGO}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

export interface BackupPanelProps {
  /** gc 端口（controllers/backupGc.ts 提供）；未注入时清理入口置灰。 */
  gc?: BackupGcPort
  /** 附件总数 / 总字节（来自 vault.assets，供展示）；省略则只显示清理入口。 */
  assetCount?: number
  assetTotalBytes?: number
  /** 覆盖文案（接 locales 用）；未覆盖的键取中文兜底。 */
  labels?: Partial<BackupPanelLabels>
}

export function BackupPanel(props: BackupPanelProps) {
  const { gc, assetCount = 0, assetTotalBytes = 0, labels } = props
  const text: BackupPanelLabels = { ...BACKUP_LABELS_ZH, ...labels }

  const [preview, setPreview] = useState<AssetGcPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [cleaned, setCleaned] = useState<{ count: number; bytes: number } | null>(null)

  function runScan() {
    if (gc === undefined || busy) return
    setBusy(true)
    setError(null)
    setCleaned(null)
    void gc
      .preview()
      .then((p) => {
        setPreview(p)
      })
      .catch((e: unknown) => {
        setError(e)
      })
      .finally(() => {
        setBusy(false)
      })
  }

  function runCleanup(ids: readonly string[]) {
    if (gc === undefined || busy || preview === null) return
    const reclaimable = preview.reclaimableBytes
    setBusy(true)
    setError(null)
    void gc
      .cleanup(ids)
      .then((removed) => {
        const remaining =
          preview.unreferenced.length === removed.length
            ? null
            : { ...preview, unreferenced: preview.unreferenced.filter((c) => !removed.includes(c.id)) }
        setPreview(remaining)
        setCleaned({ count: removed.length, bytes: reclaimable })
      })
      .catch((e: unknown) => {
        setError(e)
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div data-testid="backup-panel" style={{ padding: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: TEXT }}>{text.title}</div>

      <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>
        {assetCount === 0
          ? text.noAssets
          : fill(text.attachments, { count: assetCount, bytes: formatBytes(assetTotalBytes) })}
      </div>

      {preview === null ? (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            data-testid="backup-gc-scan"
            disabled={gc === undefined || busy}
            onClick={runScan}
            style={{ ...BUTTON, color: gc === undefined ? MUTED : INDIGO, borderColor: gc === undefined ? BORDER : INDIGO }}
          >
            {busy ? text.scanning : text.scan}
          </button>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>{text.scanHint}</div>
        </div>
      ) : (
        <div data-testid="backup-gc-preview" style={{ marginTop: 16 }}>
          {preview.unreferenced.length === 0 ? (
            <div style={{ fontSize: 12, color: MUTED }}>{text.empty}</div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: TEXT }}>
                {fill(text.unreferenced, { count: preview.unreferenced.length })}
              </div>
              <div data-testid="backup-gc-reclaim" style={{ fontSize: 12, color: AMBER, marginTop: 4 }}>
                {fill(text.reclaimable, { bytes: formatBytes(preview.reclaimableBytes) })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
                {preview.unreferenced.map((candidate) => (
                  <div
                    key={candidate.id}
                    data-testid={`backup-gc-item-${candidate.id}`}
                    style={{ ...ROW, display: 'flex', justifyContent: 'space-between' }}
                  >
                    <span style={{ fontSize: 12, color: TEXT }}>{candidate.filename}</span>
                    <span style={{ fontSize: 11, color: MUTED }}>{formatBytes(candidate.sizeBytes)}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                data-testid="backup-gc-confirm"
                disabled={busy}
                onClick={() => {
                  runCleanup(preview.unreferenced.map((c) => c.id))
                }}
                style={{ ...BUTTON, marginTop: 12 }}
              >
                {busy ? text.cleaning : fill(text.confirm, { count: preview.unreferenced.length })}
              </button>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>{text.confirmHint}</div>
            </>
          )}
        </div>
      )}

      {cleaned === null ? null : (
        <div data-testid="backup-gc-status" style={{ fontSize: 12, color: MUTED, marginTop: 12 }}>
          {fill(text.cleaned, { count: cleaned.count, bytes: formatBytes(cleaned.bytes) })}
        </div>
      )}
      {error === null ? null : (
        <div data-testid="backup-gc-error" style={{ fontSize: 12, color: 'var(--oe-overdue)', marginTop: 12 }}>
          {text.failed}：{errorText(error)}
        </div>
      )}
    </div>
  )
}

export default BackupPanel
