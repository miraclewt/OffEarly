# OffEarly 交付说明

**产品名**：OffEarly（早下班） · tagline「把事做完，早点下班。/ Finish well. Leave early.」
**交付物**：`dist/OffEarly.html` —— 单文件可执行页，**1,095,737 字节（约 1.05 MB）**
**交付日期**：2026-10-17 · **范围**：T01–T33 全部完成

---

## 1. 这是什么

一个不依赖服务器的个人任务管理工具：**双击 HTML 就能用，数据全在你自己选的文件夹里**。

- **形态**：单个 `OffEarly.html`，零外部请求（无外链 script / link / module、无 http(s) 资源引用），`file://` 直接打开即可运行
- **数据自持**：所有数据写进你选中的一个普通文件夹（`vault.json` + `assets/` + `.backup/`），不上传、不依赖云服务，换台电脑拷走文件夹即可
- **两个视图**：看板（拖拽换列）+ 甘特图（依赖箭头、关键路径、基线、日/周刻度、导出 PNG/SVG/CSV）
- **笔记支持**：Markdown 笔记、`[[双链]]` 跳转、图片粘贴/拖入/选择（存进 `assets/`，点开看灯箱）
- **数据安全**：写前自动快照、启动自愈（库损坏时自动回退最近快照进只读）、外部改动冲突三选、备份面板可导出库副本与导入

## 2. 怎么用（三步上手）

1. 双击 `dist/OffEarly.html`
2. 首次打开点「选择文件夹」，选一个空文件夹（或直接用仓库里的 `example.vault/` 试玩）
3. 之后每次打开会自动记住并连接该文件夹

更多细节见 `docs/user-guide.md`（中英双栏一页纸，12 个主题）；示例数据见 `example.vault/`。

**浏览器要求**：需支持 File System Access API（Chrome / Edge 113+）。Safari、Firefox 不支持。

## 3. 验收证据（交付前最后一次全量跑）

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | **0 错误** |
| `npm test`（Vitest） | **717 passed / 41 files** |
| `npm run e2e`（Playwright，真实 Chromium 跑 `file://`） | **25 passed + 1 skipped** |
| `npm run build` + 产物校验 | **10/10**（单文件、零外链、favicon 内联、禁 emoji 等十项全过） |
| `npm run lint:emoji` | 零命中 |

## 4. 本次收尾补做的内容（交付前最后一轮）

| 项 | 内容 |
|---|---|
| T30 密度复核 | 对照 spec §7：卡片 6 项、列头 3 项、抽屉 5 分区，全部合规（详见 `docs/visual-audit.md` 第 6 节） |
| T32 补记 | 图表导出 e2e 用例转正（浏览器下载断言），此前漏勾 |
| 甘特导出弹层 | 补 Esc / 点击外部关闭（此前只有「取消」与再点按钮两条出路） |
| 双链菜单 Esc | 菜单开着时 Esc 只关菜单，不再把抽屉一起关掉 |
| 「选择其他备份」 | 只读与安全模式相位下转正：可从 `.backup/` 里挑一份快照恢复并重回可写（此前是占位按钮） |
| `.gitattributes` | 品牌 SVG 锁 LF，根除 `core.autocrlf` 导致的 favicon 字节校验噪音（worktree 下 379 → 372） |

## 5. 已知限制（刻意保留，非缺陷）

- **浏览器**：依赖 File System Access API，仅 Chrome / Edge 系可用
- **图片插入**：粘贴路径依赖浏览器放行 `clipboardData`；工具栏选文件与拖入两条路径始终可用
- **侧栏「设置」**：仍是占位按钮（T01–T33 范围内没有设置面板任务）
- **拖拽换列的 e2e**：仍为 `test.fixme`（dnd-kit 指针序列在 headless + `file://` 下不稳定），换列本身有 24 条组件级用例覆盖
- **附件回收**：只回收 `assets` 表内登记过的附件，磁盘上手工丢进 `assets/` 的孤儿文件不在范围内
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
