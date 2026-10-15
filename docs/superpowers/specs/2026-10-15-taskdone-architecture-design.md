# OffEarly（早下班）架构设计

| 项 | 值 |
|---|---|
| 产品名 | OffEarly（中文：早下班） |
| 文档版本 | v1.3 |
| 日期 | 2026-10-15 |
| 状态 | 设计已确认，按 `task.md` 分期实现中 |
| 交付边界 | 架构设计文档 + 分期实现（任务拆分与状态同步见 `task.md`） |
| 效果图 | `docs/design/01-board-layout.png` … `04-card-closeup-recommended.png` |

---

## 0. 摘要与硬约束

OffEarly（早下班）是一个**个人本地**的任务管理与项目进度追踪工具，集成 Jira 的依赖与筛选、Planner 的轻量看板、Obsidian 的本地文件与 Markdown、MS Project 的甘特图与排期引擎的核心优势。面向企业内网环境：**不联网、不登录、不装包**。

| # | 硬约束 | 来源 |
|---|---|---|
| C1 | 运行形态为单个 HTML 文件，双击即用 | 企业无安装包权限 |
| C2 | 全部 JS/CSS/图标内联，零网络请求 | 内网离线 |
| C3 | 无登录、无账号体系 | 个人本地工具 |
| C4 | 数据主体为单个 `vault.json` 明文文件 | 可读、可迁移、可同步 |
| C5 | UI 禁用 emoji，图标一律 inline SVG | 产品要求 |
| C6 | 界面简洁，克制信息密度 | 产品要求 |
| C7 | 支持中文 / 英文双语 | 产品要求 |
| C8 | 浏览器限定 Chromium 系（Edge / Chrome 86+） | File System Access API |

---

## 1. 决策记录（ADR 摘要）

| # | 决策 | 选择 | 否决的替代 | 理由 |
|---|---|---|---|---|
| D1 | 运行形态 | 单 HTML 双击运行 | 便携 exe / 本地服务 | 企业管控最宽松，零依赖 |
| D2 | 语言 | TypeScript 7（strict） | JavaScript / 其他 | 类型安全支撑 Schema 与迁移 |
| D3 | UI 框架 | React 19.3 | Vue / Preact / vanilla | 生态与复杂交互（拖拽、富文本）成熟 |
| D4 | 构建 | Vite 8 + `vite-plugin-singlefile` 2.3.3，`format:'iife'` | 零构建手写 / UMD 内联 | `file://` 下 ES module 被 CORS 拦截，必须单 IIFE bundle |
| D5 | 数据布局 | 数据文件夹：`vault.json` + `assets/` + `.backup/` | 纯单文件 base64 | 图片 base64 会使 JSON 膨胀至数十 MB，全量写盘与同步卡顿 |
| D6 | 文件读写 | File System Access API（`showDirectoryPicker`） | 手动导入导出 | 自动落盘，体验接近本地应用 |
| D7 | 甘特图 | 自研 SVG，只读投影 | gantt-task-react / vis-timeline / frappe-gantt | 现成 MIT 库在周/日刻度、里程碑、关键路径、基线、导出上均不达标；只读化后自研成本约 2 天 |
| D8 | 甘特图交互 | 只读（无拖拽改期），日期在详情抽屉改 | 拖拽改期 / 拖入排期 | 用户明确不需要拖拽；砍掉命中测试与拖拽预览一整类复杂度 |
| D9 | 状态枚举 | `todo / doing / review / done` 四列固定 | 五列含归档 / 自定义列 | 用户明确四态；归档降级为布尔 + 筛选维度 |
| D10 | 卡片话题标识 | 色点 + 话题名文本（C 方案） | 左色条 / 顶线 / 柔和底色 | 颜色可读（色盲/打印可用）、无边缘噪声、跨 topic 筛选免做颜色映射 |
| D11 | 笔记 | TipTap + `tiptap-markdown`，存 Markdown 纯文本 | CodeMirror 双栏 / textarea | 所见即所得贴合轻量交互，Markdown 快捷语法符合 Obsidian 习惯 |
| D12 | 图片 | sidecar 文件 `assets/<id>.<ext>`，note 中以相对路径引用 | base64 内嵌 | JSON 保持轻量；文件夹可被 Obsidian 直读 |
| D13 | 状态管理 | Zustand + CommandBus（命令模式） | Redux Toolkit | 轻量；命令模式天然支撑撤销/重做与单一写入口 |
| D14 | 拖拽（看板） | dnd-kit | react-dnd | 无障碍好、API 现代 |
| D15 | 日期库 | dayjs（isoWeek / weekday 插件） | date-fns / moment | 体积小，工作日计算够用 |
| D16 | 校验与迁移 | Zod | 手写校验 | 运行时 Schema + 类型推导一体 |
| D17 | i18n | 自写约 60 行 `t()` + 类型安全消息表 | i18next | 复数/命名空间对本项目冗余，省约 40KB |
| D18 | 多端同步 | 数据文件夹放 OneDrive / 共享盘 + revision 冲突检测 | 自建同步服务 | 零服务端；冲突弹窗三选兜底 |
| D19 | 测试 | Vitest（单元/组件）+ Playwright（`file://` E2E） | Jest / Cypress | Playwright 可在 `file://` 下真实启动 |

