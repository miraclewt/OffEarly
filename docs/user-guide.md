# OffEarly 一页纸用户手册 · One-page User Guide

> OffEarly（早下班）是一个**单文件、离线、数据自持**的看板 + 甘特图工具。
> 把交付物当成一个 HTML：双击 `dist/OffEarly.html` 就能跑，不需要服务器、不联网，
> 数据全部存在你自己选的文件夹里。
>
> OffEarly is a single-file, offline, self-hosted board + Gantt tool. Treat the
> deliverable as one HTML file: double-click `dist/OffEarly.html`. No server, no
> network, and all data lives in a folder you own.

## 操作步骤 · Steps

| 主题 Topic | 中文 | English |
| --- | --- | --- |
| **1 · 打开<br>Open** | 双击 `dist/OffEarly.html`。首次打开停在「连接数据文件夹」。 | Double-click `dist/OffEarly.html`. The first screen asks you to connect a data folder. |
| **2 · 连接文件夹<br>Connect a folder** | 点「选择文件夹」，选一个空目录或已有的 OffEarly 库目录；浏览器会请求读写权限（选过一次后重开只需点一次「授权并继续」）。 | Click "选择文件夹" and pick an empty directory or an existing vault; the browser asks for read/write permission. After the first time, reopening only needs one click on "授权并继续". |
| **3 · 新建库<br>Create a vault** | 目录里没有 `vault.json` 时会问「在此创建新库？」。确认即初始化空库，并一并建好 `assets/` 与 `.backup/`。已有 `vault.json` 的目录**只会被打开，不会被覆盖**。 | If the folder has no `vault.json`, OffEarly asks "在此创建新库？". Confirming initialises an empty vault and creates `assets/` and `.backup/`. A folder that already has `vault.json` is opened, never overwritten. |
| **4 · 切换视图<br>Switch views** | 顶部左侧在「看板」与「甘特」之间切换。两个视图共用同一份筛选结果（改一次筛选，两边同时生效）。 | Use the "看板 / 甘特" switch at the top left. Both views share one query, so a filter change applies to both at once. |
| **5 · 自动保存与 Ctrl+S<br>Autosave & Ctrl+S** | 改动自动保存。顶部右侧的保存指示有三态：**已保存 / 未保存 / 保存失败**（失败时可点「重试」）。要立刻落盘按 `Ctrl+S`（macOS 为 `Cmd+S`）。 | Edits save automatically. The indicator at the top right shows **已保存 / 未保存 / 保存失败** (failed saves offer 重试). Press `Ctrl+S` (`Cmd+S`) to flush immediately. |
| **6 · 备份与恢复<br>Backup & restore** | 每次保存前，当前 `vault.json` 会被**逐字节**复制进 `.backup/`，无需手动操作。侧栏底部「备份」打开面板：快照列表 / 立即快照 / 恢复（会先自动再打一份快照）/ 导出库副本 / 从 `vault.json` 或文件夹导入 / 清理未引用附件。 | Before each save the current `vault.json` is copied byte-for-byte into `.backup/` — nothing to do. The 备份 entry at the bottom of the sidebar opens a panel with the snapshot list, instant snapshot, restore (which snapshots the current file first), export a copy of the vault, import from a `vault.json` or a folder, and unreferenced-attachment cleanup. |
| **7 · 冲突三选<br>Conflict: three choices** | 若另一端改了磁盘上的 `vault.json`，保存时会弹出「文件已被另一端修改」。三选：**以我为准**（磁盘旧版先备份到 `.backup/`）、**以磁盘为准**（放弃本地未保存改动）、**导出我的副本**（先存下我的版本再载入磁盘版，便于手工合并）。弹窗会提示「以磁盘为准」将丢掉几条本地任务。 | If another party edits `vault.json` on disk, saving raises "文件已被另一端修改" with three choices: **以我为准** (mine wins; the disk copy is backed up to `.backup/` first), **以磁盘为准** (discard local unsaved edits), **导出我的副本** (keep my version alongside the disk one for a manual merge). The dialog states how many local tasks the disk option would drop. |
| **8 · 只读安全模式<br>Read-only safe mode** | 若 `vault.json` 无法解析或校验不通过，应用**停止一切写入**，顶部常驻「只读安全模式」横幅并展示最近可用的快照。可选「恢复此快照」（当前文件先备份到 `.backup/`）、「选择其他备份」或「导出当前」。 | If `vault.json` cannot be parsed or validated, OffEarly **stops writing entirely** and pins a "只读安全模式" banner showing the latest usable snapshot: 恢复此快照 (restore; the current file is backed up first), 选择其他备份 (pick another), 导出当前 (export what you see). |
| **9 · 导出<br>Export** | 甘特图右上角「导出」：**PNG 图片 / SVG 矢量图 / CSV 表格**，范围可选「仅可见区」或「全时间跨度」（当前环境不支持 PNG 时会提示改用 SVG 或 CSV）。另有安全模式横幅里的「导出当前」与冲突弹窗里的「导出我的副本」。 | The 导出 button at the top right of the Gantt chart exports **PNG / SVG / CSV**, scoped to the visible area or the full time span (if the environment cannot produce PNG, OffEarly says so and suggests SVG or CSV). The safe-mode banner's 导出当前 and the conflict dialog's 导出我的副本 remain as well. |
| **10 · 快捷键<br>Shortcuts** | `Ctrl / Cmd + S` 立即保存；甘特图聚焦时 `+` 或 `=` 放大、`-` 或 `_` 缩小，`Ctrl / Cmd + 滚轮` 缩放；重命名话题时 `Enter` 提交、`Esc` 取消；列内新建任务时 `Enter` 创建（可连续输入）、`Esc` 退出。撤销 / 重做**尚未绑定快捷键**。 | `Ctrl / Cmd + S` saves; with the Gantt focused, `+` or `=` zooms in and `-` or `_` zooms out, `Ctrl / Cmd + wheel` zooms; while renaming a topic `Enter` commits and `Esc` cancels; while adding a task in a column `Enter` creates it (keeps going for the next one) and `Esc` exits. Undo / redo has **no key binding yet**. |
| **11 · 示例库<br>Example vault** | 想先看有数据长什么样：用「选择文件夹」连接仓库里的 `example.vault/`（5 个话题、15 个任务、3 个里程碑、7 条依赖、1 张笔记配图，覆盖四状态 / 逾期 / 被阻塞 / 未排期）。 | To see a populated app, connect `example.vault/` from the repository (5 topics, 15 tasks, 3 milestones, 7 dependencies, one illustrated note — covering all four statuses plus overdue, blocked and unscheduled work). |
| **12 · 新建任务<br>Add a task** | 每个看板列底部都有「+ 新建任务」：点开输入标题，`Enter` 创建，输入框保持展开可**连续录入**，`Esc` 或点别处退出。新任务落在该列（状态即列）、归属当前筛选的话题（没有筛选时取第一个话题），排序键追加到列尾；之后点卡片打开任务详情弹窗补日期 / 优先级 / 依赖。**库里一个话题都没有时**列底只显示「先建一个话题」——话题是任务的必填归属。 | Every board column ends with "+ 新建任务". Click it, type a title, press `Enter`; the input stays open so you can keep adding, and `Esc` or clicking away exits. The task lands in that column (its status), belongs to the currently filtered topic (or the first topic when no filter is set) and is appended to the end of the column. Click the card afterwards to fill in dates, priority and dependencies in the task dialog. **With no topics in the vault** the row only says "先建一个话题" — a topic is required. |
| **13 · 任务详情弹窗<br>Task details** | 点看板卡片、甘特图任务条、或甘特图右侧「未排期」列表里的一行，都会打开**居中的任务详情弹窗**（遮罩压暗背景，弹窗外的东西点不到）。弹窗里五个分区：标题（点一下改）/ 属性（状态、类别、优先级、负责人、话题、标签）/ 日期与进度（起止日期可填、工期只读、进度滑块；状态为「已完成」时进度锁定 100%）/ 依赖关系（模糊搜索建链、类型与 lag 可改、成环标红但允许保存）/ 笔记（Markdown，支持图片与 `[[双向链接]]`）。三条出路关掉它：`Esc`、点弹窗外的空白处、右上角 `×`；改动即时生效（顶部保存指示联动，`Ctrl / Cmd + Z` 可撤销）。 | Click a board card, a Gantt bar, or a row in the unscheduled list: a **centred task dialog** opens over a dimmed backdrop (nothing behind it is clickable). It has five sections — title (click to edit), properties (status, kind, priority, assignee, topic, tags), dates & progress (start/due editable, duration read-only, progress slider locked at 100% once the status is Done), dependencies (fuzzy search to link, type and lag editable, cycles highlighted in red but still savable) and notes (Markdown with images and `[[wiki links]]`). Close it with `Esc`, a click on the backdrop, or the `×` in the corner; every change applies immediately (the save indicator reacts, and `Ctrl / Cmd + Z` undoes it). |
 侧栏底部「设置」打开面板：**语言**（跟随系统 / 中文 / English，切换即时生效）、**主题**（本版仅浅色）、**甘特图默认刻度**（日 / 周）、**工作日历**（工作日开关、假期与补班日期表——直接影响工期计算与排期），末尾是「关于」（库标识 / 修订号 / 版本 / 计数）。每项改动都可 `Ctrl+Z` 撤销，并随自动保存落盘。 | The 设置 entry at the bottom of the sidebar opens the panel: **language** (system / 中文 / English, applied instantly), **theme** (light only in this build), **default Gantt scale** (day / week), **work calendar** (workday toggles plus holiday and extra-workday date lists, which drive duration maths and scheduling), and an 关于 section (vault id / revision / version / counts). Every change is undoable with `Ctrl+Z` and saved by autosave. |
