// BackupPanel（T26 最小版 → T28 完整版）：备份面板。
//
// 四段（自上而下）：
//   1. 附件概况 + 清理未引用附件（T26，gc 经注入端口，先「扫描」出只读清单、再「确认清理」才真删）
//   2. 快照列表（时间/大小/任务数）+ 立即快照 + 恢复（恢复前 SnapshotStore 已自动再打一份快照）
//   3. 导出库副本（递归复制数据目录到用户选的目标目录）
//   4. 导入（vault.json 文件 / 文件夹 → 校验迁移 → 预览 → 二次确认才覆盖）
//
// 分层：本组件是纯视图——不碰文件系统、不碰 store，一切 I/O 都经注入的端口
// （gc 来自 controllers/backupGc.ts，快照/导出/导入来自 controllers/backupPort.ts，与 ConflictDialog 同一手法）。
// 覆盖内存（导入确认 / 恢复后重载）由调用方经 onImported / onRestored 回调接线（App）。
// 文案不写进 src/locales/*（本任务车窗不碰该目录），自带中文兜底 + labels 覆盖位。

import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'

import type { Vault } from '../domain/types'
import type { AssetGcPreview } from '../persistence/assetStore'
import type { SnapshotInfo } from '../persistence/snapshotStore'
import type { ExportSummary } from '../persistence/backupIO'
import type { BackupGcPort } from '../controllers/backupGc'
import type { BackupExportPort, BackupImportPort, BackupSnapshotPort } from '../controllers/backupPort'
import { fs, sp, px } from '../styles/scale'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'
const INDIGO = 'var(--oe-accent)'
const AMBER = 'var(--oe-blocked)'
const DANGER = 'var(--oe-overdue)'

export interface BackupPanelLabels {
  // ── T26 附件清理 ──
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
  // ── T28 快照 / 导出 / 导入 ──
  snapshots: string
  snapshotEmpty: string
  snapshotNow: string
  snapshotting: string
  snapshotHint: string
  taskCount: string
  restore: string
  restoreConfirm: string
  restoreConfirmAction: string
  restoring: string
  restored: string
  export: string
  exporting: string
  exported: string
  import: string
  importFile: string
  importDir: string
  importPreview: string
  importConfirm: string
  importConfirmHint: string
  importing: string
  imported: string
  cancel: string
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
  snapshots: '快照',
  snapshotEmpty: '还没有快照',
  snapshotNow: '立即快照',
  snapshotting: '正在快照…',
  snapshotHint: '把当前 vault.json 复制一份到 .backup/',
  taskCount: '{count} 个任务',
  restore: '恢复',
  restoreConfirm: '恢复到此快照？当前版本会先自动打一份快照',
  restoreConfirmAction: '确认恢复',
  restoring: '正在恢复…',
  restored: '已恢复到此快照',
  export: '导出库副本',
  exporting: '正在导出…',
  exported: '已导出 {files} 个文件，共 {bytes}',
  import: '导入',
  importFile: '导入 vault.json 文件',
  importDir: '从文件夹导入',
  importPreview: '将导入 {tasks} 个任务、{milestones} 个里程碑、{assets} 个附件',
  importConfirm: '确认导入（覆盖当前 {tasks} 个任务）',
  importConfirmHint: '导入会覆盖当前库内容，建议先导出副本',
  importing: '正在导入…',
  imported: '已导入',
  cancel: '取消',
}

/** `{key}` 插值：与 ConflictDialog 的 fill 同语义，不依赖消息表。 */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => String(vars[key] ?? ''))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `2026-10-15T09:30:12+08:00` → `2026-10-15 09:30`（本地时间，切片即本地日期）。 */
function formatTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const ROW: CSSProperties = {
  padding: px('8px 12px'),
  background: 'var(--oe-surface)',
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
}

