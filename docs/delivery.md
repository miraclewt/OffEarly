# OffEarly 交付说明

**产品名**：OffEarly（早下班） · tagline「把事做完，早点下班。/ Finish well. Leave early.」
**交付物**：`dist/OffEarly.html` —— 单文件可执行页，**1,150,240 字节（约 1.10 MB）**
**交付日期**：2026-10-17 · **范围**：T01–T33 全部完成 + 思维导图泳道 T40–T48（含收尾导出/e2e/文档）

---

## 1. 这是什么

一个不依赖服务器的个人任务管理工具：**双击 HTML 就能用，数据全在你自己选的文件夹里**。

- **形态**：单个 `OffEarly.html`，零外部请求（无外链 script / link / module、无 http(s) 资源引用），`file://` 直接打开即可运行
- **数据自持**：所有数据写进你选中的一个普通文件夹（`vault.json` + `assets/` + `.backup/`），不上传、不依赖云服务，换台电脑拷走文件夹即可
- **三个视图**：看板（拖拽换列）+ 甘特图（依赖箭头、关键路径、基线、日/周刻度、任务条上直接显示任务名、左侧任务表与右侧未排期面板可折叠、导出 PNG/SVG/CSV）+ 思维导图（xmind 逻辑图·向右：键盘建树、就地改名、跨父拖拽、折叠徽标、平移缩放、导出 PNG/SVG）
- **笔记支持**：Markdown 笔记、`[[双链]]` 跳转、图片粘贴/拖入/选择（存进 `assets/`，点开看灯箱）
- **数据安全**：写前自动快照、启动自愈（库损坏时自动回退最近快照进只读）、外部改动冲突三选、备份面板可导出库副本与导入

## 2. 怎么用（三步上手）

1. 双击 `dist/OffEarly.html`
2. 首次打开点「选择文件夹」，选一个空文件夹（或直接用仓库里的 `example.vault/` 试玩）
3. 之后每次打开会自动记住并连接该文件夹

更多细节见 `docs/user-guide.md`（中英双栏一页纸，17 个主题）；示例数据见 `example.vault/`。

**浏览器要求**：需支持 File System Access API（Chrome / Edge 113+）。Safari、Firefox 不支持。

## 3. 验收证据（交付前最后一次全量跑）

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | **0 错误** |
| `npm test`（Vitest） | **931 passed / 51 files**（思维导图泳道 T40–T48 后） |
| `npm run e2e`（Playwright，真实 Chromium 跑 `file://`） | **38 passed + 1 skipped**（新增 `09-mindmap.spec.ts` 2 条；skipped 仍是既有的 dnd-kit 拖拽换列 `fixme`） |
| `npm run build` + 产物校验 | **10/10**（单文件、零外链、favicon 内联、禁 emoji 等十项全过；产物 1150240 字节，上限 1677721） |
| `npm run lint:emoji` | 零命中 |

## 4. 本次收尾补做的内容（交付前最后一轮）

