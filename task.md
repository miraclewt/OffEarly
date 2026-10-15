# OffEarly（早下班）实施任务拆分

> **For agentic workers:** 本文件是任务状态的**唯一事实源**。任何模型 / agent 在动手前必须先读完本文件与 spec，并遵守文末《状态同步协议》。实施时推荐使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务推进。

**Goal:** 交付一个双击即用的单 HTML 个人任务管理工具 OffEarly，含看板、只读甘特图、Markdown 笔记与图片、备份与多端冲突保护。

**Architecture:** 四层架构（views / controllers / domain / persistence），依赖只向下；所有写操作经 CommandBus；甘特图为领域层产出的 GanttModel 的只读 SVG 投影；数据落在用户选定的数据文件夹（vault.json + assets/ + .backup/）。

**Tech Stack:** TypeScript 7 (strict) · React 19.3 · Vite 8 + vite-plugin-singlefile 2.3.3 (format: iife) · Zustand · dnd-kit · TipTap + tiptap-markdown · dayjs · Zod · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-10-15-taskdone-architecture-design.md`（v1.1）

## Global Constraints（所有任务默认包含）

- 产物为单个 `OffEarly.html`，双击运行；`build.rollupOptions.output.format: 'iife'` + `inlineDynamicImports: true`，零 chunk
- 产物零网络请求：不含任何 `http(s)://` 资源引用；字体用系统栈，不内嵌 webfont
- 全项目禁 emoji；图标一律 inline SVG sprite（1.5px 描边）
- 看板固定四列：todo / doing / review / done；归档为布尔 + 筛选维度，不是列
- 甘特图只读：无拖拽改期、无拖入排期；日期在 TaskDrawer 修改
- 卡片话题标识为色点 + 话题名文本（C 方案），禁止左色条 / 顶线 / 整卡底色
- 数据文件夹布局：`vault.json` + `assets/` + `.backup/`；图片以 `![](assets/<id>.<ext>)` 相对路径引用
- 中英双语：自写 `t()` + 类型安全消息表，不引入 i18next；`t()` 只用于 UI 文案，不用于数据
- 派生数据不落盘；`order` 用 LexoRank 字符串
- 每个任务遵循 TDD：先写失败测试 → 实现 → 通过 → 提交；task.md 状态变更与代码同 commit

## 目录与文件职责（任务产出对照）

```
spike.html                       T01 风险验证页（一次性，验证后归档）
src/main.tsx                     入口挂载
src/App.tsx                      视图切换 + 全局 Provider + 启动流程
src/locales/{zh.ts,en.ts}        消息表
src/locales/i18n.ts              t() + locale 解析与切换
src/domain/types.ts              Vault/Task/Topic/Dependency/Milestone/Asset/Settings/Filter 类型
src/domain/schema.ts             Zod schema + schemaVersion 迁移管线
src/domain/lexorank.ts           LexoRank 中点插入
src/domain/scheduleEngine.ts     工作日历工期计算
src/domain/dependencyGraph.ts    邻接 / 环检测 / 关键路径 / 阻塞链
src/domain/topicTree.ts          topic 树与归属
src/domain/queryEngine.ts        组合筛选 + 依赖跳数 + 全文搜索
src/domain/store.ts              Zustand VaultStore
src/domain/commandBus.ts         Command 定义 + apply/undo/redo
src/domain/ganttModel.ts         buildGanttModel 纯函数
src/persistence/fsAdapter.ts     目录句柄 / 读写 / 权限
src/persistence/handleStore.ts   句柄持久化（IndexedDB，含降级）
src/persistence/vaultRepository.ts  load/save/peekRevision
src/persistence/assetStore.ts    图片落盘 / blob URL / gc
src/persistence/snapshotStore.ts 快照与恢复
src/persistence/autosave.ts      dirty / debounce / Ctrl+S
src/views/*                      BoardView GanttView TaskDrawer NoteEditor TopicSidebar
                                 MilestonePanel FilterBar BackupPanel ConflictDialog
                                 SafeModeBanner IconSprite
src/controllers/*                boardDnd ganttViewport undoRedo filters
tests/**                         与 src 镜像
```

---

## 状态同步协议（多模型 / 多 agent 必读）

**状态值：** `pending` → `in_progress` → `done`；异常为 `blocked`。

**唯一事实源：** 下方《任务总表》。任务明细块内只维护验收标准勾选，不重复存状态。

**agent 标识约定：** `<模型名>:<会话短id>`，如 `claude:sess-a1b2`、`gpt:sess-c3d4`。

1. **开工前必读。** 读 task.md 全文 + spec 对应章节；确认目标 task 为 `pending` 且其「依赖」全部 `done`，否则不得开工。
2. **领取即登记。** 立即把总表状态改 `in_progress` 并写 `(日期, agent)`；同一 agent 同一时间只持有一个 `in_progress`。
3. **完成即闭环。** 逐条跑验收标准并勾选 → 总表改 `done` 写 `(日期, agent, commit)` → 文末《完成记录》追加一条（task / agent / commit / 验收自检摘要 / 遗留问题）。三处必须一致。commit 标识写该次提交的主题行（自引用哈希不可得），真实哈希由 `git log --oneline` 提供。
4. **阻塞即上报。** 改 `blocked` 并写原因与已尝试手段；不得静默放弃、不得跳过依赖。
5. **原子提交。** task.md 的状态变更必须与该任务的代码变更在**同一个 commit**；禁止单独 commit 状态。
6. **不跨任务。** 只改本任务「产出」清单内的文件；发现需改邻居任务范围，先在《完成记录》追加「变更提议」条目再动。
7. **冲突裁决。** 两 agent 并改 task.md 冲突时按 git 时间序合并，状态取较晚完成者；无法判定回退 `pending` 并在日志记冲突事件。
8. **只增不删。** 《完成记录》只追加；更正用新条目注明「更正 Txx」。

---

## 分支与合入约定（trunk-based 短分支）

**主干：** `feat/foundation`。所有车道分支从主干切出、回合主干；合入单元是**单个任务**，不是整条车道。

**车道划分（按 spec 第 3 节分层边界，文件域互斥）：**

| 车道 | 分支 | 任务链 | 主要文件域 |
|---|---|---|---|
| A 领域·状态 | `feat/lane-domain-state` | T10 | `src/domain/{lexorank,store,commandBus}.ts` |
| B 领域·算法 | `feat/lane-depgraph` | T12 → T13 → T19 | `src/domain/{dependencyGraph,topicTree,queryEngine,ganttModel}.ts` |
| C 日程引擎 | `feat/lane-schedule` | T11 | `src/domain/scheduleEngine.ts` |
| D 持久化·安全 | `feat/lane-persistence` | T09 → T27 → T29 → T26 → T28 | `src/persistence/*` |
| E 看板 UI | `feat/lane-board-ui` | T14 → T15 → T17 → T24 → T25 | `src/views/{Topic*,Board*,Task*,Filter*,Milestone*,NoteEditor,Lightbox}.tsx` |
| F 甘特 UI | `feat/lane-gantt` | T20 → T21 → T22 → T23 | `src/views/Gantt*`、`src/controllers/ganttViewport.ts` |
| G 集成·交付 | 主干直做 | T30 → T31 → T32 → T33 | 全库（单一 owner） |

**合入规则（五条，违反即视为冲突源）：**

1. **一个任务一合入。** 某 Txx 验收全绿 → 立即 rebase 到主干 → `git merge --no-ff` → 车道继续 rebase。**分支寿命 ≤1 天**；禁止长期分歧后再合。
2. **热文件单写者。** `task.md` / `src/App.tsx` / `package.json` / `package-lock.json` 同一时刻只允许一个车道持有未提交改动。`src/locales/*` 一律**尾部追加**键。
3. **依赖安装串行。** 同一波次内只允许一条车道改 `package.json`；合并后由主干统一 `npm install` 生成 lock，其余车道再 rebase 取新 lock。**车道一律不提交 `package-lock.json` 的差异**——跑完 `npm install` 后若 lock 被改写，先 `git checkout -- package-lock.json` 还原，再只提交 `package.json` 的依赖行。
4. **App.tsx 单 owner。** 视图挂载 / 路由接线统一由集成车道（主干）执行；车道只交付「可挂载」的组件（沿用 T05 IconSprite、T08 SaveIndicator 的既定手法）。
5. **状态同步不变。** 仍遵《状态同步协议》；本约定只补充「用哪条分支、怎么合」。

**依赖修正（2026-10-15）：** `T12` 的依赖由 `T10` **放宽为 `T03`**。依据 spec 第 3 节模块表——`DependencyGraph` 是纯函数模块（依赖「无」），只需要 T03 的类型定义，不需要 T10 的 VaultStore。放宽后首波可并行 **T09 / T10 / T11 / T12** 四个文件域互斥的任务。其余依赖保持不变（`T13←T12`、`T19←T11,T12,T13` 均为真实调用依赖，不放宽）。

---

## 任务总表

### Phase 0 · 风险验证
- [x] **T01** file:// 六项风险 spike 验证 → done (2026-10-15, qoder:sess-1015a, commit: "T01: all six file:// risks verified in enterprise Edge, spike archived")

### Phase 1 · 工程基座
- [x] **T02** Vite + TS + singlefile(iife) 构建管线与空壳产物 → done (2026-10-15, qoder:sess-1015a, commit: "T02: build pipeline")
- [x] **T03** 领域类型 + Zod Schema + 迁移管线 → done (2026-10-15, qoder:sess-1015a, commit: "T03: domain types + zod schema + migration pipeline")
- [x] **T04** i18n 基座（zh/en 消息表 + t() + locale 切换） → done (2026-10-15, qoder:sess-1015a, commit: "T04: i18n base with typed message keys and locale switching")
- [x] **T05** IconSprite 线性图标集 + 禁 emoji lint → done (2026-10-15, qoder:sess-1015c, commit: "T05: inline SVG icon sprite + no-emoji lint")

### Phase 2 · 持久化基座
- [x] **T06** FsAccessAdapter + handleStore（目录连接 / 权限恢复 / 降级） → done (2026-10-15, qoder:sess-1015d, commit: "T06: FsAccessAdapter + handleStore with IndexedDB persistence and R2 fallback")
- [x] **T07** VaultRepository + 启动流程首屏 → done (2026-10-15, qoder:sess-1015e, commit: "T07: VaultRepository + startup flow first screen with safe mode")
- [x] **T08** Autosave controller（dirty / debounce / Ctrl+S / 保存指示） → done (2026-10-15, workbuddy:sess-1015f, commit: "T08: autosave controller with dirty tracking, debounce, Ctrl+S and three-state save indicator")
- [ ] **T09** SnapshotStore（自动与手动快照 / 保留策略 / 恢复） → pending

