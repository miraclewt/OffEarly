# 思维导图视图（MindMap）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在甘特之后新增第三个视图 tab「思维导图」，提供独立于任务数据的 xmind 风格自由导图（结构化编辑 + 自动布局），数据入 vault.json，导出 PNG/SVG。

**Architecture:** 复刻甘特车道的分层：`domain/mindmapModel.ts` 纯函数算布局几何 → `views/MindMapCanvas.tsx` SVG 投影 → `views/MindMapView.tsx` 宿主；写入一律经 CommandBus 新命令族；视口（pan/zoom）走 `controllers/mindmapViewport.ts` 纯 TS 控制器。

**Tech Stack:** React 19 + TypeScript + zustand vanilla store + zod 4 + vitest（jsdom）+ Playwright。零新增依赖。

**Spec:** [docs/superpowers/specs/2026-10-17-mindmap-view-design.md](../specs/2026-10-17-mindmap-view-design.md)

## Global Constraints

- 构建产物必须仍是单个自包含 `dist/OffEarly.html`，**< 1.6MB**，禁外部 URL/CDN（scripts/verify-bundle.mjs）→ 布局算法必须仓库内实现，不引库。
- 源码禁 emoji（scripts/no-emoji.mjs，U+2600-27BF / U+1F000-1FAFF 等）；图标一律走 `views/IconSprite.tsx`。
- `types.ts` 是唯一事实源，`schema.ts` 只做运行时镜像，`SchemaAlignment` 编译期闸门必须保持绿。
- 落盘键序约定：`vault.json` 中 `revision` 固定第四位，`mindmaps` 键加在 `assets` 之后。
- zh 表是键名事实源、en 表 `Record<MsgKey, string>` 平行约束（缺键即 tsc 失败）；新键尾部追加，不改既有键。
- 测试镜像目录：`tests/domain|controllers|views|persistence`，vitest include 只认 `tests/**`；e2e 在 `e2e/NN-name.spec.ts`。
- 全部门禁命令：`npm test`、`npm run build`（lint:emoji && tsc --noEmit && vite build && verify）。
- 任务编号沿用 T##：本车道 T40–T48。提交前只 stage 本任务涉及路径（多 agent 共用 worktree 的项目记忆）。

---

### Task T40：数据模型（types + schema + 工厂 + fixture）

**Files:**
- Modify: `src/domain/types.ts`（Task 接口之后、Vault 之前插入新类型；Vault L114-126 加字段）
- Modify: `src/domain/schema.ts`（MilestoneSchema 附近加两个 Schema；VaultSchema L125-144；SchemaAlignment L152-162）
- Modify: `src/persistence/vaultRepository.ts`（createNewVault L157-170）
- Modify: `example.vault/vault.json`（加 `"mindmaps": []`，位置在 `assets` 之后）
- Test: `tests/domain/schema.test.ts`（追加用例）

**Interfaces:**
- Produces: `MindNode` / `MindMap` 类型、`MindNodeSchema` / `MindMapSchema`、`Vault.mindmaps: MindMap[]`；`migrate()` 对缺 `mindmaps` 键的 v1 旧库补 `[]`。

- [ ] **Step 1: 写失败测试**（追加到 `tests/domain/schema.test.ts`）

```ts
it('旧库缺 mindmaps 键时补空数组（schemaVersion 保持 1）', () => {
  const raw = { ...validRaw, mindmaps: undefined } // validRaw 用文件内既有 fixture 手法构造
  delete (raw as Record<string, unknown>).mindmaps
  const vault = migrate(raw)
  expect(vault.mindmaps).toEqual([])
})
it('mindmaps 递归节点树通过校验', () => {
  const vault = migrate({ ...seedRaw(), mindmaps: [{
    id: 'm1', name: '图一', order: 'V',
    createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z',
    root: { id: 'r', text: '中心主题', order: 'V', folded: false,
      children: [{ id: 'a', text: '分支', order: 'V', folded: true, children: [] }] },
  }] })
  expect(vault.mindmaps[0]!.root.children[0]!.folded).toBe(true)
})
```

（若 `tests/domain/schema.test.ts` 现有 fixture 不是这种形状，照文件内既有用例的构造手法改名接入，语义不变。）

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run tests/domain/schema.test.ts` → FAIL（`VaultSchema` 无 mindmaps / 类型不存在）。

- [ ] **Step 3: types.ts 加类型**（置于 `Milestone` 之后）

```ts
export interface MindNode {
  id: string
  text: string
  /** 兄弟排序键，复用 domain/lexorank.mid */
  order: string
  /** 折叠：子树暂时隐藏但保留 */
  folded: boolean
  children: MindNode[]
}

export interface MindMap {
  id: string
  name: string
  root: MindNode
  /** 多张图之间的列表排序键 */
  order: string
  createdAt: string
  updatedAt: string
}
```

`Vault` 接口在 `assets: Asset[]` 之后加 `mindmaps: MindMap[]`。

- [ ] **Step 4: schema.ts 加镜像**

```ts
export const MindNodeSchema: z.ZodType<MindNode> = z.lazy(() =>
  z.object({
    id,
    text: z.string(),
    order: z.string(),
    folded: z.boolean(),
    children: z.array(MindNodeSchema),
  }),
)

