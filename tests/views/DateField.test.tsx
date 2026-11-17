// @vitest-environment jsdom
// T54 · DateField：统一的日期输入控件（F10）。
//
// 断言的重点是「显示与浏览器区域设置无关」——同一个值在 zh / en 界面下都是
// YYYY-MM-DD，以及「非法输入不写库」这条底线。日历浮层的尺寸/位置在 jsdom 里
// 量不出来，那部分留给 e2e。

import { useCallback, useState } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createI18n } from '../../src/locales/i18n'
import { DateField } from '../../src/views/DateField'

const i18n = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })
const t = (key: Parameters<typeof i18n.t>[0], params?: Parameters<typeof i18n.t>[1]) =>
  i18n.t(key, params)

afterEach(() => {
  cleanup()
})

interface HarnessProps {
  initial?: string
  today?: string
  disabled?: boolean
  onCommit?: (next: string) => void
}

/** 受控宿主：把提交值写回 props，行为与真实调用方一致（值一变输入框就归一化）。 */
function Harness(props: HarnessProps) {
  const [value, setValue] = useState(props.initial ?? '')
  const onCommit = useCallback(
    (next: string) => {
      props.onCommit?.(next)
      setValue(next)
    },
    [props.onCommit],
  )
  return (
    <DateField
      testId="field"
      ariaLabel="日期"
      t={t}
      value={value}
      today={props.today ?? '2026-10-15'}
      onCommit={onCommit}
      disabled={props.disabled}
    />
  )
}

function input(view: ReturnType<typeof render>): HTMLInputElement {
  return view.getByTestId('field') as HTMLInputElement
}

describe('显示格式', () => {
  it('恒为 YYYY-MM-DD，且不再是原生 date 控件', () => {
    const view = render(<Harness initial="2026-10-05" />)
    expect(input(view).getAttribute('type')).toBe('text')
    expect(input(view).value).toBe('2026-10-05')
  })

  it('空值显示占位符，而不是区域化的示例日期', () => {
    const view = render(<Harness />)
    expect(input(view).value).toBe('')
    expect(input(view).getAttribute('placeholder')).toBe('YYYY-MM-DD')
  })

  it('外部改值（撤销、切任务）同步进输入框', () => {
    function Controlled(props: { value: string }) {
      return <DateField testId="field" ariaLabel="日期" t={t} value={props.value} onCommit={() => {}} />
    }
    const view = render(<Controlled value="2026-10-05" />)
    view.rerender(<Controlled value="2026-11-09" />)
    expect(input(view).value).toBe('2026-11-09')
  })
})

