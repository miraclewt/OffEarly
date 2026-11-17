# 车道启动指令包 · 第四波（OffEarly · trunk-based 短分支）

> 用法：另开 **3 个对话框**，把下面【提示词 E / H / F】整段复制粘贴发送，即可并行开工。
> 第 4 个对话框在三条车道有产出后再用【提示词 X】做集成。
> 每个提示词都是自包含的——新窗口看不到任何上下文，**不要删减路径与步骤**。
>
> 已完成并合入主干：第一波 `docs/lane-launch-prompts.md`（T09–T12）、第二波 `docs/lane-launch-prompts-wave2.md`（T14/T20/T27）、第三波 `docs/lane-launch-prompts-wave3.md`（T15/T21/T18）。仅作留档。

---

## 0. 开工前的既定事实（供你自己对照，不要贴进提示词）

| 事项 | 状态 |
|---|---|
| 主干分支 | `feat/foundation`，检出在 `C:\Users\18304\Desktop\TaskDone` |
| 主干 tip | 第三波集成后为 `e664e21`（wave-3 集成记录；开工前以 `git log --oneline -1` 为准），工作树干净 |
| 已完成 | **T01–T15、T18、T19、T20、T21、T27、T29–T33** 全部 done |
| 剩余 | **T16、T17、T22、T23、T24、T25、T26、T28** |
| 本波可并行 | **T17 ∥ T16 ∥ T23**（文件域互斥，见下表） |
| 关键路径 | T17 → T24 → T25 → T26 → T28（T17 是本波的关键路径头） |
| 本波之后才解锁 | T24(←T17)、T25(←T24)、T22(←T16)、T26(←T25)、T28(←T26) |

**三条车道 worktree 都已被集成窗口 rebase 到主干（第三波集成时），但主干其后又多了集成记录 commit，开工前一律先 rebase：**

```bash
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-board-ui && git rebase feat/foundation
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-milestone && git rebase feat/foundation
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-gantt     && git rebase feat/foundation
```

**并发配额：** 本波放 3 条车道。`oe-lane-persistence` 本波**没有可做的活**（T26←T25、T28←T26 都堵在 E 链后面），保持空置，不要往里派任务。

### 文件域互斥表（本波 3 条车道为什么能并行）

| 车道 | 任务 | 独占文件 | 是否新增依赖 |
|---|---|---|---|
| E 看板 UI | T17 | `src/views/TaskDrawer.tsx` `src/views/DependencyEditor.tsx` `tests/views/TaskDrawer.test.tsx` **`src/domain/commandBus.ts`（link 命令扩展，本波独占）** | 否 |
| H 里程碑（借调） | T16 | `src/views/FilterBar.tsx` `src/controllers/filters.ts` `tests/views/FilterBar.test.tsx` | 否 |
| F 甘特 UI | T23 | `src/views/GanttExporter.ts` `tests/views/ganttExporter.test.ts` `src/views/GanttView.tsx`（导出入口） | 否 |
| —— | —— | `task.md`、`src/locales/{zh,en}.ts` | **三条都会碰，必然冲突，按协议第 7 条解** |

> 说明：T16（FilterBar）虽属看板/筛选域，但与本波 T17 的文件域**完全不重叠**，且 H 车道（milestone）在 T18 合入后空出，故借调给 H 车道执行——这与第三波「T16 与 T17 文件域互斥可并行」的安排一致。

### 依赖新增规则（本波三条车道都不加依赖）

- 本波 T17 / T16 / T23 **都不新增 npm 依赖**，**不要动 `package.json` / `package-lock.json`**。
- 预告：**下一波 T24 会加 TipTap**（`@tiptap/react` + `@tiptap/starter-kit` + `tiptap-markdown`），届时**仅 E 车道**可改 `package.json`，规则同第三波（车道提交前 `git checkout -- package-lock.json` 还原，lock 由集成窗口统一 `npm install` 重生成）。

### `commandBus` 扩命令授权（本波 T17 独占，其他车道仍不得碰 `src/domain/*`）

集成窗口裁决：**T17 授权扩展 `src/domain/commandBus.ts`**，增加依赖（link）命令，使依赖的增 / 删 / 改能进全局 undo 栈（T17 验收第 5 条「Ctrl+Z 撤销走 CommandBus」）。

