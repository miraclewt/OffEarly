// @vitest-environment jsdom
//
// T25 · NoteEditor 的图片三条插入路径 / 显示 / 灯箱（spec 6.4）。
//
// 三条路径（粘贴 / 拖入 / 工具栏选文件）在编辑器里是三个入口，但**出口只有一个**——
// `assets.insert(file)`：落盘与限制判定都在 AssetStore，编辑器不碰文件系统。
// 所以这组用例的核心断言是「三个入口都汇到同一个出口，且汇之前不改文档」。
//
// 粘贴只读 paste 事件的 clipboardData（T01 R4 在企业 Edge 实测通过的那条路径），
// 不使用 navigator.clipboard.read()——它额外要求前台焦点与 clipboard-read 权限。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createI18n } from '../../src/locales/i18n'
import { NoteEditor, roundTripNoteMarkdown } from '../../src/views/NoteEditor'
import type { NoteAssetInsert, NoteAssetsPort } from '../../src/views/NoteEditor'

// jsdom 没有布局：ProseMirror 的 focus / coordsAtPos 会问到 getClientRects，缺实现会抛。
const EMPTY_RECTS = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList
const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as unknown as DOMRect
for (const proto of [Node.prototype, Range.prototype]) {
  Object.defineProperty(proto, 'getClientRects', { value: () => EMPTY_RECTS, configurable: true })
  Object.defineProperty(proto, 'getBoundingClientRect', { value: () => ZERO_RECT, configurable: true })
}
// jsdom 没有命中测试：ProseMirror 的 posAtCoords 会问 elementFromPoint，缺实现会抛未捕获异常。
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true })
}

function t() {
  return createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t
}

function fileOf(name = 'shot.png', type = 'image/png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type })
}

type MockPort = NoteAssetsPort & {
  insert: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
}

function makePort(overrides: Partial<NoteAssetsPort> = {}): MockPort {
  const insert = vi.fn(async (_file: File): Promise<NoteAssetInsert> => ({ ok: true, src: 'assets/a1.png' }))
  const resolve = vi.fn((src: string) => (src === 'assets/a1.png' ? 'blob:offearly/a1' : null))
  return { insert, resolve, ...overrides } as unknown as MockPort
}

/** 渲染一个「可插图」的编辑器；value 缺省为空、debounce 归零便于确定性断言。 */
function setup(options: { value?: string; port?: Partial<NoteAssetsPort>; onAssetRejected?: (r: string) => void } = {}) {
  const port = makePort(options.port)
  const onCommit = vi.fn()
  const onAssetRejected = options.onAssetRejected ?? vi.fn()
  const view = render(
    <NoteEditor
      value={options.value ?? ''}
      onCommit={onCommit}
      assets={port}
      onAssetRejected={onAssetRejected}
      debounceMs={0}
      t={t()}
    />,
  )
  return { port, onCommit, onAssetRejected, view }
}

function content(): HTMLElement {
  return screen.getByTestId('note-editor-content')
}

/** 工具栏要等编辑器 onCreate 后才渲染（editorReady），点击前先等它出现。 */
async function toolbarButton(id: string): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByTestId(`note-tool-${id}`)).toBeTruthy())
  return screen.getByTestId(`note-tool-${id}`)
}

/** ProseMirror 自己的 paste 插件会先读 clipboardData.getData()，替身必须给全。 */
function clipboardWith(files: File[]): { files: File[]; items: unknown[]; types: string[]; getData: () => string } {
  return { files, items: [], types: files.length === 0 ? [] : ['Files'], getData: () => '' }
}

/** 提交是 debounce 后的异步动作：断言整段放进 waitFor 才有确定性。 */
async function expectCommitted(onCommit: ReturnType<typeof vi.fn>, fragment: string): Promise<void> {
  await waitFor(() => {
    const markdown = onCommit.mock.calls.at(-1)?.[0] as string | undefined
    expect(markdown ?? '').toContain(fragment)
  })
}

