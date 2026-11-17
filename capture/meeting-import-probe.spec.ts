// 临时核对脚本（T62）：把会议导入面板在真 Chromium 里拍下来，看排版有没有塌。
// 跑法：npx playwright test --config playwright.capture.config.ts capture/meeting-import-probe.spec.ts

import { test } from '@playwright/test'

import { connectWorkspace, openAppWith } from '../e2e/fixtures/app'
import { loadExampleVaultFs } from '../e2e/fixtures/exampleVault'
import { fromBase64, type FakeFsState } from '../e2e/fixtures/fakeFs'

const OUT = 'C:/Users/18304/AppData/Local/Temp/t62'

function withNotebooks(): FakeFsState {
  const fs = loadExampleVaultFs()
  const raw = JSON.parse(fromBase64(fs.files['vault.json'] as string)) as Record<string, unknown>
  const now = '2026-10-23T09:00:00.000Z'
  raw.notebooks = [{ id: 'nb-ics', name: '会议纪要', order: 'U', createdAt: now, updatedAt: now }]
  raw.noteDocs = []
  fs.files['vault.json'] = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64')
  return fs
}

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:Microsoft Exchange Server 2016',
  'BEGIN:VEVENT',
  'UID:t62-a',
  'SUMMARY:支付对账文件解析方案评审',
  'DTSTART;TZID=China Standard Time:20261023T140000',
  'DTEND;TZID=China Standard Time:20261023T150000',
  'LOCATION:3 楼会议室 / Teams',
  'ORGANIZER;CN=张三:mailto:zhangsan@example.com',
  'ATTENDEE;CN=李四;PARTSTAT=ACCEPTED:mailto:lisi@example.com',
  'ATTENDEE;CN=王五:mailto:wangwu@example.com',
  'ATTENDEE;CN=Doe, John:mailto:john@example.com',
  'DESCRIPTION:议程：\\n1. 对账口径\\n2. 文件格式与字段映射\\n3. 下周排期',
  'URL:https://teams.microsoft.com/l/meetup-join/abc',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:t62-b',
  'SUMMARY:每周例会',
  'DTSTART;TZID=China Standard Time:20261024T100000',
  'DTEND;TZID=China Standard Time:20261024T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:t62-c',
  'SUMMARY:一个特别特别长的会议主题用来检验这一行会不会把右边的徽标挤出去或者换行',
  'DTSTART;VALUE=DATE:20261026',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

test('拍到导入面板的三种状态', async ({ page }) => {
  await openAppWith(page, withNotebooks())
  await connectWorkspace(page, { create: false })
  await page.getByTestId('view-notebook').click()
  await page.getByTestId('notebook-import-ics').click()
  await page.getByTestId('meeting-import').waitFor()
  await page.screenshot({ path: `${OUT}/01-empty.png` })

  await page.getByTestId('meeting-import-file-input').setInputFiles({
    name: 'meeting.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(ICS, 'utf8'),
  })
  await page.getByTestId('meeting-import-row').first().waitFor()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.screenshot({ path: `${OUT}/02-list.png` })

  // 面板几何：宽高、列表是否溢出、确认按钮位置
  const box = await page.getByTestId('meeting-import').boundingBox()
  const rects = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="meeting-import"]') as HTMLElement
    const list = document.querySelector('[data-testid="meeting-import-list"]') as HTMLElement
    const confirm = document.querySelector('[data-testid="meeting-import-confirm"]') as HTMLElement
    return {
      panel: { w: panel.offsetWidth, h: panel.offsetHeight, scroll: panel.scrollHeight },
      list: list === null ? null : { h: list.clientHeight, scroll: list.scrollHeight },
      confirm: confirm.getBoundingClientRect().bottom,
      viewportH: window.innerHeight,
      uiScale: getComputedStyle(document.documentElement).getPropertyValue('--oe-ui-scale'),
    }
  })
  console.log('GEOMETRY', JSON.stringify({ box, ...rects }, null, 2))

  await page.getByTestId('meeting-import-confirm').click()
  await page.getByTestId('notebook-export-notice').waitFor()
  await page.screenshot({ path: `${OUT}/03-after-import.png` })

  // 生成的第一篇笔记正文
  await page.getByTestId('note-editor-content').waitFor()
  await page.screenshot({ path: `${OUT}/04-note.png` })

  // 二次导入：已导入徽标
  await page.getByTestId('notebook-import-ics').click()
  await page.getByTestId('meeting-import-file-input').setInputFiles({
    name: 'meeting.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(ICS, 'utf8'),
  })
  await page.getByTestId('meeting-import-row').first().waitFor()
  await page.screenshot({ path: `${OUT}/05-imported.png` })
})
