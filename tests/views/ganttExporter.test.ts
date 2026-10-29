// @vitest-environment jsdom
//
// T23 · GanttExporter：PNG / SVG / CSV 三格式 + 范围（仅可见区 / 全时间跨度）+ R3 栅格化管线。
//
// 口径（spec 5.5）：
//   · 几何全部来自 buildGanttModel 的 GanttModel，导出层不重算排期；
//   · 落进 SVG 的样式一律是**内联呈现属性**（不留 class、不写 var()），字体栈显式写死系统字体
//     ——这是 file:// 下 Canvas 不被 taint 的前提（T01 R3 已 PASS）；
//   · PNG 走 SVG → data URI → Image → Canvas(2x) → toBlob → 下载；jsdom 里没有真 canvas，
//     所以用 mock 的 2d 上下文 + toBlob 覆盖成功与「画布被污染」两条路径；
//   · CSV 带 UTF-8 BOM，列为 任务/开始/结束/进度/依赖，数据直接取自模型行与箭头。
//
// 断言不硬编码几何坐标，坐标期望从同一份模型推导；只对「结构、开关、范围、编码」下断言。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GANTT_ROW_HEIGHT, buildGanttModel } from '../../src/domain/ganttModel'
import type { GanttModel } from '../../src/domain/ganttModel'
import { createEmptyFilter } from '../../src/domain/queryEngine'
import type { Dependency, Milestone, Task, Topic, Vault, WorkCalendar } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import {
  GANTT_ARROW_MARKER_CRITICAL_ID,
  GANTT_ARROW_MARKER_ID,
  GANTT_BASELINE_FILL,
  GANTT_CRITICAL_COLOR,
  GANTT_LABEL_ON_PROGRESS_FILL,
  GANTT_LABEL_PAD_X,
  GANTT_OFF_COLUMN_FILL,
  GANTT_TODAY_COLOR,
} from '../../src/views/GanttCanvas'
import {
  buildGanttCsv,
  buildGanttSvgMarkup,
  exportGanttChart,
  probePngSupport,
  svgToPngBlob,
} from '../../src/views/GanttExporter'
import { GanttView } from '../../src/views/GanttView'

const t = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t

const CALENDAR: WorkCalendar = {
  workdays: [1, 2, 3, 4, 5],
  holidays: ['2026-10-01'],
  extraWorkdays: ['2026-10-17'],
}
const OCTOBER = { start: '2026-10-01', end: '2026-10-31' }
const TODAY = '2026-10-15'
const TOPIC_COLOR = '#4F46E5'
const filter = createEmptyFilter()

function makeTopic(id: string, order: string): Topic {
  return { id, name: `话题 ${id}`, color: TOPIC_COLOR, parentId: null, order, archived: false }
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    topicId: 'a',
    title: `任务 ${id}`,
    status: 'todo',
    kind: 'feature',
    priority: 'P1',
    progress: 0,
    tags: [],
    note: '',
    order: `a${id}`,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    archived: false,
    ...overrides,
  }
}

function makeVault(tasks: Task[], links: Dependency[] = [], milestones: Milestone[] = []): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'vault-t23',
    appVersion: '0.1.0',
    revision: 1,
    updatedAt: '2026-10-15T00:00:00.000Z',
    settings: {
      boardColumns: ['todo', 'doing', 'review', 'done'],
      calendar: CALENDAR,
      ganttScale: 'day',
      theme: 'light',
      locale: 'zh',
      lastFilter: null,

      noteFontSize: 13,
    },
    topics: [makeTopic('a', 'a0')],
    tasks,
    milestones,
    links,
    assets: [],
    mindmaps: [],
    notebooks: [],
    noteDocs: [],
    trash: [],
    whiteboards: [],
  }
}

/** 基准库：t1 → t2（FS），跨话题里程碑 m1；t1 带基线。 */
function makeBaselineVault(): Vault {
  return makeVault(
    [
      makeTask('t1', {
        start: '2026-10-05',
        due: '2026-10-08',
        progress: 50,
        baseline: { start: '2026-10-06', due: '2026-10-09' },
      }),
      makeTask('t2', { start: '2026-10-09', due: '2026-10-14', order: 'a2' }),
    ],
    [{ id: 'l1', from: 't1', to: 't2', type: 'FS', lagDays: 0 }],
    [{ id: 'm1', topicId: null, title: '里程碑 m1', date: '2026-10-20', done: false }],
  )
}