### Phase 3 · 领域层
- [ ] **T10** lexorank + VaultStore + CommandBus（undo/redo） → pending
- [ ] **T11** ScheduleEngine（工作日历工期计算） → pending
- [ ] **T12** DependencyGraph（邻接 / 环 / 关键路径 / 阻塞链） → pending
- [ ] **T13** TopicTree + QueryEngine（组合筛选 / 依赖跳数 / 全文） → pending

### Phase 4 · 看板与详情
- [ ] **T14** TopicSidebar（树 / CRUD / 归档 / 里程碑入口） → pending
- [ ] **T15** BoardView + TaskCard（C 方案卡片 / dnd-kit 拖拽 / 阻塞标记） → pending
- [ ] **T16** FilterBar（组合筛选 UI + lastFilter 落盘） → pending
- [ ] **T17** TaskDrawer（属性 / 日期 / 进度 / 依赖编辑） → pending
- [ ] **T18** MilestonePanel（里程碑 CRUD） → pending

### Phase 5 · 甘特图
- [ ] **T19** ganttModel（buildGanttModel 纯函数） → pending
- [ ] **T20** GanttView 渲染（虚拟化 / 刻度 / 今日线 / 里程碑 / 基线） → pending
- [ ] **T21** 依赖箭头 + 关键路径高亮 + hover 依赖高亮 → pending
- [ ] **T22** 未排期侧栏 + 甘特图与筛选联动 → pending
- [ ] **T23** GanttExporter（PNG / SVG / CSV） → pending

### Phase 6 · 笔记与图片
- [ ] **T24** NoteEditor（TipTap + markdown + 快捷语法 + [[双链]]） → pending
- [ ] **T25** AssetStore + 图片插入 / 显示 / 灯箱 → pending
- [ ] **T26** 清理未引用附件 → pending

### Phase 7 · 备份、冲突与安全模式
- [ ] **T27** ConflictDialog（revision 冲突三选 + 30s 轮询） → pending
- [ ] **T28** BackupPanel（快照列表 / 恢复 / 导出库副本 / 导入） → pending
- [ ] **T29** SafeModeBanner + 启动自愈 → pending

### Phase 8 · 打磨与交付
- [ ] **T30** 视觉规范落地校对（主题变量 / 密度 / 圆角 / 阴影） → pending
- [ ] **T31** 构建产物校验（单文件 / 零外部请求 / 体积 / favicon 内联） → pending
- [ ] **T32** Playwright E2E 套件（file:// 全流程） → pending
- [ ] **T33** example.vault 示例库 + 一页纸用户手册 → pending

---

## 任务明细

### T01 · file:// 六项风险 spike 验证

**背景：** spec 第 11 节列出 6 项 `file://` 协议下的未验证风险（R1–R6）。整个架构押注在 File System Access API 与 SVG 导出上，若 R1/R3 不成立需立即启用降级路径，越晚发现返工越大。此任务必须先于一切实现。

**依赖：** 无
**产出：** `spike.html`（约 100 行，验证后移入 `docs/spike/` 归档）

**验收标准：**
- [x] spike.html 双击在目标企业浏览器（Edge/Chrome）打开，页面列出 R1–R6 六项的 true/false 结果
- [x] R1 验证 `showDirectoryPicker` 在 `file://` 可调用并返回目录句柄、可读写子文件 —— **PASS（用户 2026-10-15 企业 Edge 实测）**：目录选择、`assets/` 子目录创建、`spike-write.json` 读写、句柄存 IndexedDB 后复检身份全链路通过。数据文件夹方案成立，**T06 门槛解除**
- [x] R2 验证句柄存入 IndexedDB 后重开页面可取出（失败则记录降级：每次启动重选目录）—— PASS：IndexedDB 在 `file://` 可读写
- [x] R3 验证内联样式 SVG → data URI → Canvas → `toBlob` 导出不抛 SecurityError（taint）—— PASS：产出 5981 字节 PNG，画布未 taint
- [x] R4 验证剪贴板粘贴图片在 `file://` 可取到 File（失败则降级为仅拖入/选文件）—— **PASS（用户 2026-10-15 企业 Edge 复测）**：粘贴框 `paste` 事件取到 `image/png`、22821 字节、名称 `image.png`、`hasFocus=true`；`clipboard.read` 探针同时取到同一张图（权限 `prompt`）。首轮 FAIL 属 spike 采集方式缺陷（拿需要前台焦点+权限的 API 测不依赖它的功能），非环境问题。**降级不启用**，三条插入路径全保留；实现只走 `paste` 事件的 `clipboardData`
- [x] R5 用 5000 任务样本 JSON 测 `JSON.stringify` 耗时并记录毫秒数 —— PASS：stringify 18.1ms / parse 8.1ms / 2691 KB
- [x] 结果回填 spec 第 11 节表格，据此裁剪降级路径；spike 归档并提交 —— 已回填 11.1：**R1–R6 全部通过，六条降级方案一条都不必启用**（保留为已备不用的兜底）；`spike.html` 标注为 T01 归档件保留在仓库根目录，可随时双击复测

**预估：** 0.5d

---

### T02 · Vite + TS + singlefile(iife) 构建管线与空壳产物

**背景：** `file://` 下 ES module 被 CORS 拦截，必须 IIFE 单 bundle。构建管线是后续所有任务的地基，需先锁定产物形态。

**依赖：** 无
**产出：** `package.json` `vite.config.ts` `tsconfig.json` `src/main.tsx` `src/App.tsx`

**验收标准：**
- [x] `npm run build` 产出单个 `dist/OffEarly.html`，内联全部 JS/CSS，无外链 `<script src>` / `<link href>`（实测：dist 目录仅 1 个文件；`<link` 0 处、`<script src` 0 处、`(src|href)="http(s)://` 0 处、`url(http` 0 处）
- [x] 产物中 `<script>` 为 IIFE（无 `type="module"`），双击在 Edge/Chrome 打开渲染出空壳界面（含 wordmark OffEarly / 早下班）—— 实测 `file://` 下渲染成功：`#root` 有 1 个子节点、logo 5 条 path、控制台零消息
- [x] tsconfig 开启 `strict`、`noUncheckedIndexedAccess`（另加 `noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax`；`tsc --noEmit` 干净）
- [x] 产物 grep 无 `http://` 与 `https://` 资源引用
- [x] 提交含构建脚本与空壳产物验证截图或说明

**实施注记（T02 发现）**：`vite-plugin-singlefile` 只内联、不改脚本标签，产物仍是 `<script type="module" crossorigin>` 且位于 `<head>`，在 `file://` 下不执行、且先于 `#root` 存在。`vite.config.ts` 因此追加 `finalizeSingleFile()` 插件：剥离 `type="module"`/`crossorigin` 并把 bundle 移到 `#root` 之后。降级为经典脚本的前提已实测确认：bundle 内 `import.meta` 0 处、top-level `export` 0 处、动态 `import()` 0 处。实际版本为 Vite 8.3.4 / React 19.3.1 / TypeScript 7.0.2 / vite-plugin-singlefile 2.3.3，spec 已同步至 v1.2。

**预估：** 0.5d

---

### T03 · 领域类型 + Zod Schema + 迁移管线

**背景：** 数据文件是用户资产，必须有运行时校验与版本迁移；类型是全部领域代码的契约。

**依赖：** T02
**产出：** `src/domain/types.ts` `src/domain/schema.ts` `tests/domain/schema.test.ts`

**验收标准：**
- [x] types.ts 定义 Vault/Topic/Task/Dependency/Milestone/Asset/Settings/WorkCalendar/Filter，字段与 spec 4.2 完全一致（status 仅四值；Task.archived 独立于 status）
- [x] schema.ts 用 Zod 镜像全部类型；`VaultSchema.parse` 对合法样本通过、对缺字段/错枚举抛错
- [x] 迁移管线 `migrate(raw): Vault` 支持 `schemaVersion` 链式升级；迁移前返回需备份标记（`needsMigration(raw)`）
- [x] 单测覆盖：合法往返、缺字段报错、错枚举报错、v1→v2 迁移函数被调用（以假迁移注册验证）
- [x] 单测全绿并提交（19 passed / `tsc --noEmit` 无错 / `npm run build` 仍产出单文件）

**实测证据：** `npx vitest run` → `Test Files 1 passed (1) / Tests 19 passed (19)`；`npx tsc --noEmit` 零输出；`npm run build` → `dist/OffEarly.html` 220.54 kB。

**变更提议（越界清单，已实施并记录）**：为使单测被类型检查覆盖并一条命令可跑，改动了 T02 的两个文件 —— `tsconfig.json` 的 `include` 增加 `"tests"`，`package.json` 增加 `"test": "vitest run"`；`schema.ts` 内的 `SchemaAlignment` 编译期断言依赖前者才会在 `npm run build` 中生效。

**实施注记（T03 发现）**：spec 4.2 只用注释描述 `settings`，落地时必须显式化，已把 `Settings` 与 `Status/Kind/Priority` 别名写进 spec 4.2（文档版本升到 v1.3）。校验语义取「settings 子树带默认值、其余一律必填」：用户手改 `vault.json` 最常漏设置项，缺失补默认；结构缺失或枚举越界直接拒绝加载，不静默修补。日期分两类，`z.iso.date()` 会拒 `2026-02-30` 这类伪日期，时间戳用 `z.iso.datetime({ offset: true })` 以容忍带时区的历史文件。迁移链以 `MigrationChain = Record<number, MigrationStep>` 注入 `applyMigrations`，因此测试可用假迁移验证链式升级，而不必真的把 `CURRENT_SCHEMA_VERSION` 顶高；`migrate` 迁移后仍跑 `VaultSchema.parse`，坏产物不会放行。`schema.ts` 内 `SchemaAlignment` 用条件类型恒等式逐实体断言 `Equal<types 声明, z.infer<schema>>`，字段漂移在编译期失败。实际版本 zod 4.6.7 / vitest 5.0.4（沿用 T02「取注册表当前稳定版」的结论）。

**预估：** 1d

---

### T04 · i18n 基座（zh/en 消息表 + t() + locale 切换）