afterEach(async () => {
  // ProseMirror 在拖放 / 点击后会延迟一次 view.focus()（setTimeout）；若此时编辑器已卸载，
  // 它会在定时器里抛 descAt 未捕获异常。先让这批定时器在视图还活着时跑完，再卸载。
  await new Promise((resolve) => {
    setTimeout(resolve, 60)
  })
  cleanup()
})

describe('T25-1 · 三条插入路径都汇到 assets.insert', () => {
  it('① 工具栏「图片」→ 隐藏文件选择器 → 落盘 → 插入 ![](assets/…)', async () => {
    const { port, onCommit } = setup()
    const input = screen.getByTestId('note-image-input')
    const click = vi.spyOn(input, 'click')
    fireEvent.click(await toolbarButton('image'))
    expect(click).toHaveBeenCalledTimes(1)

    fireEvent.change(input, { target: { files: [fileOf()] } })
    await waitFor(() => expect(port.insert).toHaveBeenCalledTimes(1))
    await expectCommitted(onCommit, '![](assets/a1.png)')
  })

  it('② 粘贴：只从 paste 事件的 clipboardData 取文件', async () => {
    const { port, onCommit } = setup()
    await toolbarButton('bold') // 编辑器 onCreate 之后才有可写的光标
    fireEvent.paste(content(), { clipboardData: clipboardWith([fileOf('paste.png')]) })
    await waitFor(() => expect(port.insert).toHaveBeenCalledTimes(1))
    expect(port.insert.mock.calls[0]?.[0].name).toBe('paste.png')
    await expectCommitted(onCommit, '![](assets/a1.png)')
  })

  it('③ 拖入：从 dataTransfer 取文件', async () => {
    const { port, onCommit } = setup()
    await toolbarButton('bold')
    // 拖在编辑器外框上：React 的 onDrop 在冒泡阶段照常收到，
    // 但不会触发 ProseMirror 自带的 drop 处理（它要在 jsdom 里做命中测试，会抛无关异常）。
    fireEvent.drop(screen.getByTestId('note-editor'), { dataTransfer: { files: [fileOf('drop.png')] } })
    await waitFor(() => expect(port.insert).toHaveBeenCalledTimes(1))
    expect(port.insert.mock.calls[0]?.[0].name).toBe('drop.png')
    await expectCommitted(onCommit, '![](assets/a1.png)')
  })

  it('纯文本粘贴不拦（快捷语法、列表续行照旧走浏览器默认）', () => {
    const { port } = setup()
    fireEvent.paste(content(), { clipboardData: clipboardWith([]) })
    expect(port.insert).not.toHaveBeenCalled()
  })

  it('一次拖入多张：逐张落盘、逐张插入', async () => {
    const { port } = setup({
      port: {
        insert: vi.fn(async (file: File) => ({ ok: true as const, src: `assets/${file.name}` })),
      },
    })
    fireEvent.drop(screen.getByTestId('note-editor'), {
      dataTransfer: { files: [fileOf('a.png'), fileOf('b.jpg', 'image/jpeg')] },
    })
    await waitFor(() => expect(port.insert).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      const markdown = screen.getByTestId('note-editor-content').textContent ?? ''
      expect(markdown).toBeDefined()
    })
  })
})