- 依据：现有 `MutationType` 只有 `task.*` 与 `settings.patch`，没有 link 命令；而本波只有 T17 一条车道碰 `src/domain/*`，**无并发冲突**（这是放开的前提）。
- 设计要点（沿用既有 `reduce` / `inverse` 手法）：
  - `'link.create': { link: Dependency; index: number | null }` —— inverse = `link.delete`；
  - `'link.delete': { id: string }` —— inverse = `link.create`（带完整 link 体与原下标，undo 后连数组位置一起还原，参照 `deleteTaskCommand`）；
  - `'link.patch': { id: string; patch: Partial<Omit<Dependency, 'id'>> }` —— inverse = 反向 patch（参照 `patchTaskCommand` + `invertPatch`）；
  - 相应导出工厂 `createLinkCommand` / `deleteLinkCommand` / `patchLinkCommand`，在 `reduce` 的 `switch` 里补上三个 case。
- **除 T17 外的车道**（H、F、D）一律不得碰 `src/domain/*`；若确需领域层补算，先在回复里报告，由集成窗口裁决，不要自行扩大文件域。

### `src/locales/*` 追加规则（三条车道必读，否则合入后 `tsc` 语法错）

历史教训：`zh.ts` 是**嵌套**表，多个车道各自「尾部追加」时，git 会把两侧新块的闭合 `},` 当成同一行公共上下文，解析后出现「上一个键块丢闭合括号、下一个键块被嵌进去」→ **语法错误**，而 `en.ts`（扁平、无内层大括号）不会中招，容易误判为已修好。

因此本波统一约定：

1. **一律追加新的顶层键块**（如 `drawer: { ... },`、`filters: { ... },`、`exporter: { ... },`），**不要往既有键块内部塞子键**。
2. 插入位置统一在 `safemode: { ... },` 之后、`} as const` 之前（即文件现有物理末尾）。
3. 每个新块**自带完整闭合 `},`**，不要依赖别处的括号。
4. `en.ts` 是扁平 `'a.b': 'x'` 表，且类型是 `Record<MsgKey, string>`——**zh 与 en 的键集合必须严格一致**，少一条翻译 tsc 立刻报错。追加时两边同步。
5. 集成窗口解冲突：按 git 时间序取并集 → **人工检查 zh 每个新增块是否都有 `},`**（缺则补）→ 跑 `npx tsc --noEmit` 确认。

---

## 提示词 E · 窗口（车道 E 看板 UI → T17）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T17 · TaskDrawer（属性 / 日期 / 进度 / 依赖编辑）。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-board-ui
当前已检出分支 feat/lane-board-ui。开工前先执行：git rebase feat/foundation（同步到主干最新 tip）。不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读项目根目录 task.md，重点：《Global Constraints》《状态同步协议》《分支与合入约定》《### T17》明细，以及已 done 的《### T15》（看板卡片，你的打开入口就在它上面）、《### T18》（MilestonePanel，受控抽屉的先例）。
2. 读 spec（docs/superpowers/specs/2026-10-15-taskdone-architecture-design.md）的 §6.3（任务详情抽屉）、§5.3（DependencyGraph）、§3（三条硬规则）、§7（UI 视觉规范）。
3. 读现有实现，确认接缝（不要重造）：
   - src/views/BoardView.tsx（T15）：卡片点击已暴露 props 回调 onOpenTask(taskId)。**这是打开 TaskDrawer 的入口之一**，但点击的实际接线由集成窗口做（见边界）。
   - src/views/GanttCanvas.tsx（T20/T21）：任务条元素带 data-gantt-bar 标记。**甘特条点击打开抽屉也由集成窗口接线**，你不要改这个文件。
   - src/domain/types.ts：Task（status/kind/priority/tags/assignee/dates/progress/note）、Dependency { id, from, to, type: DependencyType('FS'|'SS'|'FF'|'SF'), lagDays, note? }、Vault.links。
   - src/domain/dependencyGraph.ts（T12）：邻接、环检测、阻塞链。**成环判定用它，不要另写。**
   - src/domain/scheduleEngine.ts（T11）：工期（只读展示）来自它，不要在抽屉里重算。
   - src/domain/commandBus.ts（T10）：**本任务授权你扩展它**——加 link.create / link.delete / link.patch 三种 Mutation（见下方边界）。task.* 与 settings.patch 已就绪。
   - src/views/MilestonePanel.tsx（T18）：**照它的受控手法做 TaskDrawer**——组件导出默认函数 + 显式 props（含 open / onOpenChange / 受控选中 id），`if (!open) return null`，右侧 fixed 抽屉、Esc 关闭。你的抽屉结构应与它同一视觉语言。
   - src/views/SaveIndicator.tsx（T08）：保存指示三态组件，直接复用。
   - src/persistence/autosave.ts（T08）：顶部保存指示联动 Autosave 的状态来源。
   - src/styles/theme.css：--oe-* token。**颜色一律取 token，不要写死 hex**；唯一例外是 SVG 呈现属性（fill=/stroke=）不解析 var()，必须写字面量。
   - src/views/IconSprite.tsx：现有图标名（含 dependency / calendar / clock / close / plus / note 等），直接用，不要新增图标。

