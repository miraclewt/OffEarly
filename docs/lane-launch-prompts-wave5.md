# 车道启动指令包 · 第五波（OffEarly · trunk-based 短分支）

> 用法：本波放 **2 条车道**。把下面【提示词 E / F】整段复制粘贴到两个新对话框（或交由集成窗口以子 agent 启动），即可并行开工。
> 第 3 个对话框在两条车道有产出后再用【提示词 X】做集成。
> 每个提示词都是自包含的——新窗口看不到任何上下文，**不要删减路径与步骤**。
>
> 已完成并合入主干：第一波 `docs/lane-launch-prompts.md`（T09–T12）、第二波 `docs/lane-launch-prompts-wave2.md`（T14/T20/T27）、第三波 `docs/lane-launch-prompts-wave3.md`（T15/T21/T18）、第四波 `docs/lane-launch-prompts-wave4.md`（T17/T16/T23）。仅作留档。

---

## 0. 开工前的既定事实（供你自己对照，不要贴进提示词）

| 事项 | 状态 |
|---|---|
| 主干分支 | `feat/foundation`，检出在 `C:\Users\18304\Desktop\TaskDone` |
| 主干 tip | `dee08d4`（wave-4 集成记录；开工前以 `git log --oneline -1` 为准），工作树干净（仅 `scripts/resolve-conflict.mjs` 未跟踪，合入工具，勿动） |
| 基线 | `npm test` **567 passed (29 files)** / `tsc --noEmit` 0 / `npm run build` 10/10（单文件 527301 字节）/ `npm run e2e` 22 passed + 1 skipped（「拖拽换列+图片粘贴」fixme 等 T24/T25） |
| 已完成 | **T01–T23、T27、T29–T33** 全部 done |
| 剩余 | **T22、T24、T25、T26、T28**（本波做 T22 ∥ T24） |
| 本波可并行 | **T22（F 车道）∥ T24（E 车道）**，文件域互斥，见下表 |
| 关键路径 | T24 → T25 → T26 → T28（T24 是关键路径头） |
| 本波之后才解锁 | T25(←T24)、T26(←T25)、T28(←T26) |

**三条车道 worktree 都已被集成窗口 rebase 到 `336fa8e`，但主干其后又多了 `dee08d4`（task.md 记录），开工前一律先 rebase：**

```bash
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-gantt     && git rebase feat/foundation
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-board-ui  && git rebase feat/foundation
```

**并发配额：** 本波放 2 条车道。`oe-lane-persistence` 的 T26/T28 堵在 T25 后面、`oe-lane-milestone` 无剩余任务，**均保持空置，不要派任务**。

### 剩余任务全景与依赖链

| 任务 | 内容 | 依赖 | 所属车道 | 预估 |
|---|---|---|---|---|
| **T22** | 未排期侧栏 + 甘特图与筛选联动 | T20 ✓, T16 ✓ | F 甘特 UI | 0.5d |
| **T24** | NoteEditor（TipTap + markdown + 快捷语法 + [[双链]]） | T17 ✓ | E 看板 UI | 1.5d |
| T25 | AssetStore + 图片插入/显示/灯箱 | T24, T06 ✓ | E 看板 UI | 1.5d |
| T26 | 清理未引用附件 | T25 | D 持久化 | 0.5d |
| T28 | BackupPanel（快照/恢复/导出/导入） | T09 ✓, T26 | D 持久化 | 1d |

后续波次：**第六波** = E 车道 T25（T24 合入后）；**第七波** = D 车道 T26 → T28（T25 合入后，串行）。T26 先建 `BackupPanel.tsx` 的 gc 入口（最小面板），T28 再在其上扩建完整面板——两任务同在 D 车道串行，文件不冲突。

### 文件域互斥表（本波 2 条车道为什么能并行）

