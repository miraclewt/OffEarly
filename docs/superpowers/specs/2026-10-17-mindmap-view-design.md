# 思维导图视图（MindMap）设计

日期：2026-10-17 · 状态：待评审 · 关联分支：feat/foundation

## 1. 目标与范围

在顶栏视图组（看板 / 甘特）之后新增第三个 tab「思维导图」，提供**独立于任务/话题数据**的自由思维导图创作工具，交互与视觉取 xmind 风格：

- 节点树 + 自动布局（逻辑图：根居左、子树向右展开），不做自由拖拽摆位；
- 结构化编辑：新建/重命名/增删节点、跨父移动（拖到目标节点上）、折叠展开；
- 数据存入 `vault.json` 新增 `mindmaps` 数组，写路径经 CommandBus，免费获得撤销/重做、autosave、备份、冲突闸门；
- 导出 PNG / SVG，架构照抄 GanttExporter；
- **不做** `.xmind` 文件格式互通；**不引入**任何图形库（单文件产物 <1.6MB 约束，见 scripts/verify-bundle.mjs）。

非目标（本期不做）：富文本节点备注、图片节点、跨视图引用任务生成导图、键盘全量无障碍、移动端适配。

## 2. 数据模型（types.ts + schema.ts 同步）

```ts
export interface MindNode {
  id: string
  text: string
  /** 排序键，复用 domain/lexorank.mid —— 与 topics/tasks 同一惯例 */
  order: string
  /** 折叠：隐藏子树但不删除 */
  folded: boolean
  children: MindNode[]
}

export interface MindMap {
  id: string
  name: string
  root: MindNode
  /** 多张图的列表排序键 */
  order: string
  createdAt: string
  updatedAt: string
}
```

- `Vault` 增加 `mindmaps: MindMap[]`，置于现有数组键之后（save 控制键序，`revision` 保持第四位，peekRevision 依赖不变）。
- `VaultSchema.mindmaps = z.array(MindMapSchema).default([])`：旧库直接解析补空，**schemaVersion 保持 1，不注册迁移**（先例：SettingsSchema 字段默认值）。
- `MindNodeSchema` 用 `z.lazy` 递归定义；按 schema.ts 的对齐闸门补 `Assert<Equal<MindMap, z.infer<typeof MindMapSchema>>>`。
- `createNewVault`（vaultRepository.ts:157）补 `mindmaps: []`；`example.vault/vault.json` 同步补键；手拼完整 Vault 的测试 fixture 由 tsc 兜住、逐个补键。

## 3. 命令层（domain/commandBus.ts）

沿用 `{ type, payload, inverse }` + 纯 `reduce` 模式，新增 payload 种类：

| type | payload | 语义 / inverse |
|---|---|---|
| `mindmap.create` | `{ map, index }` | 插入；inverse 删同 id |
| `mindmap.delete` | `{ id }` | 删除；inverse 携完整实体 + 原下标复原 |
| `mindmap.patch` | `{ id, patch }` | 改 name；字段级逆 patch |
| `mindmap.node.add` | `{ mapId, parentId, node }` | 加子节点；inverse 删同 id |
| `mindmap.node.delete` | `{ mapId, nodeId }` | 连子树删；inverse 携完整子树 + 原父/下标复原 |
| `mindmap.node.patch` | `{ mapId, nodeId, patch }` | 改 text / 切 folded；字段级逆 |
| `mindmap.node.move` | `{ mapId, nodeId, newParentId, index }` | 跨父移动（含同父换序）；inverse 携原父/原下标 |

约束：

- 树更新全部不可变（逐层 spread），节点定位用递归 find 辅助函数；找不到 id 时 reduce 抛错、Store 不动（commandBus 既有语义）。
- move 拒绝把节点移进自己的子树（先判祖先链，抛错）——否则布局出现环。
- 根节点不可删除、不可移动、不可作为 move 的目标后代以外的特例：**根恒在**，每张图创建即有一个根。
- id/时间经 deps 注入（`deps.newId` / `deps.now`），照 controllers/taskCreate.ts 的 plan→apply 模式，构造层放 `src/controllers/mindmapActions.ts`：`applyCreateMap`、`applyAddNode` 等；空文本节点入库前规范为占位文案（i18n key，如 `mindmap.branch` / `mindmap.subtopic`）。

## 4. 布局模型（domain/mindmapModel.ts，纯函数）

零 React / 零 DOM / 零 I/O，渲染、导出、单测共用（ganttModel.ts 同构）：

```ts
buildMindMapModel(map: MindMap, opts?: { rootSide?: 'left' }): MindMapModel
```

- 算法：教科书式自右展开树布局——递归量出每棵子树高度（折叠子树按 `+N` 徽标收缩为叶子），按行高常量垂直堆叠，父节点居中于子树范围；层间距按节点宽度动态推进。非对称时（根在左）子树整体右展，根标题取「中心主题」占位规则。
- 文本度量用估算的 em 宽度（照抄 `estimateGanttLabelWidth` 思路，保证 DOM-free 导出可复算）；节点为圆角矩形，宽高由文本决定、有上下限常量。
- 产出：`nodes`（id/text/depth/folded/hiddenCount/x/y/width/height/color 档）、`edges`（父→子的 SVG path d，贝塞尔曲线，端点从父右缘到子左缘）、`bounds`（内容包围盒，供缩放适屏与导出全图）。
- 导出常量（`NODE_HEIGHT`、`H_GAP`、`V_GAP` 等）集中在本文件，视图与导出禁止另写一份。