---

## 2. 借鉴能力映射

| 借鉴来源 | 核心优势 | 本项目落地能力 |
|---|---|---|
| Jira | 依赖关系与筛选 | Dependency 独立表（FS/SS/FF/SF + lag）、组合筛选、阻塞链上下游 N 跳遍历 |
| Planner | 轻量看板 | 拖拽换列、Topic 即 Bucket、卡片信息密度克制、列完成比 |
| Obsidian | 本地文件即数据、Markdown、双链 | 明文 JSON 数据文件夹、Markdown 笔记、`[[双向链接]]` 跳转、文件夹可被 Obsidian 直读 |
| MS Project | 排期引擎 | 甘特图、里程碑、工作日历、关键路径、基线（Baseline）对比 |

---

## 3. 分层架构与模块边界

```
┌──────────────────────────────────────────────────────────────┐
│ 视图层 views/         React 组件，只渲染 + 转发事件              │
│   BoardView · GanttView · TaskDrawer · TopicSidebar ·        │
│   FilterBar · BackupPanel · NoteEditor                       │
├──────────────────────────────────────────────────────────────┤
│ 编排层 controllers/   把 UI 事件翻译成领域命令                   │
│   boardDnd · ganttViewport · autosave · undoRedo · filters   │
├──────────────────────────────────────────────────────────────┤
│ 领域层 domain/        纯 TS，零 React / 零 DOM，可全量单测       │
│   VaultStore · CommandBus · ScheduleEngine · DependencyGraph │
│   TopicTree · QueryEngine                                    │
├──────────────────────────────────────────────────────────────┤
│ 持久化层 persistence/ 全项目唯一接触 File System API 的地方      │
│   VaultRepository · FsAccessAdapter · ImportExportAdapter ·  │
│   AssetStore · SnapshotStore · MigrationPipeline(Zod)        │
└──────────────────────────────────────────────────────────────┘
```

### 三条硬规则

1. **依赖只向下。** `domain/` 不 import `persistence/`；`views/` 不直接碰文件系统。排期算法、依赖图、筛选器可脱离浏览器做纯函数单测。
2. **所有写操作走 CommandBus。** 任何变更（拖拽换列、改日期、加依赖、贴图片）都构造为 `Command { type, payload, inverse }`，经 `CommandBus.apply()` → 更新 Store → 推入撤销栈 → 标记 dirty。撤销/重做、自动保存、未来审计共用唯一入口，不存在绕过它的野写。
3. **派生数据不落盘。** 依赖双向索引、关键路径、阻塞链、筛选结果全部在内存用 selector 派生。JSON 只存事实、不存推导结果，控制多端同步冲突面。

### 模块清单

| 模块 | 职责 | 对外接口（示意） | 依赖 |
|---|---|---|---|
| `VaultStore` | 唯一状态源，immutable | `getState() / subscribe(sel)` | Zustand |
| `CommandBus` | 命令应用 + 撤销栈 | `apply(cmd) / undo() / redo()` | VaultStore |
| `ScheduleEngine` | 工作日历下的工期计算 | `addWorkdays(d,n) / workdaysBetween(a,b) / duration(t)` | dayjs |
| `DependencyGraph` | 依赖图遍历、环检测、关键路径 | `blocks(id) / blockedBy(id) / cycles() / criticalPath()` | 无 |
| `TopicTree` | topic 树与归属 | `descendants(id) / pathOf(id)` | 无 |
| `QueryEngine` | 组合筛选 + 全文搜索 | `query(filter): Task[]` | TopicTree, DependencyGraph |
| `VaultRepository` | 读写 vault.json、revision 管理 | `load() / save(vault) / peekRevision()` | FsAccessAdapter |
| `AssetStore` | 图片落盘 / 读为 blob URL / 清理孤立 | `put(file) / url(id) / gc()` | FsAccessAdapter |
| `SnapshotStore` | 滚动备份与恢复 | `snapshot() / list() / restore(id)` | FsAccessAdapter |

