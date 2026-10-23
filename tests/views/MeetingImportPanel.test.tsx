// @vitest-environment jsdom
//
// T62 · 会议导入面板：选文件 → 列出会议 → 勾选 → 交回调用方。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { MeetingImportPanel } from '../../src/views/MeetingImportPanel'
import type { IcsEvent } from '../../src/domain/ics'
import { createI18n } from '../../src/locales/i18n'

const i18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })
const t = i18n.t

// 面板 createPortal 到 body：不手动 cleanup 会跨用例残留，getByTestId 直接撞「多个元素」
afterEach(cleanup)

const CRLF = '\r\n'

function calendar(...events: string[][]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0']
  for (const event of events) lines.push('BEGIN:VEVENT', ...event, 'END:VEVENT')
  lines.push('END:VCALENDAR')
  return `${lines.join(CRLF)}${CRLF}`
}

const TWO_EVENTS = calendar(
  [
    'UID:a',
    'SUMMARY:支付对账文件解析方案评审',
    'DTSTART:20261023T060000Z',
    'DTEND:20261023T070000Z',
    'LOCATION:3 楼会议室',
    'ATTENDEE;CN=李四:mailto:lisi@example.com',
  ],
  ['UID:b', 'SUMMARY:周会', 'DTSTART:20261024T060000Z', 'DTEND:20261024T063000Z'],
)

function setup(overrides: Partial<Parameters<typeof MeetingImportPanel>[0]> = {}) {
  const onImport = vi.fn<(events: IcsEvent[]) => void>()
  const onOpenChange = vi.fn<(open: boolean) => void>()
  const view = render(
    <MeetingImportPanel
      open
      onOpenChange={onOpenChange}
      notebookName="会议纪要"
      t={t}
      importedKeys={new Set<string>()}
      onImport={onImport}
      {...overrides}
    />,
  )
  return { onImport, onOpenChange, view }
}

function choose(content: string, name = 'meeting.ics'): void {
  const file = new File([content], name, { type: 'text/calendar' })
  fireEvent.change(screen.getByTestId('meeting-import-file-input'), { target: { files: [file] } })
}

describe('T62 · 面板骨架', () => {
  it('open=false 时不渲染任何东西', () => {
    setup({ open: false })
    expect(screen.queryByTestId('meeting-import')).toBeNull()
  })

  it('打开即显示标题与「落在哪一本」的提示', () => {
    setup()
    expect(screen.getByTestId('meeting-import').textContent).toContain('导入会议')
    expect(screen.getByTestId('meeting-import').textContent).toContain('会议纪要')
  })

  it('点遮罩关闭；点在面板内部不关闭', () => {
    const { onOpenChange } = setup()
    fireEvent.mouseDown(screen.getByTestId('meeting-import'))
    fireEvent.click(screen.getByTestId('meeting-import'))
    expect(onOpenChange).not.toHaveBeenCalled()

    const backdrop = screen.getByTestId('meeting-import-backdrop')
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('T62 · 解析与勾选', () => {
  it('选中 .ics 后逐场列出主题与时间', async () => {
    setup()
    choose(TWO_EVENTS)
    await waitFor(() => expect(screen.getAllByTestId('meeting-import-row')).toHaveLength(2))
    const list = screen.getByTestId('meeting-import-list').textContent ?? ''
    expect(list).toContain('支付对账文件解析方案评审')
    expect(list).toContain('周会')
    expect(list).toContain('1 人')
  })

  it('默认全选，底部按钮跟着数量走', async () => {
    setup()
    choose(TWO_EVENTS)
    await waitFor(() => expect(screen.getByTestId('meeting-import-count').textContent).toContain('已选 2 / 2 场'))
    expect(screen.getByTestId('meeting-import-confirm').textContent).toContain('导入 2 篇')
  })

  it('全不选后确认按钮禁用，点不动也不回调', async () => {
    const { onImport } = setup()
    choose(TWO_EVENTS)
    await waitFor(() => expect(screen.getAllByTestId('meeting-import-row')).toHaveLength(2))
    fireEvent.click(screen.getByTestId('meeting-import-select-none'))
    const confirm = screen.getByTestId('meeting-import-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onImport).not.toHaveBeenCalled()
  })

  it('取消勾选一场后只导入另一场', async () => {
    const { onImport, onOpenChange } = setup()
    choose(TWO_EVENTS)
    await waitFor(() => expect(screen.getAllByTestId('meeting-import-row')).toHaveLength(2))
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    fireEvent.click(boxes[0] as HTMLInputElement)
    fireEvent.click(screen.getByTestId('meeting-import-confirm'))
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport.mock.calls[0]?.[0].map((event) => event.summary)).toEqual(['周会'])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('已导入过的会议默认不勾，并带「已导入」徽标', async () => {
    setup({ importedKeys: new Set(['ics:a@2026-10-23']) })
    choose(TWO_EVENTS)
    await waitFor(() => expect(screen.getAllByTestId('meeting-import-row')).toHaveLength(2))
    const rows = screen.getAllByTestId('meeting-import-row')
    expect(rows[0]?.dataset.imported).toBe('true')
    expect(rows[1]?.dataset.imported).toBe('false')
    expect(screen.getByTestId('meeting-import-badge').textContent).toBe('已导入')
    expect(screen.getByTestId('meeting-import-count').textContent).toContain('已选 1 / 2 场')
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes[0]?.disabled).toBe(true)
  })

  it('全部已导入时确认按钮是禁用的', async () => {
    setup({ importedKeys: new Set(['ics:a@2026-10-23', 'ics:b@2026-10-24']) })
    choose(TWO_EVENTS)
    await waitFor(() => expect(screen.getAllByTestId('meeting-import-row')).toHaveLength(2))
    expect((screen.getByTestId('meeting-import-confirm') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('T62 · 失败路径', () => {
  it('不是 iCalendar 文件时给出明确提示，且不列任何会议', async () => {
    setup()
    choose('{"hello":1}', 'vault.json')
    await waitFor(() => expect(screen.getByTestId('meeting-import-error').textContent).toContain('BEGIN:VCALENDAR'))
    expect(screen.queryByTestId('meeting-import-row')).toBeNull()
    expect((screen.getByTestId('meeting-import-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('文件里没有会议时提示「没有可以导入的会议」', async () => {
    setup()
    choose(calendar())
    await waitFor(() =>
      expect(screen.getByTestId('meeting-import-error').textContent).toContain('没有可以导入的会议'),
    )
  })

  it('取消的会议不进入列表', async () => {
    setup()
    choose(calendar(['UID:c', 'SUMMARY:已取消', 'DTSTART:20261023T060000Z', 'STATUS:CANCELLED']))
    await waitFor(() =>
      expect(screen.getByTestId('meeting-import-error').textContent).toContain('没有可以导入的会议'),
    )
  })
})
