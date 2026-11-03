/**
 * T49 · 知识库（笔记本）与图片缩放的真实落盘链路。
 *
 * 这一组回答两个具体承诺：
 *  1. 在笔记本里写下的 Markdown，真的进了 `vault.json` 的 `noteDocs`（不是内存里假装保存）；
 *  2. 图片宽度选择 50% 后，正文里留下的是 `<img … width="50%">`，重开还在。
 */
import { readFileSync } from 'node:fs'

import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith, waitSaved } from './fixtures/app'
import { fromBase64, readFakeFs, seedFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'
import type { FakeFsState } from './fixtures/fakeFs'

interface StoredVault {
  notebooks?: { id: string; name: string }[]
  noteDocs?: { id: string; title: string; content: string; parentId: string | null }[]
}

function parseVault(fs: FakeFsState): StoredVault {
  return JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
}

/** 落盘里全部文档的正文——轮询断言用，省得为「哪一篇」重复写路径。 */
function docContents(fs: FakeFsState): string[] {
  return (parseVault(fs).noteDocs ?? []).map((doc) => doc.content)
}

/** 在 example 库上追加一个笔记本与若干文档（其余任务数据保持不变）。 */
function withNotebooks(docs: { title: string; content: string }[]): FakeFsState {
  const fs = loadExampleVaultFs()
  const raw = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as Record<string, unknown>
  const now = '2026-10-22T09:00:00.000Z'
  raw.notebooks = [{ id: 'nb-e2e', name: '团队知识库', order: 'U', createdAt: now, updatedAt: now }]
  raw.noteDocs = docs.map((doc, index) => ({
    id: `doc-e2e-${index + 1}`,
    notebookId: 'nb-e2e',
    parentId: null,
    title: doc.title,
    content: doc.content,
    order: index === 0 ? 'U' : 'V',
    createdAt: now,
    updatedAt: now,
  }))
  fs.files['vault.json'] = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64')
  return fs
}

test('新建笔记本 → 新建文档 → 写 Markdown → 落盘 → 重开仍在', async ({ page }) => {
  await openAppWith(page, withNotebooks([]))
  await connectWorkspace(page, { create: false })

  await page.getByTestId('view-notebook').click()
  await expect(page.getByTestId('notebook')).toBeVisible()

  // 空笔记本已由夹具给出；直接建第一篇文档
  await page.getByTestId('notebook-new-doc').click()
  await expect(page.getByTestId('notebook-title-input')).toHaveValue('未命名文档')

  const title = page.getByTestId('notebook-title-input')
  await title.fill('发布流程')
  await title.press('Enter')

  await page.getByTestId('note-editor-content').click()
  await page.keyboard.type('# 发布流程')
  await page.keyboard.press('Enter')
  await page.keyboard.type('没有快照的发布不叫发布。')
  await waitSaved(page)

  // 写入链路是「编辑器 debounce 400ms → 命令 → autosave」，落盘晚于「已保存」文案，
  // 故对着磁盘内容轮询，而不是读一次就断言。
  await expect
    .poll(async () => docContents(await readFakeFs(page)).join('\n'), { timeout: 15_000 })
    .toContain('没有快照的发布不叫发布')

  const stored = parseVault(await readFakeFs(page))
  const doc = stored.noteDocs?.find((item) => item.title === '发布流程')
  expect(doc?.content).toContain('# 发布流程')

  // 文档 id 是运行时生成的：重开后按落盘里那个 id 点，才找得到同一篇
  const docId = doc?.id ?? ''
  expect(docId).not.toBe('')

  // 重开：把落盘快照当作「另一台机器上的磁盘」
  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await expect(page.getByText('连接数据文件夹')).toBeVisible()
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  await page.getByTestId(`doc-row-${docId}`).click()
  await expect(page.getByTestId('notebook-title-input')).toHaveValue('发布流程')
  await expect(page.getByTestId('note-editor-content')).toContainText('没有快照的发布不叫发布')
})

test('图片缩放：选 50% 后正文落成 <img width="50%">，重开尺寸还在', async ({ page }) => {
  await openAppWith(
    page,
    withNotebooks([{ title: '燃尽图', content: '![燃尽图](assets/asset-burndown.png)' }]),
  )
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  const image = page.getByTestId('note-image')
  await expect(image).toBeVisible()
  await image.hover()
  await page.getByTestId('note-image-width-50').click()
  await waitSaved(page)

  await expect
    .poll(async () => docContents(await readFakeFs(page)).join('\n'), { timeout: 15_000 })
    .toContain('width="50%"')

  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await expect(page.getByText('连接数据文件夹')).toBeVisible()
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  // 把手上的 aria-valuenow 就是当前百分比：比量 CSS 宽度稳，也不受界面尺度影响
  await expect(page.getByTestId('note-image-resize')).toHaveAttribute('aria-valuenow', '50')
  expect(docContents(await readFakeFs(page)).join('\n')).toContain('width="50%"')
})

/**
 * 这一条钉的是**百分比基准**——jsdom 没有布局，只有真浏览器能证明：
 * `width:50%` 必须相对编辑区正文宽度，而不是图片自身固有宽度。
 * 早前把百分比直接写在 <img> 上（包含块是 shrink-to-fit 的包装层），
 * 一张 480px 宽的图选 50% 只得到 240px（= 正文宽 602 的 40%），用户手感就是「比例不听话」。
 */
test('图片尺寸：百分比相对编辑区宽度；自适应档只限高不写宽度', async ({ page }) => {
  await openAppWith(
    page,
    withNotebooks([{ title: '燃尽图', content: '![燃尽图](assets/asset-burndown.png)' }]),
  )
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  const image = page.getByTestId('note-image')
  await expect(image).toBeVisible()

  // 自适应档：不写宽度，只给高度上限（长截图不该一插入就吃满一屏）
  const auto = await image.evaluate((el) => {
    const node = el as HTMLImageElement
    return { width: node.style.width, maxHeight: node.style.maxHeight }
  })
  expect(auto.width).toBe('')
  expect(auto.maxHeight).not.toBe('')

  await image.hover()
  await page.getByTestId('note-image-width-50').click()

  const ratio = await image.evaluate((el) => {
    const node = el as HTMLImageElement
    // 分母用编辑区本身：NodeViewWrapper 是内联 span（clientWidth 恒为 0），段落上一次性取不到
    const host = document.querySelector('[data-testid="note-editor-content"]') as HTMLElement | null
    return node.getBoundingClientRect().width / (host?.clientWidth ?? 1)
  })
  expect(ratio).toBeGreaterThan(0.45)
  expect(ratio).toBeLessThan(0.55)
})

// ── T50 · mermaid 渲染 / 字号 / 导出 ─────────────────────────────────────────

const MERMAID_DOC = ['```mermaid', 'flowchart TD', '  A[开始] --> B{检查}', '  B -->|有| C[结束]', '```', ''].join('\n')

test('mermaid 代码块在编辑器里渲染成图（真实 Chromium，不是 mock）', async ({ page }) => {
  await openAppWith(page, withNotebooks([{ title: '流程图', content: MERMAID_DOC }]))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  // 首次要动态加载引擎并在浏览器里跑布局，给足时间（之后同内容命中的是缓存）
  const preview = page.getByTestId('note-mermaid-preview')
  await expect(preview).toHaveAttribute('data-mermaid-state', 'ok', { timeout: 30_000 })
  await expect(preview.locator('svg')).toHaveCount(1)
  // 图里真的画了元素：节点文字与连线路径都在
  await expect(preview).toContainText('开始')
  expect(await preview.locator('svg path').count()).toBeGreaterThan(0)

  // 代码本身没有被图吞掉：仍是一段可编辑的围栏代码块
  await expect(page.getByTestId('note-editor-content')).toContainText('flowchart TD')
})

test('语法写错时给一行提示，代码原样保留', async ({ page }) => {
  await openAppWith(
    page,
    withNotebooks([{ title: '坏图', content: ['```mermaid', 'flowchart TD', '  A -->', '```', ''].join('\n') }]),
  )
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  const preview = page.getByTestId('note-mermaid-preview')
  await expect(preview).toHaveAttribute('data-mermaid-state', 'error', { timeout: 30_000 })
  await expect(page.getByTestId('note-editor-content')).toContainText('A -->')
})

test('A+ 调大字号：落盘到 settings.noteFontSize，重开仍是 14', async ({ page }) => {
  await openAppWith(page, withNotebooks([{ title: '字号', content: '读起来舒服一点。' }]))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  await expect(page.getByTestId('note-font-size')).toHaveText('13')
  await page.getByTestId('note-font-larger').click()
  await expect(page.getByTestId('note-font-size')).toHaveText('14')

  // 字号是 settings 变更 → 命令 → autosave，落盘晚于界面
  await expect
    .poll(
      async () => {
        const raw = JSON.parse(fromBase64((await readFakeFs(page)).files['vault.json'] as string)) as {
          settings?: { noteFontSize?: number }
        }
        return raw.settings?.noteFontSize
      },
      { timeout: 15_000 },
    )
    .toBe(14)

  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await expect(page.getByText('连接数据文件夹')).toBeVisible()
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  await expect(page.getByTestId('note-font-size')).toHaveText('14')
})

test('导出本文档为 HTML：浏览器下载一份自包含文件，图已渲染成内联 SVG', async ({ page }) => {
  await openAppWith(
    page,
    withNotebooks([{ title: '导出样例', content: `# 导出样例\n\n正文一段。\n\n${MERMAID_DOC}` }]),
  )
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  await page.getByTestId('notebook-export').click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('notebook-export-doc').click()
  const download = await downloadPromise

  expect(download.suggestedFilename()).toBe('导出样例.html')
  const filePath = await download.path()
  expect(filePath).not.toBeNull()
  const html = readFileSync(filePath as string, 'utf8')

  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain('<title>导出样例</title>')
  expect(html).toContain('正文一段')
  // 图表在导出文件里是真 SVG（矢量、可打印），不是一段代码
  expect(html).toContain('<figure class="diagram">')
  // 自包含：没有外链样式表 / 脚本
  expect(html).not.toMatch(/<link\b/i)
  expect(html).not.toMatch(/<script\b[^>]*src=/i)
})

test('收起左栏（T72/T57/T83）：笔记本并进切换器，正文三档宽度切换并在宽屏各停其位', async ({ page }) => {
  await openAppWith(page, withNotebooks([{ title: '正文', content: '# 正文\n\n收起面板之后这一行还得在。' }]))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()

  // 编辑区宽度用标题输入框量：它铺满编辑列（它的宽度不依赖正文内容）
  const width = async (): Promise<number> => {
    const box = await page.getByTestId('notebook-title-input').boundingBox()
    return box?.width ?? 0
  }

  // T72：笔记本不再是独立一列，而是文档树头部的一个切换器
  await expect(page.getByTestId('notebook-books-pane')).toHaveCount(0)
  await expect(page.getByTestId('notebook-switcher')).toBeVisible()
  await page.getByTestId('notebook-switcher').click()
  await expect(page.getByTestId('notebook-switcher-menu')).toBeVisible()
  await expect(page.getByTestId('notebook-add')).toBeVisible()
  await page.mouse.click(600, 400)
  await expect(page.getByTestId('notebook-switcher-menu')).toHaveCount(0)
  await expect(page.getByTestId('notebook-add')).toHaveCount(0)

  // 窄屏（900）下文档树占掉的两百多像素确实是正文的：收起后要能拿回来
  await page.setViewportSize({ width: 900, height: 800 })
  const start = await width()
  expect(start).toBeGreaterThan(0)
  expect(start).toBeLessThan(760)

  await page.getByTestId('notebook-tree-collapse').click()
  await expect(page.getByTestId('notebook-tree-rail')).toBeVisible()
  const afterCollapse = await width()
  expect(afterCollapse).toBeGreaterThan(start)
  // T57 的阅读上限：不再一路铺满整个窗口
  expect(afterCollapse).toBeLessThan(860)

  // 收起的是面板，不是内容：正文与标题都还在
  await expect(page.getByTestId('note-editor-content')).toContainText('收起面板之后这一行还得在')
  await expect(page.getByTestId('notebook-title-input')).toHaveValue('正文')

  // 竖轨自己就是展开入口；展开后宽度回到起点
  await page.getByTestId('notebook-tree-rail').click()
  await expect(page.getByTestId('notebook-tree')).toBeVisible()
  expect(await width()).toBeCloseTo(start, 0)

  // 宽屏（2560 / 27" 2K 档）下三档宽度的相对关系：
  // T83 默认「适中」放宽了上限；「窄」回到 T57 的阅读上限；「全宽」吃满整个外围。
  await page.setViewportSize({ width: 2560, height: 1440 })
  // uiScale 走 rAF 跟随 resize：等档位真正落到 1.3 再量，否则量到的还是上一档的换算
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.uiScale))
    .toBe('1.3')

  const medium = await width()
  expect(medium).toBeGreaterThan(1000)

  await page.getByTestId('notebook-width').click()
  await page.getByTestId('notebook-width-narrow').click()
  const narrow = await width()
  expect(narrow).toBeGreaterThan(900)
  expect(narrow).toBeLessThan(medium)

  await page.getByTestId('notebook-width').click()
  await page.getByTestId('notebook-width-full').click()
  const full = await width()
  expect(full).toBeGreaterThan(1500)
  expect(full).toBeGreaterThan(medium)

  // 切回默认适中，档位选择被记住：刷新后仍是适中
  // （fake fs 活在页面上，reload 会丢——先取快照再回放，与上面重开用例同口径）
  await page.getByTestId('notebook-width').click()
  await page.getByTestId('notebook-width-medium').click()
  expect(await width()).toBeCloseTo(medium, 0)
  const snapshot = await readFakeFs(page)
  await seedFakeFs(page, snapshot)
  await page.reload()
  await expect(page.getByText('连接数据文件夹')).toBeVisible()
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  expect(await width()).toBeCloseTo(medium, 0)
})

