# 车道启动指令包（OffEarly · trunk-based 短分支）

> 用法：另开 3 个对话框（窗口），每个窗口把下面【提示词 1/2/3】整段复制粘贴进去发送，即可并行开工。
> 第 4 个窗口留给「主干/集成」，等前三个有产出后再用【提示词 4】。
> 每个提示词都是自包含的——新窗口看不到任何本次对话的上下文，所以不要删减路径与步骤。

---

## 0. 开工前的既定事实（供你自己对照，不要贴进提示词）

| 事项 | 状态 |
|---|---|
| 主干分支 | `feat/foundation`，检出在 `C:\Users\18304\Desktop\TaskDone` |
| 主干当前状态 | tip 停在 `0802296`，且**有另一 agent 正在做 T10**（`src/domain/{lexorank,store,commandBus}.ts` 未提交） |
| 约定提交 | `8c76329`（《分支与合入约定》）目前只在车道分支上，尚未进主干 |
| 已完成 | T01–T08 |
| 首波可并行 | **T09 ∥ T10 ∥ T11 ∥ T12**（文件域互斥） |
| 关键路径 | T10 → T12 → T13 → T15 → T17 → T24 → T30 → T31 → T32 → T33 |

**并发配额：** 首波只放这 4 个。再加车道边际收益极低，而 `package.json` / `App.tsx` 的冲突成本线性上升。

**车道 → 窗口对应：**

| 窗口 | 车道 | worktree | 本轮任务 | 后续同车道 |
|---|---|---|---|---|
| 提示词 1 | D 持久化·安全 | `oe-lane-persistence` | **T09** | T27 → T29 → T26 → T28 |
| 提示词 2 | B 领域·算法 | `oe-lane-depgraph` | **T12** | T13 → T19 |
| 提示词 3 | C 日程引擎 | `oe-lane-schedule` | **T11** | （本车道仅此一任务） |
| 提示词 4 | G 集成·交付 | `C:\Users\18304\Desktop\TaskDone` | T10 收尾 + 合入 | T14+ 接线、T30 → T31 → T32 → T33 |

**每个车道 worktree 首次使用需先装依赖：**

```bash
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-persistence && npm install
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-depgraph    && npm install
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-schedule    && npm install
```

---

## 提示词 1 · 窗口 A（车道 D 持久化·安全 → T09）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T09 · SnapshotStore。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-persistence
当前已检出分支 feat/lane-persistence，不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读全项目根目录的 task.md，重点四块：《Global Constraints》《状态同步协议》《分支与合入约定》《### T09》明细。
2. 读 docs/superpowers/specs/2026-10-15-taskdone-architecture-design.md 第 8.4 节（备份 SnapshotStore）。
3. 若 node_modules 不存在，先执行 npm install。

【第 1 步 · 登记】
把 task.md《任务总表》中 T09 的状态由 pending 改为 in_progress，并写 (2026-10-15, <你的模型名>:<会话短id>)。

【第 2 步 · 实施】
只改本任务「产出」清单内的文件：
  src/persistence/snapshotStore.ts
  tests/persistence/snapshotStore.test.ts
严格按 T09 的 4 条验收标准逐条实现，不得遗漏。

【第 3 步 · 完工闭环】
- 逐条勾选 task.md 中 T09 的验收标准。
- 总表状态改为 done，写 (2026-10-15, <agent>, <commit 主题行>)。
- 在 task.md 文末《完成记录》追加一条：task / agent / commit / 验收自检摘要 / 遗留问题。
- 上述 task.md 改动必须与代码变更在同一个 commit，禁止单独提交状态。commit message 以 "T09: " 开头。
- 运行 npm test 与 npx tsc --noEmit，确保全绿。