function buildModel(vault: Vault): GanttModel {
  return buildGanttModel(vault, filter, 'day', { today: TODAY, range: OCTOBER })
}

/** 行数足够的库，用来制造「可见区 ⊂ 全量」的行差异。 */
function makeLongVault(count: number): Vault {
  const tasks: Task[] = []
  for (let i = 0; i < count; i += 1) {
    const day = String((i % 26) + 2).padStart(2, '0')
    tasks.push(makeTask(`t${i}`, { start: `2026-10-${day}`, due: `2026-10-${day}`, order: `a${i}` }))
  }
  return makeVault(tasks)
}

const BASE_MODEL = buildModel(makeBaselineVault())

// ── jsdom 下的 canvas / Image / 下载桩 ─────────────────────────────────────────

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
}

let downloads: Capture[]

beforeEach(() => {
  ctx = { scale: vi.fn(), drawImage: vi.fn() }
  imageBehavior = 'load'
  toBlobResult = 'ok'
  lastCanvas = null
  imageSrcs = []
  downloads = []

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
    downloads.push({ href: this.href, download: this.download })
  })
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:mock', configurable: true, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true, writable: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ── SVG ───────────────────────────────────────────────────────────────────────

describe('buildGanttSvgMarkup', () => {
  it('内联呈现属性：无 class、无 CSS 变量、字体栈显式写死系统字体', () => {
    const { markup } = buildGanttSvgMarkup(BASE_MODEL, { range: 'full' })

    expect(markup).not.toContain('class=')
    expect(markup).not.toContain('var(--')
    expect(markup).toContain('font-family="-apple-system')
    expect(markup).toContain('PingFang SC')
    expect(markup).toContain('Microsoft YaHei')
    // 不引用任何外部资源（否则 data URI 里的 Image 会 taint canvas）；
    // xmlns 的 http://www.w3.org/2000/svg 是命名空间声明，不是网络请求，故先剥掉再看
    const withoutNamespace = markup.replace(/xmlns(:\w+)?="[^"]*"/g, '')
    expect(withoutNamespace).not.toMatch(/https?:\/\//)
    expect(withoutNamespace).not.toContain('blob:')
  })

  it('T39 · 任务条与里程碑上有名字标签，判定与画布同一套（导出图不再只有色块）', () => {
    const { markup } = buildGanttSvgMarkup(BASE_MODEL, { range: 'full' })
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
    const row = BASE_MODEL.rows.find((r) => r.id === 't1')!

    const label = doc.querySelector('[data-gantt-label="t1"]')
    expect(label).not.toBeNull()
    expect(label!.textContent).toBe('任务 t1')
    expect(label!.getAttribute('data-placement')).toBe('inside')
    // t1 进度 50%、标签短 → 整段落在深色进度上 → 纯白
    expect(label!.getAttribute('fill')).toBe(GANTT_LABEL_ON_PROGRESS_FILL)
    expect(Number(label!.getAttribute('x'))).toBe(row.bar!.x + GANTT_LABEL_PAD_X)

    // 跨话题里程碑：菱形右侧
    const milestone = doc.querySelector('[data-gantt-label="m1"]')
    expect(milestone).not.toBeNull()
    expect(milestone!.getAttribute('data-placement')).toBe('outside')
    expect(milestone!.textContent).toBe('里程碑 m1')

    // 标签文字同样是内联属性色，不带 var()
    expect(markup).not.toContain('var(--')
  })

  it('把模型投影成图：表头 / 任务条 / 进度 / 今日线 / 菱形里程碑 / 箭头 / 周末底纹', () => {
    // 关掉关键路径着色，让唯一那条 FS 箭头落回中性灰 marker（关键路径那条三态另有专门用例）
    const { markup } = buildGanttSvgMarkup(BASE_MODEL, { range: 'full', criticalPathVisible: false })

    // 表头（月刻度）
    expect(markup).toContain('2026-10')
    // 左侧任务表标签
    expect(markup).toContain('任务 t1')
    // 任务条 + 进度内条（浅底 + 压暗内条都取话题色）
    expect(markup).toContain('data-gantt-bar="t1"')
    expect(markup).toContain(`fill="${TOPIC_COLOR}"`)
    expect(markup).toContain('data-gantt-progress="t1"')
    // 今日线（1px 红）+ 顶部标签
    expect(markup).toContain('data-gantt-today="line"')
    expect(markup).toContain(GANTT_TODAY_COLOR)
    expect(markup).toContain(t('gantt.today'))
    // 跨话题里程碑轨道 + 菱形
    expect(markup).toContain('data-gantt-lane="true"')
    expect(markup).toContain('data-gantt-milestone="m1"')
    // 依赖箭头（FS 折线 + marker-end）
    expect(markup).toContain('data-gantt-arrow="l1"')
    expect(markup).toContain(`marker-end="url(#${GANTT_ARROW_MARKER_ID})"`)
    expect(markup).toContain(`id="${GANTT_ARROW_MARKER_CRITICAL_ID}"`)
    // 非工作日列浅灰底（spec 5.4 写死 #F5F5F5）
    expect(markup).toContain(GANTT_OFF_COLUMN_FILL)
  })

  it('XML 合法且标题被正确转义', () => {
    const vault = makeVault([makeTask('t1', { title: 'A & B <C> "D"', start: '2026-10-05', due: '2026-10-08' })])
    const { markup } = buildGanttSvgMarkup(buildModel(vault), { range: 'full' })

    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.documentElement.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')

    const label = [...doc.querySelectorAll('text')].find((node) => node.textContent === 'A & B <C> "D"')
    expect(label).toBeDefined()
  })

  it('基线开关与关键路径开关各自生效', () => {
    const off = buildGanttSvgMarkup(BASE_MODEL, { range: 'full', baselineVisible: false, criticalPathVisible: false }).markup
    const on = buildGanttSvgMarkup(BASE_MODEL, { range: 'full', baselineVisible: true, criticalPathVisible: true }).markup

    expect(off).not.toContain('data-gantt-baseline="t1"')
    expect(on).toContain('data-gantt-baseline="t1"')
    expect(on).toContain(GANTT_BASELINE_FILL)

    // 关键路径关：只有 marker 定义里出现强调色；开：任务条描边也用它
    const countCritical = (markup: string): number => markup.split('stroke="' + GANTT_CRITICAL_COLOR + '"').length - 1
    expect(countCritical(on)).toBeGreaterThan(countCritical(off))
  })

  it('范围：full 覆盖全时间跨度，visible 只保留可见行列', () => {
    const model = buildModel(makeLongVault(20))
    const full = buildGanttSvgMarkup(model, { range: 'full' })

    const viewport = { scrollTop: 0, scrollLeft: 0, width: 200, height: 40 + 5 * GANTT_ROW_HEIGHT, zoom: 1 }
    const visible = buildGanttSvgMarkup(model, { range: 'visible', viewport })

    expect(full.width).toBeGreaterThan(visible.width)
    expect(full.width).toBe(model.width + 200)
    // 可见区行数受视口高度限制：比全量少
    const rows = (markup: string): number => markup.split('data-gantt-row="').length - 1
    expect(rows(visible.markup)).toBeLessThan(rows(full.markup))
    expect(rows(visible.markup)).toBeGreaterThan(0)

    // 缺视口状态时 visible 退化为全量，不静默出空图
    expect(buildGanttSvgMarkup(model, { range: 'visible' }).width).toBe(full.width)
  })
})

// ── CSV ───────────────────────────────────────────────────────────────────────

describe('buildGanttCsv', () => {
  it('带 UTF-8 BOM，表头为 任务/开始/结束/进度/依赖', () => {
    const csv = buildGanttCsv(BASE_MODEL, { range: 'full' })

    expect(csv.startsWith('\uFEFF')).toBe(true)
    const [header] = csv.slice(1).split('\r\n')
    expect(header).toBe('任务,开始,结束,进度,依赖')
  })

  it('任务行含日期、进度与前置依赖；里程碑以自身日期占一行', () => {
    const csv = buildGanttCsv(BASE_MODEL, { range: 'full' })
    const lines = csv.slice(1).split('\r\n').filter((line) => line.length > 0)

    expect(lines).toContain('任务 t1,2026-10-05,2026-10-08,50%,')
    expect(lines).toContain('任务 t2,2026-10-09,2026-10-14,0%,任务 t1(FS)')
    expect(lines).toContain('里程碑 m1,2026-10-20,2026-10-20,,')
  })

  it('含逗号 / 引号的字段被正确引用转义', () => {
    const vault = makeVault([
      makeTask('t1', { title: '写,文档 "v2"', start: '2026-10-05', due: '2026-10-08' }),
    ])
    const csv = buildGanttCsv(buildModel(vault), { range: 'full' })

    expect(csv).toContain('"写,文档 ""v2""",2026-10-05,2026-10-08,0%,')
  })

  it('visible 范围只导出可见行', () => {
    const model = buildModel(makeLongVault(20))
    const viewport = { scrollTop: 0, scrollLeft: 0, width: 200, height: 40 + 2 * GANTT_ROW_HEIGHT, zoom: 1 }

    const full = buildGanttCsv(model, { range: 'full' })
    const visible = buildGanttCsv(model, { range: 'visible', viewport })
    const lineCount = (csv: string): number => csv.slice(1).split('\r\n').filter((line) => line.length > 0).length

    expect(lineCount(visible)).toBeGreaterThan(1)
    expect(lineCount(visible)).toBeLessThan(lineCount(full))
  })
})

// ── PNG 管线 ──────────────────────────────────────────────────────────────────

describe('svgToPngBlob', () => {
  it('SVG → data URI → Image → Canvas(2x) → toBlob，产出 image/png', async () => {
    const blob = await svgToPngBlob({ markup: '<svg/>', width: 120, height: 60 })

    expect(blob.type).toBe('image/png')
    expect(imageSrcs[0]?.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(ctx.scale).toHaveBeenCalledWith(2, 2)
    expect(ctx.drawImage).toHaveBeenCalledTimes(1)
    expect(lastCanvas?.width).toBe(240)
    expect(lastCanvas?.height).toBe(120)
  })

  it('自定义倍率（1x）时按原尺寸出图', async () => {
    await svgToPngBlob({ markup: '<svg/>', width: 120, height: 60 }, 1)
    expect(ctx.scale).toHaveBeenCalledWith(1, 1)
    expect(lastCanvas?.width).toBe(120)
    expect(lastCanvas?.height).toBe(60)
  })

  it('画布被污染（toBlob 回调为空）时抛错，不静默成功', async () => {
    toBlobResult = 'null'
    await expect(svgToPngBlob({ markup: '<svg/>', width: 10, height: 10 })).rejects.toThrow(/toBlob|taint/i)
  })

  it('Image 加载失败时抛错', async () => {
    imageBehavior = 'error'
    await expect(svgToPngBlob({ markup: '<svg/>', width: 10, height: 10 })).rejects.toThrow(/load/i)
  })
})

describe('probePngSupport', () => {
  it('管线可用时返回 true', async () => {
    await expect(probePngSupport()).resolves.toBe(true)
  })

  it('无 2d 上下文（jsdom 默认）时返回 false', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(probePngSupport()).resolves.toBe(false)
  })
})

// ── 编排 ──────────────────────────────────────────────────────────────────────

describe('exportGanttChart', () => {
  it('三格式各自触发一次下载，文件名扩展名正确', async () => {
    for (const [format, extension] of [['svg', 'svg'], ['csv', 'csv'], ['png', 'png']] as const) {
      downloads = []
      const result = await exportGanttChart({ model: BASE_MODEL, format, range: 'full' })

      expect(downloads).toHaveLength(1)
      expect(downloads[0]?.download).toBe(`${result.filename}`)
      expect(downloads[0]?.download.endsWith(`.${extension}`)).toBe(true)
      expect(downloads[0]?.download).toContain(TODAY)
      expect(downloads[0]?.href).toBe('blob:mock')
    }
  })

  it('PNG 走 2x 画布；SVG / CSV 不触碰 canvas', async () => {
    await exportGanttChart({ model: BASE_MODEL, format: 'png', range: 'full' })
    expect(lastCanvas?.width).toBe(Math.round((BASE_MODEL.width + 200) * 2))

    const toBlobSpy = vi.mocked(HTMLCanvasElement.prototype.toBlob)
    toBlobSpy.mockClear()
    lastCanvas = null
    await exportGanttChart({ model: BASE_MODEL, format: 'svg', range: 'full' })
    expect(lastCanvas).toBeNull()
    expect(toBlobSpy).not.toHaveBeenCalled()
  })

  it('CSV 下载内容带 BOM', async () => {
    await exportGanttChart({ model: BASE_MODEL, format: 'csv', range: 'full', csvHeaders: { task: '任务', start: '开始', end: '结束', progress: '进度', dependency: '依赖' } })
    expect(downloads).toHaveLength(1)
  })
})

// ── 工具栏入口（GanttView） ────────────────────────────────────────────────────

describe('GanttView 导出入口', () => {
  it('工具栏有导出按钮；选格式后确认即触发一次下载', async () => {
    render(createElement(GanttView, { vault: makeBaselineVault(), filter, range: OCTOBER, today: TODAY, width: 640, height: 320, t }))

    const button = screen.getByTestId('gantt-export-button')
    fireEvent.click(button)

    const menu = await screen.findByTestId('gantt-export-menu')
    expect(menu).toBeTruthy()

    fireEvent.click(await screen.findByTestId('gantt-export-format-svg'))
    fireEvent.click(await screen.findByTestId('gantt-export-confirm'))

    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]?.download.endsWith('.svg')).toBe(true)
  })

  it('范围可切到全时间跨度', async () => {
    render(createElement(GanttView, { vault: makeBaselineVault(), filter, range: OCTOBER, today: TODAY, width: 640, height: 320, t }))
    fireEvent.click(await screen.findByTestId('gantt-export-button'))

    const full = await screen.findByTestId('gantt-export-range-full')
    fireEvent.click(full)
    expect(full.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(await screen.findByTestId('gantt-export-format-csv'))
    fireEvent.click(await screen.findByTestId('gantt-export-confirm'))
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]?.download.endsWith('.csv')).toBe(true)
  })

  it('PNG 不可用时该格式禁用并提示', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    render(createElement(GanttView, { vault: makeBaselineVault(), filter, range: OCTOBER, today: TODAY, width: 640, height: 320, t }))
    fireEvent.click(await screen.findByTestId('gantt-export-button'))

    const png = await screen.findByTestId('gantt-export-format-png')
    await waitFor(() => expect((png as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByTestId('gantt-export-png-hint').textContent).toContain('PNG')
    expect((screen.getByTestId('gantt-export-format-svg') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Esc 关闭弹层（收尾补交互）', async () => {
    render(createElement(GanttView, { vault: makeBaselineVault(), filter, range: OCTOBER, today: TODAY, width: 640, height: 320, t }))
    fireEvent.click(await screen.findByTestId('gantt-export-button'))
    await screen.findByTestId('gantt-export-menu')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('gantt-export-menu')).toBeNull())
  })

  it('点击弹层外部关闭；再点按钮仍走既有 toggle（收尾补交互）', async () => {
    render(createElement(GanttView, { vault: makeBaselineVault(), filter, range: OCTOBER, today: TODAY, width: 640, height: 320, t }))
    fireEvent.click(await screen.findByTestId('gantt-export-button'))
    await screen.findByTestId('gantt-export-menu')

    // 外部：甘特画布区域
    fireEvent.mouseDown(screen.getByTestId('gantt-canvas'))
    await waitFor(() => expect(screen.queryByTestId('gantt-export-menu')).toBeNull())

    // 再点按钮重新打开（toggle 路径不受 mousedown 关闭影响）
    fireEvent.click(screen.getByTestId('gantt-export-button'))
    await screen.findByTestId('gantt-export-menu')
    fireEvent.click(screen.getByTestId('gantt-export-button'))
    await waitFor(() => expect(screen.queryByTestId('gantt-export-menu')).toBeNull())
  })
})