const TABLE_DOC = [
  '表格上面这段文字用来把表格从版心顶部推开，也用来确认「光标不在表格里」。',
  '',
  '| 项目 | 状态 |',
  '| --- | --- |',
  '| 支付 | 进行中 |',
  '',
  '后记：表格下面还有一段。',
  '',
].join('\n')

/**
 * T63 · 表格的行列增删。
 *
 * 这条用例回答的是「表格建成之后还能不能改」：`TableKit` 只提供了一个「建表」按钮，
 * 行列的增删命令虽然都在，却没有任何入口 —— 用户只能切到源码模式手写竖线。
 */
test('表格行列：光标进表格浮出工具条，加行加列后写进 vault.json', async ({ page }) => {
  await openAppWith(page, withNotebooks([{ title: '表格文档', content: TABLE_DOC }]))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  await page.getByText('表格文档').first().click()

  const table = page.locator('.oe-prose table').first()
  await expect(table).toBeVisible()
  // 光标在正文里时不该有工具条：它是悬浮件，常驻会挡字
  await page.getByTestId('note-editor-content').getByText('表格上面这段文字').click()
  await expect(page.getByTestId('note-table-bar')).toHaveCount(0)

  await table.locator('td').first().click()
  const bar = page.getByTestId('note-table-bar')
  await expect(bar).toBeVisible()
  // 工具条浮在表格**上方**，而不是压在表头那一行上
  const barBox = (await bar.boundingBox()) as { y: number; height: number } | null
  const tableBox = (await table.boundingBox()) as { y: number } | null
  expect(barBox).not.toBeNull()
  expect(tableBox).not.toBeNull()
  expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThanOrEqual((tableBox?.y ?? 0) + 1)

  // 加两行、加一列
  await page.getByTestId('table-tool-row-below').click()
  await page.getByTestId('table-tool-row-below').click()
  await page.getByTestId('table-tool-col-right').click()
  await expect(table.locator('tr')).toHaveCount(4)
  await expect(table.locator('tr').first().locator('th, td')).toHaveCount(3)

  // 表格结构必须真的存进去（笔记正文只存 Markdown，存不下就等于没改）
  await expect
    .poll(
      async () => {
        // 按标题找，不按正文片段找：Markdown 表格序列化会**补空格对齐列**，
        // `| 项目 |` 落盘后是 `| 项目 |` 还是 `| 项目   |` 取决于同列最宽的单元格。
        const doc = (parseVault(await readFakeFs(page)).noteDocs ?? []).find((item) => item.title === '表格文档')
        const content = doc?.content ?? ''
        const lines = content.split('\n').filter((line) => line.trim().startsWith('|'))
        const header = lines[0] ?? ''
        return { rows: lines.length, cols: header.split('|').length - 2 }
      },
      { timeout: 15_000 },
    )
    .toEqual({ rows: 5, cols: 3 })
})