| 车道 | 任务 | 独占文件 | 是否新增依赖 |
|---|---|---|---|
| F 甘特 UI | T22 | `src/views/GanttView.tsx` `tests/views/ganttUnscheduled.test.tsx` | 否 |
| E 看板 UI | T24 | `src/views/NoteEditor.tsx` `tests/views/NoteEditor.test.tsx` `src/views/TaskDrawer.tsx`（仅换笔记占位） `package.json`（仅依赖行） | **是（TipTap，本波唯一）** |
| —— | —— | `task.md`、`src/locales/{zh,en}.ts` | **两条都会碰，按协议第 7 条解** |

> 说明：T24 换掉 TaskDrawer 的笔记占位属**同车道合理包含**（TaskDrawer.tsx 是 E 车道 T17 的产出，T24 同车道接续；先例 = wave-4 T23 在 GanttView.tsx 加导出入口）。除此之外 E 不得碰 TaskDrawer 其他分区。

### 依赖新增规则（本波仅 E 车道加 TipTap）

- **T24 新增依赖已核实（2026-10-16）**：TipTap 当前主流为 **v3**（3.31.x），`@tiptap/pm` 在 v3 是**必装 peer**；markdown 序列化用**官方 `@tiptap/markdown`**（3.7.0+ 起随 Tiptap 发布，基于 MarkedJS），**不要用社区包 `tiptap-markdown`**（那是 v2 时代的，v0.9 虽标 v3 但官方已不推荐）。
- 建议包集（装前对照实际 StarterKit 内容去重，避免重复扩展）：`@tiptap/react` `@tiptap/starter-kit` `@tiptap/pm` `@tiptap/markdown` `@tiptap/extension-task-list` `@tiptap/extension-task-item` `@tiptap/extension-table` `@tiptap/extension-image`。全部**精确锁版**（项目风格：runtime 依赖锁死版本号，不用 `^`）。
- 规则同前几波：**只有 E 车道改 `package.json`**；车道提交前 `git checkout -- package-lock.json` 还原 lock；合入后由集成窗口统一 `npm install` 重生成 lock 并单独提交 `chore: regenerate lock after T24`。
- F 车道（T22）**不加任何依赖**，不要动 `package.json` / `package-lock.json`。
- TipTap 进包后产物体积会明显上涨（预估 +300KB 量级）：构建后确认 `npm run build` 的 verify 仍 10/10（体积上限 1677721 字节，当前 527301，余量充足），单文件不变式保持。

### `src/locales/*` 追加规则（两条车道必读，否则合入后 `tsc` 语法错）

历史教训：`zh.ts` 是**嵌套**表，多个车道各自「尾部追加」时，git 会把两侧新块的闭合 `},` 当成同一行公共上下文，解析后出现「上一个键块丢闭合括号、下一个键块被嵌进去」→ **语法错误**，而 `en.ts`（扁平、无内层大括号）不会中招，容易误判为已修好。

因此本波统一约定：

1. **一律追加新的顶层键块**（如 `noteEditor: { ... },`、`ganttUnscheduled: { ... },`），**不要往既有键块内部塞子键**。
2. 插入位置统一在 `safemode: { ... },` 之后、`} as const` 之前（即文件现有物理末尾）。
3. 每个新块**自带完整闭合 `},`**，不要依赖别处的括号。
4. `en.ts` 是扁平 `'a.b': 'x'` 表，且类型是 `Record<MsgKey, string>`——**zh 与 en 的键集合必须严格一致**，少一条翻译 tsc 立刻报错。追加时两边同步。
5. 集成窗口解冲突：按 git 时间序取并集 → **人工检查 zh 每个新增块是否都有 `},`**（缺则补）→ 跑 `npx tsc --noEmit` 确认。

---