【第 1 步 · 登记】
把 task.md《任务总表》中 T17 的状态由 pending 改为 in_progress，并写 (2026-10-16, <你的模型名>:<会话短id>)。

【第 2 步 · 实施】
只改本任务「产出」清单内的文件：
  src/views/TaskDrawer.tsx
  src/views/DependencyEditor.tsx
  tests/views/TaskDrawer.test.tsx
  src/domain/commandBus.ts   ← 仅做「link 命令扩展」，别动既有 task.* / settings.patch 逻辑
严格按 T17 的 6 条验收标准逐条实现，不得遗漏：
- 右侧约 400px 覆盖式抽屉，Esc 关闭；点击卡片 / 甘特条打开（点击接线归集成窗口，你交付受控组件即可）；
- 分区：标题 inline 编辑 / 属性行（状态、类别、优先级、topic、负责人、标签）/ 日期与进度（开始、结束可填，**工期只读展示**、进度滑块；status=done 强制 progress=100）/ 依赖关系 / 笔记占位（T24 接入）；
- 依赖添加：全库标题模糊搜索下拉（天然支持跨 topic），选中即建 FS 依赖；类型 FS/SS/FF/SF 与 lagDays 可改；可删除；
- 成环时依赖行标红 + 提示，但**允许保存**；
- 顶部保存指示三态联动 Autosave；Ctrl+Z 撤销走 CommandBus；
- 组件测试覆盖建依赖 / 改日期 / 成环标红。