const BUTTON: CSSProperties = {
  padding: px('6px 14px'),
  fontSize: fs(13),
  fontWeight: 600,
  color: INDIGO,
  background: 'var(--oe-surface)',
  border: `1px solid ${INDIGO}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

const GHOST: CSSProperties = {
  ...BUTTON,
  color: MUTED,
  borderColor: BORDER,
}

const SECTION_TITLE: CSSProperties = {
  fontSize: fs(13),
  fontWeight: 600,
  color: TEXT,
  marginTop: sp(20),
  marginBottom: sp(8),
}

export interface BackupPanelProps {
  /** 受控打开态；省略时始终显示（兼容独立挂载与单测）。 */
  open?: boolean
  /** 关闭请求外送（受控时由接线方决定是否收起）。 */
  onOpenChange?: (open: boolean) => void
  /** gc 端口（controllers/backupGc.ts 提供）；未注入时清理入口置灰。 */
  gc?: BackupGcPort
  /** 附件总数 / 总字节（来自 vault.assets，供展示）。 */
  assetCount?: number
  assetTotalBytes?: number
  /** 快照端口（controllers/backupPort.ts）；未注入时快照区置灰。 */
  snapshots?: BackupSnapshotPort
  /** 导出端口；未注入时导出按钮置灰。 */
  exporter?: BackupExportPort
  /** 导入端口；未注入时导入入口置灰。 */
  importer?: BackupImportPort
  /** 当前任务数（导入确认文案里的「覆盖当前 N 个任务」）。 */
  currentTaskCount?: number
  /** 导入确认后的覆盖回调（App 接线：store.setVault + 写盘）。 */
  onImported?: (vault: Vault) => void
  /** 恢复完成后的重载回调（App 接线：磁盘已覆盖，重新 load 到 store）。 */
  onRestored?: () => void
  /** 覆盖文案（接 locales 用）；未覆盖的键取中文兜底。 */
  labels?: Partial<BackupPanelLabels>
}

export function BackupPanel(props: BackupPanelProps) {
  const {
    open,
    onOpenChange,
    gc,
    assetCount = 0,
    assetTotalBytes = 0,
    snapshots,
    exporter,
    importer,
    currentTaskCount,
    onImported,
    onRestored,
    labels,
  } = props
  const text: BackupPanelLabels = { ...BACKUP_LABELS_ZH, ...labels }
  const shown = open !== false

  // ── T26 附件清理状态 ──
  const [preview, setPreview] = useState<AssetGcPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [cleaned, setCleaned] = useState<{ count: number; bytes: number } | null>(null)

  // ── T28 快照状态 ──
  const [snapshotList, setSnapshotList] = useState<SnapshotInfo[]>([])
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const [snapshotError, setSnapshotError] = useState<unknown>(null)
  const [restoreConfirmId, setRestoreConfirmId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [restored, setRestored] = useState(false)

  // ── T28 导出 / 导入状态 ──
  const [exportBusy, setExportBusy] = useState(false)
  const [exportResult, setExportResult] = useState<ExportSummary | null>(null)
  const [exportError, setExportError] = useState<unknown>(null)
  const [importPreviewVault, setImportPreviewVault] = useState<Vault | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<unknown>(null)
  const [imported, setImported] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 挂载即加载快照列表；端口未注入或面板收起时跳过。
  useEffect(() => {
    if (!shown || snapshots === undefined) return
    let cancelled = false
    void snapshots
      .list()
      .then((list) => {
        if (!cancelled) setSnapshotList(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) setSnapshotError(e)
      })
    return () => {
      cancelled = true
    }
  }, [shown, snapshots])

  /**
   * Esc 关闭（T52）：设置 / 筛选 / 里程碑三个面板都能按 Esc 退出，只有备份面板不能，
   * 属于同一类浮层的交互不一致。这里补齐，且只在受控（接线方给了 onOpenChange）时生效。
   */
  useEffect(() => {
    if (!shown || onOpenChange === undefined) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onOpenChange?.(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [shown, onOpenChange])

  function runScan() {
    if (gc === undefined || busy) return
    setBusy(true)
    setError(null)
    setCleaned(null)
    void gc
      .preview()
      .then(setPreview)
      .catch(setError)
      .finally(() => setBusy(false))
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
      .catch(setError)
      .finally(() => setBusy(false))
  }

  async function runSnapshot() {
    if (snapshots === undefined || snapshotBusy) return
    setSnapshotBusy(true)
    setSnapshotError(null)
    setRestored(false)
    try {
      await snapshots.snapshot()
      setSnapshotList(await snapshots.list())
    } catch (e) {
      setSnapshotError(e)
    } finally {
      setSnapshotBusy(false)
    }
  }

  async function runRestore(id: string) {
    if (snapshots === undefined || restoring) return
    setRestoring(true)
    setSnapshotError(null)
    setRestored(false)
    try {
      await snapshots.restore(id)
      setSnapshotList(await snapshots.list())
      setRestoreConfirmId(null)
      setRestored(true)
      onRestored?.()
    } catch (e) {
      setSnapshotError(e)
    } finally {
      setRestoring(false)
    }
  }

  async function runExport() {
    if (exporter === undefined || exportBusy) return
    setExportBusy(true)
    setExportError(null)
    setExportResult(null)
    try {
      setExportResult(await exporter.exportCopy())
    } catch (e) {
      setExportError(e)
    } finally {
      setExportBusy(false)
    }
  }

  function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = '' // 允许再次选择同一文件
    if (file === undefined || importer === undefined) return
    setImportBusy(true)
    setImportError(null)
    setImported(false)
    void file
      .text()
      .then((textContent) => importer.parse(textContent))
      .then(setImportPreviewVault)
      .catch(setImportError)
      .finally(() => setImportBusy(false))
  }

  async function runImportDir() {
    if (importer === undefined || importBusy) return
    setImportBusy(true)
    setImportError(null)
    setImported(false)
    try {
      const textContent = await importer.fromDirectory()
      if (textContent === null) return // 用户取消
      setImportPreviewVault(importer.parse(textContent))
    } catch (e) {
      setImportError(e)
    } finally {
      setImportBusy(false)
    }
  }

  function confirmImport() {
    if (importPreviewVault === null || onImported === undefined) return
    onImported(importPreviewVault)
    setImportPreviewVault(null)
    setImported(true)
  }

  const gcDisabled = gc === undefined
  const snapshotsDisabled = snapshots === undefined
  const exporterDisabled = exporter === undefined
  const importerDisabled = importer === undefined

  // 早退必须放在**所有 hook 之后**：此前它在 useState 之前，收起→展开时 hook 数量从 0
  // 变成 12，开发构建会直接抛「Rendered more hooks than during the previous render」。
  if (!shown) return null

  return (
    <div
      data-testid="backup-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange?.(false)
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 22,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: sp(24),
        background: 'var(--oe-scrim)',
        backdropFilter: 'blur(8px) saturate(140%)',
        WebkitBackdropFilter: 'blur(8px) saturate(140%)',
        fontFamily: 'var(--oe-font)',
      }}
    >
      <div
        data-testid="backup-panel"
        style={{
          width: '100%',
          maxWidth: sp(560),
          maxHeight: '100%',
          overflowY: 'auto',
          padding: sp(16),
          background: 'var(--oe-surface)',
          border: '1px solid var(--oe-separator)',
          borderRadius: 'var(--oe-radius-overlay)',
          boxShadow: 'var(--oe-shadow-pop)',
          boxSizing: 'border-box',
        }}
      >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: fs(15), fontWeight: 600, color: TEXT }}>{text.title}</div>
        {onOpenChange === undefined ? null : (
          <button
            type="button"
            data-testid="backup-close"
            onClick={() => onOpenChange(false)}
            style={{ ...GHOST, padding: px('2px 8px'), fontSize: fs(16), lineHeight: 1 }}
            aria-label={text.cancel}
          >
            ×
          </button>
        )}
      </div>

      {/* ── T26 附件概况 + 清理 ── */}
      <div style={{ fontSize: fs(12), color: MUTED, marginTop: sp(10) }}>
        {assetCount === 0
          ? text.noAssets
          : fill(text.attachments, { count: assetCount, bytes: formatBytes(assetTotalBytes) })}
      </div>

      {preview === null ? (
        <div style={{ marginTop: sp(16) }}>
          <button
            type="button"
            data-testid="backup-gc-scan"
            disabled={gcDisabled || busy}
            onClick={runScan}
            style={{ ...BUTTON, color: gcDisabled ? MUTED : INDIGO, borderColor: gcDisabled ? BORDER : INDIGO }}
          >
            {busy ? text.scanning : text.scan}
          </button>
          <div style={{ fontSize: fs(11), color: MUTED, marginTop: sp(6) }}>{text.scanHint}</div>
        </div>
      ) : (
        <div data-testid="backup-gc-preview" style={{ marginTop: sp(16) }}>
          {preview.unreferenced.length === 0 ? (
            <div style={{ fontSize: fs(12), color: MUTED }}>{text.empty}</div>
          ) : (
            <>
              <div style={{ fontSize: fs(12), color: TEXT }}>
                {fill(text.unreferenced, { count: preview.unreferenced.length })}
              </div>
              <div data-testid="backup-gc-reclaim" style={{ fontSize: fs(12), color: AMBER, marginTop: sp(4) }}>
                {fill(text.reclaimable, { bytes: formatBytes(preview.reclaimableBytes) })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: sp(6), marginTop: sp(12) }}>
                {preview.unreferenced.map((candidate) => (
                  <div
                    key={candidate.id}
                    data-testid={`backup-gc-item-${candidate.id}`}
                    style={{ ...ROW, display: 'flex', justifyContent: 'space-between' }}
                  >
                    <span style={{ fontSize: fs(12), color: TEXT }}>{candidate.filename}</span>
                    <span style={{ fontSize: fs(11), color: MUTED }}>{formatBytes(candidate.sizeBytes)}</span>
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
                style={{ ...BUTTON, marginTop: sp(12) }}
              >
                {busy ? text.cleaning : fill(text.confirm, { count: preview.unreferenced.length })}
              </button>
              <div style={{ fontSize: fs(11), color: MUTED, marginTop: sp(6) }}>{text.confirmHint}</div>
            </>
          )}
        </div>
      )}

      {cleaned === null ? null : (
        <div data-testid="backup-gc-status" style={{ fontSize: fs(12), color: MUTED, marginTop: sp(12) }}>
          {fill(text.cleaned, { count: cleaned.count, bytes: formatBytes(cleaned.bytes) })}
        </div>
      )}
      {error === null ? null : (
        <div data-testid="backup-gc-error" style={{ fontSize: fs(12), color: DANGER, marginTop: sp(12) }}>
          {text.failed}：{errorText(error)}
        </div>
      )}

      {/* ── T28 快照列表 / 立即快照 / 恢复 ── */}
      <div data-testid="backup-snapshots" style={SECTION_TITLE}>{text.snapshots}</div>
      <button
        type="button"
        data-testid="backup-snapshot-now"
        disabled={snapshotsDisabled || snapshotBusy}
        onClick={runSnapshot}
        style={{ ...BUTTON, color: snapshotsDisabled ? MUTED : INDIGO, borderColor: snapshotsDisabled ? BORDER : INDIGO }}
      >
        {snapshotBusy ? text.snapshotting : text.snapshotNow}
      </button>
      <div style={{ fontSize: fs(11), color: MUTED, marginTop: sp(6) }}>{text.snapshotHint}</div>

      {snapshotList.length === 0 ? (
        <div style={{ fontSize: fs(12), color: MUTED, marginTop: sp(10) }}>{text.snapshotEmpty}</div>
      ) : (
        <div data-testid="backup-snapshot-list" style={{ display: 'flex', flexDirection: 'column', gap: sp(6), marginTop: sp(10) }}>
          {snapshotList.map((snapshot) => (
            <div
              key={snapshot.id}
              data-testid={`backup-snapshot-item-${snapshot.id}`}
              style={{ ...ROW, display: 'flex', flexDirection: 'column', gap: sp(4) }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: fs(12), color: TEXT }}>{formatTime(snapshot.createdAt)}</span>
                <span style={{ fontSize: fs(11), color: MUTED }}>
                  {formatBytes(snapshot.sizeBytes)} · {fill(text.taskCount, { count: snapshot.taskCount })}
                </span>
              </div>
              {restoreConfirmId === snapshot.id ? (
                <div style={{ display: 'flex', gap: sp(8), marginTop: sp(4) }}>
                  <button
                    type="button"
                    data-testid="backup-snapshot-restore-confirm"
                    disabled={restoring}
                    onClick={() => runRestore(snapshot.id)}
                    style={BUTTON}
                  >
                    {restoring ? text.restoring : text.restoreConfirmAction}
                  </button>
                  <button
                    type="button"
                    data-testid="backup-snapshot-restore-cancel"
                    disabled={restoring}
                    onClick={() => setRestoreConfirmId(null)}
                    style={GHOST}
                  >
                    {text.cancel}
                  </button>
                  <div style={{ fontSize: fs(11), color: MUTED, alignSelf: 'center' }}>{text.restoreConfirm}</div>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid={`backup-snapshot-restore-${snapshot.id}`}
                  disabled={restoring}
                  onClick={() => setRestoreConfirmId(snapshot.id)}
                  style={{ ...GHOST, marginTop: sp(4), alignSelf: 'flex-start' }}
                >
                  {text.restore}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {snapshotError === null ? null : (
        <div data-testid="backup-snapshot-error" style={{ fontSize: fs(12), color: DANGER, marginTop: sp(10) }}>
          {text.failed}：{errorText(snapshotError)}
        </div>
      )}
      {restored ? (
        <div data-testid="backup-snapshot-restored" style={{ fontSize: fs(12), color: MUTED, marginTop: sp(10) }}>
          {text.restored}
        </div>
      ) : null}

      {/* ── T28 导出库副本 ── */}
      <div style={SECTION_TITLE}>{text.export}</div>
      <button
        type="button"
        data-testid="backup-export"
        disabled={exporterDisabled || exportBusy}
        onClick={runExport}
        style={{ ...BUTTON, color: exporterDisabled ? MUTED : INDIGO, borderColor: exporterDisabled ? BORDER : INDIGO }}
      >
        {exportBusy ? text.exporting : text.export}
      </button>
      {exportResult === null ? null : (
        <div data-testid="backup-export-result" style={{ fontSize: fs(12), color: MUTED, marginTop: sp(8) }}>
          {fill(text.exported, { files: exportResult.files, bytes: formatBytes(exportResult.bytes) })}
        </div>
      )}
      {exportError === null ? null : (
        <div data-testid="backup-export-error" style={{ fontSize: fs(12), color: DANGER, marginTop: sp(8) }}>
          {text.failed}：{errorText(exportError)}
        </div>
      )}

      {/* ── T28 导入 ── */}
      <div style={SECTION_TITLE}>{text.import}</div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        data-testid="backup-import-file-input"
        style={{ display: 'none' }}
        onChange={onFileChosen}
      />
      {importPreviewVault === null ? (
        <div style={{ display: 'flex', gap: sp(8) }}>
          <button
            type="button"
            data-testid="backup-import-file"
            disabled={importerDisabled || importBusy}
            onClick={() => fileInputRef.current?.click()}
            style={{ ...BUTTON, color: importerDisabled ? MUTED : INDIGO, borderColor: importerDisabled ? BORDER : INDIGO }}
          >
            {text.importFile}
          </button>
          <button
            type="button"
            data-testid="backup-import-dir"
            disabled={importerDisabled || importBusy}
            onClick={runImportDir}
            style={{ ...BUTTON, color: importerDisabled ? MUTED : INDIGO, borderColor: importerDisabled ? BORDER : INDIGO }}
          >
            {text.importDir}
          </button>
        </div>
      ) : (
        <div data-testid="backup-import-preview" style={{ marginTop: sp(8) }}>
          <div style={{ fontSize: fs(12), color: TEXT }}>
            {fill(text.importPreview, {
              tasks: importPreviewVault.tasks.length,
              milestones: importPreviewVault.milestones.length,
              assets: importPreviewVault.assets.length,
            })}
          </div>
          <div style={{ display: 'flex', gap: sp(8), marginTop: sp(10) }}>
            <button
              type="button"
              data-testid="backup-import-confirm"
              disabled={onImported === undefined}
              onClick={confirmImport}
              style={BUTTON}
            >
              {fill(text.importConfirm, { tasks: currentTaskCount ?? 0 })}
            </button>
            <button
              type="button"
              data-testid="backup-import-cancel"
              onClick={() => setImportPreviewVault(null)}
              style={GHOST}
            >
              {text.cancel}
            </button>
          </div>
          <div style={{ fontSize: fs(11), color: MUTED, marginTop: sp(6) }}>{text.importConfirmHint}</div>
        </div>
      )}
      {importBusy ? (
        <div style={{ fontSize: fs(12), color: MUTED, marginTop: sp(8) }}>{text.importing}</div>
      ) : null}
      {importError === null ? null : (
        <div data-testid="backup-import-error" style={{ fontSize: fs(12), color: DANGER, marginTop: sp(8) }}>
          {text.failed}：{errorText(importError)}
        </div>
      )}
      {imported ? (
        <div data-testid="backup-import-status" style={{ fontSize: fs(12), color: MUTED, marginTop: sp(8) }}>
          {text.imported}
        </div>
      ) : null}
      </div>
    </div>
  )
}

export default BackupPanel
