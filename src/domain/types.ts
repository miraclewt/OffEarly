// 领域类型契约：与 spec 4.2 / 6.2 逐字段一致。
// 这里是全部领域代码的事实源；schema.ts 只做运行时镜像，不得反向定义类型。

export const CURRENT_SCHEMA_VERSION = 1

export type Status = 'todo' | 'doing' | 'review' | 'done'
export type Kind = 'feature' | 'bug' | 'chore' | 'research' | 'doc'
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'
export type GanttScale = 'day' | 'week'
export type LocaleSetting = 'zh' | 'en' | 'auto'

export interface WorkCalendar {
  workdays: number[]
  holidays: string[]
  extraWorkdays: string[]
}

export interface Topic {
  id: string
  name: string
  color: string
  parentId: string | null
  order: string
  archived: boolean
}

export interface TaskBaseline {
  start?: string
  due?: string
}

export interface Task {
  id: string
  topicId: string
  title: string
  status: Status
  kind: Kind
  priority: Priority
  assignee?: string
  start?: string
  due?: string
  estimateHours?: number
  progress: number
  tags: string[]
  note: string
  baseline?: TaskBaseline
  order: string
  createdAt: string
  updatedAt: string
  archived: boolean
}

export interface Dependency {
  id: string
  from: string
  to: string
  type: DependencyType
  lagDays: number
  note?: string
}

export interface Milestone {
  id: string
  topicId: string | null
  title: string
  date: string
  done: boolean
  color?: string
  note?: string
}

export interface MindNode {
  id: string
  text: string
  /** 兄弟排序键，复用 domain/lexorank.mid */
  order: string
  /** 折叠：子树暂时隐藏但保留 */
  folded: boolean
  children: MindNode[]
}

export interface MindMap {
  id: string
  name: string
  root: MindNode
  /** 多张图之间的列表排序键 */
  order: string
  createdAt: string
  updatedAt: string
}

export interface Asset {
  id: string
  filename: string
  sizeBytes: number
  createdAt: string
}

export interface FilterDateRange {
  from?: string
  to?: string
}

export interface Filter {
  topicIds: string[]
  includeDescendants: boolean
  statuses: Status[]
  kinds: Kind[]
  priorities: Priority[]
  tags: string[]
  tagMode: 'any' | 'all'
  assignees: string[]
  dateRange?: FilterDateRange
  overdueOnly?: boolean
  blockedOnly?: boolean
  withNotesOnly?: boolean
  includeArchived?: boolean
  text?: string
  upstreamDepth?: number
  downstreamDepth?: number
}

// spec 4.2 注释里点名的六项：看板列定义、工作日历、甘特图默认刻度、主题、locale、lastFilter
export interface Settings {
  boardColumns: Status[]
  calendar: WorkCalendar
  ganttScale: GanttScale
  theme: 'light'
  locale: LocaleSetting
  lastFilter: Filter | null
}

export interface Vault {
  schemaVersion: 1
  vaultId: string
  appVersion: string
  revision: number
  updatedAt: string
  settings: Settings
  topics: Topic[]
  tasks: Task[]
  milestones: Milestone[]
  links: Dependency[]
  assets: Asset[]
  mindmaps: MindMap[]
}
