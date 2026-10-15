import type { MsgKey } from './zh'

// 扁平的点号键：类型是 Record<MsgKey, string>，少一条翻译或键名打错都会在 tsc 阶段报错。
export const en: Record<MsgKey, string> = {
  'status.todo': 'To Do',
  'status.doing': 'In Progress',
  'status.review': 'In Review',
  'status.done': 'Done',
  topic: 'Topic',
  milestone: 'Milestone',
  dependency: 'Dependency',
  criticalPath: 'Critical Path',
  baseline: 'Baseline',
  vault: 'Vault',
  workday: 'Workday',
  workweek: 'Workweek',
}