---

## 4. 数据模型与数据文件夹布局

### 4.1 数据文件夹

用户启动时选一次，放 OneDrive / 共享盘即得多端同步：

```
MyVault/
├── vault.json            ← 唯一结构化数据源
├── assets/               ← 笔记图片，文件名 = <assetId>.<ext>
│   └── a1f3c9.png
└── .backup/              ← 滚动快照（默认留 20 份）
    ├── vault-20261015-093012.json
    └── vault-20261014-091500.json
```

### 4.2 Schema

TypeScript 定义，Zod 镜像做运行时校验与迁移。

```ts
interface Vault {
  schemaVersion: 1
  vaultId: string          // nanoid，识别"是否同一个库"
  appVersion: string
  revision: number         // 每次保存 +1，多端冲突检测
  updatedAt: string        // ISO8601
  settings: Settings       // 看板列定义、工作日历、甘特图默认刻度、主题、locale、lastFilter
  topics: Topic[]
  tasks: Task[]
  milestones: Milestone[]
  links: Dependency[]
  assets: Asset[]          // 仅元数据，引用关系从 note 文本解析
}

interface Topic {
  id: string; name: string; color: string
  parentId: string | null  // 无限层树，UI 默认展示两层
  order: string            // LexoRank 字符串
  archived: boolean
}

interface Task {
  id: string; topicId: string; title: string
  status: 'todo' | 'doing' | 'review' | 'done'
  kind: 'feature' | 'bug' | 'chore' | 'research' | 'doc'
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  assignee?: string        // 纯文本，无登录体系
  start?: string; due?: string        // YYYY-MM-DD，可空 = 未排期
  estimateHours?: number
  progress: number         // 0-100；status=done 时强制 100
  tags: string[]
  note: string             // Markdown；图片用 ![](assets/<assetId>.png)
  baseline?: { start?: string; due?: string }   // 设置基线时快照，供甘特图对比
  order: string
  createdAt: string; updatedAt: string
  archived: boolean        // 软删除；归档任务不出现在看板与甘特图
}

interface Dependency {
  id: string
  from: string             // 前置任务
  to: string               // 后置任务（from 完成后 to 才能开始）
  type: 'FS' | 'SS' | 'FF' | 'SF'
  lagDays: number          // 工作日口径的间隔
  note?: string
}

interface Milestone {
  id: string; topicId: string | null   // null = 跨 topic 里程碑
  title: string; date: string; done: boolean
  color?: string; note?: string
}

interface Asset { id: string; filename: string; sizeBytes: number; createdAt: string }

interface WorkCalendar {
  workdays: number[]       // 0-6，默认 [1,2,3,4,5]
  holidays: string[]       // 额外休息日
  extraWorkdays: string[]  // 补班日
}

type Status = 'todo' | 'doing' | 'review' | 'done'
type Kind = 'feature' | 'bug' | 'chore' | 'research' | 'doc'
type Priority = 'P0' | 'P1' | 'P2' | 'P3'

// T03 落实：原以注释描述的 Settings 显式化为类型
interface Settings {
  boardColumns: Status[]            // 看板列定义：固定四状态的可见顺序，不允许新增状态
  calendar: WorkCalendar            // 工作日历
  ganttScale: 'day' | 'week'        // 甘特图默认刻度
  theme: 'light'                    // 主题：当前仅浅色（深色不在本期）
  locale: 'zh' | 'en' | 'auto'      // 语言，auto 读 navigator.language
  lastFilter: Filter | null         // 上次筛选，结构见 6.2
}
```

`settings` 及其每个字段在 Schema 层都带默认值：用户手改 `vault.json` 时最常漏掉的就是设置项，缺失即补默认，不报错；其余字段一律必填，缺失或枚举越界直接拒绝加载。日期字段区分两类：`start/due/holidays` 必须是真实存在的 `YYYY-MM-DD`，`createdAt/updatedAt` 必须是 ISO8601 时间戳。

### 4.3 四个刻意的决定