export const MindMapSchema = z.object({
  id,
  name: z.string(),
  root: MindNodeSchema,
  order: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
})
```

`VaultSchema` 在 `assets` 行后加 `mindmaps: z.array(MindMapSchema).default([])`；`SchemaAlignment` 数组追加 `Assert<Equal<MindMap, z.infer<typeof MindMapSchema>>>`（`import type { MindMap, MindNode }`）。
注意：`.default([])` 使 `z.infer` 输出类型为必有字段，与 types.ts 对齐成立；但 **input 类型带 default 后 `Equal` 仍比对 output**，若 tsc 报漂移，改 `z.array(MindMapSchema).default([] as MindMap[])` 或把 VaultSchema 的 parse 输入构造处补键——以 `tsc --noEmit` 绿为准。

- [ ] **Step 5: createNewVault 补 `mindmaps: []`**（`assets: []` 行后）。

- [ ] **Step 6: `example.vault/vault.json` 加 `"mindmaps": []`**（`"assets"` 数组之后；保持 revision 第四位不动）。

- [ ] **Step 7: 跑全量门禁** — Run: `npx tsc --noEmit`（会暴露手拼 Vault fixture 的测试文件缺键）→ 逐个给 `tests/domain/ganttModel.test.ts`、`tests/views/GanttView.test.tsx` 等手拼 vault 对象的测试补 `mindmaps: []`；然后 `npm test` 全绿。

- [ ] **Step 8: 提交** — `git add` 上述文件 → `git commit -m "T40: mindmap data model (MindNode/MindMap in vault.json, schema v1 default [])"`

---

### Task T41：CommandBus 思维导图命令 + 树工具

**Files:**
- Create: `src/domain/mindmapTree.ts`
- Modify: `src/domain/commandBus.ts`
- Test: `tests/domain/mindmapTree.test.ts`、`tests/domain/commandBus.test.ts`（追加）

**Interfaces:**
- Produces（mindmapTree.ts）:
  `findNode(root: MindNode, id: string): MindNode | null`、
  `findParent(root: MindNode, id: string): { parent: MindNode; index: number } | null`、
  `isDescendant(root: MindNode, ancestorId: string, id: string): boolean`、
  `mapTree(root: MindNode, id: string, recipe: (node: MindNode) => MindNode): MindNode`（找不到 id 抛错）、
  `insertChild(root: MindNode, parentId: string, node: MindNode, index: number | null): MindNode`、
  `removeNode(root: MindNode, id: string): { next: MindNode; removed: MindNode; parentId: string; index: number }`（根/不存在抛错）、
  `countHidden(root: MindNode): number`（自身之外被折叠隐藏的后代数）。
- Produces（commandBus.ts）: `MutationPayloads` 新键与工厂 `createMapCommand` / `deleteMapCommand` / `patchMapCommand` / `addNodeCommand` / `deleteNodeCommand` / `patchNodeCommand` / `moveNodeCommand`（签名见 Step 3）。

- [ ] **Step 1: 写 mindmapTree 失败测试**

```ts
const tree: MindNode = { id: 'r', text: 'R', order: 'V', folded: false, children: [
  { id: 'a', text: 'A', order: 'V', folded: true, children: [
    { id: 'a1', text: 'A1', order: 'V', folded: false, children: [] }] },
  { id: 'b', text: 'B', order: 'V', folded: false, children: [] },
] }
it('findParent / isDescendant / countHidden', () => {
  expect(findParent(tree, 'a1')!.parent.id).toBe('a')
  expect(isDescendant(tree, 'a', 'r')).toBe(false)
  expect(isDescendant(tree, 'a', 'a1')).toBe(true)
  expect(countHidden(tree)).toBe(1) // a 折叠藏了 a1
})
it('removeNode 根抛错、返回复原三件套', () => {
  expect(() => removeNode(tree, 'r')).toThrow()
  const { next, removed, parentId, index } = removeNode(tree, 'a')
  expect(next.children.map((c) => c.id)).toEqual(['b'])
  expect(removed.id).toBe('a')
  expect({ parentId, index }).toEqual({ parentId: 'r', index: 0 })
})
```

Run: `npx vitest run tests/domain/mindmapTree.test.ts` → FAIL（模块不存在）。

- [ ] **Step 2: 实现 mindmapTree.ts** — 全递归不可变；`mapTree` 先 `findNode` 校验存在再逐层 `{ ...node, children: ... }` 重建；文件头注释照 `dependencyGraph.ts` 风格写明「零 React/DOM/I/O」。

- [ ] **Step 3: 写命令失败测试**（追加到 `tests/domain/commandBus.test.ts`，store/bus 构造照文件内既有 `seeded()` 手法，给种子 vault 补 `mindmaps`）

```ts
it('addNodeCommand + undo 还原树', () => {
  const map = seedMap() // root 'r'，子 ['a','b']
  const node: MindNode = { id: 'c', text: 'C', order: 'w', folded: false, children: [] }
  bus.apply(addNodeCommand(map.id, 'r', node, null))
  expect(mapRoot(store).children.map((n) => n.id)).toEqual(['a', 'b', 'c'])
  bus.undo()
  expect(mapRoot(store).children.map((n) => n.id)).toEqual(['a', 'b'])
})
it('deleteNodeCommand 逆元携完整子树复原位置', () => { /* 删 'a'（有子 a1）→ undo → a 回 index 0 且 a1 仍在 */ })
it('patchNodeCommand 字段级逆（text/folded）', () => { /* 改 text+folded → undo 双还原 */ })
it('moveNodeCommand 跨父移动 + 逆元回原父原下标', () => { /* a1: a→b index0 */ })
it('moveNodeCommand 移入自身子树抛错、不压 undo 栈', () => {
  expect(() => moveNodeCommand(store.getVault(), 'a', 'a1', 0)).toThrow()
  expect(bus.undoDepth()).toBe(0)
})
it('deleteMapCommand undo 后图与原下标复原', () => { /* 两张图删第一张 */ })
```

Run → FAIL（工厂不存在 / 命令类型编译失败）。

- [ ] **Step 4: commandBus.ts 扩 MutationPayloads**

```ts
'mindmap.create': { map: MindMap; index: number | null }
'mindmap.delete': { id: string }
'mindmap.patch': { id: string; patch: MapPatch }
'mindmap.node.add': { mapId: string; parentId: string; node: MindNode; index: number | null }
'mindmap.node.delete': { mapId: string; nodeId: string }
'mindmap.node.patch': { mapId: string; nodeId: string; patch: NodePatch }
'mindmap.node.move': { mapId: string; nodeId: string; newParentId: string; index: number }
```

`export type MapPatch = Partial<Omit<MindMap, 'id' | 'createdAt' | 'root' | 'order'>>`、`export type NodePatch = Partial<Omit<MindNode, 'id' | 'order' | 'children'>>`。

- [ ] **Step 5: reduce 新 case**（全部经 `findMap` 辅助 + mindmapTree 函数，不可变；语义逐条对应 spec §3 表格）。`mindmap.node.move` 的 reducer 假设命令工厂已完成合法性检查，直接「remove 后 insert」。

- [ ] **Step 6: 命令工厂** — `createMapCommand(map)`（inverse 按 id 删）、`deleteMapCommand(vault, id)`（inverse 携完整 map + 原下标）、`patchMapCommand(vault, id, patch)`（空 patch 抛错、invertPatch 手法）、`addNodeCommand(mapId, parentId, node, index)`（inverse 按 id 删节点）、`deleteNodeCommand(vault, mapId, nodeId)`（现场算 parent/index，inverse 为 `node.add` 携完整子树）、`patchNodeCommand`、`moveNodeCommand(vault, mapId, nodeId, newParentId, index)`（`nodeId === rootId` 或 `isDescendant(root, nodeId, newParentId)` 或 `newParentId === nodeId` 时抛错；inverse 携原 parent/index 的 `node.move`）。

- [ ] **Step 7: 门禁 + 提交** — `npx vitest run tests/domain` 绿 → `npm test` 绿 → commit `"T41: mindmap command bus mutations (create/patch tree ops with immutable inverses)"`

---

### Task T42：控制器构造层 mindmapActions（plan→apply）

**Files:**
- Create: `src/controllers/mindmapActions.ts`
- Test: `tests/controllers/mindmapActions.test.ts`

**Interfaces:**
- Consumes: T41 命令工厂、`mid`（lexorank）、`findNode/countHidden`。
- Produces: `NewMapInput { name?: string }`、`applyCreateMap(bus, vault, input, deps)`、`applyRenameMap`、`applyDeleteMap`、`applyAddNode(bus, vault, mapId, parentId, input: { text?: string }, deps): MindNode | null`（返回新节点供视图聚焦/进入编辑）、`applyRenameNode`、`applyToggleFold`、`applyDeleteNode`、`applyMoveNode(bus, vault, mapId, nodeId, newParentId, index): boolean`；`deps: { newId?: () => string; now?: () => Date }`；`DEFAULT_MAP_NAME` / `DEFAULT_NODE_TEXT` 常量取 i18n key（`mindmap.centerTopic` / `mindmap.branch`，由**视图层**传入译文文案——控制器不 import i18n，保持可测）。

占位文案注入：输入接口加 `fallbackText: string`（视图把 `t('mindmap.branch')` 传进来），空/纯空白 text 用之；与 taskCreate「不静默兜底空标题抛错」不同——导图节点允许空文本占位（xmind 新建分支即空待编辑），故 `applyAddNode` 空文本 → `fallbackText`。

- [ ] **Step 1: 失败测试**

```ts
it('applyCreateMap：根节点带占位文案、order 追加表尾、时间注入确定化', () => {
  const plan = applyCreateMap(bus, vault, { name: '计划', fallbackName: '未命名导图' },
    { newId: seq('m1', 'root1'), now: () => new Date('2026-10-17T08:00:00Z') })
  expect(vault.mindmaps).toHaveLength(0) // 应用前
  expect(store.getVault().mindmaps[0]!.root.text).toBe('中心主题')
  expect(store.getVault().mindmaps[0]!.order).toBe(mid(undefined, undefined))
})
it('applyAddNode 空文本走 fallback、返回新节点、父 folded 自动展开', () => {
  const node = applyAddNode(bus, store.getVault(), 'm1', 'a', { text: '  ', fallbackText: '分支' }, deps)!
  expect(node.text).toBe('分支')
  expect(findNode(mapRoot(store.getVault()), 'a')!.folded).toBe(false)
})
it('applyDeleteNode 根返回 false 且不写 undo 栈', () => {
  expect(applyDeleteNode(bus, store.getVault(), 'm1', 'root1', 'r', '中心主题')).toBe(false)
  expect(bus.undoDepth()).toBe(0)
})
it('applyMoveNode 非法目标透传命令层抛错、不落 undo 栈', () => { /* a→a1 → throw, depth 0 */ })
```

Run: `npx vitest run tests/controllers/mindmapActions.test.ts` → FAIL。

- [ ] **Step 2: 实现** — 每个 apply* = 纯 plan（构造实体：`id: deps.newId() ?? nanoid()`，`order: mid(尾兄弟?.order ?? undefined, undefined)`，子树尾插）+ `bus.apply`。节点 `updatedAt` 不进 MindNode（仅 MindMap 有），`applyAddNode/applyRenameNode/...` 顺带 `patchMap` 语义不做——updatedAt 只在 `applyRenameMap/applyCreateMap/applyDeleteMap` 与文本提交时经组合命令刷新（一次 `bus.apply` 只有一条命令；导图 updatedAt 刷新并入 `node.patch` 的 payload 由 reducer 统一做：见注）。
  **注（决策锁定）**：不改 node.patch 语义（保持字段级逆简单）。导图级 `updatedAt` 由 autosave 的 `save()` 统一写（vaultRepository 落盘时刷新 `vault.updatedAt`），MindMap.updatedAt 仅作创建快照 + rename 时刷新。视图不需要精确到每次节点编辑的图级时间戳。

- [ ] **Step 3: 门禁 + 提交** — `npx vitest run tests/controllers` → `npm test` → commit `"T42: mindmap action controllers (plan->apply with injected ids)"`

---

### Task T43：布局模型 mindmapModel（纯函数）

**Files:**
- Create: `src/domain/mindmapModel.ts`
- Test: `tests/domain/mindmapModel.test.ts`

**Interfaces:**
- Consumes: `MindNode`、`countHidden`（mindmapTree）、`estimateGanttLabelWidth`（controllers/ganttViewport，宽度估算复用，不复制代码）。
- Produces:

```ts
export const MINDMAP_NODE_HEIGHT = 32
export const MINDMAP_H_GAP = 48
export const MINDMAP_V_GAP = 14
export const MINDMAP_MIN_NODE_WIDTH = 56
export const MINDMAP_MAX_TEXT_WIDTH = 320   // 超出后标签截断，节点封顶
export const MINDMAP_FONT_SIZE = 13
export interface MindMapNodeView {
  id: string; text: string; depth: number
  parentId: string | null
  x: number; y: number; width: number; height: number // 内容坐标，x/y 左上角
  folded: boolean; hiddenCount: number
  hasChildren: boolean
  colorTier: number // depth % 4，视图按档取色
}
export interface MindMapEdge { parentId: string; childId: string; path: string }
export interface MindMapModel {
  nodes: MindMapNodeView[]           // 可见节点，父先于子
  edges: MindMapEdge[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}
export function buildMindMapModel(map: MindMap): MindMapModel
```

布局算法（xmind 逻辑图·向右）：递归「先排子树、父居中」——

- [ ] **Step 1: 失败测试**

```ts
const node = (id: string, text: string, children: MindNode[] = [], folded = false): MindNode =>
  ({ id, text, order: 'V', folded, children })
it('根居左垂直居中于子树，子节点自上而下堆叠', () => {
  const m = buildMindMapModel(map(node('r', '中心', [node('a', '甲'), node('b', '乙')  ])))
  const [r, a, b] = ['r', 'a', 'b'].map((id) => m.nodes.find((n) => n.id === id)!)
  expect(r.x).toBe(0)
  expect(a.x).toBe(r.x + r.width + MINDMAP_H_GAP)
  expect(b.y - a.y).toBe(MINDMAP_NODE_HEIGHT + MINDMAP_V_GAP)
  expect(r.y + r.height / 2).toBeCloseTo((a.y + b.y + MINDMAP_NODE_HEIGHT) / 2, 5)
})
it('折叠节点按叶子布局并带 hiddenCount；子树与入边不进模型', () => {
  const m = buildMindMapModel(map(node('r', 'R', [node('a', 'A', [node('a1', 'A1')], true)])))
  expect(m.nodes.map((n) => n.id)).toEqual(['r', 'a'])
  expect(m.edges).toHaveLength(1)
  expect(m.nodes.find((n) => n.id === 'a')!.hiddenCount).toBe(1)
})
it('单子链逐级右推；bounds 覆盖全部可见节点', () => {
  const m = buildMindMapModel(map(node('r', 'R', [node('a', 'A', [node('b', 'B')])])))
  const b = m.nodes.find((n) => n.id === 'b')!
  expect(m.bounds.maxX).toBeCloseTo(b.x + b.width, 5)
})
it('边是父右缘中点到子左缘中点的三次贝塞尔', () => {
  const m = buildMindMapModel(map(node('r', 'R', [node('a', '甲甲')])))
  const [r, a] = [m.nodes[0]!, m.nodes[1]!]
  expect(m.edges[0]!.path).toBe(
    `M ${r.x + r.width} ${r.y + r.height / 2} C ${(r.x + r.width + a.x) / 2} ${r.y + r.height / 2}, ${(r.x + r.width + a.x) / 2} ${a.y + a.height / 2}, ${a.x} ${a.y + a.height / 2}`)
})
```

Run → FAIL。

- [ ] **Step 2: 实现** — 两趟：① `measure(node)` 返回子树像素高（叶子 = NODE_HEIGHT；展开父 = max(自身高, Σ子高 + V_GAP×(n-1))）；② `place(node, left, top)` 深度优先：子列 `left = node.x + node.width + H_GAP` 垂直堆叠，父 `y = 子树中心 - 自身高/2`（无子/折叠 = top）。节点宽 = `clamp(estimateGanttLabelWidth(truncate 后文本, MINDMAP_FONT_SIZE) + 24, MIN, MAX)`；文本用 `truncateGanttLabel` 同文件导出函数（DOM-free 估算，导出器可复算）。`nodes` 前序遍历产出，`colorTier = depth % 4`。

- [ ] **Step 3: 门禁 + 提交** — `npx vitest run tests/domain/mindmapModel.test.ts` → `npm test` → commit `"T43: mindmap layout model (rightwards tree, DOM-free metrics)"`

---

### Task T44：视口控制器 mindmapViewport（pan/zoom/fit）

**Files:**
- Create: `src/controllers/mindmapViewport.ts`
- Test: `tests/controllers/mindmapViewport.test.ts`

**Interfaces:**
- Consumes: `MindMapModel['bounds']` 形状。
- Produces: `MINDMAP_ZOOM_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.2, 1.5, 2, 3] as const`、`MINDMAP_DEFAULT_ZOOM_INDEX = 4`、`MindMapViewportState { panX; panY; zoomIndex; width; height }`、`MindMapViewportController { subscribe; getState; getZoom; zoomIn; zoomOut; setZoomIndex; resetView; panBy(dx,dy); setPan(x,y); setViewportSize({width?,height?}); zoomAt(anchorX, anchorY, deltaSteps): void; fitToContent(bounds, padding?): void; applyWheel({ctrlKey, deltaX, deltaY}): boolean }`——骨架逐条照 `createGanttViewport`（整体 patch、无变化不 emit、稳定 getState）。

- [ ] **Step 1: 失败测试**

```ts
it('zoomAt 以视口锚点缩放：锚点内容坐标不变', () => {
  const vp = createMindmapViewport({ width: 800, height: 600 }) // zoom=1, pan=(0,0)
  vp.zoomAt(400, 300, 1) // → 1.2
  // 内容点 (400,300) 缩放前屏幕=400,300；缩放后仍应 400,300
  const s = vp.getState()
  expect(400 * zoomFactor(s.zoomIndex) + s.panX).toBeCloseTo(400, 5)
  expect(300 * zoomFactor(s.zoomIndex) + s.panY).toBeCloseTo(300, 5)
})
it('fitToContent 选最大可容纳档位并居中', () => {
  const vp = createMindmapViewport({ width: 800, height: 600 })
  vp.fitToContent({ minX: 0, minY: 0, maxX: 1600, maxY: 300 })
  const s = vp.getState()
  expect(zoomFactor(s.zoomIndex)).toBeLessThanOrEqual(800 / 1600 + 1e-9)
  // 居中：内容中心 800*zoom + panX ≈ 400
  expect(800 * zoomFactor(s.zoomIndex) + s.panX).toBeCloseTo(400, 5)
})
it('applyWheel：Ctrl 缩放、普通滚轮平移，返回是否消费', () => { /* 两分支各一例 + 边界档不动 */ })
```

- [ ] **Step 2: 实现** — `zoomAt` 数学：`content = (anchor - pan) / z0`，换档后 `pan = anchor - content * z1`。`fitToContent`：`z = min(maxStep, 档表内满足 w*z ≤ width-2p 且 h*z ≤ height-2p 的最大档；放不下则最小档)`，pan 使内容中心落在视口中心。`clampZoomIndex` 导出（照甘特同名函数）。

- [ ] **Step 3: 门禁 + 提交** — commit `"T44: mindmap viewport controller (pan/zoom/fit, gantt-style)"`

---

### Task T45：画布投影 + tab 接线（只读渲染）

**Files:**
- Create: `src/views/MindMapCanvas.tsx`、`src/views/MindMapView.tsx`
- Modify: `src/App.tsx`（L452 联合类型、L366-438 Workspace、L944-956 按钮组）
- Modify: `src/locales/zh.ts`（尾部加 `mindmap` 嵌套节 + `shell.viewMindmap`）、`src/locales/en.ts`（平行扁平键）
- Test: `tests/views/MindMapView.test.tsx`

**Interfaces:**
- Consumes: T40 vault.mindmaps、T43 buildMindMapModel、T44 控制器、T42 actions（本任务只用 applyCreateMap 于空态引导按钮——若 vault.mindmaps 为空，视图显示引导卡 +「新建思维导图」按钮，bus 已在 props）。
- Produces: `MindMapViewProps { vault: Vault; bus: CommandBus; t?; viewport?: MindMapViewportController; style? }`（默认导出组件具名 `MindMapView`；选中图 id/选中节点/编辑态全部本地 state，不进 vault）；`MindMapCanvasProps { model: MindMapModel; zoom: number; selectedId: string | null; editingId: string | null; onToggleFold?(id): void; onSelect?(id): void }`。tab testid 自动生成 `view-mindmap`。

- [ ] **Step 1: locales 加键**（zh 尾部追加节，en 补扁平键；两表都要）

```ts
// zh.ts 追加
shell: { /* …既有… */ viewMindmap: '导图' },  // shell 节内追加一行
mindmap: {
  emptyTitle: '还没有思维导图',
  emptyHint: '在画布上自由展开你的想法，数据与任务库一起保存在 vault 中。',
  create: '新建思维导图',
  defaultName: '未命名导图',
  centerTopic: '中心主题',
  branch: '分支',
  deleteMap: '删除此图',
  renameMap: '重命名',
  foldAll: '全部折叠',
  unfoldAll: '全部展开',
  fit: '适应画布',
  export: '导出',
  exportPng: '导出 PNG',
  exportSvg: '导出 SVG',
  exportVisible: '仅可见区',
  exportFull: '全图',
  cancel: '取消',
  deleteConfirm: '删除整张思维导图？',
},
```

（en 对照：`Mind map` / `No mind maps yet` / `New mind map` / `Untitled map` / `Central topic` / `Branch` / …逐键翻译，`Record<MsgKey,string>` 编译强制对齐。）

- [ ] **Step 2: App.tsx 三处触点**
  - `type` 处：`useState<'board' | 'gantt' | 'mindmap'>('board')`（L452）；Workspace props `view: 'board' | 'gantt' | 'mindmap'`（L368）。
  - 按钮组（L944）：`(['board', 'gantt', 'mindmap'] as const)`，文案改 `mode === 'board' ? t('shell.viewBoard') : mode === 'gantt' ? t('shell.viewGantt') : t('shell.viewMindmap')`。
  - Workspace 渲染（L419-438）：三分支 `view === 'mindmap' ? <MindMapView vault={vault} bus={bus} t={t} /> : view === 'gantt' ? … : …`。导图的点击不经 Workspace 事件委托（自带 onClick），L401-417 委托保持原样。
- [ ] **Step 3: 写失败视图测试**（jsdom + testing-library，桩 i18n 照 `tests/views/GanttView.test.tsx` L41 手法；bus 用 `createCommandBus(createVaultStore(vault))`）

```tsx
it('空库显示引导，点新建出现一张图', async () => {
  const { store, bus } = seeded({ mindmaps: [] })
  render(<MindMapView vault={store.getVault()} bus={bus} t={tZh} />)
  fireEvent.click(screen.getByRole('button', { name: '新建思维导图' }))
  expect(store.getVault().mindmaps).toHaveLength(1)
})
it('渲染根节点标签与一条子边', () => {
  const { container } = render(<MindMapView vault={vaultWithOneMap} bus={bus} t={tZh} />)
  expect(container.textContent).toContain('中心主题')
  expect(container.querySelectorAll('path[data-mindmap-edge]')).toHaveLength(1)
})
it('App 顶栏出现第三个 tab 并可切入', () => { /* 复用 App 集成测试手法；若过重则本任务在 e2e T48 验证，此处断言 Workspace 收到 view=mindmap 渲染 MindMapCanvas testid */ })
```

- [ ] **Step 4: MindMapCanvas.tsx** — `<svg data-testid="mindmap-canvas">` 外层，内层 `<g transform={`translate(${panX} ${panY}) scale(${zoom})`}>`（pan/zoom 经 props 传入）。渲染：edges（`<path data-mindmap-edge stroke="var(--oe-separator-strong)" fill="none">`——分隔线色若无 strong 档取 `--oe-separator`，以 theme.css 现量为准）→ nodes（`<g data-mindmap-node={id}>`: rect rx=8 + text 截断 + 折叠徽标 `<circle>+<text>+N`）。选中：rect 描边 `var(--oe-accent)`。色阶：depth 0 用 `--oe-accent` 实底白字，1-3 用 topic 色板 CSS 变量的透明度阶梯或 `--oe-fill-*`（实现时读 theme.css 现有令牌选 4 档，禁新增硬编码色值，视觉遵循「克制低密度」）。文字节点渲染 `<text>`；编辑态输入框是 T46 的 HTML overlay，Canvas 只管 `editingId` 时隐藏该节点 text。
- [ ] **Step 5: MindMapView.tsx** — 结构照 GanttView：本地 `viewport`（`useState(() => createMindmapViewport())` + `useSyncExternalStore`）、`selectedMapId`（默认第一张图，删除后回退表首）、`selectedNodeId`、`editingNodeId`。`const model = useMemo(() => selectedMap ? buildMindMapModel(selectedMap) : null, [selectedMap])`。工具条（高度常量 36，照 GanttView 的 TOOLBAR_HEIGHT）本任务先放：图选择下拉（`<select>`，options=按 order 排序的图）、「新建」「适应画布」按钮。空态引导卡 + applyCreateMap（`fallbackName: t('mindmap.defaultName')`, `rootText: t('mindmap.centerTopic')`）。根容器 `data-testid="mindmap"`。**只读边界**：本任务不接编辑/拖拽，T46/T47 补。
- [ ] **Step 6: 门禁 + 提交** — `npx vitest run tests/views` → `npm test` → `npx tsc --noEmit`（locales 对齐）→ commit `"T45: mindmap canvas + view tab (read-only projection, empty-state create)"`

---

### Task T46：编辑交互（就地编辑、快捷键、折叠、平移缩放）

**Files:**
- Modify: `src/views/MindMapView.tsx`、`src/views/MindMapCanvas.tsx`
- Test: `tests/views/MindMapView.test.tsx`（追加）

**Interfaces:**
- Consumes: T42 全部 apply*、T44 applyWheel/panBy、T45 model/view。
- Produces: 视图内交互契约（供 T47 move 拖拽复用）：节点容器 `data-mindmap-node`；折叠按钮 `data-mindmap-foldtoggle={id}`；overlay 输入框 `data-mindmap-input`；根容器 keydown 处理（容器 `tabIndex=0` + `role="application"`）。

- [ ] **Step 1: 失败测试（追加）**

```tsx
it('Tab 加子节点并进入编辑；Enter 加同级；Esc 退出编辑不残留命令', () => {
  const h = mountWithMap() // 选中 'a'
  fireEvent.keyDown(root, { key: 'Tab' })
  expect(screen.getByTestId('mindmap-input')).toBeInTheDocument()
  fireEvent.change(input, { target: { value: '新分支' } }); fireEvent.keyDown(input, { key: 'Enter' })
  expect(findNode(rootOf(store), '…')).… // 文本已提交
})
it('Backspace 删除选中节点（非根）', …)
it('折叠徽标点击切换 folded 且子树消失', …) // data-mindmap-foldtoggle
it('双击节点打开编辑、预填当前文本；提交后 patch 落库', …)
it('空白拖拽平移 panBy；Ctrl+wheel 经 applyWheel 消费', …) // fireEvent.wheel {ctrlKey:true}
it('方向键导航：Tab 后 ArrowDown 选中下一个兄弟', …) // 若实现降级为 Left/Right/Up/Down 树游走
```

（测试断语言按此意图写全，实现者按文件内既有手法展开——事件名、query 方式与 GanttView 测试一致。）

- [ ] **Step 2: HTML overlay 编辑器** — 根容器 `position: relative`；绝对定位 `<input data-mindmap-input>`，坐标 = `node.x * zoom + panX, node.y * zoom + panY`，宽 = `node.width * zoom`，字号 = `MINDMAP_FONT_SIZE * zoom`（<12px 时钳 12 且 overflow hidden——xmind 缩小时标签不渲染正文只留块，沿用「块可见」降级）。提交 → `applyRenameNode`；Enter/Esc/blur 三路。IME：input 原生支持；keydown 全局处理时**先判 `event.isComposing` 直接 return**（中文输入回车不触发提交——spike 记忆：区分能力与焦点，这里必须验证 jsdom 无法测 IME，留注释标明人工验证项）。
- [ ] **Step 3: 键盘层** — 根容器 `onKeyDown`：选中态下 Tab=加子（`applyAddNode` 后 `setEditingNodeId(新id)`）、Enter=加同级（根上禁用）、Delete/Backspace=删（根禁用；`selectedNodeId===map.root.id` 判断）、F2/双击=编辑、Space=折叠切换、Escape=退出编辑/清选中、方向键=树游走（Up/Down 兄弟、Left 父/展开、Right 首子/折叠时展开）。`deps.newId` 用 nanoid 缺省。
- [ ] **Step 4: 指针层** — 节点 `onPointerDown` 选中（stopPropagation）；折叠徽标点击；画布空白 pointerdown→pointermove 平移（`panBy` 增量，pointer capture）；`onWheel` → `applyWheel({ctrlKey, deltaX, deltaY})`，非 Ctrl 时 `panBy(-deltaX, -deltaY)`；`preventDefault`（passive:false，用 ref + addEventListener 注册 wheel）。
- [ ] **Step 5: 门禁 + 提交** — `npm test` → commit `"T46: mindmap editing (in-place input, xmind keymap, fold, pan/zoom)"`

---

### Task T47：跨父拖拽 move + 图管理工具条

**Files:**
- Modify: `src/views/MindMapView.tsx`
- Test: `tests/views/MindMapView.test.tsx`（追加）；`tests/controllers/mindmapActions.test.ts`（move 已有，补 UI 触达断言）

**Interfaces:**
- Consumes: `applyMoveNode`；T45 model 的节点矩形（命中检测）。
- Produces: 工具条完整按钮集 + 拖拽契约 `data-mindmap-dragging`。

- [ ] **Step 1: 失败测试** — ① 拖 `a1` 落到 `b`：pointerdown 于 a1 → pointermove 越过 b 矩形（断言出现 `data-mindmap-dragging` 与目标高亮 `data-mindmap-drop-target="b"`）→ pointerup → vault 树中 a1.parent 变 b、undo 一次回原状。② 拖到自己子树 a1→（a1 后代）无变化。③ 下拉切换选中图渲染对应根文本。④ 「重命名」进入工具条输入、提交走 applyRenameMap。⑤ 删除图（确认态按钮二次点击）→ store 无该图、选中回退表首、undo 恢复。⑥ 「全部折叠/展开」批处理：foldAll 对 depth≥1 全 folded。
- [ ] **Step 2: 拖拽 move** — pointerdown 在已选中节点上启动 4px 阈值拖拽；半透明 ghost（原节点 opacity 0.4）；命中 = 指针屏幕坐标反变换成内容坐标后落进某节点矩形（排除自身与后代——复用 `isDescendant`）；落点 `index = 目标 children.length`（追加尾部；同父时保留其余兄弟序）。命令：`applyMoveNode(bus, store.getVault(), mapId, nodeId, targetId, idx)`。**注意**：命令的 `index` 语义 = 先从原父 remove 后在 newParent 的插入位（reducer 顺序 remove→insert；同父时原下标被占位符前移——工厂内不做补偿，测试锁定此语义）。
- [ ] **Step 3: 工具条补全** — 图 `<select>` 后：重命名（点击切输入）、删除（Popconfirm 式两段按钮，文案 `mindmap.deleteConfirm`）、折叠全部/展开全部（单条命令循环 patch？——**否**：批量折叠会污染 undo 栈 N 条。方案：expandAll/foldAll 用本地 `foldOverride: 'all' | 'none' | null` 视图态传给 buildMindMapModel 的 opts？——**决策**：改 `buildMindMapModel(map, { foldAll?: boolean; unfoldAll?: boolean })` 覆盖展示态、**不写库**，undo 栈干净；T43 的 opts 签名在此扩展：`buildMindMapModel(map: MindMap, opts?: { foldDepth?: number })` 简化为 foldAll 布尔——实现者按此补 opts 参数与一条模型测试）。适应画布 = `viewport.fitToContent(model.bounds)`。
- [ ] **Step 4: 门禁 + 提交** — commit `"T47: mindmap node reparent drag + map toolbar"`

---

### Task T48：导出 PNG/SVG + e2e + 文档收尾

**Files:**
- Create: `src/views/MindMapExporter.ts`
- Modify: `src/views/MindMapView.tsx`（导出菜单）、`e2e/`（新增 `09-mindmap.spec.ts`）、`docs/delivery.md`、`docs/user-guide.md`
- Test: `tests/views/MindMapExporter.test.ts`

**Interfaces:**
- Consumes: `MindMapModel`、`GANTT_*` 导出探针 `probePngSupport`（从 GanttExporter 导入或提公共——若 GanttExporter 未导出该函数则本任务提 `src/views/exportProbe.ts` 并让两边共用）。
- Produces: `exportMindMap(input: { model: MindMapModel; format: 'png' | 'svg'; range: 'visible' | 'full'; viewport: { panX, panY, zoom, width, height }; fileName: string })`；SVG 字符串内联 presentation attributes（禁 `var(`——照 visual-audit §4 由测试钉住）；颜色从 theme 令牌**取字面量**（照 GanttCanvas/GanttExporter 共用常量手法，新常量 `MINDMAP_*_FILL` 集中定义）。

- [ ] **Step 1: 导出失败测试** — ① `range:'full'` 的 SVG viewBox = bounds + padding；② 每条边一个 `<path d=…>`、每个可见节点一个 rect+text，`expect(svg).not.toContain('var(')`；③ 折叠徽标 `+N` 文本出现；④ PNG 路径在 jsdom 下 mock Image/canvas 或沿用 GanttExporter 测试的现有桩手法。
- [ ] **Step 2: 实现 MindMapExporter** — 照 GanttExporter 架构：字符串级 SVG 拼装（`createElementNS` 不需要，甘特是字符串就照字符串）、PNG = SVG data-URI → Image → 2×canvas → toBlob → `<a download>`；tainted canvas 抛错不出空文件；`range:'visible'` 用视口反算内容窗。
- [ ] **Step 3: 视图接导出菜单** — 复用甘特的弹层交互（Esc/外点关闭，照 GanttView L125-133 手法），格式 PNG/SVG × 范围 可见/全图；文件名 `{图名}.png|svg`。
- [ ] **Step 4: e2e `e2e/09-mindmap.spec.ts`** — 照 e2e/04 手法：`page.getByTestId('view-mindmap').click()` → 点「新建思维导图」→ 双击节点改名 → 断言画布出现文本 → reload 回同一 fixture 目录 → 图仍在（真实 autosave 夹具，参照 e2e/fixtures 现有 startup 流程）。
- [ ] **Step 5: 全门禁** — `npm run build`（含 1.6MB verify）→ `npm test` → `npx playwright test e2e/09-mindmap.spec.ts`（本地 chromium；企业环境不可用时记录为未验证项，不虚报）。
- [ ] **Step 6: 文档** — `docs/delivery.md` 追加 T40-T48 行；`docs/user-guide.md` 加「思维导图」一节（快捷键表：Tab/Enter/F2/Space/Delete/方向键/Esc）。
- [ ] **Step 7: 提交** — commit `"T48: mindmap PNG/SVG export, e2e, docs"`

---

## Self-Review 记录

1. **Spec 覆盖**：§2 模型→T40；§3 命令→T41/T42；§4 布局→T43；§5 视口→T44；§6 tab+视图+交互→T45/T46/T47；§7 导出→T48；§8 边界（move 抛错、根不可删、空态）→T41/T42/T45；§9 测试全部映射；§10 顺序一致。无遗漏。
2. **占位符**：T45 Step3 第 ③ 例与 T46 Step1 部分断言给出意图+手法指向（复用既有文件内构造），实现者按既有 fixture 展开；无 TBD/TODO。
3. **类型一致性**：`MindNode/MindMap` 字段名全计划统一（text/order/folded/children）；`applyAddNode` 返回 `MindNode | null` 与 T46 编辑聚焦衔接；`fitToContent(bounds)` 与 T43 `MindMapModel.bounds` 形状一致；T47 对 T43 opts 的扩展已在该步显式声明。
