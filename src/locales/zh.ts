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
  startup: {
    connectTitle: '连接数据文件夹',
    connectHint: 'OffEarly 的数据全部保存在你选定的文件夹里：vault.json 是你的数据库，assets/ 存放图片，.backup/ 存放快照。',
    connectButton: '选择文件夹',
    permissionTitle: '需要重新授权',
    permissionHint: '浏览器已记住你的数据文件夹，但写入权限需要一次点击确认。',
    permissionButton: '授权并继续',
    createTitle: '在此创建新库？',
    createHint: '这个文件夹里还没有 vault.json。确认后会在其中初始化一个新的空数据库。',
    createConfirm: '创建数据库',
    createCancel: '换个文件夹',
    busy: '正在读取数据库…',
    errorTitle: '无法打开数据文件夹',
    errorRetry: '重新选择',
    safeModeTitle: '只读安全模式',
    safeModeHint: 'vault.json 无法通过校验，已停止写入以保护数据。恢复入口随备份功能提供。',
  },
  board: {
    emptyColumn: '暂无任务',
  },
  save: {
    saved: '已保存',
    dirty: '未保存',
    error: '保存失败',
    retry: '重试',
  },
  // T14 追加：topic 侧栏（尾部追加，不改动既有键）
  sidebar: {
    topics: '话题',
    newTopic: '新建话题',
    newSubtopic: '新建子话题',
    rename: '重命名',
    changeColor: '改色',
    archive: '归档',
    unarchive: '取消归档',
    showArchived: '显示已归档',
    hideArchived: '隐藏已归档',
    milestones: '里程碑',
    filters: '筛选器',
    backup: '备份',
    settings: '设置',
    untitled: '未命名话题',
    newTopicPlaceholder: '话题名称',
  },
} as const

export type MsgKey = NestedKeyOf<typeof zh>