describe('输入与提交', () => {
  it('连续 8 位数字自动分组并提交', () => {
    const onCommit = vi.fn()
    const view = render(<Harness onCommit={onCommit} />)

    fireEvent.change(input(view), { target: { value: '20261005' } })

    expect(input(view).value).toBe('2026-10-05')
    expect(onCommit).toHaveBeenCalledWith('2026-10-05')
  })

  it('不补零的写法在失焦时补齐：2026/1/5 → 2026-01-05', () => {
    const onCommit = vi.fn()
    const view = render(<Harness onCommit={onCommit} />)

    fireEvent.change(input(view), { target: { value: '2026/1/5' } })
    expect(input(view).value).toBe('2026-1-5')
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(input(view))
    expect(input(view).value).toBe('2026-01-05')
    expect(onCommit).toHaveBeenCalledWith('2026-01-05')
  })

  it('逐字敲 `2026-1-5` 时第二下连字符不会被吞掉', () => {
    const onCommit = vi.fn()
    const view = render(<Harness onCommit={onCommit} />)

    let typed = ''
    for (const char of '2026-1-5') {
      typed += char
      fireEvent.change(input(view), { target: { value: typed } })
    }

    expect(input(view).value).toBe('2026-1-5')
    fireEvent.blur(input(view))
    expect(input(view).value).toBe('2026-01-05')
    expect(onCommit).toHaveBeenCalledWith('2026-01-05')
  })

  it('逐字敲 `20260230` 不会在第七位被补零打乱节奏', () => {
    const view = render(<Harness />)

    let typed = ''
    for (const char of '20260230') {
      typed += char
      fireEvent.change(input(view), { target: { value: typed } })
    }

    // 第七位是 `2026-02-3`（合法日期），此刻若提交就会被补成 `2026-02-03`，第八位接不上
    expect(input(view).value).toBe('2026-02-30')
    expect(view.getByTestId('field-invalid')).toBeDefined()
  })

  it('伪日期保留原文、就地报错、不写库（不再被浏览器消毒成空串）', () => {
    const onCommit = vi.fn()
    const view = render(<Harness onCommit={onCommit} />)

    fireEvent.change(input(view), { target: { value: '20260230' } })

    expect(input(view).value).toBe('2026-02-30')
    expect(input(view).getAttribute('aria-invalid')).toBe('true')
    expect(view.getByTestId('field-invalid')).toBeDefined()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('半截文本不报错（用户还在打），失焦回退到上次提交的值', () => {
    const onCommit = vi.fn()
    const view = render(<Harness initial="2026-10-05" onCommit={onCommit} />)

    fireEvent.change(input(view), { target: { value: '2026-1' } })
    expect(view.queryByTestId('field-invalid')).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(input(view))
    expect(input(view).value).toBe('2026-10-05')
  })

  it('Enter 提交完整值，Enter 半截文本则回退', () => {
    const onCommit = vi.fn()
    const view = render(<Harness onCommit={onCommit} />)

    fireEvent.change(input(view), { target: { value: '2026-1' } })
    fireEvent.keyDown(input(view), { key: 'Enter' })
    expect(input(view).value).toBe('')

    fireEvent.change(input(view), { target: { value: '20261020' } })
    fireEvent.keyDown(input(view), { key: 'Enter' })
    expect(onCommit).toHaveBeenLastCalledWith('2026-10-20')
  })

  it('Esc 回退当前输入', () => {
    const view = render(<Harness initial="2026-10-05" />)
    fireEvent.change(input(view), { target: { value: '2026-11' } })
    fireEvent.keyDown(input(view), { key: 'Escape' })
    expect(input(view).value).toBe('2026-10-05')
  })

  it('清空是合法操作，提交空串', () => {
    const onCommit = vi.fn()
    const view = render(<Harness initial="2026-10-05" onCommit={onCommit} />)

    fireEvent.change(input(view), { target: { value: '' } })

    expect(onCommit).toHaveBeenCalledWith('')
    expect(input(view).value).toBe('')
  })
})

describe('日历浮层', () => {
  it('点按钮打开，月份取当前值的年月', () => {
    const view = render(<Harness initial="2026-10-05" />)
    fireEvent.click(view.getByTestId('field-calendar'))

    expect(view.getByTestId('field-popover')).toBeDefined()
    expect(view.getByTestId('field-month').textContent).toBe('2026-10')
    expect(input(view).getAttribute('aria-expanded')).toBe('true')
  })

  it('没有值时打开在当月（今天所在月）', () => {
    const view = render(<Harness today="2026-10-15" />)
    fireEvent.click(view.getByTestId('field-calendar'))
    expect(view.getByTestId('field-month').textContent).toBe('2026-10')
  })

  it('选一天即提交并关闭', () => {
    const onCommit = vi.fn()
    const view = render(<Harness initial="2026-10-05" onCommit={onCommit} />)
    fireEvent.click(view.getByTestId('field-calendar'))
    fireEvent.click(view.getByTestId('field-day-2026-10-20'))

    expect(onCommit).toHaveBeenCalledWith('2026-10-20')
    expect(input(view).value).toBe('2026-10-20')
    expect(view.queryByTestId('field-popover')).toBeNull()
  })

  it('上/下月按钮翻月，选日落到目标月', () => {
    const onCommit = vi.fn()
    const view = render(<Harness initial="2026-10-05" onCommit={onCommit} />)
    fireEvent.click(view.getByTestId('field-calendar'))

    fireEvent.click(view.getByTestId('field-next-month'))
    expect(view.getByTestId('field-month').textContent).toBe('2026-11')
    fireEvent.click(view.getByTestId('field-day-2026-11-03'))
    expect(onCommit).toHaveBeenCalledWith('2026-11-03')

    fireEvent.click(view.getByTestId('field-calendar'))
    fireEvent.click(view.getByTestId('field-prev-month'))
    fireEvent.click(view.getByTestId('field-prev-month'))
    expect(view.getByTestId('field-month').textContent).toBe('2026-09')
  })

  it('「今天」与「清空」两个快捷键各自提交', () => {
    const onCommit = vi.fn()
    const view = render(<Harness initial="2026-10-05" today="2026-10-15" onCommit={onCommit} />)

    fireEvent.click(view.getByTestId('field-calendar'))
    fireEvent.click(view.getByTestId('field-today'))
    expect(onCommit).toHaveBeenLastCalledWith('2026-10-15')

    fireEvent.click(view.getByTestId('field-calendar'))
    fireEvent.click(view.getByTestId('field-clear'))
    expect(onCommit).toHaveBeenLastCalledWith('')
  })

  it('Esc 关闭浮层并把焦点交回输入框', () => {
    const view = render(<Harness initial="2026-10-05" />)
    fireEvent.click(view.getByTestId('field-calendar'))
    fireEvent.keyDown(view.getByTestId('field-popover'), { key: 'Escape' })

    expect(view.queryByTestId('field-popover')).toBeNull()
    expect(document.activeElement).toBe(input(view))
  })

  it('点击浮层外面关闭', () => {
    const view = render(<Harness initial="2026-10-05" />)
    fireEvent.click(view.getByTestId('field-calendar'))
    expect(view.getByTestId('field-popover')).toBeDefined()

    fireEvent.mouseDown(document.body)
    expect(view.queryByTestId('field-popover')).toBeNull()
  })

  it('方向键在网格内按天移动焦点，跨月时先翻月再落点', () => {
    const view = render(<Harness initial="2026-10-05" />)
    fireEvent.click(view.getByTestId('field-calendar'))

    const start = view.getByTestId('field-day-2026-10-05')
    start.focus()
    fireEvent.keyDown(view.getByTestId('field-popover'), { key: 'ArrowRight' })
    expect((document.activeElement as HTMLElement).dataset.date).toBe('2026-10-06')

    fireEvent.keyDown(view.getByTestId('field-popover'), { key: 'ArrowDown' })
    expect((document.activeElement as HTMLElement).dataset.date).toBe('2026-10-13')

    // 10-31 → 右移跨到 11-01：网格要先换成 11 月
    view.getByTestId('field-day-2026-10-31').focus()
    fireEvent.keyDown(view.getByTestId('field-popover'), { key: 'ArrowRight' })
    expect(view.getByTestId('field-month').textContent).toBe('2026-11')
    expect((document.activeElement as HTMLElement).dataset.date).toBe('2026-11-01')
  })
})

describe('禁用态', () => {
  it('禁用时输入框与日历按钮都不可用', () => {
    const view = render(<Harness initial="2026-10-05" disabled />)
    expect(input(view).disabled).toBe(true)
    expect((view.getByTestId('field-calendar') as HTMLButtonElement).disabled).toBe(true)
  })
})
