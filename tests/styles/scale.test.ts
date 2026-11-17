// @vitest-environment jsdom
/**
 * T40 · 界面尺度（styles/scale.ts）
 *
 * 钉两件事：
 *   ① 分档表本身 —— 分辨率和档位的对应关系是产品口径，写死在这里防止被随手改掉；
 *   ② 与 DOM 的接缝 —— `--oe-ui-scale` 必须真的落到 <html> 上，否则 fs()/sp() 的
 *      calc 会一路用兜底值 1，整套改造静默失效（这种失败在截图上才看得出来）。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { fs, installUiScale, px, readScaleOverride, resolveUiScale, sp } from '../../src/styles/scale'

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
}

afterEach(() => {
  setWidth(1024)
  window.history.replaceState({}, '', '/')
  window.document.documentElement.removeAttribute('data-ui-scale')
  window.document.documentElement.style.removeProperty('--oe-ui-scale')
})

describe('resolveUiScale 分档', () => {
  it('4K 全屏（3840）取 1.65', () => {
    expect(resolveUiScale(3840)).toBe(1.65)
    expect(resolveUiScale(3400)).toBe(1.65)
  })

  it('5K（5120）取最大档 2.2', () => {
    expect(resolveUiScale(5120)).toBe(2.2)
    expect(resolveUiScale(4800)).toBe(2.2)
  })

  it('2K（2560）取 1.3，紧邻 3400 边界仍落在这一档', () => {
    expect(resolveUiScale(2560)).toBe(1.3)
    expect(resolveUiScale(3399)).toBe(1.3)
  })

  it('1080p（1920）取 1.05，微弱放大', () => {
    expect(resolveUiScale(1920)).toBe(1.05)
  })

  it('常见笔记本视口（1440）取 1，不缩不放', () => {
    expect(resolveUiScale(1440)).toBe(1)
    expect(resolveUiScale(1799)).toBe(1)
  })

  it('窄视口（1280 及以下）取 0.95，有下限不再继续缩小', () => {
    expect(resolveUiScale(1280)).toBe(0.95)
    expect(resolveUiScale(640)).toBe(0.95)
  })

  it('边界两侧严格按"宽者优先"取档', () => {
    expect(resolveUiScale(2500)).toBe(1.3)
    expect(resolveUiScale(2499)).toBe(1.15)
    expect(resolveUiScale(2100)).toBe(1.15)
    expect(resolveUiScale(1800)).toBe(1.05)
    expect(resolveUiScale(1350)).toBe(1)
    expect(resolveUiScale(1349)).toBe(0.95)
  })

  it('全区间单调不减：视口越宽档位不会反而更小', () => {
    let prev = 0
    for (let w = 320; w <= 6000; w += 7) {
      const s = resolveUiScale(w)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })

  it('极端宽的屏上正文仍不小于 1080p 的物理观感（回归：1.5 档曾偏小）', () => {
    // 27" 屏宽约 597mm，24" 约 531mm —— 用"11px 正文的物理高度"做跨屏比较。
    const heightOf = (width: number, screenMm: number) => (11 * resolveUiScale(width) * screenMm) / width
    const baseline = heightOf(1920, 531)
    expect(heightOf(2560, 597)).toBeGreaterThan(baseline * 0.9)
    expect(heightOf(3840, 597)).toBeGreaterThan(baseline * 0.85)
  })
})

describe('fs / sp 换算', () => {
  it('保留原始设计值，只乘一个旋钮', () => {
    expect(fs(11)).toBe('calc(11px * var(--oe-ui-scale, 1))')
    expect(fs(13)).toBe('calc(13px * var(--oe-ui-scale, 1))')
    expect(sp(8)).toBe('calc(8px * var(--oe-ui-scale, 1))')
  })

  it('字号与间距同源，保证"字大了空也大"', () => {
    expect(fs(12)).toBe(sp(12))
  })

  it('px() 换算简写里的每个长度', () => {
    expect(px('0 12px')).toBe('0 calc(12px * var(--oe-ui-scale, 1))')
    expect(px('12px 10px')).toBe(
      'calc(12px * var(--oe-ui-scale, 1)) calc(10px * var(--oe-ui-scale, 1))',
    )
  })

  it('px() 不碰边框宽度与 blur 半径', () => {
    expect(px('1px solid var(--oe-separator)')).toBe('1px solid var(--oe-separator)')
    expect(px('blur(20px) saturate(180%)')).toBe('blur(20px) saturate(180%)')
  })
})

describe('installUiScale 与 DOM 的接缝', () => {
  it('启动即把当前档写到 :root，不等第一次 resize', () => {
    setWidth(3840)
    const handle = installUiScale(window)

    expect(handle.current()).toBe(1.65)
    expect(window.document.documentElement.style.getPropertyValue('--oe-ui-scale')).toBe('1.65')
    expect(window.document.documentElement.dataset['uiScale']).toBe('1.65')

    handle.dispose()
  })

  it('窗口变宽后跟随换档', async () => {
    setWidth(1440)
    const handle = installUiScale(window)
    expect(handle.current()).toBe(1)

    setWidth(2560)
    window.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(handle.current()).toBe(1.3)
    expect(window.document.documentElement.style.getPropertyValue('--oe-ui-scale')).toBe('1.3')

    handle.dispose()
  })

  it('dispose 之后不再跟着窗口变', async () => {
    setWidth(1440)
    const handle = installUiScale(window)
    handle.dispose()

    setWidth(3840)
    window.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(handle.current()).toBe(1)
    expect(window.document.documentElement.style.getPropertyValue('--oe-ui-scale')).toBe('1')
  })
})

describe('URL 覆盖 ?uiScale=（本机试档用，不落盘）', () => {
  it('读得到合法值', () => {
    window.history.replaceState({}, '', '/?uiScale=1.55')
    expect(readScaleOverride(window)).toBe(1.55)
  })

  it('缺失、非数字、越界一律忽略（回退自动分档）', () => {
    window.history.replaceState({}, '', '/')
    expect(readScaleOverride(window)).toBeNull()

    window.history.replaceState({}, '', '/?uiScale=abc')
    expect(readScaleOverride(window)).toBeNull()

    window.history.replaceState({}, '', '/?uiScale=3')
    expect(readScaleOverride(window)).toBeNull()

    window.history.replaceState({}, '', '/?uiScale=0.5')
    expect(readScaleOverride(window)).toBeNull()
  })

  it('覆盖生效时以 URL 为准，且不被窗口变化改写', async () => {
    window.history.replaceState({}, '', '/?uiScale=1.7')
    setWidth(1440)
    const handle = installUiScale(window)

    expect(handle.current()).toBe(1.7)

    setWidth(3840)
    window.dispatchEvent(new Event('resize'))
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(handle.current()).toBe(1.7)
    expect(window.document.documentElement.style.getPropertyValue('--oe-ui-scale')).toBe('1.7')

    handle.dispose()
  })
})