| 项 | 内容 |
|---|---|
| T34 新建任务入口 | 看板列底「+ 新建任务」：回车创建并保持展开（连续录入）、Esc/失焦退出；归属当前筛选话题、LexoRank 追加列尾、`status=done` 任务进度直接摆到 100；无话题时列底只给「先建一个话题」提示（此前 `createTaskCommand` 有命令但全库没有入口） |
| T35 设置面板 | 侧栏「设置」从占位回调换成真面板：语言（即时生效）/ 主题（只读浅色）/ 甘特默认刻度 / 工作日历（工作日开关 + 假期 + 补班，同一天自动从另一份列表摘掉）/ 关于；写入走 `settings.patch`，可撤销、随 autosave 落盘 |
| T36 任务详情改弹窗 | 任务编辑从 spec 6.3 的「右侧滑出 400px 抽屉」改为**居中弹窗**（约 760px 宽、`--oe-scrim` 遮罩、`role="dialog"` + `aria-modal`，关闭三出路 = Esc / 点遮罩空白 / 右上角 ×；打开时焦点进面板、关闭还给触发它的卡片）。遮罩关闭按「按下与抬起都在遮罩上」判定——弹窗里有富文本编辑器，从面板内往外拖选文字时浏览器会把 click 派发到共同祖先（遮罩），只看 click 会误关。冲突弹窗补 `z-index: 70`（否则弹窗里的 Ctrl+S 触发冲突时，三选会被遮罩挡在后面） |
| T30 密度复核 | 对照 spec §7：卡片 6 项、列头 3 项（新建入口放在列**体**底部，不占列头信息位）、任务弹窗 5 分区，全部合规（详见 `docs/visual-audit.md` 第 6 节） |
| T38 全局视觉重设计 | 按产品方选定的 **方案 A · macOS 通透** 与强调色 **系统靛 `#5E5CE6`** 重做视觉：换值全部落在 `src/styles/theme.css`（新增振镜材质三档 / 发丝线两级 / 圆角三档 / 阴影四档 / 焦点光环），侧栏与顶栏改半透明模糊、看板与甘特卡片改白底纸边 + 柔影、视图与刻度切换统一为分段控件、原生下拉与滑杆与滚动条全局收敛、日期与进度改等宽数字并加宽甘特左表日期列。**语义色仍仅三处、无左色条 / 渐变、密度上限、`TOPIC_PALETTE`、全部 `data-testid` 与 aria 属性一律未变**（详见 `docs/visual-audit.md` 第 8 节） |
| T39 甘特任务名 + 面板折叠 | 甘特任务条上直接写任务名（11px，条内为主；深色进度横向盖过标签中点时自动翻成白字，放不下一个字符时整体移到条右侧而不是截成省略号），里程碑与泳道菱形同样带名字。**屏幕与导出同一套标签函数**（`controllers/ganttViewport.ts` 的宽度估算 / 截断 / 深浅三档纯函数），导出的 SVG 与 PNG 里也有任务名。左侧任务表可在工具栏一键折叠成 30px 竖排「任务表」竖轨（画布当场拿回 314px），右侧未排期面板在没有未排期任务时自动收成 36px 竖轨、用户手动展开后不再被自动收回。折叠状态不落盘（刷新回默认） |
| 手册同步 | `docs/user-guide.md` 第 6/9/12 项此前仍写着「设置面板、备份面板、图表导出尚未实现」，已按当前实现改写，并补「新建任务」「设置」「任务详情弹窗」三行与新的本版边界 |
| T32 补记 | 图表导出 e2e 用例转正（浏览器下载断言），此前漏勾 |
| 甘特导出弹层 | 补 Esc / 点击外部关闭（此前只有「取消」与再点按钮两条出路） |
| 双链菜单 Esc | 菜单开着时 Esc 只关菜单，不再把弹窗一起关掉 |
| 「选择其他备份」 | 只读与安全模式相位下转正：可从 `.backup/` 里挑一份快照恢复并重回可写（此前是占位按钮） |
| `.gitattributes` | 品牌 SVG 锁 LF，根除 `core.autocrlf` 导致的 favicon 字节校验噪音（worktree 下 379 → 372） |
| T40 导图数据模型 | `MindNode / MindMap` 进 `vault.json`（schema v1 默认空数组，字段 text/order/folded/children），工厂与夹具同步补齐 |
| T41 导图命令层 | create/patch 的树操作进命令总线，逆操作不可变（撤销/重做零成本复用既有栈）；删根、移入自身子树在 `bus.apply` 之前抛错，undo 栈必然干净 |
| T42 mindmapActions | plan→apply 两层：id 注入可测试，新节点尾插（数组序即显示序 = order 升序口径） |
| T43 布局模型 | `buildMindMapModel`：xmind 逻辑图·向右两趟布局（measure/place，父在子列垂直居中），零 DOM/零 React；兄弟序按 children 下标、折叠（含 foldAll 展示态）按叶子排布并给 `+N` 徽标计数、bounds 供视口 fit 与导出 |
| T44 视口控制器 | pan/zoom/fit 照甘特手法：离散档位 50%–300%、锚点缩放（Ctrl+滚轮档变内容不动点）、`fitToContent(bounds)` 选最大可容纳档；纯 TS 可在 node 里断言 |
| T45 画布与 tab | `MindMapCanvas`（模型只读投影，外层 `<g translate·scale>`）+ `MindMapView` + 顶栏「思维导图」tab + 空态引导卡（唯一新建入口）；颜色走 CSS 变量，零新增 hex |
| T46 编辑交互 | xmind 键位表（Tab 加子 / Enter 加同级 / F2·双击就地改名 / Space 折叠 / Delete 删 / 方向键树游走 / Esc）+ HTML overlay 就地输入（IME 双守卫：isComposing + composition ref）+ 空白拖拽平移与滚轮缩放 |
| T47 拖拽与图管理 | 节点按住拖 >4px 进入跨父 move：命中 = 屏幕反变换落进合法候选矩形（只排自身与自身后代，**中心主题是合法落点**），ghost + 落点高亮；工具条：图切换 / 新建 / 重命名（inline input）/ 删除（两段确认，确认态钉在 armed 图 id）/ 全部折叠·展开（纯展示态，不写库） |
| T48 导图导出 + e2e + 文档 | `MindMapExporter`：模型 → 自包含 SVG 字符串（呈现属性全字面量、零 `var(`——由测试钉住，色值与 theme.css/`MindMapCanvas` 同档：accent `#5E5CE6`、近黑 `#1D1D1F`、rgba 令牌拆 hex+opacity），PNG 复用甘特 R3 管线（`svgToPngBlob` / `probePngSupport` / `triggerDownload` import 共用，失败抛错不出空文件）；范围 全图 = bounds+padding 40 / 仅可见区 = 视口反算，坐标序列化收 1 位小数；导出菜单照甘特弹层（格式 × 范围、Esc/外点关闭、PNG 探针降级提示，文案复用 `ganttExport.*` 键）；**导出喂当前显示模型——「全部折叠」开着时导出的就是折叠图**；新增 `e2e/09-mindmap.spec.ts`（双击改名→落盘→重开还在 + PNG/SVG 各下载一个文件）与本节文档 |

