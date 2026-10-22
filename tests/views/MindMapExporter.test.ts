// @vitest-environment jsdom
//
// T48 · MindMapExporter：思维导图 PNG / SVG 导出。
//
// 口径（照 ganttExporter.test.ts 的桩手法与断言纪律）：
//   · 几何全部来自 buildMindMapModel 的 MindMapModel，导出层不重算布局；
//   · 落进 SVG 的样式一律是**内联呈现属性**：无 class、无 `var(`、字体栈显式写死系统字体
//     （docs/visual-audit §4 仓库法；`expect(markup).not.toContain('var(')` 是钉死项）；
//   · 颜色取 theme.css 的 --oe-* 字面量（accent #5E5CE6 / text #1D1D1F / surface #FFFFFF…），
//     与 GanttCanvas 语义相同的常量（标签色 / 强调底上白字）直接复用同一份导出常量；
//   · 坐标序列化统一收 1 位小数（T43 交接裁决）；
//   · range:'full' viewBox = bounds + padding 40；range:'visible' 视口矩形反变换回内容坐标；
//   · PNG 走 GanttExporter 的 R3 管线（svgToPngBlob / probePngSupport import 复用，不复制实现）：
//     jsdom 无真 canvas，用 mock 2d 上下文 + toBlob 覆盖成功与「画布被污染」两条路径。
//
// 断言不硬编码几何坐标：期望值从同一份模型推导，只对结构、字面量色、编码与范围下断言。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MINDMAP_FIT_PADDING } from '../../src/controllers/mindmapViewport'
import { buildMindMapModel } from '../../src/domain/mindmapModel'
import { mid } from '../../src/domain/lexorank'
import { createCommandBus } from '../../src/domain/commandBus'
import { createVaultStore } from '../../src/domain/store'
import type { MindMap, MindNode, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import { GANTT_LABEL_FILL, GANTT_LABEL_ON_PROGRESS_FILL } from '../../src/views/GanttCanvas'
import {
  buildMindMapSvgMarkup,
  exportMindMap,
  MINDMAP_EXPORT_ACCENT,
  MINDMAP_EXPORT_BADGE_FILL,
  MINDMAP_EXPORT_BORDER,
  MINDMAP_EXPORT_MUTED,
  MINDMAP_EXPORT_SURFACE,
  MINDMAP_EXPORT_TEXT,
} from '../../src/views/MindMapExporter'
import MindMapView from '../../src/views/MindMapView'

const t = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t
const NOW = '2026-10-17T08:00:00.000Z'

// ── 夹具（与 MindMapView.test 同口径：node/map/vault 小工厂） ──────────────────

function node(id: string, text: string, extra: Partial<MindNode> = {}): MindNode {
  return { id, text, order: mid(undefined, undefined), folded: false, children: [], ...extra }
}

function map(id: string, name: string, root: MindNode): MindMap {
  return { id, name, root, order: mid(undefined, undefined), createdAt: NOW, updatedAt: NOW }
}

/** 中心主题 → 分支A（叶子） + 分支B（折叠，藏 2 个孙）。 */
const BASE_MAP = map(
  'm1',
  '计划',
  node('root', '中心主题', {
    children: [
      node('a', '分支A'),
      node('b', '分支B', { folded: true, children: [node('b1', '孙1'), node('b2', '孙2')] }),
    ],
  }),
)

const BASE_MODEL = buildMindMapModel(BASE_MAP)

function vaultWith(mindmaps: MindMap[]): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'vault-t48',
    appVersion: '0.1.0',
    revision: 1,
    updatedAt: NOW,
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], extraWorkdays: [] },
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,
      noteFontSize: 13,
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps,
    notebooks: [],
    noteDocs: [],
  }
}

// ── jsdom 下的 canvas / Image / 下载桩（照 ganttExporter.test.ts 手法） ─────────

interface MockCtx {
  scale: ReturnType<typeof vi.fn>
  drawImage: ReturnType<typeof vi.fn>
}

