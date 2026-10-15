// 中文消息表是键名的事实源：en.ts 用 NestedKeyOf<typeof zh> 约束，缺翻译即编译失败。
// 键集合锁定自 spec 附录 A；新增键只在视图真正需要时加，四状态等译名不得改动。

export type NestedKeyOf<T> = T extends object
  ? { [K in keyof T & string]: T[K] extends object ? `${K}.${NestedKeyOf<T[K]>}` : K }[keyof T & string]
  : never

export const zh = {
  status: {
    todo: '待办',
    doing: '进行中',
    review: '评审中',
    done: '已完成',
  },
  topic: '话题',
  milestone: '里程碑',
  dependency: '依赖',
  criticalPath: '关键路径',
  baseline: '基线',
  vault: '数据库',
  workday: '工作日',
  workweek: '工作周',
} as const

export type MsgKey = NestedKeyOf<typeof zh>
