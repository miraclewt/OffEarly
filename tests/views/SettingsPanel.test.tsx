// @vitest-environment jsdom
//
// T35 · SettingsPanel：语言 / 主题 / 甘特刻度 / 工作日历 / 关于。
//
// 面板是纯视图 + 真 Store + 真 CommandBus：断言落在「设置改没改、发了几条命令、撤销栈深」上，
// 而不是落在实现细节上（与 FilterBar / MilestonePanel 的组件测试同一手法）。

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { Vault, WorkCalendar } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import { SettingsPanel } from '../../src/views/SettingsPanel'

const NOW = '2026-10-17T08:30:00.000Z'

function calendar(overrides: Partial<WorkCalendar> = {}): WorkCalendar {
  return { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [], ...overrides }
}

function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'vault-fixture',
    appVersion: 'OffEarly 0.1.0',
    revision: 3,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: calendar(),
      ganttScale: 'day',
      theme: 'light',
      locale: 'auto',
      lastFilter: null,
      noteFontSize: 13,
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    ...overrides,
  }
}

function setup(options: { vault?: Vault; open?: boolean } = {}) {
  const store = createVaultStore(options.vault ?? vault())
  const bus = createCommandBus(store)
  const i18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })
  const onOpenChange = vi.fn()
  const view = render(
    <SettingsPanel
      store={store}
      bus={bus}
      t={i18n.t}
      open={options.open ?? true}
      onOpenChange={onOpenChange}
    />,
  )
  return { store, bus, view, onOpenChange, t: i18n.t }
}

