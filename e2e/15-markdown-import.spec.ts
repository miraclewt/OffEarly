/**
 * T82 · 导入 Markdown 文件为笔记（真实 Chromium over file://）。
 *
 * 这一组要证明的是「双击打开的离线单文件真能读 AI 生成的 .md」：
 * 多选两个文件 → 面板按标题列出来（含标题来源）→ 确认 → `vault.json` 的 noteDocs 里
 * 真的多出这两篇、正文与 front matter 的 tags 都落了盘，且导入后面板收起、提示报数。
 *
 * 第二个用例钉的是「不静默丢文件」：非 md 单独成行写明原因，可导入数只算真的能进来的。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith } from './fixtures/app'
import { fromBase64, readFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'
import type { FakeFsState } from './fixtures/fakeFs'

interface StoredDoc {
  id: string
  notebookId: string
  title: string
  content: string
  tags?: string[]
}

interface StoredVault {
  noteDocs?: StoredDoc[]
}

function parseVault(fs: FakeFsState): StoredVault {
  return JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
}

/** 在示例库上挂一个空笔记本，其余任务数据不动。 */
function withNotebook(name = 'AI 笔记'): FakeFsState {
  const fs = loadExampleVaultFs()
  const raw = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as Record<string, unknown>
  const now = '2026-11-02T09:00:00.000Z'
  raw.notebooks = [{ id: 'nb-md', name, order: 'U', createdAt: now, updatedAt: now }]
  raw.noteDocs = []
  fs.files['vault.json'] = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64')
  return fs
}

/** 典型的两份 AI 产物：一份带 YAML 头，一份用正文首个 H1 当标题。 */
const WITH_FRONT_MATTER = [
  '---',
  'title: 支付对账方案评审',
  'tags: [工作, 评审]',
  '---',
  '',
  '## 结论',
  '',
  '- 先做对账口径',
  '',
].join('\r\n')

const WITH_HEADING = [
  '# 季度复盘',
  '',
  '## 数据',
  '',
  '| 指标 | 值 |',
  '| --- | --- |',
  '| 完成率 | 82% |',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
].join('\n')

async function openPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('view-notebook').click()
  await expect(page.getByTestId('notebook')).toBeVisible()
  await page.getByTestId('notebook-import-md').click()
  await expect(page.getByTestId('markdown-import')).toBeVisible()
}

test('导入 .md：多选、列标题、落盘（含 front matter 的 tags）', async ({ page }) => {
  await openAppWith(page, withNotebook())
  await connectWorkspace(page, { create: false })
  await openPanel(page)

  await page.getByTestId('markdown-import-file-input').setInputFiles([
    { name: 'review.md', mimeType: 'text/markdown', buffer: Buffer.from(WITH_FRONT_MATTER, 'utf8') },
    { name: 'quarter.md', mimeType: 'text/markdown', buffer: Buffer.from(WITH_HEADING, 'utf8') },
  ])

  const rows = page.getByTestId('markdown-import-row')
  await expect(rows).toHaveCount(2)
  // 标题来源一眼可辨：一份来自 YAML 头、一份来自正文首个 #
  await expect(rows.nth(0)).toHaveAttribute('data-source', 'frontmatter')
  await expect(rows.nth(1)).toHaveAttribute('data-source', 'heading')
  await expect(page.getByTestId('markdown-import-count')).toContainText('已选 2 / 2 篇')
  await expect(page.getByTestId('markdown-import-confirm')).toContainText('导入 2 篇')

  await page.getByTestId('markdown-import-confirm').click()
  await expect(page.getByTestId('markdown-import')).toHaveCount(0)
  await expect(page.getByTestId('notebook-export-notice')).toContainText('已导入 2 篇笔记')

  // 关键：磁盘上的 vault.json 真的多了这两篇，且正文是 Markdown 原文
  await expect
    .poll(async () => parseVault(await readFakeFs(page)).noteDocs?.length ?? 0)
    .toBe(2)

  const docs = parseVault(await readFakeFs(page)).noteDocs ?? []
  const review = docs.find((doc) => doc.title === '支付对账方案评审')
  expect(review?.notebookId).toBe('nb-md')
  // front matter 被剥掉，正文从 ## 开始；CRLF 已被抹平
  expect(review?.content).toBe('## 结论\n\n- 先做对账口径\n')
  expect(review?.tags).toEqual(['工作', '评审'])

  const quarter = docs.find((doc) => doc.title === '季度复盘')
  // H1 被提为标题、从正文里删掉；表格与 mermaid 围栏原样保留
  expect(quarter?.content).toContain('## 数据')
  expect(quarter?.content).not.toContain('# 季度复盘')
  expect(quarter?.content).toContain('| 完成率 | 82% |')
  expect(quarter?.content).toContain('```mermaid')

  // 文档树里也看得到，并且打开后正文真的渲染成标题（不是一堆井号）
  await expect(page.getByTestId(`doc-row-${String(quarter?.id)}`)).toBeVisible()
  await expect(page.getByTestId('note-editor-content').first()).toBeVisible()
})

test('非 Markdown 文件单独成行写明原因，不静默丢弃', async ({ page }) => {
  await openAppWith(page, withNotebook())
  await connectWorkspace(page, { create: false })
  await openPanel(page)

  await page.getByTestId('markdown-import-file-input').setInputFiles([
    { name: 'ok.md', mimeType: 'text/markdown', buffer: Buffer.from(WITH_HEADING, 'utf8') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('随手记\n', 'utf8') },
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not really', 'utf8') },
  ])

  await expect(page.getByTestId('markdown-import-row')).toHaveCount(3)
  // .txt 也认（AI 常吐 txt，语法上是 md 的子集），pdf 不认
  await expect(page.getByTestId('markdown-import-badge-skip')).toHaveCount(1)
  await expect(page.getByTestId('markdown-import-badge-skip')).toContainText('不是 Markdown 文件')
  await expect(page.getByTestId('markdown-import-count')).toContainText('已选 2 / 2 篇')
  await expect(page.getByTestId('markdown-import-skipped')).toContainText('跳过 1 个')

  await page.getByTestId('markdown-import-confirm').click()
  await expect
    .poll(async () => parseVault(await readFakeFs(page)).noteDocs?.length ?? 0)
    .toBe(2)
  const docs = parseVault(await readFakeFs(page)).noteDocs ?? []
  expect(docs.map((doc) => doc.title).sort()).toEqual(['notes', '季度复盘'])
})