1. **依赖独立成表**，而非 `task.dependsOn[]`。跨 topic 依赖、四种依赖类型、lag、以及"反向查谁阻塞了我"都靠它；内存派生 `from→to` / `to→from` 双向 Map，不落盘。
2. **`order` 用 LexoRank 风格字符串。** 拖拽换位置只改一条记录，不重排整列 —— 直接减少 JSON diff 面，降低 OneDrive 同步冲突概率。
3. **图片引用写在 note 的 Markdown 里**（`![](assets/a1f3c9.png)`），`assets` 表只存元数据。该文件夹可被 Obsidian 直接打开阅读；"清理未引用附件" = `assets 表 − 所有 note 解析出的引用集合`。
4. **软删除。** 归档只置 `archived: true`，物理清理由备份面板显式触发，误操作可救回。

---

## 5. 排期引擎与甘特图（只读投影）

### 5.1 数据流与输入契约

```
vault.json → VaultStore → buildGanttModel() → GanttModel → SVG 渲染
                            ↑
        ScheduleEngine · DependencyGraph · TopicTree · Filter
```

`GanttModel` 是领域层产出的输入契约，视图层拿到它只做投影、不做任何计算。几何（x 坐标、条宽、箭头拐点）全部在 `buildGanttModel()` 内算完。渲染、导出、单测共用同一份模型。

```ts
interface GanttModel {
  scale: 'day' | 'week'
  range: { start: string; end: string }
  columns: GanttColumn[]              // 含 weekend / holiday 标记
  headerRows: GanttHeaderCell[][]     // 两级表头：月/日 或 月/周
  rows: GanttRow[]                    // 按 topic 分组 + 里程碑独立轨道
  arrows: DependencyArrow[]           // 已算好的折线路径
  today: string
  criticalIds: Set<string>
  unscheduled: Task[]                 // 未排期侧栏
}
```

### 5.2 ScheduleEngine（纯函数）

- `isWorkday(d, cal) / nextWorkday(d) / addWorkdays(d, n) / workdaysBetween(a, b)`
- 工期 = `workdaysBetween(start, due) + 1`
- 节假日与补班日来自 `settings.calendar`
- 按日期串 memoize（`Map<dateStr, boolean>`），避免逐格重算

### 5.3 DependencyGraph

- `blockedBy(id)` 反向邻接；`isBlocked(id)` = 存在未完成前置
- `cycles()` 用 Tarjan 找强连通分量
- `criticalPath()` 对 DAG 拓扑排序 + 最长路径（工期为权）
- **存在环时降级为不计算关键路径并提示先解环，但不阻止保存** —— 个人工具应宽容，只标红警示

### 5.4 渲染要点

- SVG + 行列双向虚拟化（只渲染视口 ±10 行）
- 行高 32px；day 列宽 32px、week 列宽 14px；Ctrl+滚轮或 +/- 缩放，两种刻度各自保留缩放状态
- 任务条为圆角矩形（rx=3，浅色底 + 深色进度内条），颜色取所属 topic；`archived` 不渲染
- 里程碑为菱形（旋转 45° 正方形）；跨 topic 里程碑走顶部独立轨道
- 基线开启时在条下方叠一条细灰条（baseline start→due），实际条偏移即体现延期
- 依赖箭头为折线 path + `marker-end`；hover 某条高亮其全部直接依赖、其余淡出
- 今日线 1px 红 + 顶部小标签；周末/节假日列浅灰底 `#F5F5F5`
- 左侧固定任务表（任务/开始/结束/进度）与右侧画布同步 `scrollTop`
- 未排期侧栏：`start` 或 `due` 缺失的任务列在右侧折叠面板，点击打开详情补日期（甘特图只读，不做拖入排期）

### 5.5 导出

- **PNG** —— `XMLSerializer` 序列化 SVG；导出前把样式写成内联属性（不留 CSS class）；转 `data:image/svg+xml;charset=utf-8` → `Image` → Canvas（2x）→ `toBlob` → 下载。前提是 SVG 内不引用任何外部字体或图片，否则 canvas 被 taint；`font-family` 显式写死系统栈。
- **SVG** —— 矢量下载，可直接插 PPT。
- **CSV** —— 任务 + 日期 + 进度 + 依赖，带 UTF-8 BOM，避免 Excel 打开中文乱码。
- 范围可选：仅可见区 / 全时间跨度。

---

## 6. 看板、筛选、任务详情、笔记与图片

### 6.1 看板

