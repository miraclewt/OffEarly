# 车道启动指令包 · 第三波（OffEarly · trunk-based 短分支）

> 用法：另开 **3 个对话框**，把下面【提示词 E / F / H】整段复制粘贴发送，即可并行开工。
> 第 4 个对话框在三条车道有产出后再用【提示词 X】做集成。
> 每个提示词都是自包含的——新窗口看不到任何上下文，**不要删减路径与步骤**。
>
> 第一波 `docs/lane-launch-prompts.md`（T09–T12）、第二波 `docs/lane-launch-prompts-wave2.md`（T14/T20/T27）均已完成并合入主干，仅作留档。

---

## 0. 开工前的既定事实（供你自己对照，不要贴进提示词）

| 事项 | 状态 |
|---|---|
| 主干分支 | `feat/foundation`，检出在 `C:\Users\18304\Desktop\TaskDone` |
| 主干 tip | `f29bbb0`（本文写作时；开工前以 `git log --oneline -1` 为准），工作树**干净** |
| 已完成 | **T01–T14、T19、T20、T27、T29、T30–T33** 全部 done |
| 剩余 | **T15、T16、T17、T18、T21、T22、T23、T24、T25、T26、T28** |
| 本波可并行 | **T15 ∥ T21 ∥ T18**（文件域互斥，见下表） |
| 关键路径 | T15 → T16/T17 → T24 → T25 → T26 → T28（**T15 是全项目剩余部分的关键路径头**） |
| 本波之后才解锁 | T16/T17(←T15)、T22(←T16)、T23(←T21 同车道)、T24(←T17)、T25(←T24)、T26(←T25)、T28(←T26) |

**三条已有车道都在 `2914f2f`，落后主干两个只改 `task.md` 的 commit，开工前必须先 rebase：**

```bash
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-board-ui && git rebase feat/foundation
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-gantt    && git rebase feat/foundation
```

`oe-lane-milestone` 是本波新建的 worktree（分支 `feat/lane-milestone`，已从主干 tip 切出、已装依赖），**无需 rebase**。

**并发配额：** 本波只放 3 条车道。`oe-lane-persistence` 本波**没有可做的活**（T26←T25、T28←T26 都堵在 E 链后面），保持空置，不要往里派任务。

### 文件域互斥表（本波 3 条车道为什么能并行）

| 车道 | 任务 | 独占文件 | 是否新增依赖 |
|---|---|---|---|
| E 看板 UI | T15 | `src/views/BoardView.tsx` `src/views/BoardColumn.tsx` `src/views/TaskCard.tsx` `src/controllers/boardDnd.ts` `tests/views/BoardView.test.tsx` **`package.json`** | **是：dnd-kit** |
| F 甘特 UI | T21 | `src/views/GanttCanvas.tsx` `src/views/GanttView.tsx` `tests/views/ganttArrows.test.tsx` | 否 |
| H 里程碑 | T18 | `src/views/MilestonePanel.tsx` `tests/views/MilestonePanel.test.tsx` | 否 |
| —— | —— | `task.md`、`src/locales/{zh,en}.ts` | **三条都会碰，必然冲突，按协议第 7 条解** |

### 依赖新增规则（本波只有 E 车道适用）

- E 车道可以改 `package.json` 加 dnd-kit，但**禁止提交 `package-lock.json` 的车道差异**：提交前执行 `git checkout -- package-lock.json` 还原。
- 合入后由集成窗口统一 `npm install` 重生成 lock，并单独 commit（`chore: regenerate lock after T15`）。
- F / H 车道**不要动 `package.json`**。

### `src/locales/*` 追加规则（三条车道必读，否则合入后 `tsc` 语法错）

历史教训：`zh.ts` 是**嵌套**表，多个车道各自「尾部追加」时，git 会把两侧新块的闭合 `},` 当成同一行公共上下文，解析后出现「上一个键块丢闭合括号、下一个键块被嵌进去」→ **语法错误**，而 `en.ts`（扁平、无内层大括号）不会中招，容易误判为已修好。

因此本波统一约定：

