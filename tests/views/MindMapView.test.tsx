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
import { buildMindMapModel } from '../../src/domain/mindmapModel'
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
    const badge = view.container.querySelector('[data-mindmap-fold="a"]')
    expect(badge?.textContent).toBe('+2')
    expect(view.container.textContent).not.toContain('子A1')

    // 只读：点击 → 选中环（data-selected-node），不产生命令、不改库
    const before = store.getVault()
    fireEvent.click(view.container.querySelector('[data-mindmap-node="a"]')!)
    expect(view.getByTestId('mindmap-canvas').getAttribute('data-selected-node')).toBe('a')
    expect(store.getVault()).toBe(before)
    expect(bus.undoDepth()).toBe(0)

    // 徽标在 T45 无处理器：点击不改 folded
    fireEvent.click(badge!)
    expect(store.getVault().mindmaps[0]!.root.children[0]!.folded).toBe(true)
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
