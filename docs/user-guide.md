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
| **6 · 备份与恢复<br>Backup & restore** | 每次保存前，当前 `vault.json` 会被**逐字节**复制进 `.backup/`，无需手动操作。手动备份面板（快照列表 / 导入 / 导出库副本）**尚未实现**；目前可从「只读安全模式」横幅里恢复快照。 | Before each save the current `vault.json` is copied byte-for-byte into `.backup/` — nothing to do. The manual backup panel (snapshot list / import / export copy) is **not built yet**; for now restore snapshots from the safe-mode banner. |
| **7 · 冲突三选<br>Conflict: three choices** | 若另一端改了磁盘上的 `vault.json`，保存时会弹出「文件已被另一端修改」。三选：**以我为准**（磁盘旧版先备份到 `.backup/`）、**以磁盘为准**（放弃本地未保存改动）、**导出我的副本**（先存下我的版本再载入磁盘版，便于手工合并）。弹窗会提示「以磁盘为准」将丢掉几条本地任务。 | If another party edits `vault.json` on disk, saving raises "文件已被另一端修改" with three choices: **以我为准** (mine wins; the disk copy is backed up to `.backup/` first), **以磁盘为准** (discard local unsaved edits), **导出我的副本** (keep my version alongside the disk one for a manual merge). The dialog states how many local tasks the disk option would drop. |
| **8 · 只读安全模式<br>Read-only safe mode** | 若 `vault.json` 无法解析或校验不通过，应用**停止一切写入**，顶部常驻「只读安全模式」横幅并展示最近可用的快照。可选「恢复此快照」（当前文件先备份到 `.backup/`）、「选择其他备份」或「导出当前」。 | If `vault.json` cannot be parsed or validated, OffEarly **stops writing entirely** and pins a "只读安全模式" banner showing the latest usable snapshot: 恢复此快照 (restore; the current file is backed up first), 选择其他备份 (pick another), 导出当前 (export what you see). |
| **9 · 导出<br>Export** | **PNG / SVG / CSV 图表导出尚未实现。** 当前可用的导出有两处：安全模式横幅里的「导出当前」（把库另存为独立 JSON 文件）、冲突弹窗里的「导出我的副本」。 | **PNG / SVG / CSV chart export is not built yet.** Today there are two exports: 导出当前 in the safe-mode banner (save the vault as a standalone JSON file) and 导出我的副本 in the conflict dialog. |
| **10 · 快捷键<br>Shortcuts** | `Ctrl / Cmd + S` 立即保存；甘特图聚焦时 `+` 或 `=` 放大、`-` 或 `_` 缩小，`Ctrl / Cmd + 滚轮` 缩放；重命名话题时 `Enter` 提交、`Esc` 取消。撤销 / 重做**尚未绑定快捷键**。 | `Ctrl / Cmd + S` saves; with the Gantt focused, `+` or `=` zooms in and `-` or `_` zooms out, `Ctrl / Cmd + wheel` zooms; while renaming a topic `Enter` commits and `Esc` cancels. Undo / redo has **no key binding yet**. |
| **11 · 示例库<br>Example vault** | 想先看有数据长什么样：用「选择文件夹」连接仓库里的 `example.vault/`（5 个话题、15 个任务、3 个里程碑、7 条依赖、1 张笔记配图，覆盖四状态 / 逾期 / 被阻塞 / 未排期）。 | To see a populated app, connect `example.vault/` from the repository (5 topics, 15 tasks, 3 milestones, 7 dependencies, one illustrated note — covering all four statuses plus overdue, blocked and unscheduled work). |
| **12 · 本版边界<br>Scope of this build** | 里程碑 / 筛选器 / 设置 / 详情抽屉的入口已接线，但面板**尚未实现**，点击会提示「… 面板尚未实现」。看板卡片视图也尚未落地，当前看板位置是占位。 | The milestone / filter / settings / drawer entries are wired up but their panels are **not built**, so clicking shows "… 面板尚未实现". The board card view is not in yet either — that slot is currently a placeholder. |

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
