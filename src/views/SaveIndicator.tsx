// SaveIndicator：顶栏常驻的保存指示（spec 6.3 / 8.2），三态 已保存 / 未保存 / 保存失败(重试)。
//
// 只依赖控制器的三个面（subscribe / getState / retry），因此既能挂在真的 Autosave 上，
// 也能在组件测试里用最小假源驱动三态；重试按钮只在 error 态出现。

import { useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'

import type { SaveState } from '../persistence/autosave'
import type { MsgKey } from '../locales/i18n'
import { fs, sp, px } from '../styles/scale'

export interface SaveIndicatorSource {
  subscribe(listener: () => void): () => void
  getState(): SaveState
  retry(): Promise<void>
}

const MUTED = 'var(--oe-text-muted)'
const INDIGO = 'var(--oe-accent)'
const DANGER = 'var(--oe-overdue)'

/** 语义色只借用了逾期红这一处既有约定（spec 8.2 明写失败态为红色）。 */
const COLOR: Record<SaveState, string> = {
  saved: MUTED,
  dirty: INDIGO,
  error: DANGER,
}

export function SaveIndicator(props: {
  autosave: SaveIndicatorSource
  t: (key: MsgKey) => string
  /**
   * 测试锚点，默认 `save-indicator`（顶栏那一处）。
   * 任务弹窗里也挂了一个同类指示（T52），必须换一个名字——同一份 DOM 里出现两个
   * `save-indicator` 会让所有「等保存收敛」的 e2e 断言变成 strict mode 冲突。
   */
  testId?: string
  /**
   * 是否作为 live region 播报。顶栏常驻那处是 true；弹窗里的副本传 false ——
   * 同一状态两处播报等于对读屏用户重复念一遍。
   */
  live?: boolean
  style?: CSSProperties
}) {
  const { autosave, t } = props
  const state = useSyncExternalStore(autosave.subscribe, autosave.getState)

  return (
    <div
      role={props.live === false ? undefined : 'status'}
      data-testid={props.testId ?? 'save-indicator'}
      data-state={state}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: sp(6),
        fontSize: fs(12),
        lineHeight: px('20px'),
        color: COLOR[state],
        ...props.style,
      }}
    >
      <span>{t(`save.${state}`)}</span>
      {state === 'error' ? (
        <button
          type="button"
          onClick={() => {
            void autosave.retry()
          }}
          style={{
            padding: px('0 8px'),
            fontSize: fs(12),
            lineHeight: px('18px'),
            color: DANGER,
            background: 'var(--oe-surface)',
            border: `1px solid ${DANGER}`,
            borderRadius: 'var(--oe-radius-control)',
            cursor: 'pointer',
          }}
        >
          {t('save.retry')}
        </button>
      ) : null}
    </div>
  )
}