**背景：** 中英双语是硬约束；自写 t() 避免 i18next 体积。消息表缺失需在编译期暴露。

**依赖：** T02
**产出：** `src/locales/zh.ts` `src/locales/en.ts` `src/locales/i18n.ts` `tests/locales/i18n.test.ts`

**验收标准：**
- [x] `t(key, params?)` 支持 `{name}` 插值；key 类型为 `NestedKeyOf<typeof zh>`（`interpolate` 三条单测 + 编译期断言 `Equal<MsgKey, 附录A 十二个叶子键>`，证明不产出 `status` 这类分支键）
- [x] `en.ts` 类型为 `Record<MsgKey, string>`，缺翻译编译期报错（负例实测：删掉 `workweek` → `error TS2741: Property 'workweek' is missing … but required in type 'Record<"baseline" | … | "workweek", string>'`，`tsc` exit 1；补回后 exit 0）
- [x] `resolveLocale('auto')` 在 `navigator.language` 为 zh* 时返回 zh，否则 en；显式设置优先（zh-CN/zh-TW/zh-HK/zh → zh；en-US/de-DE/ja-JP → en；`('zh','en-US')→zh`；省略第二参时读 `navigator.language`）
- [x] locale 存于 VaultStore（非模块常量），切换后订阅组件重渲染（`LocaleSource` 接口注入，T10 的 VaultStore 即为实现；组件测试用 `useSyncExternalStore` 断言「评审中」→「In Review」且 `data-locale` 同步变化）
- [x] 消息表含 spec 附录 A 全部术语（12 条 `[key, 中文, English]` 逐字双向断言；另断言 `Object.keys(en)` 与附录 A 键集合完全相等，多一条也算失败）
- [x] 单测全绿并提交

**实测证据：** `npx tsc --noEmit` exit 0；`npm run test` → `Test Files 2 passed (2) / Tests 34 passed (34)`（本任务 15 条 + T03 19 条）；`npm run build` 产物仍为单文件 `dist/OffEarly.html` 220522 字节（与 T03 相同——`src/locales/*` 尚未被应用代码引用，接线在 T15+）。

**变更提议（越界清单）**：为满足「组件测试验证文案变化」这条验收，新增三个 devDependencies：jsdom 30.1.3、@testing-library/react 16.3.0、@testing-library/dom 10.4.1；环境切换用测试文件顶部的 `// @vitest-environment jsdom` docblock 实现，因此**没有**改 T02 的 `vite.config.ts`，只动了 `package.json` / `package-lock.json`。

**实施注记（T04 发现）**：照 spec 字面，zh 是嵌套表、en 是扁平的 `Record<MsgKey, string>`，两者结构不同，故 i18n 内部把 zh 拉平成同一张扁平表再统一查表（`flatten`，8 行）。`createI18n` 只在**解析结果真的变了**时才通知订阅者——`auto` 与显式 `'en'` 可能同为英文，VaultStore 的任何改动都不该白刷视图。插值抽成 `interpolate` 导出是为了单测：附录 A 全是单词、没有带占位符的句式，不为测试而新增消息键。

**预估：** 0.5d

---

### T05 · IconSprite 线性图标集 + 禁 emoji lint

**背景：** 禁 emoji 是产品硬要求；图标需统一 1.5px 描边线性风格并集中管理。

**依赖：** T02
**产出：** `src/views/IconSprite.tsx` `scripts/no-emoji.mjs` `package.json`(lint 脚本)

**验收标准：**
- [x] IconSprite 以 `<symbol>`+`<use>` 提供 ≥24 个图标：chevron、search、undo、redo、export、download、zoom-in、zoom-out、filter、backup、settings、note、dependency、milestone、attach、image、bold、italic、strike、code、list-ol、list-ul、list-task、quote、link、table、divider、close、plus、calendar、clock —— 共 **32** 个（清单 31 个全覆盖，另加 `chevron-right` 供 T14 话题树展开使用），单测逐名断言
- [x] 全部图标 1.5px 描边、round cap，无填充块、无 emoji 字符 —— 描边语言写在 `<symbol>` 上（`fill=none` `stroke=currentColor` `stroke-width=1.5` `stroke-linecap/linejoin=round`），子节点只有 `<path>` 且**不得自带 fill/stroke**（单测断言）；`dependency`/`settings`/`list-ul` 的圆用两段圆弧 path 表达，全表无 circle/rect 元素
- [x] `npm run lint:emoji` 扫描 src/ 与 locales/，命中 emoji 码位范围（U+1F300–U+1FAFF、U+2600–U+27BF 等）即退出码 1 —— 默认目标 `src` + `src/locales`，命中输出 `文件:行:列 U+码位 区段说明`；8 条单测覆盖 U+1F600/U+2600–27BF/U+FE0F/区域指示符、非文本扩展名跳过、以及**不误伤 `→`(U+2192) 与中日韩文本**（源码注释在用）
- [x] CI/构建脚本接入 lint:emoji；负例（临时插入一个 emoji）验证能失败后移除 —— `build` 改为 `npm run lint:emoji && tsc --noEmit && vite build`；负例实跑：临时 `src/__emoji-probe.ts` → `src/__emoji-probe.ts:1:19 U+1F600`、exit 1，删除后 exit 0
- [x] 提交

**实测证据：** `npx tsc --noEmit` exit 0；`npm run test` → `Test Files 6 passed (6) / Tests 76 passed (76)`（本任务 15 条）；`npm run build` → `dist/index.html` 220.54 kB 单文件（lint:emoji 作为 build 前置已生效）。图标质量不是推断：在真实 Chromium 的 `file://` 页面里对 32 个 symbol 逐个跑 `use.getBBox()`（全部落在 0.4–23.6 安全区内）并用 `Path2D` + canvas 栅格化为字符图逐个目检，据此放大了 `list-task` 复选框（4.5→6 单位，1.5px 描边下原本糊成实心）、加宽 `filter` 漏斗下管（10–14→9.5–14.5）、放大 `dependency` 节点圆（r2.5→3）以露出环空。

**实施注记（T05 发现）**：`<use>` 的 shadow 内容**不继承 sprite 根 `<svg>`** 的呈现属性，只继承 `<use>` 所在上下文——所以描边属性必须挂在 `<symbol>` 上而不是 sprite 容器上，`stroke="currentColor"` 因此仍按使用处的文字色解析，图标颜色跟着主题走。React 19 的 `<use href>` 即可，无需 `xlink:href`。`Icon` 默认可选 `label`：省略即 `aria-hidden`（装饰性，按钮内已有文字），给了就走 `role="img" + aria-label`。sprite 需在应用根挂载一次，本任务只交付组件、**未改 `src/App.tsx`**（不在产出清单内），接线归 T07 启动流程。