1. **一律追加新的顶层键块**（如 `board: { ... },`、`ganttArrows: { ... },`），**不要往既有键块内部塞子键**。
2. 插入位置统一在 `safemode: { ... },` 之后、`} as const` 之前（即文件现有物理末尾）。
3. 每个新块**自带完整闭合 `},`**，不要依赖别处的括号。
4. `en.ts` 是扁平 `'a.b': 'x'` 表，且类型是 `Record<MsgKey, string>`——**zh 与 en 的键集合必须严格一致**，少一条翻译 tsc 立刻报错。追加时两边同步。
5. 集成窗口解冲突：按 git 时间序取并集 → **人工检查 zh 每个新增块是否都有 `},`**（缺则补）→ 跑 `npx tsc --noEmit` 确认。

---

## 提示词 E · 窗口（车道 E 看板 UI → T15）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T15 · BoardView + TaskCard（C 方案卡片 / dnd-kit 拖拽 / 阻塞标记）。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-board-ui
当前已检出分支 feat/lane-board-ui。开工前先执行：git rebase feat/foundation（同步到主干最新 tip）。不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读项目根目录 task.md，重点：《Global Constraints》《状态同步协议》《分支与合入约定》《### T15》明细。
2. 读 spec（docs/superpowers/specs/2026-10-15-taskdone-architecture-design.md）的 §6.1（看板）、§6.2（筛选，看板与甘特共用同一份 QueryEngine 结果）、§3（三条硬规则 + 模块清单）、§7（UI 视觉规范）。
3. 读现有实现，确认可复用的能力都已就绪，不要重造：
   - src/domain/queryEngine.ts（T13）：createQueryEngine(topics, tasks, links).query(filter)
   - src/domain/dependencyGraph.ts（T12）：isBlocked(id) = 存在 status≠done 的直接前置
   - src/domain/lexorank.ts（T10）：mid() 生成同列排序键
   - src/domain/types.ts：Task.status 四态、kind 五类、priority P0-P3、tags/note/archived
   - src/views/TopicSidebar.tsx（T14）：看它怎么用 t() 与色点，卡片的话题标识要与它同一套色
   - src/styles/theme.css：--oe-* token（--oe-accent / --oe-overdue / --oe-blocked / --oe-radius-card / --oe-surface / --oe-border / --oe-text 等）。**颜色一律取 token，不要写死 hex**；唯一例外是 SVG 呈现属性（fill=/stroke=）不解析 var()，必须写字面量。
   - src/views/IconSprite.tsx：现有图标名含 note / dependency / calendar / clock / close / plus，卡片角标直接用，不要新增图标。

【第 1 步 · 装依赖（本任务独有）】
执行：npm install @dnd-kit/core @dnd-kit/sortable
以 npm 解析到的版本为准，把版本号写进 package.json 的 dependencies。若报 peer 依赖冲突，先试 npm install @dnd-kit/core @dnd-kit/sortable --legacy-peer-deps，并在回复里说明。
注意：package-lock.json 的改动**不要提交**（见纪律）。

【第 2 步 · 登记】
把 task.md《任务总表》中 T15 的状态由 pending 改为 in_progress，并写 (2026-10-15, <你的模型名>:<会话短id>)。

【第 3 步 · 实施】
只改本任务「产出」清单内的文件：
  src/views/BoardView.tsx
  src/views/BoardColumn.tsx
  src/views/TaskCard.tsx
  src/controllers/boardDnd.ts
  tests/views/BoardView.test.tsx
严格按 T15 的 6 条验收标准逐条实现，不得遗漏：
- 固定四列 todo/doing/review/done，列头含列名 + 计数 + 完成比；
- 卡片仅 6 项：色点+话题名、标题、类别 chip、优先级点、到期日（逾期用 --oe-overdue 即 #DC2626）、依赖角标；有笔记加文档图标；**无任何条纹/整卡底色**（Global Constraints 明令禁止左色条/顶线/整卡底色）；
- dnd-kit 跨列拖拽改 status、同列拖拽改 order（LexoRank mid）；拖拽后**仅被拖记录 order 变化**；
- 拖入 doing/review 时若 isBlocked 显示琥珀色阻塞标记（--oe-blocked），不阻止拖放；
- 归档任务不渲染；筛选结果驱动列内容；
- 组件测试覆盖拖拽换列与阻塞标记。