| **15 · 本版边界<br>Scope of this build** | 里程碑 / 筛选器 / 备份 / 设置四个面板、任务详情弹窗与笔记（含图片与 `[[双链]]`）均已实现。仍不在范围内的：多端实时协同（只有冲突三选与 30s 轮询）、看板列自定义（固定四列）、甘特图拖拽改期（只读投影，日期在弹窗里改）、撤销 / 重做快捷键绑定。 | The milestone / filter / backup / settings panels, the task detail dialog and notes (with images and `[[wiki links]]`) are all built. Still out of scope: real-time multi-device sync (only conflict resolution plus 30s polling), custom board columns (fixed four), drag-to-reschedule on the Gantt chart (read-only projection — edit dates in the dialog), and key bindings for undo / redo. |

## 文件夹结构 · Folder layout

```
<你选择的文件夹> / <your folder>
├── vault.json     唯一的数据库（JSON，可读可手改；改前请先备份）
│                  the single database (readable JSON; back it up before hand-editing)
├── assets/        图片附件 / image attachments
└── .backup/       每次保存前的自动快照 / automatic snapshots taken before each save
```

## 数据自持说明 · Your data stays yours

| 中文 | English |
| --- | --- |
| 交付物是**一个 HTML 文件**，不请求任何外部资源，断网可用。 | The deliverable is **one HTML file**. It requests no external resources and works offline. |
| 没有账号、没有云端、没有遥测。数据只在你本机选定的文件夹里。 | No account, no cloud, no telemetry. Data lives only in the folder you picked on your machine. |
| `vault.json` 是纯 JSON，随时可以用任何编辑器查看或备份。 | `vault.json` is plain JSON — inspect or back it up with any editor. |
| 图片放在 `assets/`，与数据库分离，方便单独同步。 | Images live in `assets/`, separate from the database, so they can be synced on their own. |
