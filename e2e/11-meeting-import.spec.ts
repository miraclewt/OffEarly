/**
 * T62 · 从 .ics 导入会议（真实 Chromium over file://）。
 *
 * 这一组要证明的是「双击打开的离线单文件真能读一个 Outlook 导出的会议」：
 * 选文件 → 面板列出会议 → 确认 → `vault.json` 的 noteDocs 里真的多出这几篇，
 * 且同一份文件再导一次不会重复建篇。
 */
import { expect, test } from '@playwright/test'

import { connectWorkspace, openAppWith } from './fixtures/app'
import { fromBase64, readFakeFs } from './fixtures/fakeFs'
import { loadExampleVaultFs } from './fixtures/exampleVault'
import type { FakeFsState } from './fixtures/fakeFs'

interface StoredVault {
  noteDocs?: { id: string; notebookId: string; title: string; content: string }[]
}

function parseVault(fs: FakeFsState): StoredVault {
  return JSON.parse(fromBase64(fs.files['vault.json'] as string)) as StoredVault
}

/** 在示例库上挂一个空笔记本，其余任务数据不动。 */
function withNotebooks(name = '会议纪要'): FakeFsState {
  const fs = loadExampleVaultFs()
  const raw = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as Record<string, unknown>
  const now = '2026-10-23T09:00:00.000Z'
  raw.notebooks = [{ id: 'nb-ics', name, order: 'U', createdAt: now, updatedAt: now }]
  raw.noteDocs = []
  fs.files['vault.json'] = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64')
  return fs
}

/** 一份 Outlook 风格的导出：两场会议，一场带参与人/地点/链接，一场是重复会议。 */
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'METHOD:PUBLISH',
  'PRODID:Microsoft Exchange Server 2016',
  'BEGIN:VTIMEZONE',
  'TZID:China Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T000000',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:040000008200E00074C5B7101A82E00800000000T62A',
  'SUMMARY:支付对账文件解析方案评审',
  'DTSTART;TZID=China Standard Time:20261023T140000',
  'DTEND;TZID=China Standard Time:20261023T150000',
  'LOCATION:3 楼会议室',
  'ORGANIZER;CN=张三:mailto:zhangsan@example.com',
  'ATTENDEE;CN=李四;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:lisi@example.com',
  'ATTENDEE;CN=王五;ROLE=OPT-PARTICIPANT:mailto:wangwu@example.com',
  'DESCRIPTION:议程：\\n1. 对账口径\\n2. 文件格式',
  'URL:https://teams.microsoft.com/l/meetup-join/abc',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:040000008200E00074C5B7101A82E00800000000T62B',
  'SUMMARY:每周例会',
  'DTSTART;TZID=China Standard Time:20261026T100000',
  'DTEND;TZID=China Standard Time:20261026T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

async function openImportPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('view-notebook').click()
  await expect(page.getByTestId('notebook')).toBeVisible()
  await page.getByTestId('notebook-import-ics').click()
  await expect(page.getByTestId('meeting-import')).toBeVisible()
}

async function chooseIcs(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('meeting-import-file-input').setInputFiles({
    name: 'meeting.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(ICS, 'utf8'),
  })
  await expect(page.getByTestId('meeting-import-row')).toHaveCount(2)
}

test('导入 .ics：会议落成笔记并写进磁盘', async ({ page }) => {
  await openAppWith(page, withNotebooks())
  await connectWorkspace(page, { create: false })
  await openImportPanel(page)
  await chooseIcs(page)

  // 列表里读得懂中文主题与时间
  const list = page.getByTestId('meeting-import-list')
  await expect(list).toContainText('支付对账文件解析方案评审')
  await expect(list).toContainText('每周例会')

  await page.getByTestId('meeting-import-confirm').click()
  await expect(page.getByTestId('meeting-import')).toHaveCount(0)
  await expect(page.getByTestId('notebook-export-notice')).toContainText('已导入 2 篇')

  // 关键：磁盘上的 vault.json 真的多了这两篇
  await expect
    .poll(async () => parseVault(await readFakeFs(page)).noteDocs?.length ?? 0)
    .toBe(2)

  const docs = parseVault(await readFakeFs(page)).noteDocs ?? []
  const meeting = docs.find((doc) => doc.title === '支付对账文件解析方案评审')
  expect(meeting?.notebookId).toBe('nb-ics')
  expect(meeting?.content).toContain('## 会议信息')
  expect(meeting?.content).toContain('3 楼会议室')
  expect(meeting?.content).toContain('@李四')
  expect(meeting?.content).toContain('@王五')
  expect(meeting?.content).toContain('teams.microsoft.com')
  // 邀请正文以引用块落地，议程不会被当成正文标题
  expect(meeting?.content).toContain('> 1. 对账口径')
  // 重复会议只导当前这一场，并在正文里说明
  expect(docs.find((doc) => doc.title === '每周例会')?.content).toContain('重复')

  // 笔记列表里也看得到
  await expect(page.getByTestId('doc-row-' + String(meeting?.id))).toBeVisible()
})

test('同一份文件再导一次：一篇也不多建', async ({ page }) => {
  await openAppWith(page, withNotebooks())
  await connectWorkspace(page, { create: false })
  await openImportPanel(page)
  await chooseIcs(page)
  await page.getByTestId('meeting-import-confirm').click()
  await expect
    .poll(async () => parseVault(await readFakeFs(page)).noteDocs?.length ?? 0)
    .toBe(2)

  await page.getByTestId('notebook-import-ics').click()
  await chooseIcs(page)
  // 两场都标成已导入，确认按钮置灰
  await expect(page.getByTestId('meeting-import-badge')).toHaveCount(2)
  await expect(page.getByTestId('meeting-import-confirm')).toBeDisabled()
  await page.getByTestId('meeting-import-cancel').click()

  await expect.poll(async () => parseVault(await readFakeFs(page)).noteDocs?.length ?? 0).toBe(2)
})
