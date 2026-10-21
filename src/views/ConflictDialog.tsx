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
import { fs, sp, px } from '../styles/scale'

const BORDER = 'var(--oe-border)'
const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'
const INDIGO = 'var(--oe-accent)'
const AMBER = 'var(--oe-blocked)'

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
  width: sp(420),
  padding: px('20px 24px'),
  background: 'var(--oe-surface)',
  border: '1px solid var(--oe-separator)',
  borderRadius: 'var(--oe-radius-overlay)',
  boxShadow: 'var(--oe-shadow-pop)',
}

const BUTTON: CSSProperties = {
  padding: px('6px 14px'),
  fontSize: fs(13),
  background: 'var(--oe-surface)',
  border: `1px solid ${BORDER}`,
  borderRadius: 'var(--oe-radius-control)',
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
        // T36：任务详情改为居中弹窗（z-25）后，这个「保存被挡下」的弹窗必须压在它之上，
        // 否则用户在弹窗里按 Ctrl+S 会把冲突三选关在遮罩后面（看不见也点不到）。
        // 取 70 高于灯箱（z-60）——冲突未裁决前它是全局唯一的可交互面。
        zIndex: 70,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--oe-scrim)',
      }}
    >
      <div style={PANEL}>
        <div style={{ fontSize: fs(15), fontWeight: 600, color: TEXT }}>{text.title}</div>
        <div style={{ fontSize: fs(12), color: MUTED, marginTop: sp(8), lineHeight: 1.7 }}>
          {text.hint}
        </div>
        <div
          data-testid="conflict-drop-warning"
          style={{ fontSize: fs(12), color: AMBER, marginTop: sp(8), lineHeight: 1.7 }}
        >
          {fill(text.droppedWarning, report.droppedTaskCount)}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: sp(8), marginTop: sp(16) }}>
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
          <div data-testid="conflict-status" style={{ fontSize: fs(12), color: MUTED, marginTop: sp(12) }}>
            {text.busy}
          </div>
        )}
        {done && pending === null && error === null ? (
          <div data-testid="conflict-status" style={{ fontSize: fs(12), color: MUTED, marginTop: sp(12) }}>
            {text.resolved}
          </div>
        ) : null}
        {error === null ? null : (
          <div data-testid="conflict-error" style={{ fontSize: fs(12), color: 'var(--oe-overdue)', marginTop: sp(12) }}>
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
      <div style={{ fontSize: fs(11), color: MUTED, marginTop: sp(4) }}>{props.hint}</div>
    </div>
  )
}

export default ConflictDialog