let ctx: MockCtx
let imageBehavior: 'load' | 'error'
let toBlobResult: 'ok' | 'null'
let lastCanvas: HTMLCanvasElement | null
let imageSrcs: string[]

class MockImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(value: string) {
    imageSrcs.push(value)
    queueMicrotask(() => {
      if (imageBehavior === 'load') this.onload?.()
      else this.onerror?.()
    })
  }
}

interface Capture {
  href: string
  download: string
  blob: Blob | null
}

let downloads: Capture[]
let lastBlob: Blob | null

beforeEach(() => {
  ctx = { scale: vi.fn(), drawImage: vi.fn() }
  imageBehavior = 'load'
  toBlobResult = 'ok'
  lastCanvas = null
  imageSrcs = []
  downloads = []
  lastBlob = null

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    lastCanvas = this
    if (toBlobResult === 'null') callback(null)
    else callback(new Blob(['fake-png'], { type: 'image/png' }))
  })
  vi.stubGlobal('Image', MockImage)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, download: this.download, blob: lastBlob })
  })
  Object.defineProperty(URL, 'createObjectURL', {
    value: (blob: Blob) => {
      lastBlob = blob
      return 'blob:mock'
    },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true, writable: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ── SVG ───────────────────────────────────────────────────────────────────────

describe('buildMindMapSvgMarkup', () => {
  it('仓库法：无 class、无 var()、字体栈显式写死、零外部引用（data URI 不 taint 的前提）', () => {
    const { markup } = buildMindMapSvgMarkup(BASE_MODEL, { range: 'full' })

    expect(markup).not.toContain('class=')
    expect(markup).not.toContain('var(')
    expect(markup).not.toContain('var(--')
    expect(markup).toContain('font-family="-apple-system')
    expect(markup).toContain('PingFang SC')
    expect(markup).toContain('Microsoft YaHei')
    const withoutNamespace = markup.replace(/xmlns(:\w+)?="[^"]*"/g, '')
    expect(withoutNamespace).not.toMatch(/https?:\/\//)
    expect(withoutNamespace).not.toContain('blob:')
  })

  it("range:'full' 的 viewBox = model.bounds + padding 40，尺寸同 viewBox 单位", () => {
    const { markup, width, height } = buildMindMapSvgMarkup(BASE_MODEL, { range: 'full' })
    const { bounds } = BASE_MODEL
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
    // 序列化契约：坐标收 1 位小数（T43 裁决），期望值同样先过这一道
    const r1 = (value: number): number => Math.round(value * 10) / 10
    const expected =
      `${r1(bounds.minX - MINDMAP_FIT_PADDING)} ${r1(bounds.minY - MINDMAP_FIT_PADDING)} ` +
      `${r1(bounds.maxX - bounds.minX + MINDMAP_FIT_PADDING * 2)} ${r1(bounds.maxY - bounds.minY + MINDMAP_FIT_PADDING * 2)}`

    expect(doc.documentElement.getAttribute('viewBox')).toBe(expected)
    expect(width).toBe(r1(bounds.maxX - bounds.minX + MINDMAP_FIT_PADDING * 2))
    expect(height).toBe(r1(bounds.maxY - bounds.minY + MINDMAP_FIT_PADDING * 2))
  })

  it('每条边一个 <path>、每个可见节点一个 rect + text；折叠的子树不进产物', () => {
    const { markup } = buildMindMapSvgMarkup(BASE_MODEL, { range: 'full' })
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')

    expect(doc.querySelectorAll('[data-mindmap-edge]').length).toBe(BASE_MODEL.edges.length)
    expect(doc.querySelectorAll('[data-mindmap-node]').length).toBe(BASE_MODEL.nodes.length)
    expect(doc.querySelectorAll('[data-mindmap-label]').length).toBe(BASE_MODEL.nodes.length)
    expect(markup).toContain('中心主题')
    expect(markup).toContain('分支A')
    // 折叠藏起来的孙子不在模型里，自然也不在图里
    expect(markup).not.toContain('孙1')
    // 每条边都带 d 属性（贝塞尔路径来自模型，不在导出层重算）
    for (const edge of BASE_MODEL.edges) {
      expect(markup).toContain(`data-mindmap-edge="${edge.childId}"`)
    }
  })

  it('折叠徽标 +N 文本出现在产物里', () => {
    const { markup } = buildMindMapSvgMarkup(BASE_MODEL, { range: 'full' })
    expect(markup).toContain('+2')
    expect(markup).toContain('data-mindmap-foldbadge="b"')
  })

  it('颜色全部是 theme 字面量：根 accent 实底 + 强调底上白字，普通节点 surface 底 + 文本近黑', () => {
    const { markup } = buildMindMapSvgMarkup(BASE_MODEL, { range: 'full' })
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')

    // 中心主题（depth 0）：--oe-accent #5E5CE6 实底
    expect(MINDMAP_EXPORT_ACCENT).toBe('#5E5CE6')
    const rootRect = doc.querySelector('[data-mindmap-node="root"] rect')
    expect(rootRect?.getAttribute('fill')).toBe(MINDMAP_EXPORT_ACCENT)
    // 根标签：与甘特「深色底上白字」同一常量（--oe-on-accent）
    expect(doc.querySelector('[data-mindmap-label="root"]')?.getAttribute('fill')).toBe(
      GANTT_LABEL_ON_PROGRESS_FILL,
    )
    // 分支A（tier 1）：surface 底 + accent 描边递减透明度
    expect(MINDMAP_EXPORT_SURFACE).toBe('#FFFFFF')
    expect(GANTT_LABEL_FILL).toBe('#1D1D1F')
    const rectA = doc.querySelector('[data-mindmap-node="a"] rect')
    expect(rectA?.getAttribute('fill')).toBe(MINDMAP_EXPORT_SURFACE)
    expect(rectA?.getAttribute('stroke')).toBe(MINDMAP_EXPORT_ACCENT)
    expect(rectA?.getAttribute('stroke-opacity')).toBe('0.45')
    // 标签近黑（--oe-text）、边线取 --oe-border 的 rgba(0,0,0,0.12) 拆成 hex + opacity
    expect(doc.querySelector('[data-mindmap-label="a"]')?.getAttribute('fill')).toBe(MINDMAP_EXPORT_TEXT)
    expect(MINDMAP_EXPORT_BORDER).toBe('#000000')
    const edge = doc.querySelector('[data-mindmap-edge]')
    expect(edge?.getAttribute('stroke')).toBe(MINDMAP_EXPORT_BORDER)
    expect(edge?.getAttribute('stroke-opacity')).toBe('0.12')
    // 徽标底 --oe-fill 同手法拆解、数字 --oe-text-muted
    expect(MINDMAP_EXPORT_BADGE_FILL).toBe('#787880')
    expect(MINDMAP_EXPORT_MUTED).toBe('#6E6E73')
  })

  it("坐标序列化收 1 位小数（T43 交接裁决）：产物里不出现两位以上的小数", () => {
    // 制造小数坐标：三个孩子让父节点按子列中心居中（y 带 0.5）
    const wideMap = map(
      'm2',
      '小数',
      node('root', '中心', {
        children: [node('c1', '一'), node('c2', '二'), node('c3', '三')],
      }),
    )
    const { markup } = buildMindMapSvgMarkup(buildMindMapModel(wideMap), { range: 'full' })
    // 只扫坐标类属性（0.45 / 0.12 这类透明度本来就有两位小数，不在射程内）
    const coordValues = [...markup.matchAll(/(?:^|\s)(?:x|y|width|height|cx|cy|r|rx|viewBox|d)="([^"]*)"/g)].map(
      (match) => match[1] as string,
    )
    expect(coordValues.length).toBeGreaterThan(0)
    for (const value of coordValues) {
      expect(value).not.toMatch(/\.\d\d/)
    }
  })

  it("range:'visible' 把视口矩形反变换回内容坐标；缺视口退化为全量", () => {
    const viewport = { panX: -20, panY: -10, zoom: 2, width: 300, height: 200 }
    const { markup, width, height } = buildMindMapSvgMarkup(BASE_MODEL, { range: 'visible', viewport })
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')

    // content = (screen - pan) / zoom：left=10, top=5, w=150, h=100
    expect(doc.documentElement.getAttribute('viewBox')).toBe('10 5 150 100')
    // 出图像素 = 视口屏幕尺寸（PNG 栅格按此尺寸）
    expect(width).toBe(300)
    expect(height).toBe(200)

    // 缺 viewport 时 visible 退化为 full，不静默出空图
    const degraded = buildMindMapSvgMarkup(BASE_MODEL, { range: 'visible' })
    const full = buildMindMapSvgMarkup(BASE_MODEL, { range: 'full' })
    expect(degraded.width).toBe(full.width)
    expect(degraded.height).toBe(full.height)
  })

  it('background 可覆写；默认不透明白底', () => {
    const white = buildMindMapSvgMarkup(BASE_MODEL, { range: 'full' }).markup
    expect(white).toContain('fill="#FFFFFF"')
    const colored = buildMindMapSvgMarkup(BASE_MODEL, { range: 'full', background: '#F0F0F5' }).markup
    expect(colored).toContain('fill="#F0F0F5"')
  })

  it('XML 合法且特殊字符被转义', () => {
    const tricky = map('m3', '怪名', node('root', 'A & B <C> "D"'))
    const { markup } = buildMindMapSvgMarkup(buildMindMapModel(tricky), { range: 'full' })
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')

    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.documentElement.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')
    const label = [...doc.querySelectorAll('text')].find((n) => n.textContent === 'A & B <C> "D"')
    expect(label).toBeDefined()
  })

  it('foldAll 展示态：喂进来的模型是什么就导出什么（折叠视图导出折叠图）', () => {
    const collapsed = buildMindMapModel(BASE_MAP, { foldAll: true })
    const { markup } = buildMindMapSvgMarkup(collapsed, { range: 'full' })

    expect(markup).toContain('中心主题')
    expect(markup).not.toContain('分支A')
    expect(markup).toContain('+4') // 折叠后根徽标：藏掉 A、B 与 B 的两个孙（countHidden = 全部后代）
  })
})

// ── 编排：exportMindMap ────────────────────────────────────────────────────────

describe('exportMindMap', () => {
  it('SVG：一次下载、文件名为 {fileName}.svg、内容是那份 markup', async () => {
    const result = await exportMindMap({ model: BASE_MODEL, format: 'svg', range: 'full', fileName: '计划' })

    expect(result).toEqual({ filename: '计划.svg', format: 'svg', bytes: expect.any(Number) })
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.download).toBe('计划.svg')
    const text = await downloads[0]?.blob?.text()
    expect(text).toContain('<svg')
    expect(text).toContain('中心主题')
    expect(text ?? '').not.toContain('var(')
  })

  it('PNG：走 R3 管线（2x canvas → toBlob → 下载），文件名 {fileName}.png', async () => {
    const result = await exportMindMap({ model: BASE_MODEL, format: 'png', range: 'full', fileName: '计划' })

    expect(result.filename).toBe('计划.png')
    expect(downloads).toHaveLength(1)
    expect(imageSrcs[0]?.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(ctx.scale).toHaveBeenCalledWith(2, 2)
    // canvas 宽 = 出图宽（1 位小数序列化后）× 2
    const svg = buildMindMapSvgMarkup(BASE_MODEL, { range: 'full' })
    expect(lastCanvas?.width).toBe(Math.round(svg.width * 2))
  })

  it('文件名里的路径非法字符收敛为 "-"，不产生跨目录名', async () => {
    const result = await exportMindMap({
      model: BASE_MODEL,
      format: 'svg',
      range: 'full',
      fileName: 'a/b\\c:d*e?f"g<h>i|j',
    })
    expect(result.filename).toBe('a-b-c-d-e-f-g-h-i-j.svg')
  })

  it('PNG 管线不可用（toBlob 回调空 = 画布被污染）时抛错，不出空文件', async () => {
    toBlobResult = 'null'
    await expect(
      exportMindMap({ model: BASE_MODEL, format: 'png', range: 'full', fileName: '计划' }),
    ).rejects.toThrow(/toBlob|taint/i)
    expect(downloads).toHaveLength(0)
  })

  it('Image 加载失败同样抛错且零下载', async () => {
    imageBehavior = 'error'
    await expect(
      exportMindMap({ model: BASE_MODEL, format: 'png', range: 'full', fileName: '计划' }),
    ).rejects.toThrow(/load/i)
    expect(downloads).toHaveLength(0)
  })
})

// ── 视图接线：MindMapView 导出菜单（照 GanttView 弹层交互） ────────────────────

describe('MindMapView 导出入口', () => {
  function renderView(mindmaps: MindMap[]) {
    const store = createVaultStore(vaultWith(mindmaps))
    const bus = createCommandBus(store)
    render(createElement(MindMapView, { vault: store.getVault(), bus, t, width: 640, height: 320 }))
    return store
  }

  it('工具栏有导出按钮；选 SVG 确认后触发一次下载', async () => {
    renderView([BASE_MAP])
    fireEvent.click(await screen.findByTestId('mindmap-export-button'))
    expect(await screen.findByTestId('mindmap-export-menu')).toBeTruthy()

    fireEvent.click(await screen.findByTestId('mindmap-export-format-svg'))
    fireEvent.click(await screen.findByTestId('mindmap-export-confirm'))

    await waitFor(() => expect(downloads).toHaveLength(1))
    // 文件名 = 图名
    expect(downloads[0]?.download).toBe('计划.svg')
  })

  it('折叠全部开着时导出的是折叠后的显示模型', async () => {
    renderView([BASE_MAP])
    fireEvent.click(await screen.findByTestId('mindmap-fold-all'))
    fireEvent.click(await screen.findByTestId('mindmap-export-button'))
    fireEvent.click(await screen.findByTestId('mindmap-export-format-svg'))
    fireEvent.click(await screen.findByTestId('mindmap-export-confirm'))

    await waitFor(() => expect(downloads).toHaveLength(1))
    const text = await downloads[0]?.blob?.text()
    expect(text).toContain('中心主题')
    expect(text ?? '').not.toContain('分支A')
  })

  it('PNG 探针不可用时该格式禁用并提示（R3 降级，非失败）', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    renderView([BASE_MAP])
    fireEvent.click(await screen.findByTestId('mindmap-export-button'))

    const png = await screen.findByTestId('mindmap-export-format-png')
    await waitFor(() => expect((png as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByTestId('mindmap-export-png-hint').textContent).toContain('PNG')
    expect((screen.getByTestId('mindmap-export-format-svg') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Esc 与点击外部关闭弹层；再点按钮仍可切换开关', async () => {
    renderView([BASE_MAP])
    fireEvent.click(await screen.findByTestId('mindmap-export-button'))
    await screen.findByTestId('mindmap-export-menu')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('mindmap-export-menu')).toBeNull())

    fireEvent.click(screen.getByTestId('mindmap-export-button'))
    await screen.findByTestId('mindmap-export-menu')
    fireEvent.mouseDown(screen.getByTestId('mindmap-canvas'))
    await waitFor(() => expect(screen.queryByTestId('mindmap-export-menu')).toBeNull())

    fireEvent.click(screen.getByTestId('mindmap-export-button'))
    await screen.findByTestId('mindmap-export-menu')
    fireEvent.click(screen.getByTestId('mindmap-export-button'))
    await waitFor(() => expect(screen.queryByTestId('mindmap-export-menu')).toBeNull())
  })

  it('格式 × 范围可切：默认 PNG + 仅可见区，range 切换有 aria 状态', async () => {
    renderView([BASE_MAP])
    fireEvent.click(await screen.findByTestId('mindmap-export-button'))

    const visible = await screen.findByTestId('mindmap-export-range-visible')
    const full = screen.getByTestId('mindmap-export-range-full')
    expect(visible.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(full)
    expect(full.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('mindmap-export-format-png').getAttribute('aria-checked')).toBe('true')
  })
})