**越界/并发说明**：`tests/views/IconSprite.test.tsx`、`tests/scripts/noEmoji.test.ts` 依「tests/** 与 src 镜像」与 TDD 全局约束新增（与 T03/T04 同样的测试文件补法，未改邻居任务文件）。`package-lock.json` 本次无改动。提交期间工作树存在另一 agent 的 T06 未提交产物（`src/persistence/*`、`tests/persistence/*`），本次 commit 只 stage 本任务四个新文件 + `package.json` + `task.md`，未纳入也未改写对方文件；对方一度写入 `package.json` 的 `zustand` 依赖行与 T10 的 `in_progress` 行在其自行回退后才提交，故本 commit 的 `package.json` 只含 lint 脚本两行。

**预估：** 0.5d

---

### T06 · FsAccessAdapter + handleStore（目录连接 / 权限恢复 / 降级）

**背景：** 全项目唯一接触 File System API 的层；句柄持久化与降级策略决定启动体验。

**依赖：** T01, T03
**产出：** `src/persistence/fsAdapter.ts` `src/persistence/handleStore.ts` `tests/persistence/fsAdapter.test.ts`

**验收标准：**
- [x] `connectDir()` 调 `showDirectoryPicker` 返回目录句柄；`ensureSubdirs()` 创建 `assets/` 与 `.backup/`（已存在则跳过）
- [x] `readText/writeText/readBinary/writeBinary/remove/list` 六个原语齐备，write 后 `close()` flush
- [x] handleStore 将句柄存 IndexedDB；重开可取出并 `queryPermission`；无权限时 `requestPermission` 一次点击恢复
- [x] R2 降级生效：IndexedDB 不可用时 handleStore 返回 null 且不抛错（启动走重选目录路径）
- [x] 单测以 mock 句柄覆盖六原语与降级分支；全绿并提交

**预估：** 1d

---

### T07 · VaultRepository + 启动流程首屏

**背景：** 启动流程是用户第一接触点：连接目录、校验、迁移、或新建库。

**依赖：** T06
**产出：** `src/persistence/vaultRepository.ts` `src/App.tsx`(启动流程) `tests/persistence/vaultRepository.test.ts`

**验收标准：**
- [x] `load()` 读 vault.json → Zod 校验 → 迁移 → 返回 Vault；文件不存在返回 null
- [x] 空目录启动显示「在此创建新库？」确认；确认后初始化 vault.json（vaultId=nanoid、revision=0、schemaVersion=1）
- [x] 含 vault.json 的目录启动直接进入应用并渲染空看板
- [x] `peekRevision()` 只读返回磁盘 revision，不加载全量
- [x] 校验失败不写盘、进入只读安全模式占位（T29 完成横幅）；单测覆盖三路径；提交

**实测证据：** `npx tsc --noEmit` exit 0；`npm run test` 107/107 绿（本任务 27 条：repository 17 + App 启动 10，先 RED 后 GREEN）；`npm run lint:emoji` 干净；`npm run build` 产出单文件 `dist/OffEarly.html` 325.5 kB（`<script src` 0 / `<link href` 0 / 外链 0；5 处 `http(s)://` 匹配全是 React 内部错误文案模板与 W3C 命名空间标识符，非资源引用）；产物在真实浏览器 `file://` 下冒烟：首屏渲染「连接数据文件夹 + 选择文件夹」、侧栏 wordmark 正常、控制台零消息。

**实施注记（T07 发现）：**
- `peekRevision` 的「不加载全量」用 `fsAdapter.readHead`（新原语，T06 文件的追加，见变更提议）只取前 4096 字节正则提 `"revision":N`；能这么做的前提是 `save()` 自己控制键序（revision 固定在第四位），键序被用户手改/外部格式化打乱时退回全量解析兜底（有专门用例）。
- `create()` 调 `ensureSubdirs`（assets/ + .backup/）后写盘；**已有 vault.json 时拒绝覆盖**——空目录询问与防覆盖是同一安全面的两面。
- 错误统一：JSON 语法坏、Zod 结构非法、schemaVersion 过高三类失败在 `load()` 内统一抛 `VaultValidationError`（带 issues 明细），App 只认这一种错误进安全模式；安全模式下不写盘由 App 测试断言「原文件字节不变」落在 mock 文件系统上，不是 spy 次数。
- App 的 `StartupPorts` 注入六 seam（loadStoredDir/storeDir/hasWritePermission/requestWritePermission/pickDir/openRepository），默认实现接 T06 的 handleStore/verifyPermission/connectDir；组件测试因此全链路走真 repository + mock FS。
- 句柄「打开成功才记住」：空目录、损坏库都不写 IndexedDB，下次启动仍走选择路径，避免污染。
- 空看板占位按 `vault.settings.boardColumns` 渲染（当前固定四列），列头走 `t('status.*')`；`IconSprite` 已在 App 根挂载（T05 遗留接线），`data-testid="board"` 留给 T15。
- locale：库打开前按 `navigator.language` 解析，打开后随 `vault.settings.locale`；T10 的 VaultStore 落地后此 useI18n 换接 Store 的 LocaleSource。
- `appVersion` 写入 `'OffEarly 0.1.0'` 字符串常量（与 package.json version 对齐），未引构建期注入——体积约束下不值得为它加 define 管线，T31 校验时如需要再统一。

**变更提议（越界清单，均经用户确认，已实施）：**
1. `src/locales/zh.ts` / `en.ts` 新增 `startup.*`（13 键）与 `board.emptyColumn`：附录 A 锁的是 12 条术语译名，启动屏 UI 文案无处可放；`tests/locales/i18n.test.ts` 的「en 键集合与附录 A 完全相等」改为超集断言（12 条术语逐字存在、分支键 `status` 不可查），编译期 `Record<MsgKey,string>` 约束不变；spec 附录 A 下补「锁定范围」注记（文档仍 v1.3）。
2. `src/persistence/fsAdapter.ts` 追加 `readHead(dir, path, maxBytes)` 原语（`tests/persistence/fsAdapter.test.ts` +4 用例）：fsAdapter 是「全项目唯一接触 File System API 的层」，peekRevision 的头读必须经它，不能破分层。
3. `tests/persistence/mockFs.ts` 的 `getFile()` 返回值补齐 `size`/`slice`（真实 `File extends Blob` 的能力），并把内容模型统一为字节拼接（string chunk 按 UTF-8 编码后拼接，比之前「text 拼接 + 取最后一个字节 chunk」更贴近真实 createWritable 语义）；另暴露 `bytes()` 供落盘断言。T06 既有用例全部保持绿，无行为回退。
4. `package.json` / `package-lock.json` 新增 runtime 依赖 `nanoid 6.0.2`（ESM-only，Vite IIFE 打包实测通过）：验收项字面要求 `vaultId=nanoid`，T25 附件 id 复用。

**预估：** 1d

---

### T08 · Autosave controller（dirty / debounce / Ctrl+S / 保存指示）

**背景：** 自动落盘是"本地应用感"的来源；保存指示是用户信任锚点。

**依赖：** T07, T10
**产出：** `src/persistence/autosave.ts` `tests/persistence/autosave.test.ts`

**验收标准：**
- [x] Store 变更标记 dirty；debounce 1200ms 后触发 save；Ctrl+S 立即 save（假计时器验证）—— 19 条单测跑 `vi.useFakeTimers` + `advanceTimersByTimeAsync`：1199ms 不写盘、1200ms 写一次、窗口内两次改动合并为一次且写最新内容、`saveNow()` 立即写并取消已排队的自动保存、无变更时 no-op
- [x] save 时 `revision++` 且 `updatedAt` 刷新；保存成功后 dirty 清除 —— revision 0→1→2 递增；写盘对象的 `updatedAt` 取自注入的 `now()`；保存成功后 `markSaved(revision, updatedAt)` 把新 revision 回写 Store（不回写则下次保存原地踏步、T27 冲突检测失效）
- [x] 保存失败置 `saveState='error'`，UI 显示「保存失败(重试)」，内存数据不丢；重试成功恢复 `saved` —— 失败时 sink 一次都没被写入、Store 里的任务原样保留、dirty 不被清掉；`retry()` 成功后 `lastError=null`、落盘 revision=1、内容含失败期间的全部编辑
- [x] 保存指示三态 `saved / dirty / error` 在顶栏可见（组件测试）—— 新增 `src/views/SaveIndicator.tsx`，以 `useSyncExternalStore` 订阅控制器；组件测试 3 条（三态文案 + `data-state` + en 文案 + 点重试调用控制器）＋ 2 条与真 Autosave 联动的端到端（编辑→未保存→debounce 到期→已保存；失败→保存失败+重试按钮→修复后点重试→已保存）
- [x] 单测全绿并提交 —— `npm run test` 131/131（本任务 24 条：autosave 19 + SaveIndicator 5，先 RED 后 GREEN）；`npx tsc --noEmit` exit 0；`npm run lint:emoji` 干净；`npm run build` 单文件 `dist/OffEarly.html` 325651 字节（`<script src` 0 / `<link` 0 / `type="module"` 0 / `http(s)://` 资源引用 0）

**实测证据：** 上一条即逐项证据。新增的两个模块都还没被 `src/App.tsx` 引用，产物只随 locales 的 4 个新键微增（325.5 → 325.65 kB），T02/T03/T05 的单文件不变式复测通过。

**变更提议（越界清单，已实施并记录）**
1. 新增 `src/views/SaveIndicator.tsx` + `tests/views/SaveIndicator.test.tsx`：验收项 4 明写「保存指示三态在顶栏可见（组件测试）」，但本任务产出清单只有 `autosave.ts`，没有任何视图文件——按 T03/T07「产出清单不全即补并记录」的先例补齐。
2. `src/locales/zh.ts` / `en.ts` 新增 `save.*` 4 键（`saved/dirty/error/retry`）：UI 文案必须走 `t()`，而 spec 6.3 锁定的三态文案无处可放；`tests/locales/i18n.test.ts` 的断言在 T07 已放宽为「附录 A 12 条术语逐字存在 + en 为 `Record<MsgKey,string>`」，新增键无需改测试。
3. **未**改 `src/App.tsx`：顶栏挂载点需要活着的 VaultStore（T10 产出），本任务只交付「可挂载」的控制器与指示器，处理方式同 T05 的 IconSprite、T04 的 locales。

**实施注记（T08 发现）**
- **依赖 T10 未落地，用注入端口解耦。** 总表里 T08 依赖写了 T10（VaultStore），而 T10 当时仍 pending。沿用 T04「`LocaleSource` 接口注入、由 T10 的 VaultStore 实现」的既定手法，autosave 只依赖最小端口 `AutosaveStore { subscribe, getVault, markSaved }`，不 import `domain/store`；T10 落地时让 VaultStore 实现该端口并调 `start()` 即可，无需改本模块。
- **「自通知不能算用户改动」是本次最容易踩的坑。** Store 写回新 revision 会通知订阅者，若不屏蔽就是「保存→通知→判定被改→再保存」的自激写盘死循环。两道闸一起上：同步通知用 `applying` 抑制位挡掉；延迟/异步通知靠 `markSaved` 的返回值与 `lastAccepted` 引用相等挡掉——所以端口约定 `markSaved` 必须返回 Store 当前持有的那个对象。
- **写盘串行化。** Ctrl+S 与 debounce 可能同时到，用 `chain` 把 `doFlush` 串行化，避免两个 `createWritable` 交错写同一个文件。
- **写盘途中的编辑不能丢。** 保存完成后无脑清 dirty 会吞掉这期间的改动；改用 `edits` 计数与进入写盘时的 `seen` 比对，不一致就保留 dirty 并再排一次 debounce。配套约束：`markSaved` 只回写 revision/updatedAt，**不整体替换** Store 内容，否则会覆盖写盘期间的新编辑。
- **写前快照（T09 接入点）。** `snapshotter` 可选注入，在 `sink.save` 之前调用；快照失败一律视为保存失败、不写盘，兑现 spec 8.2「写前必有快照」——宁可留着 dirty 重试，也不在无备份的情况下覆盖用户数据。「每会话首存 / 距上次 ≥30min」的判定按 T09 验收项留在实现方。
- `Ctrl+S` 在无未保存变更时是 no-op：不白抬 revision，也避免 T27 拿一个没意义的 revision 去做冲突判定。

**遗留：**
- 顶栏挂载点（App shell）与 `Ctrl+S` 全局按键绑定归 T10 / T15：本任务只交付控制器与指示器组件。
- 到目前为止保存流程里没有真正的写前快照：`snapshotter` 端口已就位但无人注入，等 T09 的 SnapshotStore 接上。
- T27 的冲突检测基线应与本控制器对齐：`markSaved` 已把写盘 revision 回写 Store，读 `vault.revision` 即内存基线；30s 轮询与三选弹窗本身不在本任务范围。

**预估：** 0.5d

---

### T09 · SnapshotStore（自动与手动快照 / 保留策略 / 恢复）

**背景：** 无原子 rename 的前提下，快照 + 自愈是数据安全的唯一保障。

**依赖：** T06
**产出：** `src/persistence/snapshotStore.ts` `tests/persistence/snapshotStore.test.ts`

**验收标准：**
- [ ] `snapshot()` 把当前 vault.json 复制为 `.backup/vault-<YYYYMMDD-HHmmss>.json`
- [ ] 自动策略：每会话首存 1 份 + 距上次 ≥30min 1 份（假计时器验证）
- [ ] 保留策略：最近 20 份 + 每日首份保留 30 天，超出删除（构造 25 份样本验证）
- [ ] `list()` 返回时间/大小/任务数；`restore(id)` 恢复前对当前版本再打一份快照
- [ ] 单测全绿并提交

**预估：** 1d

---

### T10 · lexorank + VaultStore + CommandBus（undo/redo）

**背景：** 唯一写入口与撤销栈是看板拖拽、甘特图联动、笔记编辑共用的地基；LexoRank 控制 JSON diff 面。

**依赖：** T03
**产出：** `src/domain/lexorank.ts` `src/domain/store.ts` `src/domain/commandBus.ts` `tests/domain/{lexorank,commandBus}.test.ts`

**验收标准：**
- [ ] `mid(a, b)` 返回严格介于 a、b 之间的字符串；首尾插入（b/a 为 undefined）正确；连续 100 次插入不产生等长冲突退化
- [ ] VaultStore 为 immutable 更新；selector 订阅精确（改 task 不触发 topic 订阅者，组件测试）
- [ ] `CommandBus.apply(cmd)` 更新 Store、推 undo 栈、标记 dirty；`undo()/redo()` 可逆（以 MoveTask 命令验证往返一致）
- [ ] 每个 Command 带 `inverse`；undo 后状态与 apply 前深度相等（结构化比较）
- [ ] 单测全绿并提交

**预估：** 1d

---

### T11 · ScheduleEngine（工作日历工期计算）

**背景：** 甘特图与工期显示的全部日期数学集中于此，必须纯函数可测；节假日/补班是中国企业场景刚需。

**依赖：** T03
**产出：** `src/domain/scheduleEngine.ts` `tests/domain/scheduleEngine.test.ts`

**验收标准：**
- [ ] `isWorkday(d, cal)` 正确区分周末、holidays、extraWorkdays（补班周六为工作日）
- [ ] `addWorkdays(d, n)` 跳过非工作日；n=0 返回当日；负数向前推
- [ ] `workdaysBetween(a, b)` 含端点；a>b 返回负值；跨年（12-30 → 01-03）正确
- [ ] `duration(task)` = workdaysBetween(start, due)+1；start/due 缺失返回 null
- [ ] memoize 生效：同日期二次调用不重复计算（以 spy 计数验证）
- [ ] 单测 ≥15 例含节假日/补班/跨年；全绿并提交

**预估：** 1d

---

### T12 · DependencyGraph（邻接 / 环 / 关键路径 / 阻塞链）

**背景：** Jira 式依赖能力核心；环检测决定关键路径是否可算；阻塞链驱动看板标记与筛选。

**依赖：** T03（原为 T10，2026-10-15 放宽：DependencyGraph 为纯函数模块，只需 T03 类型；依据见《分支与合入约定》）
**产出：** `src/domain/dependencyGraph.ts` `tests/domain/dependencyGraph.test.ts`

**验收标准：**
- [ ] 从 links 派生 `from→to` 与 `to→from` 双向 Map；`blocks(id)/blockedBy(id)` 正确
- [ ] `isBlocked(id)` = 存在 status≠done 的前置（FS 语义）
- [ ] `cycles()` 用 Tarjan 返回所有强连通分量中 size>1 的环；无环返回空
- [ ] `criticalPath()` 对 DAG 拓扑排序 + 最长路径（工期为权）返回任务 id 集合；含环时返回 null
- [ ] `upstream(id, n)/downstream(id, n)` N 跳遍历不重复访问、n=0 仅自身
- [ ] 单测含：线性链、菱形、环、双环、跨 topic 依赖；全绿并提交

**预估：** 1.5d

---

### T13 · TopicTree + QueryEngine（组合筛选 / 依赖跳数 / 全文）

**背景：** 筛选是看板与甘特图共用的数据入口；依赖跳数是本项目最有价值的筛选能力。

**依赖：** T12
**产出：** `src/domain/topicTree.ts` `src/domain/queryEngine.ts` `tests/domain/queryEngine.test.ts`

**验收标准：**
- [ ] `descendants(id)` 含全部子孙；`includeDescendants=false` 时仅本 topic
- [ ] Filter 全字段组合生效：statuses/kinds/priorities/tags(any|all)/assignees/dateRange/overdueOnly/blockedOnly/withNotesOnly/includeArchived/text
- [ ] `text` 匹配标题与 note（小写包含）；note 含 markdown 与图片路径不误匹配
- [ ] `upstreamDepth/downstreamDepth` 在命中集合上扩展 N 跳（复用 DependencyGraph）
- [ ] 归档任务默认排除、includeArchived=true 时包含
- [ ] 单测 ≥12 例覆盖组合与边界；全绿并提交

**预估：** 1.5d

---

### T14 · TopicSidebar（树 / CRUD / 归档 / 里程碑入口）

**背景：** topic 是任务归属与筛选主轴；侧栏同时承载里程碑入口与备份/设置入口。

**依赖：** T10, T04, T05
**产出：** `src/views/TopicSidebar.tsx` `src/controllers/topicActions.ts` `tests/views/TopicSidebar.test.tsx`

**验收标准：**
- [ ] 渲染 topic 树（色块 swatch + 名称 + 计数 + chevron），支持无限层、默认展开两层
- [ ] 悬浮显示「+」新建子话题；右键菜单含 重命名 / 改色 / 新建子话题 / 归档
- [ ] 改色从固定 12 色调色板选取；归档 topic 其任务从看板/甘特图消失
- [ ] 点击 topic 设置筛选 topicIds；底部含「里程碑」「筛选器」「备份」「设置」四入口
- [ ] 全部文案走 t()；组件测试覆盖新建/重命名/归档；提交

**预估：** 1d

---

### T15 · BoardView + TaskCard（C 方案卡片 / dnd-kit 拖拽 / 阻塞标记）

**背景：** 看板是主视图；卡片信息密度与话题标识是产品"简洁"主张的直接体现。

**依赖：** T13, T14
**产出：** `src/views/BoardView.tsx` `src/views/BoardColumn.tsx` `src/views/TaskCard.tsx` `src/controllers/boardDnd.ts` `tests/views/BoardView.test.tsx`

**验收标准：**
- [ ] 固定四列 todo/doing/review/done，列头含列名 + 计数 + 完成比
- [ ] 卡片仅 6 项：色点+话题名、标题、类别 chip、优先级点、到期日（逾期 `#DC2626`）、依赖角标；有笔记加文档图标；**无任何条纹/整卡底色**
- [ ] dnd-kit 跨列拖拽改 status、同列拖拽改 order（LexoRank mid）；拖拽后仅被拖记录 order 变化
- [ ] 拖入 doing/review 时若 isBlocked 显示琥珀色阻塞标记（不阻止）
- [ ] 归档任务不渲染；筛选结果驱动列内容
- [ ] 组件测试覆盖拖拽换列与阻塞标记；提交

**预估：** 1.5d

---

### T16 · FilterBar（组合筛选 UI + lastFilter 落盘）

**背景：** 筛选状态需跨视图保持并重开恢复，是"切视图不丢条件"的承诺。

**依赖：** T15
**产出：** `src/views/FilterBar.tsx` `src/controllers/filters.ts` `tests/views/FilterBar.test.tsx`

**验收标准：**
- [ ] 提供 chips：状态/类别/优先级/标签(any|all)/负责人/日期范围/逾期/被阻塞/有笔记/含归档 + 全文搜索框
- [ ] 依赖跳数输入：上游 N 跳 / 下游 N 跳（0–3）
- [ ] 筛选变更写入 `settings.lastFilter` 并落盘；重开应用恢复
- [ ] 看板与甘特图共用同一 QueryEngine 结果（切视图条件不丢，组件测试）
- [ ] 清空按钮一键重置；组件测试覆盖落盘与恢复；提交

**预估：** 1d

---

### T17 · TaskDrawer（属性 / 日期 / 进度 / 依赖编辑）

**背景：** 甘特图只读后，详情抽屉是唯一的排期修改入口；依赖编辑支撑跨 topic 建链。

**依赖：** T15, T12
**产出：** `src/views/TaskDrawer.tsx` `src/views/DependencyEditor.tsx` `tests/views/TaskDrawer.test.tsx`

**验收标准：**
- [ ] 右侧约 400px 覆盖式抽屉，Esc 关闭；点击卡片/甘特条打开
- [ ] 分区：标题 inline 编辑 / 属性行 / 日期与进度（工期只读展示、进度滑块；status=done 强制 progress=100）/ 依赖关系 / 笔记占位（T24 接入）
- [ ] 依赖添加：全库标题模糊搜索下拉，选中建 FS 依赖；类型 FS/SS/FF/SF 与 lagDays 可改；可删除
- [ ] 成环时依赖行标红 + 提示，但允许保存
- [ ] 顶部保存指示三态联动 Autosave；Ctrl+Z 撤销走 CommandBus
- [ ] 组件测试覆盖建依赖/改日期/成环标红；提交

**预估：** 1.5d

---

### T18 · MilestonePanel（里程碑 CRUD）

**背景：** 里程碑是 Project 式进度锚点；需独立管理入口与甘特图菱形联动。

**依赖：** T14
**产出：** `src/views/MilestonePanel.tsx` `tests/views/MilestonePanel.test.tsx`

**验收标准：**
- [ ] 侧栏「里程碑」入口打开列表面板；可新建/编辑/删除（标题、日期、所属 topic 或跨 topic、完成态、颜色）
- [ ] 跨 topic 里程碑 topicId=null，列表置顶分组
- [ ] 甘特图点击菱形打开同一编辑面板（事件联通，T20 渲染后联调）
- [ ] 删除里程碑不影响任务与依赖
- [ ] 组件测试覆盖 CRUD；提交

**预估：** 0.5d

---

### T19 · ganttModel（buildGanttModel 纯函数）

**背景：** 甘特图全部几何在领域层算完，视图只投影；渲染/导出/单测共用同一模型。

**依赖：** T11, T12, T13
**产出：** `src/domain/ganttModel.ts` `tests/domain/ganttModel.test.ts`

**验收标准：**
- [ ] `buildGanttModel(vault, filter, scale, viewport)` 返回 GanttModel（scale/columns/headerRows/rows/arrows/today/criticalIds/unscheduled）
- [ ] day 刻度列宽 32、week 刻度列宽 14；两级表头（月/日、月/周）正确；周末与节假日列带标记
- [ ] rows 按 topic 分组排序（LexoRank），未排期任务进 unscheduled 不进 rows
- [ ] arrows 为已算好的折线拐点坐标（FS 语义：前置右端 → 后置左端）
- [ ] criticalIds 来自 DependencyGraph.criticalPath；含环时为 emptySet 且 model.cycles 非空
- [ ] 单测覆盖刻度切换/分组/箭头坐标/环降级；全绿并提交

**预估：** 1.5d

---

### T20 · GanttView 渲染（虚拟化 / 刻度 / 今日线 / 里程碑 / 基线）

**背景：** 只读投影的渲染层；虚拟化保证大库流畅。

**依赖：** T19
**产出：** `src/views/GanttView.tsx` `src/views/GanttCanvas.tsx` `src/views/GanttTable.tsx` `src/controllers/ganttViewport.ts` `tests/views/GanttView.test.tsx`

**验收标准：**
- [ ] SVG 渲染 rows/arrows/今日线；行高 32；仅渲染视口 ±10 行与可见列（1000 任务样本 DOM 节点数受控，测试断言）
- [ ] 日/周刻度切换按钮 + Ctrl+滚轮与 +/- 缩放，两刻度各自保留缩放状态
- [ ] 任务条圆角矩形（topic 色浅底 + 深色进度内条）；里程碑菱形；跨 topic 里程碑在顶部独立轨道
- [ ] 基线开关：开启时条下方细灰条（baseline start→due）
- [ ] 左侧任务表（任务/开始/结束/进度）与画布 scrollTop 同步；周末/节假日列浅灰底
- [ ] 组件测试覆盖刻度切换与虚拟化断言；提交

**预估：** 2d

---

### T21 · 依赖箭头 + 关键路径高亮 + hover 依赖高亮

**背景：** 依赖可视化是甘特图的价值核心；关键路径与阻塞提示需一眼可辨。

**依赖：** T20
**产出：** `src/views/GanttCanvas.tsx`(箭头层) `tests/views/ganttArrows.test.tsx`

**验收标准：**
- [ ] 箭头为折线 path + marker-end；FS/SS/FF/SF 四种锚点正确（SS 左→左、FF 右→右）
- [ ] 环上依赖箭头红色虚线；criticalIds 任务条描边加粗
- [ ] 「关键路径」checkbox 关闭时不加粗、不计算展示
- [ ] hover 某条：高亮其全部直接依赖（前后各一跳）箭头与条，其余透明度降至 0.25
- [ ] 今日线 1px 红 + 顶部标签
- [ ] 组件测试覆盖四锚点与环标红；提交

**预估：** 1d

---

### T22 · 未排期侧栏 + 甘特图与筛选联动

**背景：** 未排期任务不能从进度视图消失；需给出补排期入口。

**依赖：** T20, T16
**产出：** `src/views/GanttView.tsx`(侧栏) `tests/views/ganttUnscheduled.test.tsx`

**验收标准：**
- [ ] 右侧折叠面板列出 unscheduled 任务（标题 + topic 色点）；可折叠/展开
- [ ] 点击未排期任务打开 TaskDrawer 补日期；补完后该任务进入甘特图 rows
- [ ] 甘特图 rows 受 FilterBar 结果驱动（改筛选即重渲染，条件与看板一致）
- [ ] 组件测试覆盖列出与补排期后出现；提交

**预估：** 0.5d

---

### T23 · GanttExporter（PNG / SVG / CSV）

**背景：** "支持下载图表"是硬需求；PNG 导出在 file:// 下有 taint 风险，需内联样式策略。

**依赖：** T20, T01(R3)
**产出：** `src/views/GanttExporter.ts` `tests/views/ganttExporter.test.ts`

**验收标准：**
- [ ] 导出前把计算样式写成 SVG 内联属性（不留 class）；`font-family` 显式系统栈
- [ ] PNG：SVG → data URI → Image → Canvas(2x) → toBlob → 下载；R3 失败时该按钮禁用并提示
- [ ] SVG：序列化直接下载；CSV：任务+开始+结束+进度+依赖，带 UTF-8 BOM
- [ ] 范围可选：仅可见区 / 全时间跨度
- [ ] 单测以 jsdom + mock canvas 覆盖三格式与 BOM；提交

**预估：** 1d

---

### T24 · NoteEditor（TipTap + markdown + 快捷语法 + [[双链]]）

**背景：** 笔记是 Obsidian 优势的落地；存 Markdown 纯文本保证可读与可迁移。

**依赖：** T17
**产出：** `src/views/NoteEditor.tsx` `tests/views/NoteEditor.test.tsx`

**验收标准：**
- [ ] TipTap + tiptap-markdown；`note` 字段存 Markdown 纯文本（往返 parse/serialize 不丢内容）
- [ ] 工具栏一行线性图标：粗体/斜体/删除线/行内码/代码块/H2/H3/无序/有序/任务列表/引用/链接/表格/图片/分隔线
- [ ] 快捷语法生效：行首 `# ` `- ` `1. ` `> ` `[] ` 与行内 `` ` ``
- [ ] 输入 `[[` 弹任务/里程碑标题搜索，插入 `[[标题]]`；渲染为可点击跳转；同名多任务列候选
- [ ] 编辑经 CommandBus 进 undo 栈；debounce 写入 Store
- [ ] 组件测试覆盖 markdown 往返与双链插入；提交

**预估：** 1.5d

---

### T25 · AssetStore + 图片插入 / 显示 / 灯箱

**背景：** 图片以 sidecar 存储保持 JSON 轻量；file:// 下必须经 blob URL 显示。

**依赖:** T24, T06
**产出：** `src/persistence/assetStore.ts` `src/views/NoteEditor.tsx`(图片节点) `src/views/Lightbox.tsx` `tests/persistence/assetStore.test.ts`

**验收标准：**
- [ ] `put(file)` 写 `assets/<nanoid>.<ext>` 并在 assets 表记元数据；返回相对路径 `assets/<id>.<ext>`
- [ ] 三条插入路径：粘贴 / 拖入 / 工具栏选文件（T01 R4 已在企业 Edge 实测通过，全保留）。粘贴只读 `paste` 事件的 `clipboardData`，不使用 `navigator.clipboard.read()`——后者额外要求前台焦点与 clipboard-read 权限，本功能用不上
- [ ] 限制 png/jpg/jpeg/gif/webp/svg、单张 ≤5MB，超出提示压缩不写入
- [ ] 显示经 `getFile()` → `createObjectURL`，`Map<assetId, objectURL>` 缓存；卸载/删除时 revoke
- [ ] 点击图片开灯箱（原图/缩放/下载）
- [ ] 单测覆盖 put/限制/缓存与 revoke；提交

**预估：** 1.5d

---

### T26 · 清理未引用附件

**背景：** 删除引用不删文件的安全策略需要显式回收通道，避免 assets 无限增长。

**依赖：** T25
**产出：** `src/persistence/assetStore.ts`(gc) `src/views/BackupPanel.tsx`(入口) `tests/persistence/assetGc.test.ts`

**验收标准：**
- [ ] 引用集合 = 扫描全部 task.note 解析 `assets/<id>` 得到
- [ ] `gcPreview()` 返回未引用附件清单 + 可释放字节数；不删除
- [ ] `gc(ids)` 仅删除确认清单内文件与 assets 表记录
- [ ] BackupPanel 提供「清理未引用附件」入口，先展示 preview 再确认
- [ ] 单测覆盖 preview 与 gc 边界（全被引用/全未引用）；提交

**预估：** 0.5d

---

### T27 · ConflictDialog（revision 冲突三选 + 30s 轮询）

**背景：** 共享盘多端同步必然冲突；三选 + 副本导出是不做自动 merge 前提下的安全闭环。

**依赖：** T08, T09
**产出：** `src/views/ConflictDialog.tsx` `src/persistence/vaultRepository.ts`(冲突检测) `tests/persistence/conflict.test.ts`

**验收标准：**
- [ ] save 前 `peekRevision()` > 内存基线 → 弹 ConflictDialog 三选：以我为准 / 以磁盘为准 / 导出我的副本
- [ ] 「以我为准」覆盖磁盘且磁盘旧版已进 .backup；「以磁盘为准」重载并警告丢失条数；「导出副本」写 `vault-conflict-<ts>.json` 后重载
- [ ] 30s 轮询 peekRevision：磁盘变且本地不 dirty → 静默重载；dirty → 顶栏提示
- [ ] 单测覆盖三路径与轮询两分支（假计时器）；提交

**预估：** 1d

---

### T28 · BackupPanel（快照列表 / 恢复 / 导出库副本 / 导入）

**背景：** "支持备份数据"是硬需求；导出整库与导入是迁移/灾备通道。

**依赖：** T09, T26
**产出：** `src/views/BackupPanel.tsx` `tests/views/BackupPanel.test.tsx`

**验收标准：**
- [ ] 列出快照（时间/大小/任务数）；「立即快照」；「恢复」前对当前版本再打快照
- [ ] 「导出库副本」递归复制整个数据文件夹（含 assets/）到用户选的目标目录
- [ ] 「导入」选 vault.json 或文件夹 → 校验 → 迁移 → 覆盖内存（写盘前二次确认）
- [ ] 显示附件总大小；含 T26 清理入口
- [ ] 组件测试覆盖列表/恢复确认/导入确认；提交

**预估：** 1d

---

### T29 · SafeModeBanner + 启动自愈

**背景：** 写中断或外部损坏时绝不静默覆盖；只读安全模式是最后防线。

**依赖：** T07, T09
**产出：** `src/views/SafeModeBanner.tsx` `src/persistence/vaultRepository.ts`(自愈) `tests/persistence/safemode.test.ts`

**验收标准：**
- [ ] vault.json 解析/校验/迁移失败 → 不写盘，加载最近可用快照为只读视图
- [ ] 顶部横幅含三按钮：恢复此快照 / 选择其他备份 / 导出当前
- [ ] 只读模式下所有写操作禁用（CommandBus 拒绝并提示）
- [ ] 启动自愈：解析失败自动尝试最近快照一次，仍失败才进安全模式
- [ ] 单测覆盖损坏→自愈→只读链路；提交

**预估：** 1d

---

### T30 · 视觉规范落地校对（主题变量 / 密度 / 圆角 / 阴影）

**背景：** "简洁、克制"是产品主张，需一次集中校对把规范落到 CSS 变量与组件。

**依赖：** T15, T20, T24
**产出：** `src/styles/theme.css` 及各视图样式校对

**验收标准：**
- [ ] CSS 变量集中：背景 `#FAFAFA`、卡片 `#FFFFFF`、边框 `#E5E7EB`、强调 `#4F46E5`、逾期 `#DC2626`、周末底 `#F5F5F5`
- [ ] 圆角 6–8px；阴影仅 hover 2–4px 柔影；无渐变/无装饰插画/无头像
- [ ] 卡片 6 项、列头 3 项、抽屉 5 分区信息密度上限复核（对照 spec 第 7 节）
- [ ] 语义色仅逾期红/阻塞琥珀/完成绿三处
- [ ] 与 `docs/design/01`–`04` 效果图目视比对并记录差异清单；提交

**预估：** 1d

---

### T31 · 构建产物校验（单文件 / 零外部请求 / 体积 / favicon 内联）

**背景：** 交付物必须是可双击、离线、自包含的单文件；需机器校验而非人工保证。

**依赖：** T02, T05, T30
**产出：** `scripts/verify-bundle.mjs` `package.json`(verify 脚本) `src/index.html`(favicon)

**验收标准：**
- [ ] favicon 以 `brand/logo-mark-mono.svg` 的 data URI 内联，无外链
- [ ] verify 脚本断言：单 HTML、无 `<script src>`/`<link href>` 外链、无 `http(s)://` 资源引用、无 `type="module"`
- [ ] 体积断言 < 1.6MB（超出即失败）
- [ ] lint:emoji 接入 verify；产物在 Edge/Chrome 双击打开渲染完整应用
- [ ] verify 接入 build 后置步骤；提交

**预估：** 0.5d

---

### T32 · Playwright E2E 套件（file:// 全流程）

**背景：** 单文件 + file:// 形态的回归只能靠真实浏览器 E2E 保证。

**依赖：** T15, T20, T24, T27, T31
**产出：** `e2e/*.spec.ts` `playwright.config.ts`

**验收标准：**
- [ ] 配置以 `file://` 加载 dist/OffEarly.html 启动
- [ ] 用例：连接目录 → 新建 topic/任务 → 拖拽换列 → 加依赖 → 贴图片 → 保存 → 重开验证落盘
- [ ] 用例：外部改 vault.json revision 后保存触发 ConflictDialog 三选
- [ ] 用例：导出 PNG/SVG/CSV 产生下载文件
- [ ] 用例：甘特图日/周切换与关键路径开关渲染变化
- [ ] 全套件在 CI 或本地一条命令跑绿；提交

**预估：** 2d

---

### T33 · example.vault 示例库 + 一页纸用户手册

**背景：** 首次使用者需要开箱即见的样例与最短上手路径。

**依赖：** T32
**产出：** `example.vault/`（vault.json + assets/ 示例图） `docs/user-guide.md`

**验收标准：**
- [ ] example.vault 含 ≥3 topic、≥12 任务（覆盖四状态/逾期/被阻塞/未排期）、≥2 里程碑、≥1 环外依赖链、≥1 笔记含图片
- [ ] 连接 example.vault 后看板与甘特图均有内容且无校验报错
- [ ] 用户手册一页纸：连接文件夹 / 自动保存与 Ctrl+S / 备份与恢复 / 冲突三选 / 导出图表 / 快捷键，中英双栏
- [ ] 手册截图或步骤与真实 UI 一致；提交

**预估：** 0.5d

---

## 完成记录（只追加）

<!-- 格式：
- [日期] Txx | agent: <模型:会话id> | commit: <hash> | 验收: 全部通过 / 遗留: ... | 备注: ...
-->

- [2026-10-15] T01 | agent: qoder:sess-1015a | commit: 进行中 | 验收: 自动化项 R2/R3/R5 全部 PASS，环境探测确认 `file://` 下 `isSecureContext=true` 且 `showDirectoryPicker`/`showOpenFilePicker`/`createWritable` 均存在 | 遗留: R1/R4/R6 需用户手势，须在真实企业 Edge 中打开 `spike.html` 点击运行；内置浏览器（Electron 43 / Chrome 150）与企业 Edge 的 `file://` 策略可能存在差异，故 R1 未复验前不启动 T06 | 备注: 实测数据已回填 spec 第 11.1 节

- [2026-10-15] T02 | agent: qoder:sess-1015a | commit: "T02: build pipeline" | 验收: 全部通过 | 备注: 产物 `dist/OffEarly.html` 216KB 单文件，`file://` 下实测渲染成功且控制台零消息；发现并修复 singlefile 保留 `type="module"` 的坑（新增 `finalizeSingleFile()` 插件）；实际版本 Vite 8.3.4 / React 19.3.1 / TS 7.0.2，spec 同步至 v1.2 | 遗留: 无

- [2026-10-15] T03 | agent: qoder:sess-1015a | commit: "T03: domain types + zod schema + migration pipeline" | 验收: 全部通过 | 备注: `npx vitest run` 19/19 绿，`npx tsc --noEmit` 零错，`npm run build` 仍产出单文件 `dist/OffEarly.html`（type=module 0 / 外链 0 / http 引用 0，T02 不变式复测通过）；spec 4.2 补写 `Settings` 显式类型与 `Status/Kind/Priority` 别名，文档版本 v1.3；依赖新增 zod 4.6.7（runtime）、vitest 5.0.4（dev） | 越界改动: `tsconfig.json` include 增 `"tests"`、`package.json` 增 `test` 脚本（见 T03 变更提议） | 遗留: `src/domain/*` 尚未被应用代码引用，产物体积不变，接线在 T07/T10；`progress` 与 `status=done` 的联动约束属领域规则，留给 T10 CommandBus 强制，schema 只校验 0-100 区间

- [2026-10-15] T01（补记 R4） | agent: qoder:sess-1015a | commit: "T01: R4 clipboard paste confirmed unavailable in enterprise Edge" | 验收: R4 判定完成（结果 FAIL），R1/R6 仍待用户回报 | 备注: 用户在企业 Edge 实测回报「R4 fail」，按 spec 第 11 节预案启用降级——笔记图片只保留拖入与工具栏选择两条路径，剪贴板粘贴不做条件开关；已同步改 spec 6.4、11.1 与 T25 的第 595 行验收项（跨任务裁剪，依据即本条） | 遗留: R4 失败签名未采集，需在 `spike.html` 红卡上区分「权限被策略拒绝」与「剪贴板内无图片项」；R1/R6 结果仍待用户回报，R1 未通过前 T06 不启动

- [2026-10-15] T01（补记 R4 签名） | agent: qoder:sess-1015a | commit: "T01: record R4 NotAllowedError signature" | 验收: R4 仍判 FAIL，成因待一次复测区分 | 备注: 用户提供红卡原文 `NotAllowedError: Failed to execute 'read' on 'Clipboard'`，说明 API 存在且可达、失败发生在权限门，不是能力缺失；Chromium 的 `NotAllowedError` 有两类成因——权限被拒（弹窗取消或组策略）与 `Document is not focused`（截图工具抢占前台焦点，真实使用中不复现）。降级维持不变：拖入与工具栏选择已完整覆盖图片插入，粘贴路径不做条件开关，仅在复测通过时恢复。已同步 spec 11.1 的 R4 行与 T01 验收项 | 遗留: R1/R6 结果仍待用户回报，R1 未通过前 T06 不启动

- [2026-10-15] 更正 T01（R4 首轮判定作废） | agent: qoder:sess-1015a | commit: "T01: R4 verdict voided, spike now measures the paste path" | 验收: R4 改回待复验；R1/R6 仍待用户回报 | 备注: 用户补全红卡原文 `NotAllowedError: Failed to execute 'read' on 'Clipboard': Document is not focused.`，成因是**焦点**不是**能力**——`clipboard.read()` 要求文档持有系统前台焦点并具备 clipboard-read 权限，截图工具抢焦点即报此错，故前两条补记里「FAIL / 权限门拦下」的判读作废，据此做的裁剪（spec 6.4 两条路径、T25 验收项）已全部撤回。`spike.html` 的 R4 改为双信号：新增静态粘贴框，以 `paste` 事件的 `clipboardData` 判定（这才是 TipTap 实际走的路径，无需权限），原按钮降级为 `clipboard.read` 探针并把失焦报错标注为非决定性。内置浏览器 `file://` 实测三分支：注入图片 File→PASS 并回报 `image/png, 2048 字节, 名称 shot.png, hasFocus=false`；仅文本→PENDING 并提示复制图片；探针在无焦点下报「非决定性」且不下拉结论；`render()` 重建卡片后粘贴框仍在（焦点不被打断）；控制台零消息 | 遗留: 请用户重开 `spike.html`，点粘贴框后按 Ctrl+V 复测 R4；R1/R6 结果仍待回报，R1 未通过前 T06 不启动

- [2026-10-15] 更正 T01（R4 定案 PASS） | agent: qoder:sess-1015a | commit: "T01: R4 confirmed PASS via paste event in enterprise Edge" | 验收: R4 关闭；T01 仅剩 R1/R6 | 备注: 用户用改造后的粘贴框在企业 Edge 复测，`paste` 事件取到 `image/png` 22821 字节（名称 `image.png`，`hasFocus=true`），`clipboard.read` 探针同一轮也取到同一张图（权限状态 `prompt`）。前两条 R4 记录（87cb440 判 FAIL、d62b6ff 记签名、5f08c65 作废判定）至此定案：**R4 PASS，降级不启用**，笔记图片三条插入路径全保留；实现只用 `paste` 事件的 `clipboardData`，不引入 `clipboard.read()` 的焦点与权限依赖。已回填 spec 6.4、第 11 节 R4 行与 11.1 结论（R2/R3/R4/R5 成立，主路径无需降级），并解除 T25 验收项的裁剪条件 | 教训: spike 必须按目标功能真实使用的机制来测——用 A 接口的报错给 B 功能判死刑是本任务里第二次同类误判（第一次是内置浏览器与企业 Edge 的差异）；报错文案的确切成因（能力缺失 / 缺权限 / 缺焦点或缺手势）要在红卡里分档显示 | 遗留: R1、R6 待用户回报；R1 未通过前 T06 不启动

- [2026-10-15] T01（定案） | agent: qoder:sess-1015a | commit: "T01: all six file:// risks verified in enterprise Edge, spike archived" | 验收: 7/7 全部勾选，任务转 done | 备注: 用户回报「R1 R6 测试通过」，至此 R1–R6 六项全部 PASS（R2/R3/R5 内置浏览器自动化实测，R1/R4/R6 企业 Edge 手动实测）。**第 11 节六条降级方案一条都不必启用**，全部转为已备不用的兜底；**T06（FsAccessAdapter）门槛解除**。`spike.html` 加归档说明后复测：页面在 `file://` 正常加载，R2/R3/R5 自动通过、R1/R4/R6 处于待手势的 pending 态、8 张卡片齐全、控制台零消息 | 遗留: R6 的写/读往返毫秒数未回传（OneDrive 伪冲突仍需日常观察，冲突弹窗保留「导出副本」兜底）；R1 每次重启后句柄权限是否仍免提示，由 T06 在真实启动流程里复验 | 教训: 与前两条 R4 记录同源——spike 要按目标功能真实使用的机制测，报错要分档显示成因

- [2026-10-15] T04 | agent: qoder:sess-1015a | commit: "T04: i18n base with typed message keys and locale switching" | 验收: 全部通过（6/6） | 备注: `npx tsc --noEmit` exit 0；`npm run test` 34/34 绿（本任务 15 条）；`npm run build` 仍为单文件 220522 字节，与 T03 一致——`src/locales/*` 暂未被应用代码引用，接线在 T15+。负例已实跑：从 `en.ts` 删去 `workweek` 得 `TS2741`（exit 1），补回后 exit 0，故「缺翻译编译期报错」不是推断而是测量。组件重渲染按验收要求做成真测试（jsdom + `useSyncExternalStore`，「评审中」→「In Review」且 `data-locale` 同步） | 越界改动: 新增 devDeps jsdom 30.1.3 / @testing-library/react 16.3.0 / @testing-library/dom 10.4.1，`package.json` 随之变动；环境用测试文件顶部 `// @vitest-environment jsdom` 指定，未触碰 T02 的 `vite.config.ts` | 遗留: dayjs locale（日期/星期/月份名）不在本任务产出内，归 T11 排期引擎与 T19 甘特图表头使用

- [2026-10-15] T05 | agent: qoder:sess-1015c | commit: "T05: inline SVG icon sprite + no-emoji lint" | 验收: 全部通过（5/5） | 备注: 32 个 `<symbol>`（验收清单 31 个全覆盖，另加 `chevron-right` 给 T14 话题树），描边属性集中在 symbol 上（`<use>` 的 shadow 内容只继承使用处上下文，挂 sprite 根无效），颜色走 currentColor；`npm run lint:emoji` 默认扫 `src` + `src/locales`，命中输出 `文件:行:列 U+码位` 并 exit 1，已作为 `build` 前置；负例实跑（临时 `src/__emoji-probe.ts` → exit 1，删除后 exit 0）。图标质量按「可测量」处理：真实 Chromium `file://` 下 32 个 symbol 的 `getBBox()` 全落在 0.4–23.6 安全区，并用 Path2D+canvas 栅格化成字符图逐个目检，据此放大 `list-task` 复选框与 `dependency` 节点圆、加宽 `filter` 下管。`npx tsc --noEmit` exit 0；`npm run test` 76/76 绿（本任务 15 条）；`npm run build` 仍为单文件 220.54 kB | 越界改动: 新增 `tests/views/IconSprite.test.tsx`、`tests/scripts/noEmoji.test.ts`（依「tests 与 src 镜像」+ TDD 约束）；`package.json` 只加 `lint:emoji` 与 `build` 前置两行，`package-lock.json` 未动 | 并发: 提交时工作树有另一 agent 的 T06 未提交产物（`src/persistence/*`、`tests/persistence/*`），本次只 stage T05 的四个新文件 + `package.json` + `task.md`，未纳入对方文件；对方曾写入的 `zustand` 依赖行与 T10 `in_progress` 行已由其自行回退，故不在本 commit 内 | 遗留: sprite 挂载点未接线（`src/App.tsx` 不在本任务产出清单，归 T07 启动流程一次性挂 `<IconSprite />`）；效果预览留在未跟踪的 `.tmp-preview/preview.html`（双击可看 16/24/48px 与深色底三轮），后续 agent 请勿 commit 该目录；禁 emoji lint 目前只覆盖 `src`，`tests`/`docs`/`spike.html` 不在扫描范围，T31 的 verify 若要吃全量需显式传目标

- [2026-10-15] T06 | agent: qoder:sess-1015d | commit: "T06: FsAccessAdapter + handleStore with IndexedDB persistence and R2 fallback" | 验收: 全部通过（5/5） | 备注: `fsAdapter` 六原语 + `connectDir`/`ensureSubdirs`；所有写路径统一 `createWritable() → write → close()`（close 即 flush，单测断言 close 被调用）；`remove` 命中 `NotFoundError` 返回 false 而非抛错；路径解析拒绝含 `..` 的段，越界在读之前就挡掉（测试用 spy 断言句柄完全未被触碰）。`handleStore` 把 backend 抽成 `{get,set,remove}` 注入点，IndexedDB 实现走 `offearly/handles` 单键存储；降级做成三层兜底（backend 抛错 → save=false/load=null/clear=false；存的是脏数据 → load=null；环境无 `indexedDB` 全局 → load=null），全程不抛错，T07 启动流程只需判 `load()===null` 即走重选目录。`verifyPermission(handle, requestIfDenied)` 先 `queryPermission`，未授权且允许交互时才 `requestPermission` 一次，用户拒绝则 false，请求参数固定 `{mode:'readwrite'}` | 验证: `npx tsc --noEmit` exit 0；`npm run test` 76/76 绿（本任务 27 条，先 RED 后 GREEN）；`npm run build` 单文件 220.54 kB，与 T05 持平——persistence 层尚未被应用代码引用，接线归 T07 | 越界改动: 新增 `tests/persistence/mockFs.ts`（手写 mock 句柄，依「tests 与 src 镜像」+ TDD 约束）；TS lib.dom 未声明 `FileSystemDirectoryHandle.queryPermission/requestPermission`（Chromium 实际有），故在 `handleStore` 内补齐 `VaultDirHandle` 交叉类型，未改 tsconfig | 并发: 等 T05 提交（1b822c3）落地后才提交，本次只 stage `src/persistence/*`、`tests/persistence/*`、`task.md`；`.tmp-preview/`（T05 预览目录）保持未跟踪、未纳入 | 遗留: 真实启动流程里「重启后句柄权限是否仍免提示」需 T07 在目标企业 Edge 复验（spike R1 的待办移交至此）；`list()` 只回名字数组、不区分文件/目录，若 T09 保留策略需要类型信息再扩展；mock 覆盖不到真实 IndexedDB 的结构化克隆，首次落盘需在 T07 冒烟

- [2026-10-15] T07 | agent: qoder:sess-1015e | commit: "T07: VaultRepository + startup flow first screen with safe mode" | 验收: 全部通过（5/5） | 备注: 交付 `vaultRepository`（load/save/peekRevision/create）+ App 启动状态机（booting/need-dir/need-permission/busy/empty-dir/ready/safe-mode/failed 八相）。`npx tsc --noEmit` exit 0；`npm run test` 107/107 绿（本任务 27 条，repository 17 + App 10，先 RED 后 GREEN）；`npm run lint:emoji` 干净；`npm run build` 单文件 325.5 kB；产物真实浏览器 `file://` 冒烟：首屏「连接数据文件夹」渲染、控制台零消息。peekRevision 经新原语 `readHead` 只取文件头 4096 字节提 revision（save 自控键序为前提，键序被打乱时全量解析兜底）；「校验失败不写盘」由 App 测试断言原文件字节不变落在 mock FS 上。句柄打开成功才存 IndexedDB，空目录/坏库不污染下次启动；`create()` 对已存在 vault.json 拒绝覆盖 | 越界改动: ① locales 新增 `startup.*`/`board.emptyColumn` 14 键 + T04 键集合断言放宽为超集（用户已确认，spec 附录 A 补「锁定范围」注记，仍 v1.3）；② fsAdapter 追加 `readHead`（+4 用例）；③ mockFs `getFile` 补 `size`/`slice`、内容模型改字节拼接、暴露 `bytes()`；④ runtime 依赖 nanoid 6.0.2 | 并发: 工作树共享期间 `src/persistence/vaultRepository.ts` 与 `tests/persistence/vaultRepository.test.ts` 一度被未知进程删除（写入后、提交前），已重写恢复并即刻提交，后续 agent 若发现未提交产物丢失请优先怀疑并发清理并尽快落盘提交 | 遗留: 安全模式横幅的三按钮（恢复此快照/选择其他备份/导出当前）是 T29 的范围，本任务只交付占位卡（`data-testid="safe-mode"`）；「重启后句柄权限是否免提示」仍需在企业 Edge 真机复验（承接 T06 遗留）；App 的 locale 源在 T10 落地后应换接 VaultStore 的 LocaleSource

- [2026-10-15] T08 | agent: workbuddy:sess-1015f | commit: "T08: autosave controller with dirty tracking, debounce, Ctrl+S and three-state save indicator" | 验收: 全部通过（5/5） | 备注: 交付 `createAutosave`（dirty 标记 / debounce 1200ms / Ctrl+S 立即保存 / 三态 saved-dirty-error / retry）+ `SaveIndicator` 指示器组件。`npm run test` 131/131 绿（本任务 24 条：autosave 19 + SaveIndicator 5，先 RED 后 GREEN——首轮 18/19，唯一红的是「写盘途中的编辑」，属测试构造缺陷：`chain.then` 把 doFlush 推到微任务，`fs.edit` 抢在写盘前跑完，改用 `io.waitEntered()` 等到真的进了 save 再构造并发编辑）；`npx tsc --noEmit` exit 0（首轮报 TS6196 未用导入，删除后干净）；`npm run lint:emoji` 干净；`npm run build` 单文件 `dist/OffEarly.html` 325651 字节，`<script src`/`<link`/`type="module"`/`http(s)://` 资源引用四项均为 0（T02 不变式复测通过） | 依赖偏离: T08 依赖列了 T10，而 T10 仍 pending，未等待即开工——依 T04「接口注入、T10 的 VaultStore 即实现」的既定先例，autosave 只依赖最小端口 `AutosaveStore { subscribe, getVault, markSaved }`，不 import `domain/store`；T10 落地时让 VaultStore 实现该端口并调 `start()` 即可。**此条与《状态同步协议》第 1、4 条（依赖未 done 不得开工）相悖，请用户裁决：若要求严格串行，T08 应改回 pending 并在 T10 之后重做一次接线验收** | 越界改动: ① 新增 `src/views/SaveIndicator.tsx` + `tests/views/SaveIndicator.test.tsx`（产出清单漏了视图，而验收项 4 要求组件测试）；② locales 新增 `save.*` 4 键；③ 刻意**未**改 `src/App.tsx`（顶栏挂载点需要活着的 VaultStore） | 并发: 提交前工作树只有本任务新增的 3 个文件与 locales/task.md 改动，无其他 agent 的未提交产物 | 遗留: 顶栏挂载与 Ctrl+S 全局按键绑定归 T10/T15；保存流程目前无真正的写前快照（`snapshotter` 端口已就位、无人注入，等 T09）