test('表格合并：框选两格才可合并，页面上不再出现整页蒙层', async ({ page }) => {
  await openAppWith(page, withNotebooks([{ title: '合并文档', content: TABLE_DOC }]))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  await page.getByText('合并文档').first().click()

  const table = page.locator('.oe-prose table').first()
  await expect(table).toBeVisible()

  // 单选时合并/拆分都置灰：点了没反应比按钮不存在更让人困惑
  await table.locator('td').first().click()
  await expect(page.getByTestId('table-tool-merge')).toBeDisabled()

  const first = (await table.locator('td').nth(0).boundingBox()) as { x: number; y: number; width: number; height: number }
  const second = (await table.locator('td').nth(1).boundingBox()) as { x: number; y: number; width: number; height: number }
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 6 })
  await page.mouse.up()

  await expect(page.getByTestId('table-tool-merge')).toBeEnabled()

  // T63 顺手修掉的坑：单元格没有定位时，`.selectedCell::after` 会一路找到视口，
  // 选中两格就在整页盖一层紫。这里量的是「那层蒙层不再盖住整页」。
  const overlay = await page.evaluate(() => {
    const cell = document.querySelector('.oe-prose td.selectedCell') as HTMLElement | null
    const prose = document.querySelector('.oe-prose') as HTMLElement | null
    if (cell === null || prose === null) return null
    return {
      afterPosition: getComputedStyle(cell, '::after').position,
      // 修复的关键：单元格自己必须是包含块，蒙层才被关在格子里
      cellPosition: getComputedStyle(cell).position,
      cellWidth: Math.round(cell.getBoundingClientRect().width),
      proseWidth: Math.round(prose.getBoundingClientRect().width),
    }
  })
  expect(overlay?.afterPosition).toBe('absolute')
  expect(overlay?.cellPosition).toBe('relative')
  expect(overlay?.cellWidth ?? 0).toBeLessThan((overlay?.proseWidth ?? 0) * 0.75)

  await page.getByTestId('table-tool-merge').click()
  await expect(table.locator('td[colspan="2"]')).toHaveCount(1)
})