【第 3 步 · 边界与协调（重要，违反即返工）】
- **commandBus 扩命令是本任务唯一允许碰 src/domain 的例外**：只加 link.create / link.delete / link.patch 三种 MutationType + 对应 reduce 分支 + 三个命令工厂（createLinkCommand / deleteLinkCommand / patchLinkCommand）。**不要改 task.* / settings.patch 的既有行为**，不要动别的 domain 文件。删除的 inverse 要带完整 link 体与原下标（参照 deleteTaskCommand），patch 的 inverse 走字段级还原（参照 patchTaskCommand/invertPatch）——二者是 undo 语义唯一性的关键。
- **点击接线不要你做**：BoardView 的 onOpenTask、GanttCanvas 的 data-gantt-bar 点击，都由集成窗口在 App.tsx 里接线。TaskDrawer 只暴露受控契约（如 open / taskId / onOpenChange / onSelect 之类），**在组件测试里用 rerender 驱动 props 验证「外部传入 taskId → 抽屉打开并定位」**。
- **不要改 src/App.tsx、src/views/BoardView.tsx、src/views/GanttCanvas.tsx、src/views/GanttView.tsx**。
- 笔记分区**只做占位**（T24 NoteEditor 未实现）：不要 import 尚不存在的 NoteEditor；留一个标注"笔记由 T24 接入"的空位即可。
- 组件必须可挂载：默认导出 + 显式 props；数据读写经 store / CommandBus（link 操作走你新加的 link 命令）。
- 改 src/locales/* 时遵守本文档第 0 节的「locales 追加规则」：只加新的顶层键块、插在 safemode 之后、自带闭合、zh/en 同步。

【第 4 步 · 完工闭环】
- 逐条勾选 task.md 中 T17 的验收标准。
- 总表状态改为 done，写 (2026-10-16, <agent>, <commit 主题行>)。
- 在 task.md 文末《完成记录》追加一条：task / agent / commit / 验收自检摘要 / 遗留问题（**务必写明「点击接线待集成窗口」**）。
- 上述 task.md 改动必须与代码变更在同一个 commit，禁止单独提交状态。commit message 以 "T17: " 开头。
- 运行 npm test 与 npx tsc --noEmit，确保全绿。
- 提交前执行：git checkout -- package-lock.json

【纪律 · 违反即返工】
- 不改 package.json；不提交 package-lock.json 差异；不改 src/App.tsx；不碰 GanttView.tsx / GanttCanvas.tsx / BoardView.tsx；除 commandBus 的 link 命令外不碰 src/domain/*；不碰 milestone / persistence 车道的文件。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、commandBus 新增命令类型、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 H · 窗口（车道 H 里程碑 → T16）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T16 · FilterBar（组合筛选 UI + lastFilter 落盘）。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-milestone
当前已检出分支 feat/lane-milestone（T18 已完成合入，本任务的文件域与本波 T17 完全不重叠）。开工前先执行：git rebase feat/foundation。不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读项目根目录 task.md，重点：《Global Constraints》《状态同步协议》《分支与合入约定》《### T16》明细，以及已 done 的《### T13》（QueryEngine，筛选语义都在这儿）、《### T15》（看板消费筛选结果的手法）。
2. 读 spec 的 §6.2（筛选 QueryEngine）、§3（三条硬规则）、§7（UI 视觉规范）。
3. 读现有实现，确认接缝（不要重造）：
   - src/domain/queryEngine.ts（T13）：createQueryEngine(topics, tasks, links).query(filter) 与 createEmptyFilter()。**Filter 的全部字段语义在此实现，你只做 UI 与落盘**，不要重写查询逻辑。
   - src/domain/types.ts：Filter（topicIds/includeDescendants、statuses、kinds、priorities、tags/tagMode、assignees、dateRange、overdueOnly/blockedOnly/withNotesOnly、includeArchived、text、upstreamDepth/downstreamDepth）。
   - src/domain/commandBus.ts（T10）：settings.patch 命令已就绪——lastFilter 落盘走它（不要改 commandBus.ts）。
   - src/views/TopicSidebar.tsx（T14）：看清它的色点 / 标签 / 底部入口的视觉语言，FilterBar 要与它同一套。
   - src/views/MilestonePanel.tsx（T18）：右侧抽屉面板的先例；FilterBar 若是弹出面板可参考它的开合与视觉。
   - src/styles/theme.css：--oe-* token。颜色一律取 token，不写死 hex。

【第 1 步 · 登记】
总表中 T16 状态改为 in_progress，写 (2026-10-16, <你的模型名>:<会话短id>)。

【第 2 步 · 实施】
只改本任务「产出」清单内的文件：
  src/views/FilterBar.tsx
  src/controllers/filters.ts
  tests/views/FilterBar.test.tsx
严格按 T16 的 5 条验收标准逐条实现，不得遗漏：
- 提供 chips：状态 / 类别 / 优先级 / 标签(any|all) / 负责人 / 日期范围 / 逾期 / 被阻塞 / 有笔记 / 含归档 + 全文搜索框；
- 依赖跳数输入：上游 N 跳 / 下游 N 跳（0–3）；
- 筛选变更写入 settings.lastFilter 并落盘；重开应用恢复；
- 看板与甘特图共用同一 QueryEngine 结果（切视图条件不丢，组件测试）；
- 清空按钮一键重置；组件测试覆盖落盘与恢复。

【第 3 步 · 边界与协调（重要，违反即返工）】
- **筛选的计算逻辑必须抽成 src/controllers/filters.ts 里的纯函数**：如「给定 Filter + 一次 chip 切换 → 新 Filter」「Filter → 是否非空 / 清空」等。组件只负责渲染与把结果写回 store/CommandBus，纯函数才能被可靠单测。
- lastFilter 的写入口走 CommandBus 的 settings.patch（已就绪）；**不要改 src/domain/commandBus.ts**（那是 T10 文件域）。
- 组件必须可挂载：导出默认组件 + 显式 props（current filter / onChange / t 等由外部传入）。**不要改 src/App.tsx**——FilterBar 挂到侧栏「筛选器」入口由集成窗口接线。
- **不要 import 尚不存在的组件**（TaskDrawer T17 / NoteEditor T24 / BackupPanel T28 都还没实现）。
- 看板与甘特共用筛选是「同一份 Filter 交给两边各自的 QueryEngine」，不要把查询结果本身传进 FilterBar；FilterBar 只产出 Filter。
- 改 src/locales/* 时遵守本文档第 0 节的「locales 追加规则」：只加新的顶层键块、插在 safemode 之后、自带闭合、zh/en 同步。

【第 4 步 · 完工闭环】
- 勾选验收标准 → 总表改 done 写 (2026-10-16, <agent>, <commit 主题行>) → 文末《完成记录》追加一条（含遗留问题）。
- 与代码同一 commit，message 以 "T16: " 开头。
- 跑 npm test 与 npx tsc --noEmit，全绿。
- 提交前执行：git checkout -- package-lock.json

【纪律 · 违反即返工】
- 不改 package.json / package-lock.json；不改 src/App.tsx；不碰 src/domain/*；不碰 T17（TaskDrawer/DependencyEditor/commandBus）与 gantt / persistence 车道的文件。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 F · 窗口（车道 F 甘特 UI → T23）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T23 · GanttExporter（PNG / SVG / CSV）。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-gantt
当前已检出分支 feat/lane-gantt。开工前先执行：git rebase feat/foundation（同步到主干最新 tip）。不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读项目根目录 task.md，重点：《Global Constraints》《状态同步协议》《分支与合入约定》《### T23》明细，以及已 done 的《### T19》（ganttModel，导出几何来源）、《### T20》《### T21》（渲染层，SVG 结构与箭头 path 来源）。
2. 读 spec 的 §5.5（导出）、§5.4（渲染要点）、§3（三条硬规则）、§9（构建与交付：产物零网络请求）。
3. 读现有实现，确认接缝（不要重造）：
   - src/domain/ganttModel.ts（T19）：buildGanttModel(vault, filter, scale, viewport) 已算出 rows/arrows/today/criticalIds/unscheduled——**CSV 的数据直接来自模型，不要重算排期**。
   - src/views/GanttCanvas.tsx（T20/T21）：SVG 结构与箭头 path 已就绪；T21 已把 dependencyArrowPath / routeAnchoredArrow 导出，可复用。
   - src/views/GanttView.tsx（T20/T21）：工具栏挂点（gantt-scale-* / gantt-zoom-* / gantt-baseline-toggle / 关键路径 checkbox）。**本任务授权你在工具栏加导出入口**（见边界）。
   - src/controllers/ganttViewport.ts：viewport 控制器（范围可选「仅可见区 / 全时间跨度」需要它）。
   - **T01 的 R3 结论（已 PASS，直接采用，不必重跑 spike）**：内联样式的 SVG → data URI → Image → Canvas(2x) → toBlob 在 file:// 下**不 taint**，可导出 PNG。
   - src/styles/theme.css：颜色 token；SVG 呈现属性（fill=/stroke=）必须写字面量 hex（与 GanttCanvas 顶部注释一致）。

【第 1 步 · 登记】
总表中 T23 状态改为 in_progress，写 (2026-10-16, <你的模型名>:<会话短id>)。

【第 2 步 · 实施】
只改本任务「产出」清单内的文件：
  src/views/GanttExporter.ts
  tests/views/ganttExporter.test.ts
  src/views/GanttView.tsx   ← 仅加导出入口（工具栏按钮 + 格式/范围选择）
严格按 T23 的 5 条验收标准逐条实现，不得遗漏：
- 导出前把计算样式写成 SVG 内联属性（不留 class）；font-family 显式系统栈（否则 canvas taint）；
- PNG：SVG → data URI → Image → Canvas(2x) → toBlob → 下载；R3 失败时该按钮禁用并提示；
- SVG：序列化直接下载；CSV：任务+开始+结束+进度+依赖，带 UTF-8 BOM；
- 范围可选：仅可见区 / 全时间跨度；
- 单测以 jsdom + mock canvas 覆盖三格式与 BOM。

【第 3 步 · 边界与协调（重要，违反即返工）】
- **导出入口挂在 GanttView.tsx 工具栏是本任务范围的合理包含**：e2e/05-export.spec.ts 的 fixme 用例期望「打开甘特 → 点导出 → 选格式 → 断言数据文件夹多出文件」，需要 UI 入口。本任务在 F 车道内串行（T22 未开工），改 GanttView.tsx 不与他人冲突。**当你只改工具栏与导出触发部分，不要改动 GanttView 既有行为（刻度/缩放/基线/关键路径）**。
- **不要做 T22 的未排期侧栏**（那是同车道下一站，依赖 T16）。T20 已交付的未排期折叠面板保持原样。
- PNG 的 taint 前提：SVG 内不引用任何外部字体或图片。**导出前务必把 CSS 变量/类样式展开成内联属性**，并确保不把 blob:/http(s) 资源写进 SVG。R3 若在真实环境失败（理论上不会），按钮禁用并提示，不要静默出错。
- **不要改 src/App.tsx、src/domain/*、src/controllers/*（除只读引用）**；不要 import 尚不存在的组件（T22 侧栏、T16 FilterBar）。
- 改 src/locales/* 时遵守本文档第 0 节的「locales 追加规则」：只加新的顶层键块、插在 safemode 之后、自带闭合、zh/en 同步。

【第 4 步 · 完工闭环】
- 勾选验收标准 → 总表改 done 写 (2026-10-16, <agent>, <commit 主题行>) → 文末《完成记录》追加一条（含遗留问题）。
- 与代码同一 commit，message 以 "T23: " 开头。
- 跑 npm test 与 npx tsc --noEmit，全绿；跑 npm run e2e，确认既有 21 条仍绿（**不要自行启用 05-export 的 fixme**，由集成窗口在合入后启用）。
- 提交前执行：git checkout -- package-lock.json

【纪律 · 违反即返工】
- 不改 package.json / package-lock.json；不改 src/App.tsx；不碰 src/domain/*；除 GanttView.tsx 的导出入口外不碰其他视图；不碰 board-ui / milestone 车道的文件。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、导出入口的触发方式（按钮 data-testid）、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 D · 窗口（车道 D 持久化）——本波空置

本波**不要启动 D 车道**。`oe-lane-persistence` 的下一站 T26（清理未引用附件）依赖 T25（E 车道的 T24→T25 链），T28 又依赖 T26，二者都堵在 E 链后面。等 E 车道把 T25 做完、集成窗口合入后，再按第五波派工启动。

---

## 提示词 X · 窗口（集成 / 车道 G → 合入 + App.tsx 接线）

> 前提：三条车道（T17 / T16 / T23）至少各有一次提交；且确认没有别的 agent 正在 `C:\Users\18304\Desktop\TaskDone` 里改东西。

```text
你是 OffEarly（早下班）项目的集成 agent（车道 G）。你独占主干，负责合入与全库接线。

【工作目录】
C:\Users\18304\Desktop\TaskDone
当前已检出主干分支 feat/foundation。你是本仓库唯一允许向 feat/foundation 合入的角色。

【第 1 步 · 逐个合入车道（每完成一个车道任务就合一次，别攒）】
先确认本工作树干净：git status --porcelain 必须为空。
  git merge --no-ff feat/lane-board-ui  -m "merge: T17 (lane-board-ui)"
  git merge --no-ff feat/lane-milestone -m "merge: T16 (lane-milestone)"
  git merge --no-ff feat/lane-gantt     -m "merge: T23 (lane-gantt)"
task.md 冲突按《状态同步协议》第 7 条处理：按 git 时间序合并，状态取较晚完成者，《完成记录》两侧条目都要保留（只增不删）。
src/locales/* 冲突用一次性脚本 scripts/resolve-conflict.mjs 按 <<<<<<< / ======= / >>>>>>> 标记做并集（条目单行可达数千字符，不要手抄），zh.ts 用 addBraceAfterHead 补顶层闭合 `},`，**并人工检查 zh.ts 每个新增键块是否都有闭合 `},`**（缺则补）；en.ts 是扁平表、键集合必须与 zh 严格一致。
注意 T17 合入会带 src/domain/commandBus.ts 的新增（link 命令）——确认它只新增、未改既有 task.* / settings.patch 行为；合入后跑 tsc 确认。

【第 2 步 · 验证（本波无新依赖，不重生成 lock）】
本波 T17/T16/T23 都不加 npm 依赖，故**无需 npm install**。直接跑：
  npm test && npx tsc --noEmit && npm run build && npm run e2e
全部绿了再继续。若 package-lock.json 意外出现差异，单独 commit（chore: regenerate lock after <Txx>）。任一步红：先修再合下一个。

【第 3 步 · App.tsx 接线（只有你能改 src/App.tsx）】
- TaskDrawer（T17）：把 BoardView 的 onOpenTask(taskId) 与甘特条点击接到 TaskDrawer。手法参照既有 MilestonePanel 接线——App 顶层持受控状态（如 drawerTaskId / open），BoardView 传 onOpenTask，甘特条用 Workspace 外层 div 事件委托捕获 closest('[data-gantt-bar]')（与菱形 data-gantt-milestone 同一手法，零侵入 GanttView/GanttCanvas）。
- FilterBar（T16）：把侧栏底部「筛选器」入口从 panelPlaceholder('sidebar.filters') 换成真面板；若 FilterBar 是弹出/抽屉面板，按它的受控契约接线。**切视图不丢筛选**（看板与甘特已经共用 settings.lastFilter，接线后确认生效）。
- 甘特导出入口（T23）：T23 已在 GanttView 工具栏挂好，确认 App.tsx 不需额外传参；若导出需要 vault/filter，从其 props 契约核对。
- 底部四个入口：里程碑（已接 MilestonePanel，保持）、筛选器（本波接真面板）、备份(T28)/设置 仍保持 panelPlaceholder，不要引用不存在的组件。
- 接线完成后跑 npm run build，确认 dist/OffEarly.html 仍满足单文件不变式（无外链 script/link、无 type="module"、无 http(s) 资源引用）；再跑 npm run e2e。
- 启用 e2e/05-export.spec.ts 的「图表导出」fixme：T23 落地且有 UI 入口后，把它从 test.fixme 改为正式 test（步骤：打开甘特 → 点导出 → 选格式 → 断言数据文件夹多出对应文件）。另一条「拖拽换列与图片粘贴」仍依赖 T24，**保持 fixme 不动**。

【第 4 步 · 通知车道 rebase】
  git -C C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-board-ui  rebase feat/foundation
  git -C C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-milestone rebase feat/foundation
  git -C C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-gantt     rebase feat/foundation
（E 车道接着做 T24，F 车道接着做 T22，都要 rebase 后再开工。）

【第 5 步 · 后续你的职责】
- 下一波派工（依赖解锁后）：
  · E 车道（board-ui）：T24（←T17，会新增 TipTap 依赖）→ T25（←T24）
  · F 车道（gantt）：T22（←T20、T16，同车道串行接在 T23 之后）
  · D 车道（persistence）：T26（←T25）→ T28（←T09、T26）
  · H 车道（milestone）：T16 做完后空出，本波无后续任务（T22 属 F，T26/T28 属 D）
- 每合入一个任务，通知对应车道 rebase 到最新主干再继续下一站。
- T24 会加 TipTap：届时只有 E 车道改 package.json，合入后主干必须 npm install 重生成 lock。

【纪律】
- 你是热文件（task.md / src/App.tsx / package.json / package-lock.json）的唯一写者，别让别人同时改。
- 不要改动车道分支上尚未合入的代码。
- 每一步合入后先让测试全绿再继续。
```

---

## 合入流水线（每个车道任务都走一遍）

```bash
# 1) 车道侧：提交后自查（在车道 worktree 内）
npm test && npx tsc --noEmit

# 2) 集成侧：确认主干干净后合入
cd C:/Users/18304/Desktop/TaskDone
git status --porcelain          # 必须为空
git merge --no-ff feat/lane-<x> -m "merge: <Txx> (lane-<x>)"

# 3) 集成侧：验证（本波无新依赖；若改了 package.json 才 npm install + 提交 lock）
npm test && npx tsc --noEmit && npm run build && npm run e2e

# 4) 其他车道 rebase 到最新主干
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-<y> && git rebase feat/foundation
```

---

## 禁忌清单

- 禁止两个窗口同时改 `task.md` / `src/App.tsx` / `package.json` / `package-lock.json`。
- 禁止车道窗口自行合入主干（只有集成窗口可以）。
- 禁止提交 `package-lock.json` 的车道差异（提交前 `git checkout -- package-lock.json`）。
- 禁止一个窗口同时持有两个 `in_progress`。
- 禁止分支活过 1 天：一个任务做完立刻合，别攒。
- 禁止车道 import 尚未实现的面板组件（TaskDrawer T17 / NoteEditor T24 / BackupPanel T28 / 未排期侧栏 T22）。
- **除 T17 授权扩展 `src/domain/commandBus.ts` 的 link 命令外，禁止车道改 `src/domain/*` 与 `src/App.tsx`**；需要领域层补算时先在回复里报告，由集成窗口裁决。
- 禁止往 `src/locales/*` 既有键块内部塞子键；一律追加新的顶层键块（插在 `safemode` 之后、自带闭合 `},`），zh/en 键集合严格一致。
- 禁止 T23 改动 GanttView 既有行为（刻度/缩放/基线/关键路径）——只加导出入口。
- 卡片禁条纹 / 禁整卡底色（C 方案），这是硬约束不是风格偏好。
