// ConflictDialog（T27）：多端 revision 冲突的三选弹窗（spec 8.3）。
//
// 分层：本组件是纯视图 —— 只渲染数字与文案、把点击转发给 props，
// 一行文件系统代码都没有（spec 3 硬规则 1）。三条出路各自要做什么由
// vaultRepository 的 createConflictGuard 提供，集成车道（App.tsx）接线。
//
// 文案不写进 src/locales/*（本轮车窗不碰该目录），故自带中文兜底并开放
// labels 覆盖位：集成车道接 locales 时传 labels 即可，组件本身无需改动。

import { useState } from 'react'
import type { CSSProperties } from 'react'

import type { ConflictReport } from '../persistence/vaultRepository'

const BORDER = '#E5E7EB'
const TEXT = '#111827'
const MUTED = '#6B7280'
const INDIGO = '#4F46E5'
const AMBER = '#B45309'

export interface ConflictLabels {
  title: string
  hint: string
  /** 会丢掉的本地任务条数提示；`{n}` 为条数。 */
  droppedWarning: string
  keepMine: string
  takeDisk: string
  exportCopy: string
  keepMineHint: string
  takeDiskHint: string
  exportCopyHint: string
  busy: string
  failed: string
  resolved: string
}

export const CONFLICT_LABELS_ZH: ConflictLabels = {
  title: '文件已被另一端修改',
  hint: '磁盘上的 vault.json 版本比当前内存版本更新，请选择如何处理。',
  droppedWarning: '选择「以磁盘为准」会丢掉本地 {n} 条未同步的任务。',
  keepMine: '以我为准',
  takeDisk: '以磁盘为准',
  exportCopy: '导出我的副本',
  keepMineHint: '磁盘旧版会先备份到 .backup/，之后可回滚',
  takeDiskHint: '放弃本地未保存的改动',
  exportCopyHint: '先存下我的版本再载入磁盘版，便于手动合并',
  busy: '正在处理…',
  failed: '处理失败',
  resolved: '已处理，正在载入…',
}

/** `{n}` 插值：与 locales 的 interpolate 同语义，但本组件不依赖消息表。 */
function fill(template: string, n: number): string {
  return template.replace(/\{n\}/g, String(n))
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const PANEL: CSSProperties = {
  width: 420,
  padding: '20px 24px',
  background: '#FFFFFF',
  border: `1px solid ${BORDER}`,
  borderRadius: 12,
}

const BUTTON: CSSProperties = {
  padding: '6px 14px',
  fontSize: 13,
  background: '#FFFFFF',
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  cursor: 'pointer',
}

export interface ConflictDialogProps {
  report: ConflictReport
  onKeepMine: () => void | Promise<void>
  onTakeDisk: () => void | Promise<void>
  onExportCopy: () => void | Promise<void>
  /** 覆盖文案（接 locales 用）；未覆盖的键取中文兜底。 */
  labels?: Partial<ConflictLabels>
}

export function ConflictDialog(props: ConflictDialogProps) {
  const { report, labels } = props
  const text: ConflictLabels = { ...CONFLICT_LABELS_ZH, ...labels }
  const [pending, setPending] = useState<null | 'mine' | 'disk' | 'export'>(null)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState(false)

  function run(which: 'mine' | 'disk' | 'export', action: () => void | Promise<void>) {
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={text.title}
      data-testid="conflict-dialog"
      data-disk-revision={report.diskRevision}
      data-state={pending !== null ? 'busy' : error !== null ? 'error' : 'idle'}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(17, 24, 39, 0.28)',
      }}
    >
      <div style={PANEL}>
        <div style={{ fontSize: 15, fontWeight: 600, color: TEXT }}>{text.title}</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 8, lineHeight: 1.7 }}>
          {text.hint}
        </div>
        <div
          data-testid="conflict-drop-warning"
          style={{ fontSize: 12, color: AMBER, marginTop: 8, lineHeight: 1.7 }}
        >
          {fill(text.droppedWarning, report.droppedTaskCount)}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
          <Choice
            testId="conflict-keep-mine"
            label={text.keepMine}
            hint={text.keepMineHint}
            disabled={pending !== null}
            onClick={() => {
              run('mine', props.onKeepMine)
            }}
          />
          <Choice
            testId="conflict-take-disk"
            label={text.takeDisk}
            hint={text.takeDiskHint}
            disabled={pending !== null}
            onClick={() => {
              run('disk', props.onTakeDisk)
            }}
          />
          <Choice
            testId="conflict-export-copy"
            label={text.exportCopy}
            hint={text.exportCopyHint}
            disabled={pending !== null}
            onClick={() => {
              run('export', props.onExportCopy)
            }}
          />
        </div>

        {pending === null ? null : (
          <div data-testid="conflict-status" style={{ fontSize: 12, color: MUTED, marginTop: 12 }}>
            {text.busy}
          </div>
        )}
        {done && pending === null && error === null ? (
          <div data-testid="conflict-status" style={{ fontSize: 12, color: MUTED, marginTop: 12 }}>
            {text.resolved}
          </div>
        ) : null}
        {error === null ? null : (
          <div data-testid="conflict-error" style={{ fontSize: 12, color: '#DC2626', marginTop: 12 }}>
            {text.failed}：{errorText(error)}
          </div>
        )}
      </div>
    </div>
  )
}

function Choice(props: {
  testId: string
  label: string
  hint: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <div>
      <button
        type="button"
        data-testid={props.testId}
        disabled={props.disabled}
        onClick={props.onClick}
        style={{
          ...BUTTON,
          fontWeight: 600,
          color: props.disabled ? MUTED : INDIGO,
          borderColor: props.disabled ? BORDER : INDIGO,
        }}
      >
        {props.label}
      </button>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{props.hint}</div>
    </div>
  )
}

export default ConflictDialog
