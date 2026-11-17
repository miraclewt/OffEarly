# 车道启动指令包 · 第二波（OffEarly · trunk-based 短分支）

> 用法：另开 **3 个对话框**，把下面【提示词 E / F / G】整段复制粘贴发送，即可并行开工。
> 第 4 个对话框在三条车道有产出后再用【提示词 X】做集成。
> 每个提示词都是自包含的——新窗口看不到任何上下文，**不要删减路径与步骤**。
>
> 第一波对应 `docs/lane-launch-prompts.md`（T09–T12），已完成并合入主干，仅作留档。

---

## 0. 开工前的既定事实（供你自己对照，不要贴进提示词）

| 事项 | 状态 |
|---|---|
| 主干分支 | `feat/foundation`，检出在 `C:\Users\18304\Desktop\TaskDone` |
| 主干 tip | `e304e4f`（含 T09–T13 与 T19 的合入），工作树**干净** |
| 已完成 | **T01–T13、T19** 全部 done |
| 本波可并行 | **T14 ∥ T20 ∥ T27**（文件域互斥，且三者都不新增第三方依赖） |
| 关键路径 | T20 → T30 → T31 → T32 → T33（**T20 是本波唯一落在关键路径上的任务**） |
| 本波之后才解锁 | T15(←T14)、T18(←T14)、T21/T22/T23(←T20)、T29(←T27 同车道)、T17(←T15) |

**并发配额：** 本波只放 3 条车道。T27 与 T29 都改 `src/persistence/vaultRepository.ts`，**必须同车道串行**，不能并排开两个窗口。

**车道 → 窗口对应：**

| 提示词 | 车道 | worktree | 本轮任务 | 后续同车道 |
|---|---|---|---|---|
| 提示词 E | 看板 UI（lane-board-ui） | `oe-lane-board-ui` | **T14** | T15 → T17 → T24 → T25 |
| 提示词 F | 甘特 UI（lane-gantt） | `oe-lane-gantt` | **T20** | T21 → T22 → T23 |
| 提示词 G | 持久化·安全（lane-persistence） | `oe-lane-persistence` | **T27** | T29 → T26 → T28 |
| 提示词 X | 集成·交付（lane-G） | `C:\Users\18304\Desktop\TaskDone` | 合入 + `App.tsx` 接线 | T30 → T31 → T32 → T33 |

**闲置车道（本波不要用）：** `oe-lane-depgraph` 与 `oe-lane-schedule` 的职责（T11/T12/T13/T19）已全部完成，本波没有它们的工作，保持空置。

**两个新 worktree 首次使用需先装依赖**（persistence 那个已有 `node_modules`，可跳过）：

```bash
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-board-ui && npm install
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-gantt    && npm install
```

---

## 提示词 E · 窗口（车道 E 看板 UI → T14）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T14 · TopicSidebar（树 / CRUD / 归档 / 里程碑入口）。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-board-ui
当前已检出分支 feat/lane-board-ui（已同步到主干 e304e4f），不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读项目根目录 task.md，重点四块：《Global Constraints》《状态同步协议》《分支与合入约定》《### T14》明细。
2. 读 docs/superpowers/specs/2026-10-15-taskdone-architecture-design.md 的 §6.5（主题、基线与 topic 管理）、§3（模块清单与分层硬规则）、§7（UI 视觉规范）。
3. 若 node_modules 不存在，先执行 npm install。

【第 1 步 · 登记】
把 task.md《任务总表》中 T14 的状态由 pending 改为 in_progress，并写 (2026-10-15, <你的模型名>:<会话短id>)。

【第 2 步 · 实施】
只改本任务「产出」清单内的文件：
  src/views/TopicSidebar.tsx
  src/controllers/topicActions.ts
  tests/views/TopicSidebar.test.tsx