## 5. 已知限制（刻意保留，非缺陷）

- **浏览器**：依赖 File System Access API，仅 Chrome / Edge 系可用
- **图片插入**：粘贴路径依赖浏览器放行 `clipboardData`；工具栏选文件与拖入两条路径始终可用
- **新建任务的默认归属**：落在「当前筛选的话题」（无筛选取第一个），因此筛选开着时新任务一定可见；库里没有任何话题时无法创建（`topicId` 是必填字段），列底会明确提示先建话题
- **拖拽换列的 e2e**：仍为 `test.fixme`（dnd-kit 指针序列在 headless + `file://` 下不稳定），换列本身有 24 条组件级用例覆盖
- **附件回收**：只回收 `assets` 表内登记过的附件，磁盘上手工丢进 `assets/` 的孤儿文件不在范围内
- **任务详情是弹窗，其余三面是浮层（2026-10-17 产品方裁决，不再变更）**：任务详情按产品方要求偏离 spec 6.3 的「右侧滑出抽屉」（`docs/design/02-gantt-detail.png` 画的仍是抽屉），改为居中弹窗；里程碑面板、筛选栏、设置面板**经裁决保留贴侧边浮层**。两种形态并存是有意为之——任务详情是聚焦编辑面，后三者是「边看甘特边改」的辅助面
- **深色主题仍未做**：设置面板里「主题」是只读的浅色。T38 重设计的材质与阴影全部按浅色档标定（三档 `--oe-material-*` 与四档阴影），上深色需整体换档、另开任务。`backdrop-filter` 的浏览器边界与本项目一致（Chrome / Edge 系）；不支持时半透明材质退成不透明底色，可读性与层级不受影响
- **两处设计待裁决**：设计稿的优先级彩点（红/黄/绿）与「正常态日期琥珀点」与 spec 语义色规范冲突，未擅自实现（见 `docs/visual-audit.md` 第 5 节）

## 6. 仓库结构速览

```
dist/OffEarly.html      交付产物（单文件）
example.vault/          示例库（vault.json + assets/）
docs/user-guide.md      一页纸用户手册（中英）
docs/visual-audit.md    视觉规范校对记录
src/                    源码（domain 领域层 / persistence 持久层 / controllers / views）
tests/                  单测（与 src 镜像）
e2e/                    Playwright 端到端（真实 Chromium over file://）
```
