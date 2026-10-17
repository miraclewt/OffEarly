/**
 * 抓取落地页要用的 4 张真实界面图：看板 / 甘特 / 思维导图 / 任务详情弹窗。
 *
 * 为什么走 Playwright 而不是手画设计稿：截图来自 **真实的 dist/OffEarly.html**，
 * 界面一改，重跑一次素材就跟着改，落地页不会挂着半年前的旧 UI。
 *
 * 复用的正是 e2e 那套假目录（fakeFs）——它只替换 showDirectoryPicker 这一个动作，
 * 之后 vault.json 读写、视图渲染跑的全是产品代码。时钟同样冻结在 FROZEN_NOW，
 * 否则甘特的「今天线」和逾期判定会随真实日期漂移，截图每次都不一样。
 *
 * 跑法：npm run build && npm run capture
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { ARTIFACT, ROOT } from '../playwright.config'
import { connectWorkspace, openAppWith } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'
import { fromBase64, toBase64, type FakeFsState } from '../e2e/fixtures/fakeFs'

const OUT = join(ROOT, 'site', 'assets')

/** 点过工具栏按钮后焦点环会留在截图里，静态图上读起来像噪点，拍之前摘掉。 */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

/**
 * example.vault 里的 mindmaps 是空的（它是交付给用户的样例库，不该为了截图去改磁盘上
 * 的用户数据）。这里在内存副本里注入一棵演示导图，只存在于本次抓取。
 */
function withDemoMindMap(fs: FakeFsState): FakeFsState {
  const vault = JSON.parse(fromBase64(fs.files['vault.json'])) as Record<string, unknown>

  let seq = 0
  const node = (text: string, children: unknown[] = []): unknown => ({
    id: `mm-${(seq += 1)}`,
    text,
    order: 'a',
    folded: false,
    children,
  })

  vault.mindmaps = [
    {
      id: 'mm-map',
      name: 'OffEarly 产品地图',
      order: 'a',
      createdAt: '2026-10-15T09:00:00+08:00',
      updatedAt: '2026-10-15T09:00:00+08:00',
      root: node('OffEarly', [
        node('看板', [node('四列状态流'), node('拖拽换列'), node('连续录入')]),
        node('甘特', [node('依赖与关键路径'), node('工作日历'), node('导出 PNG·SVG·CSV')]),
        node('思维导图', [node('键盘建树'), node('折叠 +N 徽标'), node('跨父拖拽')]),
        node('数据安全', [node('写前快照'), node('启动自愈'), node('冲突三选')]),
        node('笔记', [node('Markdown'), node('[[双向链接]]'), node('图片附件')]),
      ]),
    },
  ]

  return { ...fs, files: { ...fs.files, 'vault.json': toBase64(JSON.stringify(vault)) } }
}

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
  // dist/ 在 .gitignore 里，但落地页的「打开在线版」要有东西可指：
  // 把同一份产物随站点入库，访客在 Chrome/Edge 里点开即可连自己的文件夹真用。
  copyFileSync(ARTIFACT, join(ROOT, 'site', 'OffEarly.html'))
})

test('capture landing page screenshots', async ({ page }) => {
  await openAppWith(page, withDemoMindMap(loadExampleVaultFs()))
  await connectWorkspace(page, { create: false })

  // 顶栏保存指示刚连上库时会短暂闪「未保存」，等它收敛再拍
  await expect(page.getByTestId('save-indicator')).toContainText('已保存')

  await page.screenshot({ path: join(OUT, 'board.png') })

  await page.getByTestId('view-gantt').click()
  await expect(page.getByTestId('gantt-view')).toBeVisible()
  // 日刻度 100% 下整条跨度约 2400px，画布只有 1000px 出头，任务条会被推到右缘裁断。
  // 换成周刻度并缩到最小档，让 9 月中到 11 月底的全跨度一屏放得下。
  await page.getByTestId('gantt-scale-week').click()
  await page.getByTestId('gantt-zoom-out').click()
  await page.getByTestId('gantt-zoom-out').click()
  await blur(page)
  await page.screenshot({ path: join(OUT, 'gantt.png') })

  await page.getByTestId('view-mindmap').click()
  await expect(page.getByTestId('mindmap')).toBeVisible()
  await page.getByTestId('mindmap-fit').click()
  await page.keyboard.press('Escape')
  await blur(page)
  await page.screenshot({ path: join(OUT, 'mindmap.png') })

  await page.getByTestId('view-board').click()
  await expect(page.getByTestId('board')).toBeVisible()

  const vault = JSON.parse(fromBase64((await loadExampleVaultFs()).files['vault.json'])) as {
    tasks: { id: string; note?: string }[]
  }
  // 挑一条有笔记的任务，弹窗里五个分区都能填满
  const showcase = vault.tasks.find((task) => (task.note ?? '').length > 0) ?? vault.tasks[0]
  await page.getByTestId(`task-card-${showcase.id}`).click()
  await expect(page.getByTestId('task-modal')).toBeVisible()
  // 弹窗比屏幕高，不滚一下的话笔记区正好被截在标题上。滚到配图处，
  // 让「Markdown + 图片 + [[双链]]」三样一次进画——这是笔记最能说明问题的一屏。
  const noteImage = page.locator('[data-testid="task-modal"] img').first()
  await noteImage.waitFor({ state: 'visible' })
  await noteImage.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(OUT, 'task-modal.png') })
})
