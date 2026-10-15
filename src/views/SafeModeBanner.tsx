// SafeModeBanner（T29）：只读安全模式的顶部横幅（spec 8.5）。
//
// 分层：纯视图 —— 只渲染原因/快照信息 + 转发三个动作，零文件系统、零 CommandBus 依赖。
// 「恢复此快照」「导出当前」的实际动作由 vaultRepository 的 createSelfHealingLoader 提供；
// 「选择其他备份」**只做回调 props**：打开备份面板（BackupPanel）是 T28 的活，
// 本组件刻意不 import 尚不存在的组件，装配由集成车道在 App.tsx 完成。
//
// 文案不写进 src/locales/*（本轮车窗不碰该目录），故自带中文兜底并开放 labels 覆盖位。

import { useState } from 'react'
import type { CSSProperties } from 'react'

import type { SafeModeSnapshotRef } from '../persistence/vaultRepository'

const AMBER_BG = 'var(--oe-blocked-bg)'
const AMBER_BORDER = 'var(--oe-blocked-border)'
const AMBER_TEXT = 'var(--oe-blocked)'
const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'

export interface SafeModeLabels {
  title: string
  hint: string
  /** 当前载入的快照行前缀，`{id}` / `{count}` 会被替换。 */
  snapshotLine: string
  noSnapshot: string
  restore: string
  restoreHint: string
  chooseOther: string
  chooseOtherHint: string
  exportCurrent: string
  exportCurrentHint: string
  busy: string
  failed: string
  resolved: string
}

export const SAFE_MODE_LABELS_ZH: SafeModeLabels = {
  title: '只读安全模式',
  hint: 'vault.json 无法解析或校验未通过，已停止写入以保护数据。当前显示的是最近可用的快照。',
  snapshotLine: '当前快照：{id}（{count} 个任务）',
  noSnapshot: '当前没有可用快照，请选择其他备份',
  restore: '恢复此快照',
  restoreHint: '覆盖 vault.json（当前文件会先备份到 .backup/）',
  chooseOther: '选择其他备份',
  chooseOtherHint: '从备份列表中另选一份',
  exportCurrent: '导出当前',
  exportCurrentHint: '把正在看的内容另存为独立文件',
  busy: '正在处理…',
  failed: '处理失败',
  resolved: '已处理',
}

function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) =>
    key in params ? String(params[key]) : `{${key}}`,
  )
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const BUTTON: CSSProperties = {
  padding: '4px 12px',
  fontSize: 12,
  background: 'var(--oe-surface)',
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
  cursor: 'pointer',
}

export interface SafeModeBannerProps {
  /** 磁盘失败原因（VaultValidationError 的消息或展开的 issues）。 */
  reason: string
  /** 当前只读视图命中的快照；null 表示没有可用快照。 */
  snapshot: SafeModeSnapshotRef | null
  onRestore: () => void | Promise<void>
  /** 只做回调：打开备份面板由集成车道处理（T28）。 */
  onChooseOther: () => void | Promise<void>
  onExportCurrent: () => void | Promise<void>
  /** 覆盖文案（接 locales 用）；未覆盖的键取中文兜底。 */
  labels?: Partial<SafeModeLabels>
}

export function SafeModeBanner(props: SafeModeBannerProps) {
  const { reason, snapshot } = props
  const text: SafeModeLabels = { ...SAFE_MODE_LABELS_ZH, ...props.labels }
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState(false)

  function run(which: string, action: () => void | Promise<void>) {
    if (pending !== null) return
    setPending(which)
    setError(null)
    void Promise.resolve()
      .then(action)
      .then(() => {
        setDone(true)
      })
      .catch((e: unknown) => {
        setError(e)
      })
      .finally(() => {
        setPending(null)
      })
  }

  const busy = pending !== null

  return (
    <div
      role="alert"
      data-testid="safe-mode-banner"
      data-snapshot={snapshot?.id ?? ''}
      data-state={busy ? 'busy' : error !== null ? 'error' : 'idle'}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        background: AMBER_BG,
        borderBottom: `1px solid ${AMBER_BORDER}`,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 260, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: AMBER_TEXT }}>{text.title}</div>
        <div style={{ color: MUTED, lineHeight: 1.6 }}>{text.hint}</div>
        <div data-testid="safe-mode-reason" style={{ color: AMBER_TEXT, lineHeight: 1.6 }}>
          {reason}
        </div>
        <div data-testid="safe-mode-snapshot" style={{ color: MUTED }}>
          {snapshot === null
            ? text.noSnapshot
            : fill(text.snapshotLine, { id: snapshot.id, count: snapshot.taskCount })}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          type="button"
          data-testid="safe-mode-restore"
          disabled={busy || snapshot === null}
          onClick={() => {
            run('restore', props.onRestore)
          }}
          style={{ ...BUTTON, fontWeight: 600, color: AMBER_TEXT, borderColor: AMBER_BORDER }}
        >
          {text.restore}
        </button>
        <span style={{ fontSize: 11, color: MUTED }}>{text.restoreHint}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          type="button"
          data-testid="safe-mode-choose-other"
          disabled={busy}
          onClick={() => {
            run('chooseOther', props.onChooseOther)
          }}
          style={{ ...BUTTON, color: TEXT }}
        >
          {text.chooseOther}
        </button>
        <span style={{ fontSize: 11, color: MUTED }}>{text.chooseOtherHint}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          type="button"
          data-testid="safe-mode-export"
          disabled={busy}
          onClick={() => {
            run('export', props.onExportCurrent)
          }}
          style={{ ...BUTTON, color: TEXT }}
        >
          {text.exportCurrent}
        </button>
        <span style={{ fontSize: 11, color: MUTED }}>{text.exportCurrentHint}</span>
      </div>

      {busy ? (
        <div data-testid="safe-mode-status" style={{ color: MUTED }}>
          {text.busy}
        </div>
      ) : null}
      {done && !busy && error === null ? (
        <div data-testid="safe-mode-status" style={{ color: MUTED }}>
          {text.resolved}
        </div>
      ) : null}
      {error === null ? null : (
        <div data-testid="safe-mode-error" style={{ color: 'var(--oe-overdue)' }}>
          {text.failed}：{errorText(error)}
        </div>
      )}
    </div>
  )
}

export default SafeModeBanner