严格按 T14 的 5 条验收标准逐条实现，不得遗漏：
- topic 树渲染（色块 swatch + 名称 + 计数 + chevron），无限层、默认展开两层；
- 悬浮「+」新建子话题；右键菜单含 重命名 / 改色 / 新建子话题 / 归档；
- 改色取固定 12 色调色板；归档 topic 后其任务从看板/甘特图消失；
- 点击 topic 设置筛选 topicIds；底部含「里程碑」「筛选器」「备份」「设置」四入口；
- 全部文案走 t()。

【第 3 步 · 边界与协调（重要）】
- 数据读写一律经现有 store / CommandBus（src/domain/store.ts、src/domain/commandBus.ts），不要把状态藏在组件里。
- 底部四个入口：本任务**只做可点击的入口按钮 + 回调 props**（如 onOpenMilestones / onOpenFilters / onOpenBackup / onOpenSettings）。
  里程碑面板(T18)、筛选栏(T16)、备份面板(T28) 尚未实现，**不要 import 尚不存在的组件**，面板挂载由集成窗口后续接线。
- 组件必须可挂载：导出默认组件 + 显式 props 接口，不要改 src/App.tsx 做接线（那是集成窗口的活）。
- 颜色语言与 T15 卡片色点共用同一套话题色，参照 §7。

【第 4 步 · 完工闭环】
- 逐条勾选 task.md 中 T14 的验收标准。
- 总表状态改为 done，写 (2026-10-15, <agent>, <commit 主题行>)。
- 在 task.md 文末《完成记录》追加一条：task / agent / commit / 验收自检摘要 / 遗留问题。
- 上述 task.md 改动必须与代码变更在同一个 commit，禁止单独提交状态。commit message 以 "T14: " 开头。
- 运行 npm test 与 npx tsc --noEmit，确保全绿。

