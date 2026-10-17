// @vitest-environment jsdom
//
// T45 · MindMapView 视图测试：画布只读投影 + 空态新建 + 图切换 + 适应画布。
//
// 断言口径与 GanttView.test 同款：几何一律从 buildMindMapModel 现算，与渲染结果对同一份
// 模型比对，不硬编码坐标。桩 i18n 用 createI18n 固定 zh。store/bus 用真实实现
// （createCommandBus + createVaultStore），只测视图确实「只读」——除新建外零命令。
// jsdom 无 ResizeObserver：实现里 typeof 守卫直接跳过测量，视口沿用控制器默认尺寸。

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { applyDeleteMap } from '../../src/controllers/mindmapActions'
import { createMindmapViewport, MINDMAP_FIT_PADDING, MINDMAP_ZOOM_STEPS } from '../../src/controllers/mindmapViewport'
import { createCommandBus } from '../../src/domain/commandBus'
import type { CommandBus } from '../../src/domain/commandBus'
import { buildMindMapModel, MINDMAP_FONT_SIZE } from '../../src/domain/mindmapModel'
import { findNode } from '../../src/domain/mindmapTree'
import { mid } from '../../src/domain/lexorank'
import { createVaultStore } from '../../src/domain/store'
import type { VaultStore } from '../../src/domain/store'
import type { MindMap, MindNode, Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import MindMapView from '../../src/views/MindMapView'

const t = createI18n({ getLocale: () => 'zh', subscribe: () => () => {} }).t
const NOW = '2026-10-17T08:00:00.000Z'

function node(id: string, text: string, extra: Partial<MindNode> = {}): MindNode {
  return { id, text, order: mid(undefined, undefined), folded: false, children: [], ...extra }
}

function map(id: string, name: string, root: MindNode): MindMap {
  return {
    id,
    name,
    root,
    order: mid(undefined, undefined),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function vaultWith(mindmaps: MindMap[]): Vault {
  return {
    schemaVersion: 1,
    vaultId: 'vault-t45',
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
    },
    topics: [],
    tasks: [],
    milestones: [],
    links: [],
    assets: [],
    mindmaps,
  }
}

function seeded(mindmaps: MindMap[]): { store: VaultStore; bus: CommandBus; vault: Vault } {
  const vault = vaultWith(mindmaps)
  const store = createVaultStore(vault)
  return { store, bus: createCommandBus(store), vault }
}

/** 基础树：中心主题 → 分支A（与 mindmapModel 测试同口径，几何从模型现算）。 */
function simpleMap(overrides: Partial<MindMap> = {}): MindMap {
  return map(
    overrides.id ?? 'm1',
    overrides.name ?? '计划',
    node('root1', '中心主题', { children: [node('a', '分支A')] }),
  )
}

// 空态引导：一张空库 → 点「新建思维导图」→ 落库并被选中
describe('T45-1 · 空态引导卡与新建', () => {
  it('空库显示引导；点新建写入一张默认图并切换过去', () => {
    const { store, bus } = seeded([])
    const view = render(<MindMapView vault={store.getVault()} bus={bus} t={t} />)

    expect(view.getByTestId('mindmap').getAttribute('data-testid')).toBe('mindmap')
    const card = view.getByTestId('mindmap-empty')
    expect(card.textContent).toContain('还没有思维导图')
    expect(view.queryByTestId('mindmap-canvas')).toBeNull()

    fireEvent.click(view.getByRole('button', { name: '新建思维导图' }))

    const created = store.getVault().mindmaps
    expect(created).toHaveLength(1)
    expect(created[0]!.name).toBe('未命名导图')
    expect(created[0]!.root.text).toBe('中心主题')
    expect(bus.undoDepth()).toBe(1)

    // App 里 store 变更会推动 Workspace 重渲染；测试手动 rerender 同一出口
    view.rerender(<MindMapView vault={store.getVault()} bus={bus} t={t} />)
    expect(view.queryByTestId('mindmap-empty')).toBeNull()
    expect(view.getByTestId('mindmap-canvas')).toBeTruthy()
    const select = view.getByTestId('mindmap-select') as HTMLSelectElement
    expect(select.value).toBe(created[0]!.id)
  })

  it('已有图时工具条提供新建与图切换（数组序）', () => {
    const { store, bus } = seeded([
      map('m1', '第一图', node('r1', '第一中心')),
      map('m2', '第二图', node('r2', '第二中心')),
    ])
    const view = render(<MindMapView vault={store.getVault()} bus={bus} t={t} />)
    const select = view.getByTestId('mindmap-select') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['第一图', '第二图'])
    expect(select.value).toBe('m1')
    expect(view.container.textContent).toContain('第一中心')

    // 默认选中表首；切到第二图后画布换树
    fireEvent.change(select, { target: { value: 'm2' } })
    expect(view.container.textContent).toContain('第二中心')

    fireEvent.click(view.getByTestId('mindmap-create'))
    expect(store.getVault().mindmaps).toHaveLength(3)
    view.rerender(<MindMapView vault={store.getVault()} bus={bus} t={t} />)
    expect((view.getByTestId('mindmap-select') as HTMLSelectElement).value).toBe(
      store.getVault().mindmaps[2]!.id,
    )
  })

  it('选中图被删除后回退表首（selectedMapId 悬空不白屏）', () => {
    const { store, bus } = seeded([
      map('m1', '第一图', node('r1', '第一中心')),
      map('m2', '第二图', node('r2', '第二中心')),
    ])
    const view = render(<MindMapView vault={store.getVault()} bus={bus} t={t} />)
    fireEvent.change(view.getByTestId('mindmap-select'), { target: { value: 'm2' } })
    expect(view.container.textContent).toContain('第二中心')

    applyDeleteMap(bus, store.getVault(), 'm2')
    view.rerender(<MindMapView vault={store.getVault()} bus={bus} t={t} />)
    expect((view.getByTestId('mindmap-select') as HTMLSelectElement).value).toBe('m1')
    expect(view.container.textContent).toContain('第一中心')

    applyDeleteMap(bus, store.getVault(), 'm1')
    view.rerender(<MindMapView vault={store.getVault()} bus={bus} t={t} />)
    expect(view.getByTestId('mindmap-empty')).toBeTruthy()
  })
})

// 投影：节点/边/折叠徽标全部与模型一致，视图零写入
describe('T45-2 · 画布只读投影', () => {
  it('渲染根标签与一条子边；节点组前序 = 模型序；transform 走 translate/scale 契约', () => {
    const { store, bus } = seeded([simpleMap()])
    const model = buildMindMapModel(store.getVault().mindmaps[0]!)
    const view = render(<MindMapView vault={store.getVault()} bus={bus} t={t} />)

    expect(view.container.textContent).toContain('中心主题')
    const edges = view.container.querySelectorAll('path[data-mindmap-edge]')
    expect(edges).toHaveLength(1)
    expect(edges[0]!.getAttribute('d')).toBe(model.edges[0]!.path)
    expect(edges[0]!.getAttribute('data-mindmap-edge')).toBe('a')

    const groups = [...view.container.querySelectorAll('[data-mindmap-node]')]
    expect(groups.map((g) => g.getAttribute('data-mindmap-node'))).toEqual(model.nodes.map((n) => n.id))

    // 初始视口：pan 0、zoom 1（MINDMAP_DEFAULT_ZOOM_INDEX 档）
    const world = view.container.querySelector('[data-mindmap-world]')
    expect(world?.getAttribute('transform')).toBe('translate(0 0) scale(1)')
  })

  it('折叠节点带 +N 徽标并藏子树；点节点仅本地选中（环），零命令零写库', () => {
    const folded = map('m1', '计划', node('root1', '中心主题', {
      children: [node('a', '分支A', { folded: true, children: [node('a1', '子A1'), node('a2', '子A2')] }), node('b', '分支B')],
    }))
    const { store, bus } = seeded([folded])
    const model = buildMindMapModel(folded)
    expect(model.nodes.map((n) => n.id)).toEqual(['root1', 'a', 'b'])
    const view = render(<MindMapView vault={store.getVault()} bus={bus} t={t} />)

    // 折叠子树不进画布：3 节点 2 边，徽标 +2
    expect(view.container.querySelectorAll('[data-mindmap-node]')).toHaveLength(3)
    expect(view.container.querySelectorAll('path[data-mindmap-edge]')).toHaveLength(2)
    // T46 契约：折叠按钮属性名改为 data-mindmap-foldtoggle={id}（供 T47 复用）
    const badge = view.container.querySelector('[data-mindmap-foldtoggle="a"]')
    expect(badge?.textContent).toBe('+2')
    expect(view.container.textContent).not.toContain('子A1')

    // 只读投影口径：节点按下 → 选中环（data-selected-node），不产生命令、不改库。
    // （T46 起选中由 onClick 挪到 onPointerDown——指针层裁决；badge 的交互接线见 T46-3。）
    const before = store.getVault()
    fireEvent.pointerDown(view.container.querySelector('[data-mindmap-node="a"]')!)
    expect(view.getByTestId('mindmap-canvas').getAttribute('data-selected-node')).toBe('a')
    expect(store.getVault()).toBe(before)
    expect(bus.undoDepth()).toBe(0)
  })
})

// 适应画布：fit 语义 = 选最大可容纳档 + 内容中心对齐视口中心
describe('T45-3 · 适应画布按钮', () => {
  it('点击后 viewport 落到 fitToContent(model.bounds) 的目标档与 pan', () => {
    const { store, bus } = seeded([simpleMap()])
    const model = buildMindMapModel(store.getVault().mindmaps[0]!)
    const viewport = createMindmapViewport()
    const state0 = viewport.getState()
    const view = render(<MindMapView vault={store.getVault()} bus={bus} t={t} viewport={viewport} />)

    fireEvent.click(view.getByTestId('mindmap-fit'))
    const state = viewport.getState()
    const zoom = viewport.getZoom()

    // 内容小到顶档也放得下 → 选最大档；pan 使内容中心落在视口中心
    const contentW = model.bounds.maxX - model.bounds.minX
    const contentH = model.bounds.maxY - model.bounds.minY
    expect(zoom).toBe(MINDMAP_ZOOM_STEPS[MINDMAP_ZOOM_STEPS.length - 1])
    expect(contentW * zoom).toBeLessThanOrEqual(state0.width - MINDMAP_FIT_PADDING * 2 + 1e-9)
    expect(contentH * zoom).toBeLessThanOrEqual(state0.height - MINDMAP_FIT_PADDING * 2 + 1e-9)
    expect(state.panX).toBe(state0.width / 2 - ((model.bounds.minX + model.bounds.maxX) / 2) * zoom)
    expect(state.panY).toBe(state0.height / 2 - ((model.bounds.minY + model.bounds.maxY) / 2) * zoom)

    // 屏幕投影契约同步：svg data-zoom 与 <g transform> 用同一组值
    expect(view.getByTestId('mindmap-canvas').getAttribute('data-zoom')).toBe(String(zoom))
    expect(view.container.querySelector('[data-mindmap-world]')?.getAttribute('transform')).toBe(
      `translate(${state.panX} ${state.panY}) scale(${zoom})`,
    )
  })
})

afterEach(cleanup)

// ============================================================================
// T46 · 编辑交互：就地编辑 overlay + xmind 快捷键层 + 折叠徽标 + 平移缩放指针层。
//
// 手法与 T45 段一致：真实 store/bus；每次 bus 写入后手动 refresh() 推新 vault
// （事件处理器读的正是「事件时刻的 vault prop」——App 里 store 变更会推动重渲染，
// 测试必须如实复现这条数据流，否则 rename 提交会拿旧快照找不到新节点）。
// 几何断言一律从 buildMindMapModel 现算；滚轮/指针走 RTL fireEvent（jsdom 30 有
// PointerEvent/WheelEvent/CompositionEvent；setPointerCapture 缺实现，实现里 typeof 守卫）。
// ============================================================================

/** T46 键盘游走树：root1 → [a(a1, a2), b]——Up/Down 兄弟与 Left/Right 父子都有第二候选。 */
function editTree(): MindMap {
  return map(
    'm1',
    '计划',
    node('root1', '中心主题', {
      children: [
        node('a', '分支A', { children: [node('a1', '子A1'), node('a2', '子A2')] }),
        node('b', '分支B'),
      ],
    }),
  )
}

function mountT46(maps: MindMap[] = [editTree()]) {
  const viewport = createMindmapViewport()
  const h = seeded(maps)
  const jsx = () => <MindMapView vault={h.store.getVault()} bus={h.bus} t={t} viewport={viewport} />
  const view = render(jsx())
  return {
    store: h.store,
    bus: h.bus,
    viewport,
    view,
    /** 视图根容器（role=application + tabIndex=0），快捷键层挂它。 */
    root: () => view.getByTestId('mindmap'),
    nodeEl: (id: string) => view.container.querySelector(`[data-mindmap-node="${id}"]`)!,
    /** 画布表面的 data-selected-node（null = 未选中）。 */
    selected: () => view.getByTestId('mindmap-canvas').getAttribute('data-selected-node'),
    /** 模拟 App 侧 store 变更推动的重渲染：把事件处理器的 vault 闭包推进到新快照。 */
    refresh: () => view.rerender(jsx()),
  }
}

describe('T46-1 · 键盘层：Tab 加子 / Enter 加同级 / 删除 / Space / 方向键 / Escape', () => {
  it('Tab 给选中节点加子并进入编辑；提交后 add + rename 两条记录', () => {
    const m = mountT46()
    fireEvent.pointerDown(m.nodeEl('a'))
    expect(m.selected()).toBe('a')
    expect(m.bus.undoDepth()).toBe(0) // 选中本身不写库

    fireEvent.keyDown(m.root(), { key: 'Tab' })
    expect(m.bus.undoDepth()).toBe(1) // 子节点先落库（占位文案）
    const created = findNode(m.store.getVault().mindmaps[0]!.root, 'a')!.children[2]!
    expect(created.text).toBe('分支')
    // 新节点要先进入模型投影才有 overlay 的落点：refresh() 复现 App 的 store→props 传导
    m.refresh()
    expect(m.view.getByTestId('mindmap-input')).toBeTruthy()
    expect((m.view.getByTestId('mindmap-input') as HTMLInputElement).value).toBe('分支')

    const input = m.view.getByTestId('mindmap-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: ' 新分支 ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(m.bus.undoDepth()).toBe(2)
    expect(findNode(m.store.getVault().mindmaps[0]!.root, created.id)!.text).toBe('新分支')
    expect(m.view.queryByTestId('mindmap-input')).toBeNull()
    expect(m.selected()).toBe(created.id)
  })

  it('折叠父上加子 = 展开 + 加子两条 undo 记录（T42 裁决锁定）', () => {
    const foldedTree = map('m1', '计划', node('root1', '中心主题', {
      children: [node('a', '分支A', { folded: true, children: [node('a1', '子A1')] })],
    }))
    const m = mountT46([foldedTree])
    fireEvent.pointerDown(m.nodeEl('a'))
    fireEvent.keyDown(m.root(), { key: 'Tab' })
    expect(m.bus.undoDepth()).toBe(2)
    const a = findNode(m.store.getVault().mindmaps[0]!.root, 'a')!
    expect(a.folded).toBe(false)
    expect(a.children.map((c) => c.text)).toEqual(['子A1', '分支'])
    m.refresh() // 展开 + 新子进投影后 overlay 才有落点（同 T46-1 第一条的口径）
    expect(m.view.getByTestId('mindmap-input')).toBeTruthy()
  })

  it('Enter 加同级（挂到父序列尾）；根上 no-op 零写入', () => {
    const m = mountT46()
    fireEvent.pointerDown(m.nodeEl('a'))
    fireEvent.keyDown(m.root(), { key: 'Enter' })
    expect(m.bus.undoDepth()).toBe(1)
    const rootNow = m.store.getVault().mindmaps[0]!.root
    expect(rootNow.children.map((c) => c.text)).toEqual(['分支A', '分支B', '分支'])
    m.refresh()
    // 取消空编辑：不残留 rename 记录
    fireEvent.keyDown(m.view.getByTestId('mindmap-input'), { key: 'Escape' })
    expect(m.bus.undoDepth()).toBe(1)

    // 根上 Enter：no-op，零写入
    fireEvent.pointerDown(m.nodeEl('root1'))
    fireEvent.keyDown(m.root(), { key: 'Enter' })
    expect(m.bus.undoDepth()).toBe(1)
    expect(m.store.getVault().mindmaps[0]!.root.children).toHaveLength(3)
  })

  it('Delete 删选中子树并清选中；Backspace 同义；根 no-op 零写入', () => {
    const m = mountT46()
    fireEvent.pointerDown(m.nodeEl('a'))
    fireEvent.keyDown(m.root(), { key: 'Delete' })
    expect(m.bus.undoDepth()).toBe(1)
    const rootNow = m.store.getVault().mindmaps[0]!.root
    expect(findNode(rootNow, 'a')).toBeNull()
    expect(findNode(rootNow, 'a1')).toBeNull() // 连子树删
    m.refresh()
    expect(m.selected()).toBeNull()

    // 根上 Backspace：no-op
    fireEvent.pointerDown(m.nodeEl('root1'))
    fireEvent.keyDown(m.root(), { key: 'Backspace' })
    expect(m.bus.undoDepth()).toBe(1)
    expect(findNode(m.store.getVault().mindmaps[0]!.root, 'root1')).not.toBeNull()
  })

  it('Space 切换选中节点折叠（写库、子树消失/回来）', () => {
    const m = mountT46()
    fireEvent.pointerDown(m.nodeEl('a'))
    fireEvent.keyDown(m.root(), { key: ' ' })
    expect(m.bus.undoDepth()).toBe(1)
    expect(findNode(m.store.getVault().mindmaps[0]!.root, 'a')!.folded).toBe(true)
    m.refresh()
    expect(m.view.container.querySelector('[data-mindmap-node="a1"]')).toBeNull()
    expect(m.view.container.querySelector('[data-mindmap-foldtoggle="a"]')?.textContent).toBe('+2')

    fireEvent.keyDown(m.root(), { key: ' ' })
    expect(m.bus.undoDepth()).toBe(2)
    expect(findNode(m.store.getVault().mindmaps[0]!.root, 'a')!.folded).toBe(false)
  })

  it('方向键树游走只改选中态（零写入）：Up/Down 兄弟、Left 父、Right 首子', () => {
    const m = mountT46()
    const go = (key: string) => fireEvent.keyDown(m.root(), { key })
    fireEvent.pointerDown(m.nodeEl('a'))
    expect(m.selected()).toBe('a')
    go('ArrowDown')
    expect(m.selected()).toBe('b') // 下一兄弟
    go('ArrowUp')
    expect(m.selected()).toBe('a')
    go('ArrowRight')
    expect(m.selected()).toBe('a1') // 首子
    go('ArrowLeft')
    expect(m.selected()).toBe('a') // 父
    go('ArrowLeft')
    expect(m.selected()).toBe('root1')
    go('ArrowLeft') // 根上左移：no-op
    expect(m.selected()).toBe('root1')
    go('ArrowDown') // 根无兄弟：no-op
    expect(m.selected()).toBe('root1')
    expect(m.bus.undoDepth()).toBe(0)
    expect(m.store.getVault().mindmaps[0]!.root.children[0]!.children).toHaveLength(2)
  })

  it('Escape 第一下退出编辑且不残留命令，再按一下清选中', () => {
    const m = mountT46()
    fireEvent.pointerDown(m.nodeEl('a'))
    fireEvent.keyDown(m.root(), { key: 'F2' })
    const input = m.view.getByTestId('mindmap-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '草稿' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(m.view.queryByTestId('mindmap-input')).toBeNull()
    expect(m.bus.undoDepth()).toBe(0) // 取消：零写入
    expect(findNode(m.store.getVault().mindmaps[0]!.root, 'a')!.text).toBe('分支A')
    expect(m.selected()).toBe('a') // 编辑退出，选中还在

    fireEvent.keyDown(m.root(), { key: 'Escape' })
    expect(m.selected()).toBeNull()
  })
})

describe('T46-2 · 就地编辑 overlay（HTML 绝对定位 + IME 守卫）', () => {
  const RAW = '这是一段会被宽度封顶截断的很长的分支文案'.repeat(8)

  it('双击节点进入编辑：预填未截断原文；Enter 提交；blur 也提交', () => {
    const longTree = map('m1', '计划', node('root1', '中心主题', {
      children: [node('a', RAW), node('b', '分支B')],
    }))
    const model = buildMindMapModel(longTree)
    const viewA = model.nodes.find((n) => n.id === 'a')!
    expect(viewA.text).not.toBe(RAW) // sanity：模型里的文本已截断，overlay 必须回填原文

    const m = mountT46([longTree])
    fireEvent.doubleClick(m.nodeEl('a'))
    const input = m.view.getByTestId('mindmap-input') as HTMLInputElement
    expect(input.value).toBe(RAW)
    expect(input.getAttribute('data-mindmap-input')).toBe('a')
    // 定位契约：screen = content * zoom + pan（默认档 zoom 1 / pan 0）
    expect(input.style.left).toBe(`${viewA.x}px`)
    expect(input.style.top).toBe(`${viewA.y}px`)
    expect(input.style.width).toBe(`${viewA.width}px`)
    expect(input.style.fontSize).toBe(`${MINDMAP_FONT_SIZE}px`)

    fireEvent.change(input, { target: { value: '新文案' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(m.bus.undoDepth()).toBe(1)
    expect(findNode(m.store.getVault().mindmaps[0]!.root, 'a')!.text).toBe('新文案')
    expect(m.view.queryByTestId('mindmap-input')).toBeNull()

    // blur 提交路：再开编辑 → 改值 → blur
    m.refresh()
    fireEvent.doubleClick(m.nodeEl('a'))
    const input2 = m.view.getByTestId('mindmap-input') as HTMLInputElement
    fireEvent.change(input2, { target: { value: 'blur 提交' } })
    fireEvent.blur(input2)
    expect(m.bus.undoDepth()).toBe(2)
    expect(findNode(m.store.getVault().mindmaps[0]!.root, 'a')!.text).toBe('blur 提交')
  })

  it('缩小档字号钳 12px；输入框位置随 zoom/pan 走', () => {
    const m = mountT46()
    const viewA = buildMindMapModel(editTree()).nodes.find((n) => n.id === 'a')!
    m.viewport.setZoomIndex(0) // zoom 0.5
    m.viewport.panBy(12, 20)
    fireEvent.doubleClick(m.nodeEl('a'))
    const input = m.view.getByTestId('mindmap-input') as HTMLInputElement
    expect(input.style.fontSize).toBe('12px') // 13 * 0.5 < 12 → 钳 12
    expect(input.style.left).toBe(`${viewA.x * 0.5 + 12}px`)
    expect(input.style.top).toBe(`${viewA.y * 0.5 + 20}px`)
    expect(input.style.width).toBe(`${viewA.width * 0.5}px`)
  })

  it('IME：组词期间 Enter 不提交、compositionEnd 后 Enter 才落库；根容器 isComposing 直接 return', () => {
    const m = mountT46()
    fireEvent.pointerDown(m.nodeEl('a'))
    // 根容器快捷键守卫：isComposing 的 keydown 一律不响应（Space 不折叠）
    fireEvent.keyDown(m.root(), { key: ' ', isComposing: true })
    expect(m.bus.undoDepth()).toBe(0)

    fireEvent.keyDown(m.root(), { key: 'F2' })
    const input = m.view.getByTestId('mindmap-input') as HTMLInputElement
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '候选文本' } })
    fireEvent.keyDown(input, { key: 'Enter' }) // 组词中的 Enter = 上屏候选，绝不提交
    expect(m.bus.undoDepth()).toBe(0)
    expect(m.view.queryByTestId('mindmap-input')).toBeTruthy()

    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(m.bus.undoDepth()).toBe(1)
    expect(findNode(m.store.getVault().mindmaps[0]!.root, 'a')!.text).toBe('候选文本')
    // 说明：jsdom 能模拟 compositionstart/end 与 isComposing 标志位，但真实中文 IME
    // （微软拼音/搜狗）的上屏时序无法在此复刻——列入浏览器人工验证项。
  })
})

describe('T46-3 · 折叠徽标 + 指针层（拖拽平移 / 滚轮）', () => {
  it('折叠徽标点击切换 folded 且子树回来；徽标 pointerdown 不选中节点也不平移', () => {
    const foldedTree = map('m1', '计划', node('root1', '中心主题', {
      children: [node('a', '分支A', { folded: true, children: [node('a1', '子A1'), node('a2', '子A2')] }), node('b', '分支B')],
    }))
    const m = mountT46([foldedTree])
    const badge = m.view.container.querySelector('[data-mindmap-foldtoggle="a"]')!
    expect(badge.textContent).toBe('+2')

    fireEvent.pointerDown(badge, { pointerId: 1, clientX: 5, clientY: 5 })
    expect(m.selected()).toBeNull() // 徽标不吃选中
    expect(m.viewport.getState().panX).toBe(0) // 也不起平移
    fireEvent.pointerUp(badge, { pointerId: 1 })

    fireEvent.click(badge)
    expect(m.bus.undoDepth()).toBe(1)
    expect(findNode(m.store.getVault().mindmaps[0]!.root, 'a')!.folded).toBe(false)
    m.refresh()
    expect(m.view.container.querySelector('[data-mindmap-node="a1"]')).toBeTruthy() // 子树回来
    expect(m.view.container.querySelector('[data-mindmap-foldtoggle="a"]')).toBeNull()

    fireEvent.pointerDown(m.nodeEl('a')) // badge 的 pointerdown 已拦截，节点此时仍未选中——点节点本体才吃选中
    expect(m.selected()).toBe('a')
  })

  it('滚轮：Ctrl+滚轮经 applyWheel 消费并 preventDefault；普通滚轮平移；零增量不消费', () => {
    const m = mountT46()
    const surface = m.view.getByTestId('mindmap-viewport')
    // 组件的 wheel 监听注册更早（effect 先跑），同目标监听按注册序执行——后挂的探针读到的
    // defaultPrevented 即组件 preventDefault 之后的终值。
    let prevented = false
    surface.addEventListener('wheel', (event) => {
      prevented = event.defaultPrevented
    })

    prevented = false
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: -120 })
    expect(prevented).toBe(true)
    expect(m.viewport.getZoom()).toBe(MINDMAP_ZOOM_STEPS[5]) // 默认档上滚一格 = 1.2
    expect(m.view.getByTestId('mindmap-canvas').getAttribute('data-zoom')).toBe(String(MINDMAP_ZOOM_STEPS[5]))
    // 锚点缩放会同步改 pan（T44 契约），后续平移断言以这一刻为基线
    const afterZoom = m.viewport.getState()

    prevented = false
    fireEvent.wheel(surface, { deltaX: 30, deltaY: 10 }) // 非 Ctrl → panBy(-dx, -dy)
    expect(prevented).toBe(true)
    expect(m.viewport.getState().panX).toBe(afterZoom.panX - 30)
    expect(m.viewport.getState().panY).toBe(afterZoom.panY - 10)

    prevented = false
    fireEvent.wheel(surface, { deltaX: 0, deltaY: 0 }) // 无增量：applyWheel 未消费 → 不拦截
    expect(prevented).toBe(false)
    expect(m.bus.undoDepth()).toBe(0) // 滚轮/平移全程零库写入
  })

  it('空白拖拽平移走 panBy 增量；pointerup 后不再跟随；节点 pointerdown 选中且不起平移', () => {
    const m = mountT46()
    const surface = m.view.getByTestId('mindmap-viewport')
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 130, clientY: 90 })
    expect(m.viewport.getState().panX).toBe(30)
    expect(m.viewport.getState().panY).toBe(-10)
    fireEvent.pointerUp(surface, { pointerId: 1 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 300, clientY: 300 })
    expect(m.viewport.getState().panX).toBe(30) // 抬起后不再跟随

    fireEvent.pointerDown(m.nodeEl('a'), { pointerId: 2, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 50, clientY: 50 })
    expect(m.viewport.getState().panX).toBe(30) // 节点上的按下不起拖拽
    expect(m.selected()).toBe('a')
  })

  it('切换导图清掉 selectedNodeId（T45 遗留修复）', () => {
    const m = mountT46([editTree(), map('m2', '第二图', node('r2', '第二中心'))])
    fireEvent.pointerDown(m.nodeEl('a'))
    expect(m.selected()).toBe('a')
    fireEvent.change(m.view.getByTestId('mindmap-select'), { target: { value: 'm2' } })
    expect(m.selected()).toBeNull()
    fireEvent.change(m.view.getByTestId('mindmap-select'), { target: { value: 'm1' } })
    expect(m.selected()).toBeNull()
  })
})

