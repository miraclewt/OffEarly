// T70 · 语义色的屏幕侧呈现。
//
// 单独一个文件是为了让「画布」与「调色板」用同一份色表：调色板里的预设色块必须与画出来
// 的框长得一样，否则用户点了「警告」却得到另一种黄。这正是 T69 里两套配色（屏幕用令牌、
// 导出用字面量）留下的教训——同一件事只能有一处定义。
//
// 自定义色不在这里：它是用户数据，走 domain/whiteboardModel 的 resolveNodePaint。

import type { WhiteboardTone } from '../domain/types'

export interface WhiteboardTonePaint {
  background: string
  border: string
  color: string
}

/** 语义色 → CSS（全部走 theme.css 令牌，深浅主题自动跟随）。 */
export function tonePaint(tone: WhiteboardTone): WhiteboardTonePaint {
  switch (tone) {
    case 'accent':
      return { background: 'var(--oe-accent-tint)', border: 'var(--oe-accent)', color: 'var(--oe-accent-deep)' }
    case 'ok':
      return { background: 'var(--oe-whiteboard-ok-bg)', border: 'var(--oe-done)', color: 'var(--oe-text)' }
    case 'warn':
      return { background: 'var(--oe-whiteboard-warn-bg)', border: 'var(--oe-blocked-border)', color: 'var(--oe-blocked)' }
    case 'danger':
      return { background: 'var(--oe-whiteboard-danger-bg)', border: 'var(--oe-overdue)', color: 'var(--oe-overdue)' }
    case 'muted':
      return { background: 'var(--oe-fill-subtle)', border: 'var(--oe-border)', color: 'var(--oe-text-muted)' }
    default:
      return { background: 'var(--oe-surface)', border: 'var(--oe-border)', color: 'var(--oe-text)' }
  }
}

/** 调色板里预设色块的显示顺序：中性色打头，其余按「从常用到少见」。 */
export const TONE_ORDER: readonly WhiteboardTone[] = ['plain', 'muted', 'accent', 'ok', 'warn', 'danger']