【纪律 · 违反即返工】
- 不提交 package-lock.json 的差异；若 npm install 改动了它，先 git checkout -- package-lock.json 还原。
- 不改 src/App.tsx；不改 src/locales/*（若确需新文案，只做**尾部追加**）；不碰其他任务文件。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 F · 窗口（车道 F 甘特 UI → T20）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T20 · GanttView 渲染（虚拟化 / 刻度 / 今日线 / 里程碑 / 基线）。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-gantt
当前已检出分支 feat/lane-gantt（已同步到主干 e304e4f），不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读 task.md，重点四块：《Global Constraints》《状态同步协议》《分支与合入约定》《### T20》明细。
2. 读 spec 的 §5.1（数据流与输入契约）、§5.4（渲染要点）、§6.2（QueryEngine 筛选，看板与甘特共用同一份筛选结果）。
3. 关键前提：几何计算**已在领域层完成**，直接读 src/domain/ganttModel.ts（T19 已 done，导出 buildGanttModel 与 GanttModel/Row/Arrow 类型）。
   渲染层只做投影，**不要在这里重算列宽/条几何/箭头坐标**。
4. 若 node_modules 不存在，先 npm install。

【第 1 步 · 登记】
总表中 T20 状态改为 in_progress，写 (2026-10-15, <agent>) 。

【第 2 步 · 实施】
只改本任务「产出」清单内的文件：
  src/views/GanttView.tsx
  src/views/GanttCanvas.tsx
  src/views/GanttTable.tsx
  src/controllers/ganttViewport.ts
  tests/views/GanttView.test.tsx
严格按 T20 的 6 条验收标准实现，不得遗漏：
- SVG 渲染 rows/arrows/今日线，行高 32；仅渲染视口 ±10 行与可见列；用 1000 任务样本在测试里断言 DOM 节点数受控；
- 日/周刻度切换按钮 + Ctrl+滚轮与 +/- 缩放；两刻度各自保留缩放状态；
- 任务条（topic 色浅底 + 深色进度内条）、里程碑菱形、跨 topic 里程碑在顶部独立轨道；
- 基线开关：开启时条下方细灰条（baseline start→due）；
- 左侧任务表（任务/开始/结束/进度）与画布 scrollTop 同步；周末/节假日列浅灰底。

【第 3 步 · 边界与协调（重要）】
- 本任务**只做只读投影**：不做拖拽改期、不做拖入排期（spec §12 明确非目标）。
- 箭头层（GanttCanvas）本任务先渲染 buildGanttModel 已算好的折线 path 即可；
  **T21 会继续改 GanttCanvas 加关键路径高亮与 hover 高亮**——所以把箭头层做成独立子组件 + 明确的 props 接口，便于 T21 扩展。
- 已知遗留（T19 移交）：当前箭头一律按「前置右端 → 后置左端」连线，SS/FF/SF 的端点分支留给 T21，本任务不要试图在渲染层修。
- 组件必须可挂载：导出默认组件 + 显式 props（vault / filter / scale / viewport 由外部传入或从 store 派生），不要改 src/App.tsx。

【第 4 步 · 完工闭环】
- 勾选验收标准 → 总表改 done 写 (2026-10-15, <agent>, <commit 主题行>) → 文末《完成记录》追加一条。
- 与代码同一 commit，message 以 "T20: " 开头。
- 跑 npm test 与 npx tsc --noEmit，全绿。

【纪律 · 违反即返工】
- 不提交 package-lock.json 差异；不改 src/App.tsx；不改 src/locales/*（必要时只尾部追加）；不碰其他任务文件（尤其 src/domain/* 与 src/views/TopicSidebar.tsx）。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 G · 窗口（车道 D 持久化·安全 → T27，续 T29）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮先做 T27，做完继续 T29（同一车道，串行）。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-persistence
当前已检出分支 feat/lane-persistence（已同步到主干 e304e4f），不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读 task.md，重点四块：《Global Constraints》《状态同步协议》《分支与合入约定》《### T27》《### T29》明细。
2. 读 spec 的 §8.2（自动保存）、§8.3（冲突处理 多端）、§8.1（启动流程）、§8.5（迁移与只读安全模式）。
3. 现有基础：src/persistence/vaultRepository.ts（T07 建，含 revision）、src/persistence/snapshotStore.ts（T09 建，快照/保留/恢复）。
   T27 与 T29 都改 vaultRepository.ts，**必须串行**：先完整做完并提交 T27，再动 T29，任何时刻只有一个 in_progress。

【第 1 步 · T27 登记与实施】
- 总表 T27 状态改 in_progress，写 (2026-10-15, <agent>)。
- 只改：src/views/ConflictDialog.tsx、src/persistence/vaultRepository.ts（仅新增冲突检测相关）、tests/persistence/conflict.test.ts
- 严格按 T27 的 4 条验收标准实现：
  · save 前 peekRevision() > 内存基线 → 弹 ConflictDialog 三选：以我为准 / 以磁盘为准 / 导出我的副本；
  · 「以我为准」覆盖磁盘且磁盘旧版已进 .backup；「以磁盘为准」重载并警告丢失条数；「导出副本」写 vault-conflict-<ts>.json 后重载；
  · 30s 轮询 peekRevision：磁盘变且本地不 dirty → 静默重载；dirty → 顶栏提示；
  · 单测覆盖三路径与轮询两分支（用假计时器）。
- 闭环：勾选 → 总表 done 写 (2026-10-15, <agent>, <commit 主题行>) → 《完成记录》追加 → 与代码同一 commit，message 以 "T27: " 开头 → npm test 与 npx tsc --noEmit 全绿。

【第 2 步 · T29 实施（同窗口继续）】
- 总表 T29 状态改 in_progress，写 (2026-10-15, <agent>)。
- 只改：src/views/SafeModeBanner.tsx、src/persistence/vaultRepository.ts（仅新增自愈相关）、tests/persistence/safemode.test.ts
- 严格按 T29 的 4 条验收标准实现：
  · vault.json 解析/校验/迁移失败 → 不写盘，加载最近可用快照为只读视图；
  · 顶部横幅含三按钮：恢复此快照 / 选择其他备份 / 导出当前；
  · 只读模式下所有写操作禁用（CommandBus 拒绝并提示）；
  · 启动自愈：解析失败自动尝试最近快照一次，仍失败才进安全模式。
- 闭环同上，message 以 "T29: " 开头。

【边界与协调】
- 横幅与对话框组件必须可挂载：导出默认组件 + 显式 props，不要改 src/App.tsx（集成窗口负责接线）。
- 「选择其他备份」按钮只做回调 props（打开 BackupPanel 是 T28 的活），不要 import 尚不存在的组件。
- 不改 src/App.tsx / src/locales/*。

【纪律 · 违反即返工】
- 不提交 package-lock.json 差异；不碰 board-ui / gantt 车道的文件。
- 每个任务提交后即止于本车道，不要尝试合入主干。在回复里分别报告 T27 与 T29：任务号、commit 主题行与哈希、验收自检结果、遗留问题。
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
  git merge --no-ff feat/lane-board-ui   -m "merge: T14 (lane-board-ui)"
  git merge --no-ff feat/lane-gantt      -m "merge: T20 (lane-gantt)"
  git merge --no-ff feat/lane-persistence -m "merge: T27 T29 (lane-persistence)"
task.md 冲突按《状态同步协议》第 7 条处理：按 git 时间序合并，状态取较晚完成者，《完成记录》两侧条目都要保留（只增不删）。
每次合入后统一生成 lock 并验证：
  npm install && npm test && npx tsc --noEmit && npm run build
lock 有变化就单独 commit 一次（chore: regenerate lock after <Txx>）。

【第 2 步 · App.tsx 接线（只有你能改 src/App.tsx）】
把本波新视图挂进应用外壳，保持现有 startup 流程与注入 ports 的接缝不被破坏：
- 视图切换：看板（BoardView，T15 尚未完成则先留占位）/ 甘特（GanttView）/ 详情抽屉宿主；
- TopicSidebar：接 T14 的四个底部入口回调；里程碑/筛选器/备份/设置面板尚未实现，先接成空实现或占位，勿引用不存在的组件；
- 依赖安装与挂载：GanttView 需从 store 派生 vault + 当前 filter 再调用 buildGanttModel；筛选结果看板与甘特共用同一份（spec §6.2）；
- 对 T27/T29 的 ConflictDialog 与 SafeModeBanner 做挂载：冲突弹窗由 autosave 保存路径触发；安全模式横幅在启动自愈失败时置顶显示；
- 接线完成后跑一次 npm run build，确认 dist/OffEarly.html 仍满足单文件不变式（无外链 script/link、无 http(s) 引用）。

【第 3 步 · 后续你的职责】
- 你独占 T30（视觉校对）→ T31（产物校验）→ T32（Playwright E2E）→ T33（示例库与手册）。
- 每合入一个任务，通知对应车道 rebase 到最新主干（git -C <lane worktree> rebase feat/foundation）再继续下一站。

【纪律】
- 你是热文件（task.md / src/App.tsx / package.json / package-lock.json）的唯一写者，别让别人同时改。
- 不要改动车道分支上尚未合入的代码。
- 每一步合入后先让测试全绿再继续，别把多个车道的不确定状态堆在一起。
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

# 3) 集成侧：统一生成 lock 并验证
npm install && npm test && npx tsc --noEmit && npm run build
git add package-lock.json && git commit -m "chore: regenerate lock after <Txx>"

# 4) 其他车道 rebase 到最新主干
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-<y> && git rebase feat/foundation
```

---

## 禁忌清单

- 禁止两个窗口同时改 `task.md` / `src/App.tsx` / `package.json` / `package-lock.json`。
- 禁止车道窗口自行合入主干（只有集成窗口可以）。
- 禁止提交 `package-lock.json` 的车道差异。
- 禁止一个窗口同时持有两个 `in_progress`。
- 禁止把 T27 与 T29 分到两个窗口并行（都改 `vaultRepository.ts`）。
- 禁止在车道里 import 尚未实现的面板组件（T16/T18/T28）。
- 禁止分支活过 1 天：一个任务做完立刻合，别攒。
