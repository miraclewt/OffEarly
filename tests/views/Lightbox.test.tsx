// @vitest-environment jsdom
//
// T25 · Lightbox（spec 6.4「图片点击 → 灯箱预览（原图、缩放、下载）」）。
//
// 口径：缩放只改 transform，**不动 img 的 src**——「下载原图」必须拿到未缩放的原始字节；
// 下载走 `<a download>`（blob URL 直落盘，零网络请求）；Esc / 遮罩 / 关闭钮三条出路都要能关。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createI18n } from '../../src/locales/i18n'
import { Lightbox } from '../../src/views/Lightbox'

function t() {
  return createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t
}

function setup(props: Partial<Parameters<typeof Lightbox>[0]> = {}) {
  const onClose = vi.fn()
  const view = render(
    <Lightbox open src="blob:offearly/1" alt="截图" filename="shot.png" onClose={onClose} t={t()} {...props} />,
  )
  return { onClose, view }
}

afterEach(cleanup)

describe('T25-1 · Lightbox 渲染与三条关闭出路', () => {
  it('显示原图与文件名，下载链接指向未缩放的 blob', () => {
    setup()
    const image = screen.getByTestId('lightbox-image')
    expect(image.getAttribute('src')).toBe('blob:offearly/1')
    expect(image.getAttribute('alt')).toBe('截图')
    const download = screen.getByTestId('lightbox-download')
    expect(download.getAttribute('href')).toBe('blob:offearly/1')
    expect(download.getAttribute('download')).toBe('shot.png')
  })

  it('open=false 不渲染（受控显隐，不留残影）', () => {
    setup({ open: false })
    expect(screen.queryByTestId('lightbox')).toBeNull()
  })

  it('Esc / 遮罩 / 关闭钮都能关；点面板内部不关（误点不该丢预览）', () => {
    const { onClose } = setup()
    fireEvent.click(screen.getByTestId('lightbox-panel'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('lightbox'))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByTestId('lightbox-close'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

describe('T25-2 · 缩放（只改 transform，src 始终指向原图）', () => {
  it('放大 / 缩小 / 复位，档位显示同步', () => {
    setup()
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('100%')
    fireEvent.click(screen.getByTestId('lightbox-zoom-in'))
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('125%')
    fireEvent.click(screen.getByTestId('lightbox-zoom-out'))
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('100%')
    fireEvent.click(screen.getByTestId('lightbox-zoom-in'))
    fireEvent.click(screen.getByTestId('lightbox-reset'))
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('100%')
  })

  it('键盘 + / - / 0 同样生效', () => {
    setup()
    fireEvent.keyDown(window, { key: '+' })
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('125%')
    fireEvent.keyDown(window, { key: '-' })
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('100%')
    fireEvent.keyDown(window, { key: '+' })
    fireEvent.keyDown(window, { key: '0' })
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('100%')
  })

  it('缩放有上下界（25%–400%），且 src 始终不变——下载到的永远是原图', () => {
    setup()
    const src = screen.getByTestId('lightbox-image').getAttribute('src')
    for (let i = 0; i < 20; i += 1) fireEvent.click(screen.getByTestId('lightbox-zoom-in'))
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('400%')
    expect(screen.getByTestId('lightbox-image').getAttribute('src')).toBe(src)
    for (let i = 0; i < 30; i += 1) fireEvent.click(screen.getByTestId('lightbox-zoom-out'))
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('25%')
    expect(screen.getByTestId('lightbox-image').getAttribute('src')).toBe(src)
  })

  it('换图即回到 100%（上一张的倍率对下一张没意义）', () => {
    const { view } = setup()
    fireEvent.click(screen.getByTestId('lightbox-zoom-in'))
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('125%')
    view.rerender(
      <Lightbox open src="blob:offearly/2" filename="other.png" onClose={() => undefined} t={t()} />,
    )
    expect(screen.getByTestId('lightbox-scale').textContent).toBe('100%')
  })
})