【纪律 · 违反即返工】
- 不要提交 package-lock.json 的差异。若 npm install 改动了它，先 git checkout -- package-lock.json 还原，再只提交 package.json 的依赖行。
- 不要改 src/App.tsx；不要改 src/locales/*；不要改其他任务的文件。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 2 · 窗口 B（车道 B 领域·算法 → T12）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T12 · DependencyGraph。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-depgraph
当前已检出分支 feat/lane-depgraph，不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读 task.md，重点四块：《Global Constraints》《状态同步协议》《分支与合入约定》《### T12》明细。
2. 读 docs/superpowers/specs/2026-10-15-taskdone-architecture-design.md 第 5.3 节（DependencyGraph）。
3. 若 node_modules 不存在，先 npm install。

【第 1 步 · 登记】
总表中 T12 状态改为 in_progress，写 (2026-10-15, <agent>)。

【第 2 步 · 实施】
只改：src/domain/dependencyGraph.ts、tests/domain/dependencyGraph.test.ts
注意：T12 的依赖已于 2026-10-15 放宽为 T03（已完成），因此本任务不需要 T10 的 VaultStore。
DependencyGraph 必须是纯函数模块——零 React、零 DOM、零 I/O，输入 links 与 tasks，输出派生结果。
严格按 T12 的 6 条验收标准实现，环检测用 Tarjan，关键路径用拓扑排序 + 最长路径。

【第 3 步 · 完工闭环】
- 勾选验收标准 → 总表改 done 写 (2026-10-15, <agent>, <commit 主题行>) → 文末《完成记录》追加一条。
- 与代码同一 commit，message 以 "T12: " 开头。
- 跑 npm test 与 npx tsc --noEmit，全绿。

【第 4 步 · 本车道续做（可选，同窗口继续）】
T12 完成并提交后，本车道可继续 T13 · TopicTree + QueryEngine（依赖 T12，已 done）。
T13 完成后本车道暂停：T19 · ganttModel 还需要 T11 的 ScheduleEngine，那由别的车道负责，
等 T11 落地后（确认 task.md 总表中 T11 为 done）再做 T19。
每完成一个任务都要走一次上面的闭环，且保持「同一时刻只有一个 in_progress」。

【纪律 · 违反即返工】
- 不提交 package-lock.json 差异（同上还原法）。
- 不改 src/App.tsx、src/locales/*、src/views/*；不要碰其他任务文件。
- 每个任务提交后停止，不要尝试合入主干；在回复里报告任务号、commit、验收自检、遗留问题。
```

---

## 提示词 3 · 窗口 C（车道 C 日程引擎 → T11）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T11 · ScheduleEngine。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-schedule
当前已检出分支 feat/lane-schedule，不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读 task.md，重点四块：《Global Constraints》《状态同步协议》《分支与合入约定》《### T11》明细。
2. 读 docs/superpowers/specs/2026-10-15-taskdone-architecture-design.md 第 5.2 节（ScheduleEngine 纯函数）。
3. 若 node_modules 不存在，先 npm install。

【第 1 步 · 登记】
总表中 T11 状态改为 in_progress，写 (2026-10-15, <agent>)。

【第 2 步 · 实施】
只改：src/domain/scheduleEngine.ts、tests/domain/scheduleEngine.test.ts
本任务需要 dayjs：在 package.json 的 dependencies 中加入 dayjs（这是本波次里唯一允许改 package.json 的车道）。
ScheduleEngine 必须纯函数、零 I/O；节假日与补班（extraWorkdays）按 T11 验收标准处理。
单测 ≥15 例，必须覆盖节假日、补班周六、跨年（12-30 → 01-03）、负数推移、memoize spy 计数。

【第 3 步 · 完工闭环】
- 勾选验收标准 → 总表改 done 写 (2026-10-15, <agent>, <commit 主题行>) → 文末《完成记录》追加一条。
- 与代码同一 commit，message 以 "T11: " 开头。
- 跑 npm test 与 npx tsc --noEmit，全绿。

【纪律 · 违反即返工】
- 只提交 package.json 的 dayjs 依赖行；不要提交 package-lock.json 的差异（跑完 npm install 后
  先 git checkout -- package-lock.json 还原，lock 由主干统一生成）。
- 不改 src/App.tsx；不改 src/locales/*；不要碰其他任务文件（尤其 src/domain 下不属于 T11 的文件）。
- 完成后停止，不要尝试合入主干；在回复里报告任务号、commit、验收自检、遗留问题。
```

---

## 提示词 4 · 窗口 D（主干 / 集成 → T10 收尾 + 合入 + T30–T33）

> 前提：确认原先在 `C:\Users\18304\Desktop\TaskDone` 做 T10 的那个 agent 已停止，否则先别用这个窗口，避免踩掉它的未提交改动。

```text
你是 OffEarly（早下班）项目的集成 agent（车道 G）。你独占主干，负责合入与全库接线。

【工作目录】
C:\Users\18304\Desktop\TaskDone
当前已检出主干分支 feat/foundation。你是本仓库唯一允许向 feat/foundation 合入的角色。

【第 1 步 · 接手 T10】
该目录里已有未提交的 T10 产物：
  M package.json / package-lock.json
  ?? src/domain/{lexorank,store,commandBus}.ts
  ?? tests/domain/{lexorank,commandBus}.test.ts、store.test.tsx
先读 task.md《### T10》与 spec 第 3 节模块表，按 T10 的 5 条验收标准核对并补齐实现；
然后走《状态同步协议》闭环（总表改 done + 《完成记录》追加，与代码同一个 commit，message 以 "T10: " 开头），
最后 npm test 与 npx tsc --noEmit 全绿。

【第 2 步 · 把约定提交带进主干】
T10 提交后，把《分支与合入约定》提交 8c76329 带进主干（它目前只在车道分支上）。
合入任一车道分支时会自动带入；若你在合入前就先做一次，可执行：
  git merge --no-ff 8c76329 -m "merge: trunk-based branch/merge convention"

【第 3 步 · 逐个合入车道（每完成一个车道的一个任务就合一次）】
先确认本工作树干净：git status --porcelain 必须为空。
  git merge --no-ff feat/lane-persistence -m "merge: T09 (lane-persistence)"
  git merge --no-ff feat/lane-depgraph    -m "merge: T12 (lane-depgraph)"
  git merge --no-ff feat/lane-schedule    -m "merge: T11 (lane-schedule)"
task.md 冲突按《状态同步协议》第 7 条处理：按 git 时间序合并，状态取较晚完成者，
《完成记录》两侧条目都要保留（只增不删）。
每次合入后统一生成 lock 并验证：
  npm install && npm test && npx tsc --noEmit && npm run build
lock 有变化就单独 commit 一次。

【第 4 步 · 后续你的职责】
- src/App.tsx 的视图挂载 / 路由接线由你单独完成，车道只交付「可挂载」组件。
- 你独占 T30 → T31 → T32 → T33（视觉校对、构建产物校验、Playwright E2E、示例库与手册）。
- 每合入一个任务，就通知对应车道 rebase 到最新主干再继续下一站。

【纪律】
- 你是热文件（task.md / src/App.tsx / package.json / package-lock.json）的唯一写者，别让别人同时改。
- 不要改动车道分支上尚未合入的代码。
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
cd ../oe-lane-<y> && git rebase feat/foundation
```

---

## 禁忌清单

- 禁止两个窗口同时改 `task.md` / `src/App.tsx` / `package.json` / `package-lock.json`。
- 禁止车道窗口自行合入主干（只有集成窗口可以）。
- 禁止提交 `package-lock.json` 的车道差异。
- 禁止一个窗口同时持有两个 `in_progress`。
- 禁止分支活过 1 天：一个任务做完立刻合，别攒。
- 禁止踩 `C:\Users\18304\Desktop\TaskDone` 里别人未提交的改动。