## 5. 视口控制器（controllers/mindmapViewport.ts）

照 ganttViewport.ts 骨架：纯 TS、`subscribe/getState` 稳定引用、整体 patch、`applyWheel` 收视图转发的原始事实。

- 状态：`panX / panY / zoomIndex`（离散档 `[0.5, 0.6, 0.75, 0.9, 1, 1.2, 1.5, 2, 3]`）、`width / height`。
- API：`setPan`、`panBy(dx, dy)`、`zoomIn/zoomOut/zoomAt(factor)`（Ctrl+滚轮以光标为锚缩放，换算进 panBy+zoomIndex）、`resetView`、`fitToContent(bounds)`（tab 切入/「适应画布」按钮调用）、`setViewportSize`。
- 与甘特刻意不同：没有 scale/baseline 概念；pan 取代 scrollTop/scrollLeft。

## 6. 视图与交互（views/MindMapView.tsx + MindMapCanvas.tsx）

App.tsx 三处触点：view 联合类型加 `'mindmap'`（L452）、按钮数组加字面量（L944）、Workspace 渲染分支（L419）；locales zh/en 各加 `shell.viewMindmap` 与 `mindmap.*` 文案键（en 表类型对齐由 tsc 强制）。tab testid 自动成为 `view-mindmap`（e2e/01 既有用例不受影响）。

组件契约照 GanttView：显式 props（`vault`、`t`、`bus`、`onOpenTask?` 不需要），不读 store。图内本地状态：当前选中图 id、选中节点 id、编辑中的节点 id——均不进 vault.json。

渲染两层：

1. **SVG 底层**（MindMapCanvas）：边（path）→ 节点（rect + 折叠 `+N` 徽标 + 选中描边）。节点数在数百级，不做虚拟化。
2. **HTML 顶层**：节点文字与就地编辑器是绝对定位的 div（同一坐标公式投影，编辑器用 `<input>`/contenteditable），IME/中文输入可靠， foreignObject 不采用。

交互清单：

- 单击选节点；双击或 F2 就地改文本（Enter 提交、Esc 放弃）；
- **Tab** 加子节点（自动进入编辑）、**Enter** 加同级节点、**Delete/Backspace** 删节点（根除外）、**方向键**在树上游走、**Esc** 取消选中；折叠：节点右侧 +/- 圆钮，`Space` 切换选中节点折叠；
- 拖拽节点落到另一节点上 → `mindmap.node.move`（拖出即跟手半透明，落下命中检测用布局模型矩形）；
- 空白处拖拽 = 平移，Ctrl+滚轮 = 缩放，滚轮 = 纵向平移；
- 顶部工具条：图切换（当前库内多张图的下拉/分段）、新建图、重命名、删除图、折叠全部/展开全部、适应画布、导出菜单（照甘特 T23 的弹层与 Esc/外点关闭行为）。
- 节点配色按层级深度取主题色阶（CSS 变量，遵循用户偏好：色点/克制，无左色条式装饰）。

## 7. 导出（views/MindMapExporter.ts）

照 GanttExporter 架构：从 `MindMapModel` DOM-free 重拼 SVG（内联 presentation attributes，禁 class/CSS 变量），PNG 走 SVG data-URI → Image → 2x canvas → toBlob → 下载；范围为「可见区 / 全图」（全图用 `bounds`）。`probePngSupport` 复用。

## 8. 错误处理与边界

- reduce 找不到 mapId/nodeId：抛错，Store 不变（既有语义），UI 层不吞、由全局 notice 呈现（沿用 shell-notice 通道）。
- 删除当前选中图：选中态回退到列表首张；空库（无图）时视图显示「新建思维导图」引导卡。
- move 入自身子树：命令工厂层面直接拒绝（不产生 undo 记录）。
- 并发/只读闸门：写路径都过 `guardCommandBus`，无额外工作。
- 循环渲染防护：布局对 `children` 自引用不做检测（数据经 Zod + 命令层不变式保证是树）。

## 9. 测试

- `tests/domain/mindmapModel.test.ts`：坐标确定性断言（固定文本/常量）、折叠隐藏数、bounds、边 path 端点。
- `tests/domain/commandBus.test.ts` 增补 7 个 case；`tests/domain/schema.test.ts` 补旧库缺 `mindmaps` 键解析默认值用例。
- `tests/controllers/mindmapActions.test.ts`：plan→apply、占位文案、move 拒绝进子树、id/now 注入确定性。
- `tests/views/MindMapView.test.tsx`（jsdom + testing-library，i18n 桩照 GanttView 测试）：切 tab、新建图、Tab/Enter 快捷键、编辑提交、折叠、选中态。
- `tests/controllers/mindmapViewport.test.ts`：离散档位、pan/zoomAt 锚点数学、fitToContent。
- e2e 增 `e2e/09-mindmap.spec.ts`：`view-mindmap` 点击 → 建图 → 加节点 → 刷新后仍在（走真实 autosave 夹具）。

## 10. 实施顺序（供计划拆解）

1. 模型 + schema + fixture/示例库（含 T 号任务登记）
2. 命令层 + mindmapActions（含单测）
3. 布局模型 + 单测
4. 视口控制器 + 单测
5. MindMapCanvas + MindMapView 只读渲染 + App tab 接线 + locales
6. 编辑交互（快捷键、就地编辑、折叠、拖拽 move）
7. 图管理工具条（多图切换、重命名、删除）
8. 导出 PNG/SVG
9. e2e + 收尾（docs/user-guide 增补一节）