// jsdom 无 navigator.language 的 zh 保证：面板只断言中文文案，锁定语言环境
beforeEach(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(cleanup)

describe('SettingsPanel · 开合', () => {
  it('open=false 时什么都不渲染', () => {
    const { view } = setup({ open: false })
    expect(view.queryByTestId('settings-panel')).toBeNull()
  })

  it('五段齐全：语言 / 主题 / 甘特图 / 工作日历 / 关于', () => {
    setup()
    expect(screen.getByText('语言')).toBeDefined()
    expect(screen.getByText('主题')).toBeDefined()
    expect(screen.getByText('甘特图')).toBeDefined()
    expect(screen.getByText('工作日历')).toBeDefined()
    expect(screen.getByText('关于')).toBeDefined()
  })

  it('Esc 与关闭按钮都请求关闭（受控时只外送，不自己改状态）', () => {
    const { onOpenChange } = setup()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByTestId('settings-close'))
    expect(onOpenChange).toHaveBeenCalledTimes(2)
    // 受控面板仍然挂在树上（开合由接线方决定）
    expect(screen.getByTestId('settings-panel')).toBeDefined()
  })

  it('点背板请求关闭', () => {
    const { onOpenChange } = setup()
    fireEvent.click(screen.getByTestId('settings-backdrop'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('SettingsPanel · 语言', () => {
  it('当前语言高亮；点 English 写进 settings.locale 并可撤销', () => {
    const { store, bus } = setup()
    expect(screen.getByTestId('settings-locale-auto').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByTestId('settings-locale-en'))
    expect(store.getVault().settings.locale).toBe('en')
    expect(screen.getByTestId('settings-locale-en').getAttribute('aria-pressed')).toBe('true')
    expect(bus.undoDepth()).toBe(1)

    bus.undo()
    expect(store.getVault().settings.locale).toBe('auto')
  })

  it('点当前语言不发命令（撤销栈保持干净）', () => {
    const { bus } = setup()
    fireEvent.click(screen.getByTestId('settings-locale-auto'))
    expect(bus.undoDepth()).toBe(0)
  })
})

describe('SettingsPanel · 主题与甘特刻度', () => {
  it('主题只读展示浅色 + 说明', () => {
    setup()
    expect(screen.getByTestId('settings-theme-light').textContent).toBe('浅色')
    expect(screen.getByText('当前版本仅提供浅色主题')).toBeDefined()
  })

  it('切换默认刻度写进 settings.ganttScale', () => {
    const { store } = setup()
    expect(screen.getByTestId('settings-gantt-scale-day').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('settings-gantt-scale-week'))
    expect(store.getVault().settings.ganttScale).toBe('week')
  })
})

describe('SettingsPanel · 工作日历', () => {
  it('七个工作日开关按周一 → 周日排列，默认高亮周一至周五', () => {
    setup()
    const labels = [1, 2, 3, 4, 5, 6, 0].map(
      (day) => screen.getByTestId(`settings-workday-${day}`).textContent,
    )
    expect(labels).toEqual(['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
    for (const day of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`settings-workday-${day}`).getAttribute('aria-pressed')).toBe('true')
    }
    expect(screen.getByTestId('settings-workday-6').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('settings-workday-0').getAttribute('aria-pressed')).toBe('false')
  })

  it('取消周六工作 / 把周日设为工作日', () => {
    const { store } = setup()
    fireEvent.click(screen.getByTestId('settings-workday-6'))
    expect(store.getVault().settings.calendar.workdays).toEqual([1, 2, 3, 4, 5, 6])
    fireEvent.click(screen.getByTestId('settings-workday-0'))
    expect(store.getVault().settings.calendar.workdays).toEqual([0, 1, 2, 3, 4, 5, 6])
    fireEvent.click(screen.getByTestId('settings-workday-6'))
    expect(store.getVault().settings.calendar.workdays).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('只剩一个工作日时该开关置灰（空日历是自相矛盾的配置）', () => {
    setup({ vault: vault({ settings: { ...vault().settings, calendar: calendar({ workdays: [1] }) } }) })
    const only = screen.getByTestId('settings-workday-1') as HTMLButtonElement
    expect(only.disabled).toBe(true)
    fireEvent.click(only)
    expect(only.getAttribute('aria-pressed')).toBe('true')
  })

  it('加假期：写进 calendar.holidays，列表出现可移除的条目', () => {
    const { store } = setup()
    const input = screen.getByTestId('settings-holidays-input')
    fireEvent.change(input, { target: { value: '2026-10-01' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(store.getVault().settings.calendar.holidays).toEqual(['2026-10-01'])
    expect(screen.getByTestId('settings-holidays-item-2026-10-01')).toBeDefined()
    expect(screen.getByTestId('settings-holidays-count').textContent).toBe('1')

    fireEvent.click(screen.getByTestId('settings-holidays-remove-2026-10-01'))
    expect(store.getVault().settings.calendar.holidays).toEqual([])
    expect(screen.queryByTestId('settings-holidays-item-2026-10-01')).toBeNull()
  })

  it('点「添加」按钮与回车等价（不只认回车）', () => {
    const { store } = setup()
    fireEvent.change(screen.getByTestId('settings-holidays-input'), { target: { value: '2026-02-28' } })
    fireEvent.click(screen.getByTestId('settings-holidays-add'))
    expect(store.getVault().settings.calendar.holidays).toEqual(['2026-02-28'])
  })

  it('伪日期被拦下：报错、不写库、输入保留', () => {
    const { store, bus } = setup()
    const input = screen.getByTestId('settings-holidays-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2026-02-30' } })
    fireEvent.click(screen.getByTestId('settings-holidays-add'))

    expect(screen.getByTestId('settings-error').textContent).toContain('日期不合法')
    expect(store.getVault().settings.calendar.holidays).toEqual([])
    expect(bus.undoDepth()).toBe(0)
    expect(input.value).toBe('2026-02-30')
  })

  it('同一天不能既是假期又是补班：加到补班会自动从假期里摘掉', () => {
    const { store } = setup({ vault: vault({ settings: { ...vault().settings, calendar: calendar({ holidays: ['2026-10-10'] }) } }) })
    expect(screen.getByTestId('settings-holidays-item-2026-10-10')).toBeDefined()

    fireEvent.change(screen.getByTestId('settings-extra-input'), { target: { value: '2026-10-10' } })
    fireEvent.click(screen.getByTestId('settings-extra-add'))

    const cal = store.getVault().settings.calendar
    expect(cal.extraWorkdays).toEqual(['2026-10-10'])
    expect(cal.holidays).toEqual([])
    expect(screen.queryByTestId('settings-holidays-item-2026-10-10')).toBeNull()
    expect(screen.getByTestId('settings-extra-item-2026-10-10')).toBeDefined()
  })

  it('空列表给空态文案', () => {
    setup()
    const holidays = screen.getByTestId('settings-holidays')
    expect(within(holidays).getByText('暂无假期')).toBeDefined()
    expect(within(screen.getByTestId('settings-extra')).getByText('暂无补班')).toBeDefined()
  })
})

describe('SettingsPanel · 关于', () => {
  it('展示库标识 / 修订号 / 版本与三处计数', () => {
    setup()
    const about = screen.getByTestId('settings-about')
    expect(within(about).getByText('vault-fixture')).toBeDefined()
    expect(within(about).getByText('3')).toBeDefined()
    expect(within(about).getByText('OffEarly 0.1.0')).toBeDefined()
    expect(screen.getByTestId('settings-counts').textContent).toBe('0 个任务 · 0 个话题 · 0 个里程碑')
  })
})
