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

/**
 * T69 · 白板：自由画布（架构图 / 流程图 / 框架梳理）。
 *
 * 与思维导图的区别是「谁决定位置」：导图的坐标由 domain/mindmapModel 算出来，数据里只有树；
 * 白板的坐标是**用户摆的**，必须原样存进数据。所以节点带 x/y/width/height，边带两端 id 与锚点。
 *
 * 形状是枚举而不是任意 path：白板要能被导出、能被键盘操作、能在不同缩放档下保持清晰，
 * 自由笔迹会把这三件事一起拖垮。用户需要「典型的图」，枚举比画笔更贴合。
 */
export type WhiteboardShape = 'rect' | 'round' | 'ellipse' | 'diamond' | 'note' | 'text' | 'frame'

/**
 * 色调走令牌名而不是 hex：主题一变，画布跟着变（与 T45「零新增 hex」同一条红线）。
 * `plain` 是中性白底；`muted` 用于渐隐的辅助说明；其余四档对应语义色。
 */
export type WhiteboardTone = 'plain' | 'accent' | 'ok' | 'warn' | 'danger' | 'muted'

/** 连线端点：`auto` 按两端中心的相对方位选最近的边中点，其余四值钉死在指定边。 */
export type WhiteboardAnchor = 'auto' | 'top' | 'right' | 'bottom' | 'left'

/** 走线：正交折线（架构图/流程图）或直线（关系图）。 */
export type WhiteboardRoute = 'ortho' | 'straight'

/** 箭头位置：末端 / 双向 / 无。 */
export type WhiteboardArrow = 'end' | 'both' | 'none'

export interface WhiteboardNode {
  id: string
  shape: WhiteboardShape
  /** 内容坐标，左上角；frame 与 note 也是左上角 */
  x: number
  y: number
  width: number
  height: number
  text: string
  tone: WhiteboardTone
  /**
   * 自定义填充色（小写 `#rrggbb`）。缺省表示「用 tone 的语义色」。
   * 有值时**覆盖** tone：屏幕与导出都只认它。文本图元上它是字色。
   */
  fill?: string
}

export interface WhiteboardEdge {
  id: string
  from: string
  to: string
  fromAnchor: WhiteboardAnchor
  toAnchor: WhiteboardAnchor
  route: WhiteboardRoute
  arrow: WhiteboardArrow
  dashed: boolean
  /** 线上标签；空串表示不画 */
  label: string
}

export interface Whiteboard {
  id: string
  name: string
  /** 多张白板之间的排序键，复用 domain/lexorank.mid */
  order: string
  nodes: WhiteboardNode[]
  edges: WhiteboardEdge[]
  createdAt: string
  updatedAt: string
}

/** 白板自身的可改字段（标题 / 排序 / 刷新时间戳）；节点与边各有自己的 patch。 */
export type WhiteboardPatch = Partial<Pick<Whiteboard, 'name' | 'order' | 'updatedAt'>>
export type WhiteboardNodePatch = Partial<
  Pick<WhiteboardNode, 'x' | 'y' | 'width' | 'height' | 'text' | 'shape' | 'tone'>
> & {
  /**
   * 自定义色。`null` 是**明确的「清除」**（回到 tone），不是 `undefined`：
   * 撤销栈要让「选了色 → 清除」与「本来就没色」两个状态可区分，否则逆元无法表达清除。
   */
  fill?: string | null
}
export type WhiteboardEdgePatch = Partial<
  Pick<WhiteboardEdge, 'fromAnchor' | 'toAnchor' | 'route' | 'arrow' | 'dashed' | 'label'>
>

/**
 * T49 · 笔记本（知识库）：一个库里可以有多个笔记本，每个笔记本下是一棵文档树。
 * 与思维导图同属「用户内容」，但仍住在 vault.json 里——备份、冲突保护、导出都天然覆盖。
 */
export interface Notebook {
  id: string
  name: string
  /** 笔记本之间的排序键，复用 domain/lexorank.mid */
  order: string
  createdAt: string
  updatedAt: string
}

/**
 * T49 · 知识库文档：`content` 与 `Task.note` 同口径，永远存 Markdown 纯文本。
 * `parentId` 构成文档树（null = 知识库顶层），`order` 只在其兄弟之间比较。
 */
export interface NoteDoc {
  id: string
  notebookId: string
  parentId: string | null
  title: string
  content: string
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

/**
 * T64 · 回收站条目。
 *
 * 为什么是独立数组而不是在 Task / NoteDoc 上加 `deletedAt`：全库有十几处读路径（看板、
 * 甘特、搜索、文档树、导入去重、引用扫描…），软删除要求每一处都过滤，漏一处已删内容就会
 * 「复活」；而独立数组只有一个读路径（回收站面板），删除就是删除。
 *
 * 条目自带 id 与 deletedAt，并**冻结删除那一刻的全部内容**：任务条目带完整 Task 与当时被
 * 连带摘掉的依赖，文档条目带整棵子树。恢复因此不需要任何外部快照，也不依赖「删除时还剩什么」。
 */
export interface TrashTaskEntry {
  id: string
  kind: 'task'
  deletedAt: string
  /** 删除时在 vault.tasks 里的下标（恢复时尽量回到原位；越界则夹到末尾）。 */
  index: number
  task: Task
  /** 删除任务时被连带摘掉的依赖，各带原下标（与 task.restore 同口径）。 */
  links: { link: Dependency; index: number }[]
}

export interface TrashDocEntry {
  id: string
  kind: 'doc'
  deletedAt: string
  /** 被删的那一篇（子树的根）；恢复后定位与提示都用它。 */
  rootId: string
  /** 整棵子树，各带原下标（升序插回即可精确复原顺序）。 */
  docs: { doc: NoteDoc; index: number }[]
}

export type TrashEntry = TrashTaskEntry | TrashDocEntry

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

/** 笔记正文字号的档位边界（设计稿 px，最终由界面尺度换算成 CSS px）。 */
export const NOTE_FONT_SIZE_MIN = 12
export const NOTE_FONT_SIZE_MAX = 20
export const NOTE_FONT_SIZE_DEFAULT = 13

// spec 4.2 注释里点名的六项：看板列定义、工作日历、甘特图默认刻度、主题、locale、lastFilter
export interface Settings {
  boardColumns: Status[]
  calendar: WorkCalendar
  ganttScale: GanttScale
  theme: 'light'
  locale: LocaleSetting
  lastFilter: Filter | null
  /**
   * T50 · 笔记正文基准字号（px，设计稿口径）。任务笔记与知识库文档共用同一个值——
   * 它们是同一个编辑器，各存一份只会让「同一段文字在两处不一样大」变成常态。
   */
  noteFontSize: number
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
  /** T49：知识库。旧库缺键由 schema 补空数组，schemaVersion 不升、不注册迁移。 */
  notebooks: Notebook[]
  noteDocs: NoteDoc[]
  /**
   * T64：回收站。同样「旧库缺键补空数组」——磁盘上的旧 vault.json 原样能打开。
   * 键序排在 noteDocs 之后，save 的键序约定不变。
   */
  trash: TrashEntry[]
  /**
   * T69：白板。同样是「旧库缺键补空数组」——键序排在 trash 之后，save 的键序约定不变。
   */
  whiteboards: Whiteboard[]
}