- 固定 4 列：To Do / In Progress / In Review / Done（本地化，见附录 A），列不可增删
- 归档不是列：`archived: true` 的任务从看板与甘特图消失，靠筛选器"包含已归档"找回
- 卡片信息刻意克制为 6 项：话题色点 + 话题名、标题、类别标签、优先级点、到期日（逾期转红）、依赖角标（"被 N 阻塞"）；有笔记的加一个线性文档图标
- 卡片话题标识采用 **C 方案（色点 + 话题名）**：无条纹；meta 行以 8px 话题色圆点 + 二级灰话题名开头。颜色可读（色盲/打印/灰度可用）、无边缘噪声、跨 topic 筛选免做颜色映射；色点与侧栏色块 swatch 共用同一套颜色语言
- dnd-kit 拖拽：跨列改 `status`、同列改 `order`（LexoRank 中点插入）
- 拖入 In Progress / In Review 时若存在未完成前置，卡片右上角出现琥珀色阻塞标记（不阻止，仅提示）
- 列头：列名 + 计数 + 该列完成比

### 6.2 筛选（QueryEngine）

```ts
interface Filter {
  topicIds: string[]; includeDescendants: boolean
  statuses: Status[]; kinds: Kind[]; priorities: Priority[]
  tags: string[]; tagMode: 'any' | 'all'
  assignees: string[]
  dateRange?: { from?: string; to?: string }
  overdueOnly?: boolean; blockedOnly?: boolean; withNotesOnly?: boolean
  includeArchived?: boolean
  text?: string                    // 标题 + note 全文小写包含匹配
  upstreamDepth?: number           // Jira 式：命中集合的上游/下游 N 跳
  downstreamDepth?: number
}
```

- 筛选状态写进 `settings.lastFilter` 落盘，重开恢复
- **看板与甘特图共用同一份筛选结果**，切视图不丢条件
- `upstreamDepth / downstreamDepth` 是本项目最有价值的筛选能力：选中一个任务 + 下游 2 跳，直接看清"这个延期会波及谁"

### 6.3 任务详情抽屉（TaskDrawer）

- 右侧滑出约 400px，覆盖式，Esc 关闭
- 分区：标题（inline 编辑）/ 属性行（状态、类别、优先级、topic、负责人、标签）/ 日期与进度（开始、结束可填，工期只读展示、进度滑块）/ 依赖关系 / 笔记
- 依赖添加：全库标题模糊搜索下拉（天然支持跨 topic），选中即建 FS 依赖；类型与 lag 可改；成环标红提示但允许保存
- 顶部常驻保存指示：`已保存 / 未保存 / 保存失败(重试)`
- Ctrl+Z 走全局 CommandBus 撤销栈

### 6.4 笔记与图片（NoteEditor）