## 提示词 E · 窗口（车道 E 看板 UI → T24）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T24 · NoteEditor（TipTap + markdown + 快捷语法 + [[双链]]）。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-board-ui
当前已检出分支 feat/lane-board-ui。开工前先执行：git rebase feat/foundation（同步到主干最新 tip）。不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读项目根目录 task.md，重点：《Global Constraints》《状态同步协议》《分支与合入约定》《### T24》明细，以及已 done 的《### T17》（TaskDrawer，你的笔记占位就在它里面）、《### T15》（看板）、《### T03》（领域类型，Task.note 字段）。
2. 读 spec（docs/superpowers/specs/2026-10-15-taskdone-architecture-design.md）的 §6.4（笔记与图片）、§7（UI 视觉规范）、§3（三条硬规则）。
3. 读现有实现，确认接缝（不要重造）：
   - src/views/TaskDrawer.tsx（T17）：第 ⑤ 分区是笔记占位（data-testid="drawer-note-placeholder"）。**本任务授权你把占位换成真 NoteEditor**（同车道合理包含，先例 = wave-4 T23 在 GanttView 加导出入口）；除此之外不要动 TaskDrawer 的其他分区。
   - src/domain/commandBus.ts（T10/T17）：patchTaskCommand(vault, id, patch) 已就绪，TaskPatch 含 note 字段——**笔记写入走它进 undo 栈，不要改 commandBus.ts**。
   - src/persistence/autosave.ts（T08）：debounce 落盘已由 Autosave 负责，你不要再造保存机制。
   - src/domain/types.ts：Task（含 note: string）、Milestone（标题搜索用）。
   - src/styles/theme.css：--oe-* token。颜色一律取 token，不要写死 hex；唯一例外是 SVG 呈现属性（fill=/stroke=）不解析 var()。
   - src/views/IconSprite.tsx：工具栏图标**只能用现有 symbol**（bold/italic/strike/code/code-block/H2/H3/list/list-ordered/list-task/quote/link/table/image/minus 之类，先逐个确认存在）；**缺图标不要自己加**，在最终回复里报告缺哪些。
   - src/locales/{zh,en}.ts：消息表；追加规则见下方边界。

【第 1 步 · 登记】
把 task.md《任务总表》中 T24 的状态由 pending 改为 in_progress，并写 (2026-10-16, <你的模型名>:<会话短id>)。

【第 2 步 · 安装依赖（本波唯一允许加依赖的车道）】
- 包集：@tiptap/react、@tiptap/starter-kit、@tiptap/pm（v3 必装 peer）、@tiptap/markdown（官方，基于 MarkedJS；**禁用社区包 tiptap-markdown**）、@tiptap/extension-task-list、@tiptap/extension-task-item、@tiptap/extension-table、@tiptap/extension-image。装前对照实际 StarterKit 内容去重（如 Link 已在 StarterKit 内就不要再单独装）。
- 全部精确锁版（不用 ^），与项目现有风格一致（dayjs 1.11.23 / zustand 5.0.15 式）。
- npm install 后**不要提交 package-lock.json**（提交前 git checkout -- package-lock.json 还原）；lock 由集成窗口合入后统一重生成。
- 在最终回复里报告实际安装的包与版本。

【第 3 步 · 实施】
只改本任务「产出」清单内的文件（外加下述授权包含）：
  src/views/NoteEditor.tsx
  tests/views/NoteEditor.test.tsx
  src/views/TaskDrawer.tsx      ← 仅把第 ⑤ 分区笔记占位换成 NoteEditor，别的一律不碰
  package.json                   ← 仅依赖行