【第 4 步 · 边界与协调（重要，违反即返工）】
- **拖拽的判定逻辑必须抽成 src/controllers/boardDnd.ts 里的纯函数**（入参：links/tasks/被拖 id/目标列/目标邻居 → 出参：要 apply 的 Command 或 Store 更新）。jsdom 下 dnd-kit 的 pointer 事件序列很难稳定模拟，纯函数才能被可靠单测；DOM 层测试只断言渲染结构与阻塞标记，不要试图在 jsdom 里复刻完整拖拽手势。
- 数据读写一律经现有 store / CommandBus（src/domain/store.ts、src/domain/commandBus.ts）。若现有 MutationType 只有 task.* 与 settings.patch，就用已有的 task 写命令；**不要改 domain/commandBus.ts 扩命令类型**（那是 T10 的文件域，已合入主干，改它会引起跨车道冲突）。
- 组件必须可挂载：导出默认组件 + 显式 props 接口。签名参照 src/views/GanttView.tsx 的既有手法——vault / filter / t / onOpenTask 等全部由外部传入，**从 store 派生是集成窗口的活**。
- TaskDrawer（T17）尚未实现：卡片点击只暴露 onOpenTask(taskId) 回调 props，**不要 import 尚不存在的 TaskDrawer**。
- FilterBar（T16）尚未实现：**不要 import 尚不存在的 FilterBar**；BoardView 接收外部算好的 filter 即可。
- **不要改 src/App.tsx**（集成窗口负责把 EmptyBoard 占位换成 BoardView）。但要注意：App.tsx 现有占位带 data-testid="board"，你的 BoardView 根元素**必须保留 data-testid="board"**，否则 E2E 会挂。
- 改 src/locales/* 时遵守本文档第 0 节的「locales 追加规则」：只加新的顶层键块、插在 safemode 之后、自带闭合、zh/en 同步。

【第 5 步 · 完工闭环】
- 逐条勾选 task.md 中 T15 的验收标准。
- 总表状态改为 done，写 (2026-10-15, <agent>, <commit 主题行>)。
- 在 task.md 文末《完成记录》追加一条：task / agent / commit / 验收自检摘要 / 遗留问题。
- 上述 task.md 改动必须与代码变更在同一个 commit，禁止单独提交状态。commit message 以 "T15: " 开头。
- 运行 npm test 与 npx tsc --noEmit，确保全绿。
- 提交前执行：git checkout -- package-lock.json

【纪律 · 违反即返工】
- 不提交 package-lock.json 的差异；不改 src/App.tsx；不碰 gantt / milestone 车道的文件（src/views/GanttCanvas.tsx、GanttView.tsx、MilestonePanel.tsx 一律不碰）；不碰 src/domain/*。
- 卡片禁条纹/禁整卡底色（C 方案），这是产品"简洁"主张的硬约束，不是风格偏好。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、dnd-kit 实际安装版本、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 F · 窗口（车道 F 甘特 UI → T21）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T21 · 依赖箭头 + 关键路径高亮 + hover 依赖高亮。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-gantt
当前已检出分支 feat/lane-gantt。开工前先执行：git rebase feat/foundation（同步到主干最新 tip）。不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读项目根目录 task.md，重点：《Global Constraints》《状态同步协议》《分支与合入约定》《### T21》明细，以及《### T19》《### T20》两条已 done 的明细（你的实现基础）。
2. 读 spec 的 §5.3（DependencyGraph）、§5.4（渲染要点）、§5.1（数据流与输入契约）、§3（三条硬规则）、§7（UI 视觉规范）。
3. 读现有实现，确认接缝：
   - src/domain/ganttModel.ts（T19）：buildGanttModel(vault, filter, scale, viewport) 已算出 rows/arrows/today/criticalIds/cycles/unscheduled。Arrow 类型已带 from/to/x/y/points 等字段，**几何不要重算**。
   - src/domain/dependencyGraph.ts（T12）：criticalPath() 返回总浮动=0 的任务 id 集合；含环时返回 null，此时 ganttModel 把 criticalIds 置为 emptySet 且 model.cycles 非空（spec 5.3 降级）。
   - src/views/GanttCanvas.tsx：**箭头层已被 T20 刻意独立成导出子组件 `<GanttArrowsLayer>`（约 80-120 行，props 接口 GanttArrowsLayerProps 明确导出）**，注释里写明就是留给 T21 扩展的。你的主要工作在这个子组件里。
   - src/views/GanttView.tsx：工具栏挂点在 160-260 行（gantt-scale-day/week、gantt-zoom-*、gantt-baseline-toggle），「关键路径」checkbox 加在这里。

【第 1 步 · 登记】
总表中 T21 状态改为 in_progress，写 (2026-10-15, <你的模型名>:<会话短id>)。

【第 2 步 · 实施】
只改本任务「产出」清单内的文件：
  src/views/GanttCanvas.tsx（箭头层与相关子组件）
  src/views/GanttView.tsx（工具栏「关键路径」checkbox 与状态）
  tests/views/ganttArrows.test.tsx
严格按 T21 的 6 条验收标准逐条实现，不得遗漏：
- 箭头为折线 path + marker-end；FS/SS/FF/SF 四种锚点正确（SS 左→左、FF 右→右、FS 右→左、SF 左→右）；
- 环上依赖箭头红色虚线；criticalIds 任务条描边加粗；
- 「关键路径」checkbox 关闭时不加粗、不计算展示（默认开）；
- hover 某条：高亮其全部直接依赖（前后各一跳）箭头与条，其余透明度降至 0.25；
- 今日线 1px 红 + 顶部标签；
- 组件测试覆盖四锚点与环标红。

【第 3 步 · 边界与协调（重要，违反即返工）】
- **T19 已移交的遗留，正是你本轮要补的**：当前箭头一律按「前置右端 → 后置左端」连线，SS/FF/SF 的端点分支没做。用 Link 自带的 type/lagDays 字段分流，**不要改 ganttModel.ts**（T19 已合入主干，改它会引起跨车道冲突）；如果箭头坐标确实需要在领域层补算，那是缺陷——先在回复里报告，由集成窗口裁决，不要自行扩大文件域。
- 关键路径的**计算**已在 domain 层完成（criticalPath），你只做投影与开关，不要在这里重算 CPM。
- **不要做 T22 的未排期侧栏**（那是下一站，依赖 T16）。T20 已交付的未排期折叠面板保持原样，不要改动它的行为。
- **不要改 src/App.tsx**；不要 import 尚不存在的组件（T22 侧栏、T16 FilterBar）。
- 颜色：高亮/虚线等用 --oe-* token；SVG 呈现属性（stroke=/fill=）不解析 var()，必须写字面量 hex（与 GanttCanvas 顶部现有注释一致）。
- 改 src/locales/* 时遵守本文档第 0 节的「locales 追加规则」：只加新的顶层键块、插在 safemode 之后、自带闭合、zh/en 同步。

【第 4 步 · 完工闭环】
- 勾选验收标准 → 总表改 done 写 (2026-10-15, <agent>, <commit 主题行>) → 文末《完成记录》追加一条。
- 与代码同一 commit，message 以 "T21: " 开头。
- 跑 npm test 与 npx tsc --noEmit，全绿。
- 注意：tests/views/GanttView.test.tsx 是 T20 的既有用例（20 条），你的改动不要把它改红；若必须调整既有断言，在完成记录里写明原因。

【纪律 · 违反即返工】
- 不改 package.json / package-lock.json；不改 src/App.tsx；不碰 board-ui / milestone 车道的文件；不碰 src/domain/*。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 H · 窗口（车道 H 里程碑 → T18）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T18 · MilestonePanel（里程碑 CRUD）。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-milestone
当前已检出分支 feat/lane-milestone（已从主干 tip 切出），不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读项目根目录 task.md，重点：《Global Constraints》《状态同步协议》《分支与合入约定》《### T18》明细，以及《### T14》（TopicSidebar，已 done，你的入口就在它上面）、《### T20》（GanttView，已 done，菱形渲染在那儿）。
2. 读 spec 的 §6.5（里程碑、基线与 topic 管理）、§3（三条硬规则）、§7（UI 视觉规范）。
3. 读现有实现，确认接缝：
   - src/domain/types.ts：Milestone 类型（id/title/date/topicId/完成态/颜色）；topicId=null 表示跨 topic 里程碑。
   - src/views/TopicSidebar.tsx（T14）：底部已有「里程碑」入口按钮，**data-testid="sidebar-open-milestones"**，且已声明 onOpenMilestones 回调 props——你的面板就是被这个回调拉起来的。
   - src/views/GanttCanvas.tsx：里程碑菱形由 MilestoneDiamond 子组件渲染（约 122 行），**但本任务不要改这个文件**（见边界）。
   - src/styles/theme.css：颜色取 --oe-* token，不要写死 hex。

【第 1 步 · 登记】
总表中 T18 状态改为 in_progress，写 (2026-10-15, <你的模型名>:<会话短id>)。

【第 2 步 · 实施】
只改本任务「产出」清单内的文件：
  src/views/MilestonePanel.tsx
  tests/views/MilestonePanel.test.tsx
严格按 T18 的 5 条验收标准逐条实现，不得遗漏：
- 侧栏「里程碑」入口打开列表面板；可新建/编辑/删除（标题、日期、所属 topic 或跨 topic、完成态、颜色）；
- 跨 topic 里程碑 topicId=null，列表置顶分组；
- 甘特图点击菱形打开同一编辑面板（事件联通）——本轮的落地方式见下方边界说明；
- 删除里程碑不影响任务与依赖；
- 组件测试覆盖 CRUD。

【第 3 步 · 边界与协调（重要，违反即返工）】
- **甘特菱形的 onClick 不要你接**：src/views/GanttCanvas.tsx 正被甘特车道（T21）修改，你碰它会造成合入冲突。验收第 3 条按「契约就绪」交付：
  · MilestonePanel 以 props 暴露选中契约（如 onSelect(milestone) / open(milestone) 或受控 openId + onOpenChange），使外部任何入口都能打开同一个面板；
  · 在组件测试里直接调用这些 props 验证「外部选中某里程碑 → 面板打开并定位到该条」；
  · 菱形点击的实际连线由集成窗口在 T21 合入后接线，你在完成记录里注明「菱形 onClick 待集成窗口接线」。
- 数据读写一律经现有 store / CommandBus。若 MutationType 里没有 milestone.* 命令，就用 store 的既有更新入口，**不要改 src/domain/commandBus.ts**（T10 文件域，已合入主干）。
- 组件必须可挂载：导出默认组件 + 显式 props 接口，**不要改 src/App.tsx**（集成窗口负责把 TopicSidebar 的 onOpenMilestones 从占位换成真面板）。
- **不要 import 尚不存在的组件**：FilterBar（T16）、TaskDrawer（T17）、BackupPanel（T28）都还没实现。
- 改 src/locales/* 时遵守本文档第 0 节的「locales 追加规则」：只加新的顶层键块、插在 safemode 之后、自带闭合、zh/en 同步。

【第 4 步 · 完工闭环】
- 勾选验收标准 → 总表改 done 写 (2026-10-15, <agent>, <commit 主题行>) → 文末《完成记录》追加一条。
- 与代码同一 commit，message 以 "T18: " 开头。
- 跑 npm test 与 npx tsc --noEmit，全绿。

【纪律 · 违反即返工】
- 不改 package.json / package-lock.json；不改 src/App.tsx；不碰 src/views/GanttCanvas.tsx、GanttView.tsx 与 board-ui 车道的任何文件；不碰 src/domain/*。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、commit 主题行与哈希、验收自检结果、遗留问题（务必写明「菱形 onClick 待集成窗口接线」）。
```

---

## 提示词 X · 窗口（集成 / 车道 G → 合入 + App.tsx 接线）

> 前提：三条车道至少各有一次提交；且确认没有别的 agent 正在 `C:\Users\18304\Desktop\TaskDone` 里改东西。

```text
你是 OffEarly（早下班）项目的集成 agent（车道 G）。你独占主干，负责合入与全库接线。

【工作目录】
C:\Users\18304\Desktop\TaskDone
当前已检出主干分支 feat/foundation。你是本仓库唯一允许向 feat/foundation 合入的角色。

【第 1 步 · 逐个合入车道（每完成一个车道任务就合一次，别攒）】
先确认本工作树干净：git status --porcelain 必须为空。
  git merge --no-ff feat/lane-board-ui    -m "merge: T15 (lane-board-ui)"
  git merge --no-ff feat/lane-gantt       -m "merge: T21 (lane-gantt)"
  git merge --no-ff feat/lane-milestone   -m "merge: T18 (lane-milestone)"
task.md 冲突按《状态同步协议》第 7 条处理：按 git 时间序合并，状态取较晚完成者，《完成记录》两侧条目都要保留（只增不删）。
src/locales/* 冲突用一次性脚本按 <<<<<<< / ======= / >>>>>>> 标记做并集（条目单行可达数千字符，不要手抄），并**人工检查 zh.ts 每个新增键块是否都有闭合 },**（缺则补），这是已知的语法错误陷阱；en.ts 是扁平表、键集合必须与 zh 严格一致。

【第 2 步 · 统一生成 lock 并验证（本波必做，T15 新增了 dnd-kit）】
  npm install            # 只有这一步能重生成 package-lock.json
  git add package-lock.json && git commit -m "chore: regenerate lock after T15"
  npm test && npx tsc --noEmit && npm run build && npm run e2e
全部绿了再继续。任一步红：先修再合下一个，不要把多个车道的不确定状态堆在一起。

【第 3 步 · App.tsx 接线（只有你能改 src/App.tsx）】
- 看板：把 Workspace 里的 EmptyBoard 占位换成 T15 的 BoardView。**保留 data-testid="board"**（e2e/01-startup.spec.ts 与 connectWorkspace 都靠它）。BoardView 的 vault/filter 从 store 派生，与 GanttView 同一手法（spec §6.2：看板与甘特共用同一份筛选结果）。
- 里程碑：把 TopicSidebar 的 onOpenMilestones 从 panelPlaceholder('sidebar.milestones') 换成真面板 MilestonePanel；同时把甘特菱形的 onClick 接上去（T18 只交付了 props 契约，这一跳归你）。
- T21 的「关键路径」checkbox 已在 GanttView 工具栏里，确认 App.tsx 不需要再传什么；若需要，从 store 派生后传入。
- 四个底部入口：里程碑已接真面板；筛选器(T16)/备份(T28)/设置 仍保持 panelPlaceholder，不要引用不存在的组件。
- 接线完成后跑 npm run build，确认 dist/OffEarly.html 仍满足单文件不变式（无外链 script/link、无 type="module"、无 http(s) 资源引用）；再跑 npm run e2e 确认 21 条仍全绿——E2E 是这套接线唯一的回归网。

【第 4 步 · 通知车道 rebase】
  git -C C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-gantt     rebase feat/foundation
  git -C C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-milestone rebase feat/foundation
（board-ui 车道接着做 T17，也要 rebase 后再开工。）

【第 5 步 · 后续你的职责】
- 下一波派工（依赖解锁后）：
  · E 车道（board-ui）：T17（←T15）→ T24（←T17）→ T25（←T24）
  · H 车道（milestone，T18 做完会空出来）：T16（←T15，与 T17 文件域互斥，可并行）
  · F 车道（gantt）：T23（←T21，同车道串行）→ T22（←T16，需等 H 的 T16）
  · D 车道（persistence，继续空置）：T26（←T25）→ T28（←T26）
- T23 依赖 T01 的 R3 结论（已 PASS：内联样式 SVG → data URI → Canvas → toBlob 不 taint），可直接按该结论实现，不必重跑 spike。
- 每合入一个任务，通知对应车道 rebase 到最新主干再继续下一站。

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

# 3) 集成侧：统一生成 lock 并验证（本波 T15 改了 package.json，必须做）
npm install && npm test && npx tsc --noEmit && npm run build && npm run e2e
git add package-lock.json && git commit -m "chore: regenerate lock after <Txx>"

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
- 禁止车道 import 尚未实现的面板组件（FilterBar T16 / TaskDrawer T17 / BackupPanel T28 / 未排期侧栏 T22）。
- 禁止车道改 `src/domain/*` 与 `src/App.tsx`；T21/T18 需要领域层补算时，先在回复里报告，由集成窗口裁决。
- 禁止往 `src/locales/*` 既有键块内部塞子键；一律追加新的顶层键块（插在 `safemode` 之后、自带闭合 `},`），zh/en 键集合严格一致。
- 禁止 H 车道（T18）碰 `src/views/GanttCanvas.tsx`——菱形 onClick 由集成窗口接线。
- 卡片禁条纹 / 禁整卡底色（C 方案），这是硬约束不是风格偏好。