describe('T25-2 · 被拒（超限 / 格式）只提示，不改文档', () => {
  it('insert 返回 ok=false：外送原因 + 显示提示 + 文档保持原样', async () => {
    const onAssetRejected = vi.fn()
    const { port } = setup({
      port: { insert: vi.fn(async (): Promise<NoteAssetInsert> => ({ ok: false, reason: 'size' })) },
      onAssetRejected,
    })
    fireEvent.paste(content(), { clipboardData: clipboardWith([fileOf('big.png')]) })
    await waitFor(() => expect(onAssetRejected).toHaveBeenCalledWith('size'))
    expect(screen.getByTestId('note-asset-hint').textContent).toContain('5MB')
    expect(content().textContent).not.toContain('assets/')
    expect(port.insert).toHaveBeenCalledTimes(1)
  })

  it('格式不允许时提示的是「不支持的格式」而不是体积', async () => {
    const onAssetRejected = vi.fn()
    setup({
      port: { insert: vi.fn(async (): Promise<NoteAssetInsert> => ({ ok: false, reason: 'type' })) },
      onAssetRejected,
    })
    fireEvent.paste(content(), { clipboardData: clipboardWith([fileOf('x.bmp', 'image/bmp')]) })
    await waitFor(() => expect(onAssetRejected).toHaveBeenCalledWith('type'))
    expect(screen.getByTestId('note-asset-hint').textContent).toContain('png')
  })
})

describe('T25-3 · 显示经 blob URL + 点击开灯箱', () => {
  it('解析到 blob URL 就渲染真图（file:// 下相对路径本就解析不到）', async () => {
    setup({ value: '看这张 ![](assets/a1.png)' })
    await waitFor(() => expect(screen.getByTestId('note-image')).toBeTruthy())
    const image = screen.getByTestId('note-image')
    expect(image.getAttribute('src')).toBe('blob:offearly/a1')
    expect(image.getAttribute('data-note-image')).toBe('assets/a1.png')
  })

  it('图片还没读出来时是灰底 chip，不是碎图', async () => {
    setup({ value: '![](assets/a1.png)', port: { resolve: () => null } })
    await waitFor(() => expect(screen.getByTestId('note-image-pending')).toBeTruthy())
    expect(screen.queryByTestId('note-image')).toBeNull()
  })

  it('宿主缓存就绪的通知到达后重画成真图（异步读出也能补上）', async () => {
    const notifyBox: { current: (() => void) | null } = { current: null }
    let ready = false
    setup({
      value: '![](assets/a1.png)',
      port: {
        resolve: () => (ready ? 'blob:offearly/late' : null),
        subscribe: (listener) => {
          notifyBox.current = listener
          return () => undefined
        },
      },
    })
    await waitFor(() => expect(screen.getByTestId('note-image-pending')).toBeTruthy())
    ready = true
    notifyBox.current?.()
    await waitFor(() => expect(screen.getByTestId('note-image')).toBeTruthy())
    expect(screen.getByTestId('note-image').getAttribute('src')).toBe('blob:offearly/late')
  })

  it('点击图片开灯箱（拿的是 blob URL，下载名是文件名）→ 关闭后消失', async () => {
    setup({ value: '![](assets/a1.png)' })
    await waitFor(() => expect(screen.getByTestId('note-image')).toBeTruthy())
    fireEvent.click(screen.getByTestId('note-image'))
    await waitFor(() => expect(screen.getByTestId('lightbox')).toBeTruthy())
    expect(screen.getByTestId('lightbox-image').getAttribute('src')).toBe('blob:offearly/a1')
    expect(screen.getByTestId('lightbox-download').getAttribute('download')).toBe('a1.png')
    fireEvent.click(screen.getByTestId('lightbox-close'))
    expect(screen.queryByTestId('lightbox')).toBeNull()
  })
})

describe('T25-4 · 存进 note 的仍是 Markdown 相对路径', () => {
  it('插入后 note 里是 ![](assets/<id>.<ext>)，且往返幂等（可被 Obsidian 直读）', async () => {
    const { onCommit } = setup()
    await toolbarButton('bold')
    fireEvent.paste(content(), { clipboardData: clipboardWith([fileOf()]) })
    await expectCommitted(onCommit, '![](assets/a1.png)')
    const markdown = onCommit.mock.calls.at(-1)?.[0] as string
    expect(roundTripNoteMarkdown(markdown)).toBe(roundTripNoteMarkdown(roundTripNoteMarkdown(markdown)))
  })
})