test('T73 · `/` 斜杠命令：菜单弹在光标处，Enter 落成真表格并写进 vault.json', async ({ page }) => {
  await openAppWith(page, withNotebooks([{ title: '周会纪要', content: '# 结论\n\n先做对账。' }]))
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  await page.getByText('周会纪要').first().click()

  const body = page.getByTestId('note-editor-content')
  await body.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/表')

  // 菜单是 portal 到 body 的，位置贴着光标（视口坐标）
  const menu = page.getByTestId('note-slash-menu')
  await expect(menu).toBeVisible()
  const geom = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="note-slash-menu"]') as HTMLElement | null
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    return {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      viewport: window.innerWidth,
      first: (document.querySelector('[data-testid^="note-slash-option-"]') as HTMLElement | null)?.dataset.testid,
    }
  })
  // 「表」同时命中「列表」与「表格」，排序后表格必须在第一行
  expect(geom?.first).toBe('note-slash-option-table')
  // 没有被右墙裁掉
  expect(geom?.right ?? 0).toBeLessThanOrEqual(geom?.viewport ?? 0)

  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.oe-prose table').first()).toBeVisible()
  // `/表` 这三个字符不该留在正文里
  await expect(page.locator('.oe-prose')).not.toContainText('/表')

  await waitSaved(page)
  await expect
    .poll(async () => docContents(await readFakeFs(page))[0] ?? '')
    .toContain('| --- |')
})