严格按 T24 的 6 条验收标准逐条实现，不得遗漏：
- TipTap + @tiptap/markdown；note 字段存 Markdown 纯文本，往返 parse/serialize 不丢内容；
- 工具栏一行线性图标：粗体/斜体/删除线/行内码/代码块/H2/H3/无序/有序/任务列表/引用/链接/表格/图片/分隔线（图标用现有 sprite，缺则报告）；
- 快捷语法生效：行首 `# ` `- ` `1. ` `> ` `[] ` 与行内 `` ` ``（逐条写测试验证，不要假设 StarterKit 输入规则全覆盖）；
- 输入 `[[` 弹任务/里程碑标题搜索（子序列模糊匹配即可，参照 T17 DependencyEditor 的做法），插入 `[[标题]]`；渲染为可点击跳转（点击经回调 props 外送，如 onNavigate(target)；**接线归集成窗口**，组件测试用 rerender 驱动 props 验证）；同名多任务列候选；
- 编辑经 CommandBus 进 undo 栈（patchTaskCommand）；debounce 写入 Store（undo 粒度自行裁决并在代码注释与完成记录里写明，参照 T17「回车/blur 提交」先例的思路）；
- 组件测试覆盖 markdown 往返与双链插入。

**markdown 往返测试必须覆盖的样本（已知上游坑，勿裸奔）**：标题/无序/有序/任务列表/引用/表格/行内码/代码块/链接/图片语法 ![](assets/<id>.png)/[[双链]]/空笔记。已知 @tiptap/markdown 两个缺陷：代码块内嵌 ``` 时序列化 fence 不安全导致往返破裂（issue #8341）、前导 1-3 空格的围栏代码块解析被丢弃（#8460）——用嵌套围栏等样本实测，若中招：能绕（自定义序列化/节点）就绕，绕不了在完成记录里写明「已知库缺陷 + 样本」，**绝不允许静默丢内容**。

【第 4 步 · 边界与协调（重要，违反即返工）】
- 组件必须可挂载：默认导出 + 显式 props（note / onCommit / t / onNavigate 等由外部传入，参照 GanttView 的 t 注入 + 中文兜底手法）。**不要改 src/App.tsx**——挂载接线归集成窗口。
- **图片按钮只做形态与接缝**：真正的插入（粘贴/拖入/选文件）与 blob URL 显示是 T25 的范围（assetStore.ts 尚不存在）——不要 import 不存在的模块；图片语法 ![](assets/...) 必须**原样往返**，显示侧先给占位（如「图片（预览待 T25）」灰底 chip），T25 再来换真预览。
- **不要碰**：src/domain/*（commandBus 只读调用）、src/persistence/*（assetStore 是 T25 的，不要创建）、src/views/Gantt*、src/views/BoardView.tsx、src/views/FilterBar.tsx、其他车道的文件。
- 改 src/locales/* 时遵守「追加新的顶层键块（如 noteEditor）、插在 safemode 之后、自带闭合、zh/en 同步」。
- 禁 emoji；颜色取 --oe-* token；全项目 TDD（先写失败测试）。
- 构建后确认 npm run build 的 verify 10/10（TipTap 进包后体积上涨属预期，上限 1677721 字节，当前 527301）。

【第 5 步 · 完工闭环】
- 逐条勾选 task.md 中 T24 的验收标准。
- 总表状态改为 done，写 (2026-10-16, <agent>, <commit 主题行>)。
- 在 task.md 文末《完成记录》追加一条：task / agent / commit / 验收自检摘要 / 遗留问题（**务必写明：图片插入与灯箱待 T25；挂载接线待集成窗口；实际安装的 TipTap 包与版本**）。
- 上述 task.md 改动必须与代码变更在同一个 commit，禁止单独提交状态。commit message 以 "T24: " 开头。
- 运行 npm test 与 npx tsc --noEmit 与 npm run build，确保全绿。
- 提交前执行：git checkout -- package-lock.json

【纪律 · 违反即返工】
- 不改 package-lock.json；不改 src/App.tsx；除 patchTaskCommand 只读调用外不碰 src/domain/*；不创建 assetStore.ts；不碰 gantt / milestone / persistence 车道的文件；不往 IconSprite 加图标（缺则报告）。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、安装的依赖及版本、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 F · 窗口（车道 F 甘特 UI → T22）

```text
你是 OffEarly（早下班）项目的实施 agent。本轮只做一个任务：T22 · 未排期侧栏 + 甘特图与筛选联动。

【工作目录】必须在此目录内作业，不要切换到其他 worktree：
C:\Users\18304\WorkBuddy\Worktrees\TaskDone\oe-lane-gantt
当前已检出分支 feat/lane-gantt。开工前先执行：git rebase feat/foundation（同步到主干最新 tip）。不要切换分支、不要新建分支。

【第 0 步 · 读文档（动手前必须完成）】
1. 读项目根目录 task.md，重点：《Global Constraints》《状态同步协议》《分支与合入约定》《### T22》明细，以及已 done 的《### T19》（ganttModel，unscheduled 字段的来源）、《### T20》《### T21》《### T23》（GanttView 的既有形态，含导出入口）。
2. 读 spec（docs/superpowers/specs/2026-10-15-taskdone-architecture-design.md）的 §5.4（甘特渲染要点）、§6.2（筛选共用）、§3（三条硬规则）、§7（UI 视觉规范）。
3. 读现有实现，确认接缝（不要重造）：
   - src/domain/ganttModel.ts（T19）：buildGanttModel(vault, filter, scale, viewport) 已返回 unscheduled（= 查询结果里 start/due 缺一的任务，**随 filter 收缩**，与 rows 同源）与 colorOfTopic（话题色点取色，直接用）。
   - src/views/GanttView.tsx（T20/T21/T23）：props 为 vault / filter / viewport? / today? / t? 等；工具栏已有刻度/缩放/基线/关键路径/导出入口——**侧栏加在画布右侧，不要破坏既有行为**。
   - src/views/TaskDrawer.tsx（T17）：补排期的落点。**不要 import 它**——点击未排期任务经回调 props（如 onOpenTask(taskId)）外送，接线归集成窗口（App.tsx 已有 drawer 受控状态，board 的 onOpenTask 与甘特条 data-gantt-bar 委托是现成先例）。
   - src/styles/theme.css：--oe-* token。颜色一律取 token，不写死 hex。
   - src/views/IconSprite.tsx：折叠/展开用现有图标（chevron 类），不要新增。

【第 1 步 · 登记】
把 task.md《任务总表》中 T22 的状态由 pending 改为 in_progress，并写 (2026-10-16, <你的模型名>:<会话短id>)。

【第 2 步 · 实施】
只改本任务「产出」清单内的文件：
  src/views/GanttView.tsx          ← 加未排期侧栏（折叠面板）
  tests/views/ganttUnscheduled.test.tsx
严格按 T22 的 4 条验收标准逐条实现，不得遗漏：
- 右侧折叠面板列出 unscheduled 任务（标题 + topic 色点，色点取 colorOfTopic）；可折叠/展开（折叠状态可存本地 state，不要求持久化）；
- 点击未排期任务经 onOpenTask 回调外送（组件测试用 rerender 驱动 props 验证回调被调用）；「补完后该任务进入甘特图 rows」——用「rerender 传入已补日期的 vault」验证任务从侧栏消失、rows 出现；
- 甘特图 rows 受 FilterBar 结果驱动（改筛选即重渲染，条件与看板一致）——GanttView 已消费 filter → buildGanttModel，本任务补测试固化：换一个 filter 重渲染，rows 集合与侧栏 unscheduled 集合同步变化；
- 组件测试覆盖列出与补排期后出现；提交。

【第 3 步 · 边界与协调（重要，违反即返工）】
- **不要做 clone/DOM 序列化之类越界事**：侧栏数据一律取自 buildGanttModel 的 unscheduled，不要在视图层重算排期/查询。
- 侧栏视觉与 GanttView 同一语言（token 取色、行高与画布协调、空态给一句文案）；topic 色点用话题色（colorOfTopic），跨话题（topicId 为 null）任务给中性色点并在完成记录说明取色。
- **不要改 src/App.tsx、src/domain/*、src/controllers/*（只读引用可以）**；不要 import 尚不存在的组件；不要动 TaskDrawer.tsx / GanttCanvas.tsx / GanttTable.tsx（除非侧栏必须的最小改动——若必须，先在回复里向集成窗口报告再动）。
- 改 src/locales/* 时遵守「追加新的顶层键块（如 ganttUnscheduled）、插在 safemode 之后、自带闭合、zh/en 同步」。
- 禁 emoji；颜色取 --oe-* token；全项目 TDD（先写失败测试）。
- 本任务**不加任何 npm 依赖**，不要动 package.json / package-lock.json。

【第 4 步 · 完工闭环】
- 逐条勾选 task.md 中 T22 的验收标准。
- 总表状态改为 done，写 (2026-10-16, <agent>, <commit 主题行>)。
- 在 task.md 文末《完成记录》追加一条：task / agent / commit / 验收自检摘要 / 遗留问题（**务必写明「onOpenTask 接线与 App.tsx 挂载待集成窗口」**）。
- 上述 task.md 改动必须与代码变更在同一个 commit，禁止单独提交状态。commit message 以 "T22: " 开头。
- 运行 npm test 与 npx tsc --noEmit 与 npm run build，确保全绿。
- 提交前执行：git checkout -- package-lock.json

【纪律 · 违反即返工】
- 不改 package.json / package-lock.json；不改 src/App.tsx；不碰 src/domain/*；不碰 TaskDrawer.tsx；不碰 board-ui / milestone / persistence 车道的文件；不加 npm 依赖。
- 完成后立即停止，不要尝试合入主干。在回复里报告：任务号、onOpenTask 契约（props 签名）、commit 主题行与哈希、验收自检结果、遗留问题。
```

---

## 提示词 X · 窗口（集成 / 车道 G → 合入 + App.tsx 接线）

> 前提：两条车道（T24 / T22）至少各有一次提交；且确认没有别的 agent 正在 `C:\Users\18304\Desktop\TaskDone` 里改东西。

```text
你是 OffEarly（早下班）项目的集成 agent（车道 G）。你独占主干，负责合入与全库接线。

【工作目录】
C:\Users\18304\Desktop\TaskDone
当前已检出主干分支 feat/foundation。你是本仓库唯一允许向 feat/foundation 合入的角色。

【第 1 步 · 逐个合入车道（每完成一个车道任务就合一次，别攒）】
先确认本工作树干净：git status --porcelain 必须为空（scripts/resolve-conflict.mjs 是既知未跟踪文件，无视）。
  git merge --no-ff feat/lane-board-ui -m "merge: T24 (lane-board-ui)"
  git merge --no-ff feat/lane-gantt     -m "merge: T22 (lane-gantt)"
task.md 冲突按《状态同步协议》第 7 条处理：按 git 时间序合并，状态取较晚完成者，《完成记录》两侧条目都要保留（只增不删）；总表若出现重复行，手工去重取较晚完成者（脚本并集会留重复行的已知陷阱）。
src/locales/* 冲突用一次性脚本 scripts/resolve-conflict.mjs 按 <<<<<<< / ======= / >>>>>>> 标记做并集（条目单行可达数千字符，不要手抄），zh.ts 用 addBraceAfterHead 补顶层闭合 `},`，**并人工检查 zh.ts 每个新增键块是否都有闭合 `},`**（缺则补）；en.ts 是扁平表、键集合必须与 zh 严格一致。

【第 2 步 · 重生成 lock（本波唯一加依赖的车道是 E）】
T24 引入 TipTap：合入后**必须**在主干 npm install 重生成 lock，并单独提交：
  git add package-lock.json && git commit -m "chore: regenerate lock after T24"
F 车道（T22）无新依赖，其 lock 差异（如有）应是空——若非空，说明车道违规提交过 lock，单独 commit 前先diff 确认内容只有 TipTap 相关行。

【第 3 步 · 验证】
  npm test && npx tsc --noEmit && npm run build && npm run e2e
全部绿了再继续。任一步红：先修再合下一个。基线：567 passed (29 files) / e2e 22 passed + 1 skipped。

【第 4 步 · App.tsx 接线（只有你能改 src/App.tsx）】
- NoteEditor（T24）：TaskDrawer 第 ⑤ 分区应已被 E 车道换成真组件（同车道合理包含）；核对 props 接线（note/onCommit/t/onNavigate）是否齐全，缺则在 App.tsx 或 TaskDrawer.tsx 补接（TaskDrawer.tsx 属 E 车道文件但已合入主干，集成窗口可修）。
- onNavigate（[[双链]]点击跳转）：接到既有 TaskDrawer 受控状态（与 BoardView onOpenTask、甘特条 data-gantt-bar 委托同一手法）；milestone 目标的跳转落点由你定（MilestonePanel 已接线，可打开面板并选中）。
- 未排期侧栏（T22）：把 GanttView 的 onOpenTask 接到既有 TaskDrawer（与 board 的 onOpenTask 同一状态源）；折叠面板无需外部状态。
- 底部四个入口：里程碑（已接）、筛选器（已接）、备份(T28)/设置 仍保持 panelPlaceholder，不要引用不存在的组件。
- 接线完成后跑 npm run build，确认 dist/OffEarly.html 仍满足单文件不变式（无外链 script/link、无 type="module"、无 http(s) 资源引用）；再跑 npm run e2e。
- e2e/05-export.spec.ts 的「拖拽换列与图片粘贴」fixme：**T24 落地后图片粘贴的一半可试启用**——若 NoteEditor 的图片按钮仍是占位（等 T25），保持 fixme 不动；T25 合入后再启用。

【第 5 步 · 通知车道 rebase】
  git -C C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-board-ui  rebase feat/foundation
  git -C C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-gantt     rebase feat/foundation
（E 车道接着做 T25，F 车道无后续任务，保持空置。）
注意：T24 合入后各 worktree 的 node_modules 会 stale（TipTap 只在主干装过）——E 车道做 T25 前在 oe-lane-board-ui 里 npm install 补齐（只补缺失包，lock 零差异，无需提交）。

【第 6 步 · 后续你的职责】
- 第六波派工：E 车道 T25（←T24；产出含 src/persistence/assetStore.ts + NoteEditor 图片节点 + Lightbox.tsx；依赖 T06 已 done）。
- 第七波派工：D 车道 T26（←T25；gc 进 assetStore.ts + BackupPanel.tsx 建最小 gc 入口）→ T28（←T09、T26；在其上扩建完整备份面板）。派工前先把 oe-lane-persistence rebase 到主干（它停在 2914f2f，落后两个波次）。
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
git status --porcelain          # 必须为空（scripts/resolve-conflict.mjs 除外）
git merge --no-ff feat/lane-<x> -m "merge: <Txx> (lane-<x>)"

# 3) 集成侧：验证（T24 合入后 npm install 重生成 lock 并单独提交）
npm test && npx tsc --noEmit && npm run build && npm run e2e

# 4) 其他车道 rebase 到最新主干
cd C:/Users/18304/WorkBuddy/Worktrees/TaskDone/oe-lane-<y> && git rebase feat/foundation
```

---

## 禁忌清单

- 禁止两个窗口同时改 `task.md` / `src/App.tsx` / `package.json` / `package-lock.json`。
- 禁止车道窗口自行合入主干（只有集成窗口可以）。
- 禁止提交 `package-lock.json` 的车道差异（提交前 `git checkout -- package-lock.json`）；本波仅 E 车道（T24）经集成窗口重生成 lock。
- 禁止一个窗口同时持有两个 `in_progress`。
- 禁止分支活过 1 天：一个任务做完立刻合，别攒。
- 禁止车道 import 尚未实现的面板组件（BackupPanel T28 / assetStore T25 / Lightbox T25）。
- **除本波授权 E 车道在 TaskDrawer.tsx 换笔记占位外，禁止车道改 `src/domain/*` 与 `src/App.tsx`**；需要领域层补算时先在回复里报告，由集成窗口裁决。
- 禁止往 `src/locales/*` 既有键块内部塞子键；一律追加新的顶层键块（插在 `safemode` 之后、自带闭合 `},`），zh/en 键集合严格一致。
- 卡片禁条纹 / 禁整卡底色（C 方案），这是硬约束不是风格偏好。
- TipTap 只用官方 `@tiptap/markdown` 做 markdown 序列化；禁止引入社区 `tiptap-markdown`。