- TipTap + `tiptap-markdown`，`note` 存 Markdown 纯文本
- 工具栏一行线性 SVG 图标：粗体、斜体、删除线、行内码、代码块、H2/H3、无序/有序/任务列表、引用、链接、表格、图片、分隔线
- Markdown 快捷语法：`# `、`- `、`1. `、`> `、`[] `、`` ` `` —— Obsidian 习惯
- 双向链接最小落地：输入 `[[` 弹任务/里程碑标题搜索，插入 `[[任务标题]]`；渲染时解析为可点击跳转，同名多任务列候选
- **图片三条插入路径**（粘贴剪贴板截图 / 拖入文件 / 工具栏选择）统一走：

```
File → AssetStore.put(file) → 写 assets/<nanoid>.<ext>
     → 插入 ![](assets/<id>.png) → assets 表记元数据
```

- 显示必须经 `FileSystemFileHandle.getFile()` → `URL.createObjectURL(blob)`，因为 `file://` 下相对路径解析不到数据文件夹。用 `Map<assetId, objectURL>` 缓存，删除附件或组件卸载时 `revokeObjectURL`
- 限制：png/jpg/jpeg/gif/webp/svg；单张 5 MB 上限（超出提示压缩）；附件总大小在备份面板展示
- 删除引用不删文件（避免误删）；由"清理未引用附件"显式列出待删清单与可释放空间后回收
- 图片点击 → 灯箱预览（原图、缩放、下载）

### 6.5 里程碑、基线与 topic 管理

- **里程碑**：侧栏底部"里程碑"入口打开列表面板，可新建/编辑/删除（标题、日期、所属 topic 或跨 topic、完成态、颜色）；甘特图上点击菱形同样打开该里程碑的编辑面板
- **基线**：甘特图工具栏"设置基线"把当前全部已排期任务的 start/due 快照进各自 `baseline`；"清除基线"置空。基线对比开关同在工具栏
- **topic 管理**：侧栏 topic 树悬浮显示"+"新建子话题；topic 行右键菜单提供 重命名 / 改色 / 新建子话题 / 归档；颜色从固定 12 色调色板选取（保证浅色主题下对比度一致）

---

## 7. UI 视觉规范

- 浅色主题：背景 `#FAFAFA`，卡片 `#FFFFFF`，发丝边框 `#E5E7EB`，主强调色深靛 `#4F46E5`
- 语义色克制：仅逾期红 `#DC2626`、阻塞琥珀、完成绿三处
- **全项目禁用 emoji**；图标一律 1.5px 描边 inline SVG sprite（`<symbol>` + `<use>`）；CI lint 禁止 emoji 码位进入源码
- 字体系统栈：`-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`；不内嵌 webfont
- 圆角 6–8px；阴影仅 hover 态 2–4px 柔影；无渐变、无装饰插画、无头像
- 信息密度：卡片 6 项、详情抽屉 5 分区、看板列头 3 项，均为上限
- 效果图见 `docs/design/`：`01-board-layout.png`（看板整体）、`02-gantt-detail.png`（甘特图 + 详情抽屉）、`03-card-variants-compare.png`（卡片四方案对比）、`04-card-closeup-recommended.png`（C 方案特写含 hover/逾期态）

### 品牌与图标资产

- 产品名 **OffEarly**（中文：早下班）；tagline「把事做完，早点下班。/ Finish well. Leave early.」
- 品牌标记概念：5 点时钟 + 从表盘右侧缺口穿出的离场箭头（"到点就走"），1.8px 描边、深靛 `#4F46E5`，与 UI 线性图标同一语言

| 资产 | 用途 |
|---|---|
| `brand/logo-mark.svg` | 彩色线性标，单一事实源；任意尺寸由此缩放 |
| `brand/logo-mark-mono.svg` | 单色标（`currentColor`）；favicon、打印、单色上下文 |
| `brand/logo-lockup.svg` | 标 + OffEarly 字标 + 早下班；侧栏 wordmark、文档页眉 |
| `brand/app-icon-1024.png` | 应用图标：桌面快捷方式、PWA manifest、系统"打开方式"图标 |

- favicon 以 `logo-mark-mono.svg` 的 data URI 内联进单 HTML，保证零外部请求
- 192/512/48/32/16 等光栅尺寸在构建期由 SVG / 1024 源导出，**不入库**
- 可执行物命名 `OffEarly.html`；数据文件夹与 `vault.json` 命名不变

---

## 8. 持久化、自动保存、备份与冲突

### 8.1 启动流程

```
双击 HTML
├─ 有持久化目录句柄 → queryPermission → 有权限直接进 / 无权限一次点击授权进
└─ 无句柄 → 首屏"连接数据文件夹"（showDirectoryPicker）
     ├─ 选中含 vault.json 的目录 → Zod 校验 + 迁移 → 进入
     └─ 选中空目录 → 询问"在此创建新库？" → 初始化 vault.json
```

### 8.2 自动保存

- dirty 标记 + debounce 1200ms；Ctrl+S 立即保存；保存时 `revision++`、刷新 `updatedAt`
- **File System Access API 没有原子 rename**（`createWritable()` 是截断写，真实文件系统无 `move()`）。不追求伪原子性，改用"写前必有快照 + 启动自愈"：

```
save():
  1. peekRevision() 读磁盘 revision
  2. 磁盘 revision > 内存基线 → 冲突分支
  3. 会话首次写 / 距上次快照 ≥30min → SnapshotStore.snapshot()
  4. writable = vault.json createWritable() → write → close()（flush）
  5. 失败 → 顶部红色"保存失败(重试)"，内存数据不丢，可手动导出兜底
```

- 若写中断导致 JSON 损坏，启动时解析失败 → 自动从 `.backup/` 最近快照恢复，**绝不静默覆盖损坏文件**

### 8.3 冲突处理（多端）

- 检测：保存前磁盘 revision > 内存基线 revision
- 弹窗三选：
  1. **以我为准** —— 覆盖磁盘（磁盘旧版已自动进 `.backup`，可回滚）
  2. **以磁盘为准** —— 放弃本地未保存变更并重载（明确警告丢失条数）
  3. **导出我的副本** —— 内存版本存为 `vault-conflict-<ts>.json` 后重载磁盘版，手动合并
- **不做字段级自动 merge** —— 对嵌套 Markdown 不可靠，个人工具不值得这个复杂度
- 30s 轮询 `peekRevision()`：磁盘变了且本地不 dirty → 静默重载；dirty → 提示"另一端已更新，保存时将询问"

### 8.4 备份（SnapshotStore）

- 自动快照：每会话首存 1 份 + 每 30 分钟 1 份
- 保留策略：最近 20 份 + 每日首份保留 30 天
- 手动：备份面板"立即快照"
- 恢复：列出快照（时间/大小/任务数）；恢复前对当前版本再打一份快照，防恢复误操作
- 导出库副本：用 FS Access API 把整个文件夹（含 `assets/`）递归复制到用户选的目标目录，无需 zip 依赖
- 导入：选一个 vault.json（或文件夹）→ 校验 → 迁移 → 覆盖当前内存（写盘前确认）

### 8.5 迁移与只读安全模式

- `schemaVersion` 整数 + 链式 `migrations: Record<from, (v) => v>`；迁移前自动快照
- 任何解析/校验/迁移失败 → 只读安全模式：加载最近可用快照为只读视图，顶部横幅给出 `[恢复此快照] [选择其他备份] [导出当前]`，不写盘

---

## 9. 构建与交付

- Vite 8 + TypeScript 7（strict）+ `vite-plugin-singlefile` 2.3.3 内联全部 JS/CSS
- 两个硬约束：
  1. `build.rollupOptions.output.format: 'iife'` + `inlineDynamicImports: true` —— `file://` 下 ES module 被 CORS 拦截，必须单 IIFE bundle、零 chunk
  2. 图标全部 inline SVG sprite；CI lint 禁止 emoji 码位进入源码
- **实测坑（T02）**：`vite-plugin-singlefile` 只做内联，不改脚本标签 —— 产物仍是 `<script type="module" crossorigin>` 且位于 `<head>`。构建管线需追加 finalize 步骤：去掉 `type="module"`/`crossorigin` 并把脚本移到 `#root` 之后，否则 `file://` 下不执行或挂载时取不到 root。前提已验证：bundle 内无 `import.meta`、无 top-level `export`、无动态 `import()`，降级为经典脚本安全
- 无 sourcemap 进产物（外挂保存）
- 产物目标 < 1.6 MB；CI 校验产物中不含任何 `http(s)://` 资源引用（保证零网络依赖）
- `APP_VERSION` 内嵌于 HTML（git tag）；`schemaVersion` 独立演进，向后兼容 N-1
- 交付物：`OffEarly.html`（唯一可执行物）+ `docs/`（设计文档与一页纸用户手册）+ 可选 `example.vault/` 示例库（含示例 topic/任务/里程碑/图片）

---

## 10. 测试策略

- **单元（Vitest）**：ScheduleEngine（节假日/补班/跨年）、DependencyGraph（环检测/关键路径/阻塞链）、LexoRank 插入、QueryEngine（组合筛选/依赖跳数）、MigrationPipeline、Zod Schema 往返
- **组件（Vitest + Testing Library）**：看板拖拽、筛选栏、详情抽屉表单校验
- **E2E（Playwright，在 `file://` 协议下真实启动）**：连接文件夹 → 建任务 → 拖拽 → 加依赖 → 贴图片 → 保存 → 重开验证落盘；外部改 revision 触发冲突弹窗；导出 PNG/CSV 校验文件产生
- **视觉回归（可选）**：Playwright 截图对比看板/甘特图

---

## 11. 技术风险验证清单（实现第一步：spike）

实现的第一步是一个约 100 行的 `spike.html`，在目标企业浏览器上跑一遍，把 6 项结果打在页面上，5 分钟出结论：

| # | 风险 | 验证方式 | 降级方案 |
|---|---|---|---|
| R1 | `showDirectoryPicker` 在 `file://` 可用 | spike 页 | 退回 `showOpenFilePicker` 单文件 + 图片 base64 内嵌（限 1MB） |
| R2 | 目录句柄可持久化（IndexedDB 在 `file://`） | spike 页 | 每次启动重选文件夹（一次点击，可接受） |
| R3 | SVG→Canvas 导出 PNG 在 `file://` 不 taint | spike 页 | 导出仅保留 SVG + CSV |
| R4 | 剪贴板图片粘贴在 `file://` 可用 | spike 页 | 仅支持拖入 / 工具栏选文件 |
| R5 | 大库（>5000 任务）全量序列化耗时 | 基准脚本 | 提示拆分库 / 分片写 |
| R6 | OneDrive 同步延迟造成伪冲突 | 实测 | 冲突弹窗已含"导出副本"兜底 |

spike 结果回填本文档第 11 节并据此裁剪降级路径，然后才进入实现。

### 11.1 实测结果（T01，2026-10-15）

`spike.html` 已在 Qoder 内置浏览器（Electron 43 / Chrome 150，`file://` 协议）跑通全部自动化项。环境探测：`protocol=file:`、`isSecureContext=true`、`showDirectoryPicker=true`、`showOpenFilePicker=true`、`createWritable=true`。

| # | 结果 | 实测说明 |
|---|---|---|
| R1 | 待人工验证 | API 存在已确认；目录选择与子文件读写需用户手势，待企业 Edge 实测 |
| R2 | **PASS** | IndexedDB 在 `file://` 可读写；句柄结构化克隆往返由 R1 授权后自动复检 |
| R3 | **PASS** | SVG→data URI→Canvas→PNG 成功（5981 字节），画布未被 taint |
| R4 | 待人工验证 | 剪贴板读取需手势与权限，待企业 Edge 实测 |
| R5 | **PASS** | 5000 任务：stringify 18.1ms、parse 8.1ms、2691 KB，远低于 200ms 阈值 |
| R6 | 待人工验证 | 依赖 R1 句柄做读写往返计时；同步盘延迟需人工观察 |

**结论**：R2 / R3 / R5 成立，架构主路径（数据文件夹 + 句柄持久化 + PNG 导出 + 全量序列化）**无需启用降级**。内置浏览器与企业 Edge 的 `file://` 策略可能存在差异，因此 R1 未在企业 Edge 复验前不进入 T06（FsAccessAdapter）。

---

## 12. 非目标（明确不做）

- 多人实时协作 / 服务端 / 登录账号
- 字段级自动 merge
- 移动端适配
- 插件系统 / 主题市场
- 时间追踪计时器（pomodoro 等）
- 自定义看板列（固定四列）
- 内嵌 webfont / CDN 资源
- i18next 等重型 i18n 库
- 甘特图拖拽改期 / 拖入排期
- 图片 base64 大图内嵌

---

## 附录 A · i18n 术语表（锁定）

| Key | 中文 | English |
|---|---|---|
| status.todo | 待办 | To Do |
| status.doing | 进行中 | In Progress |
| status.review | 评审中 | In Review |
| status.done | 已完成 | Done |
| topic | 话题 | Topic |
| milestone | 里程碑 | Milestone |
| dependency | 依赖 | Dependency |
| criticalPath | 关键路径 | Critical Path |
| baseline | 基线 | Baseline |
| vault | 数据库 | Vault |
| workday | 工作日 | Workday |
| workweek | 工作周 | Workweek |

i18n 实现：自写约 60 行 `t()` + 插值；`type MsgKey = NestedKeyOf<typeof zh>`，`en.json` 用 `Record<MsgKey, string>` 约束，缺翻译编译期报错；`settings.locale: 'zh' | 'en' | 'auto'`，auto 读 `navigator.language.startsWith('zh')`；切换即时重渲染（locale 在 VaultStore，非模块级常量）；日期/星期/月份名走 dayjs locale（内联 zh-cn + en）。**边界规则：`t()` 只用于 UI 文案，绝不用于数据**（任务标题、topic 名、笔记内容原样显示）。

## 附录 B · 效果图清单

| 文件 | 内容 |
|---|---|
| `docs/design/01-board-layout.png` | 看板整体布局（侧栏 topic 树 / 筛选栏 / 五列示意） |
| `docs/design/02-gantt-detail.png` | 甘特图 + 周/日切换 + 关键路径 + 详情抽屉（含依赖与图片附件） |
| `docs/design/03-card-variants-compare.png` | 卡片话题标识四方案同屏对比（A 左色条 / B 顶线 / C 色点+话题名 / D 柔和底色） |
| `docs/design/04-card-closeup-recommended.png` | C 方案卡片特写，含 hover 态与逾期态 |

> 注：`01-board-layout.png` 与 `02-gantt-detail.png` 已按 OffEarly 品牌、固定四列与 C 方案卡片重生成；`03` / `04` 不含字标，不受更名影响。效果图中的文案与像素细节以第 6、7 节文字规范为准。
