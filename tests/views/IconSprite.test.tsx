// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Icon, IconSprite, ICON_NAMES, iconSymbolId } from '../../src/views/IconSprite'
import type { IconName } from '../../src/views/IconSprite'

const REQUIRED: readonly IconName[] = [
  'chevron',
  'search',
  'undo',
  'redo',
  'export',
  'download',
  'zoom-in',
  'zoom-out',
  'filter',
  'backup',
  'settings',
  'note',
  'dependency',
  'milestone',
  'attach',
  'image',
  'bold',
  'italic',
  'strike',
  'code',
  'list-ol',
  'list-ul',
  'list-task',
  'quote',
  'link',
  'table',
  'divider',
  'close',
  'plus',
  'calendar',
  'clock',
]

describe('ICON_NAMES', () => {
  it('覆盖验收清单的全部图标且不少于 24 个', () => {
    for (const name of REQUIRED) expect(ICON_NAMES).toContain(name)
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(24)
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length)
  })

  it('id 唯一且带命名空间前缀', () => {
    const ids = ICON_NAMES.map(iconSymbolId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^oe-icon-[a-z0-9-]+$/)
  })
})

describe('IconSprite', () => {
  it('每个图标都是 1.5px 圆头描边、无填充的 symbol', () => {
    const { container } = render(<IconSprite />)
    const root = container.querySelector('svg[data-icon-sprite="true"]')
    expect(root).not.toBeNull()
    expect(root!.getAttribute('aria-hidden')).toBe('true')

    for (const name of ICON_NAMES) {
      const symbol = container.querySelector(`symbol#${CSS.escape(iconSymbolId(name))}`)
      expect(symbol, `symbol for ${name}`).not.toBeNull()
      expect(symbol!.getAttribute('viewBox')).toBe('0 0 24 24')
      expect(symbol!.getAttribute('stroke-width')).toBe('1.5')
      expect(symbol!.getAttribute('stroke-linecap')).toBe('round')
      expect(symbol!.getAttribute('stroke-linejoin')).toBe('round')
      expect(symbol!.getAttribute('fill')).toBe('none')
      expect(symbol!.getAttribute('stroke')).toBe('currentColor')

      const shapes = Array.from(symbol!.children)
      expect(shapes.length, `${name} has paths`).toBeGreaterThan(0)
      for (const shape of shapes) {
        expect(shape.tagName.toLowerCase(), `${name} shape tag`).toBe('path')
        expect(shape.getAttribute('d')).toMatch(/\S/)
        // 描边语言由 symbol 统一持有，子路径不得自带填充/描边（否则出现填充块）
        expect(shape.getAttribute('fill'), `${name} 自带 fill`).toBeNull()
        expect(shape.getAttribute('stroke'), `${name} 自带 stroke`).toBeNull()
      }
    }
  })

  it('sprite 本身不占布局', () => {
    const { container } = render(<IconSprite />)
    const root = container.querySelector('svg[data-icon-sprite="true"]') as SVGElement
    expect(root.style.display).toBe('none')
  })
})

describe('Icon', () => {
  it('通过 use 引用 symbol，尺寸可配', () => {
    const { container } = render(<Icon name="clock" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    const use = svg.querySelector('use')!
    expect(use.getAttribute('href')).toBe(`#${iconSymbolId('clock')}`)

    const big = render(<Icon name="clock" size={24} />).container.querySelector('svg')!
    expect(big.getAttribute('width')).toBe('24')
  })

  it('装饰性图标对辅助技术隐藏，带 label 时暴露', () => {
    const decorative = render(<Icon name="close" />).container.querySelector('svg')!
    expect(decorative.getAttribute('aria-hidden')).toBe('true')
    expect(decorative.hasAttribute('role')).toBe(false)

    const labelled = render(<Icon name="backup" label="备份" />).container.querySelector('svg')!
    expect(labelled.getAttribute('role')).toBe('img')
    expect(labelled.getAttribute('aria-label')).toBe('备份')
    expect(labelled.hasAttribute('aria-hidden')).toBe(false)
  })

  it('图标名不含 emoji 字符', () => {
    for (const name of ICON_NAMES) expect(/[\u{1F000}-\u{1FAFF}]/u.test(name)).toBe(false)
  })
})
