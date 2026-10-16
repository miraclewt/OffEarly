/**
 * 全站线性图标 sprite（spec 8.4）：单一 `<symbol>` 定义 + `<use>` 引用，零网络请求、零 emoji。
 * 描边语言集中在 symbol 上：1.5px、round cap/join、fill none；颜色走 currentColor，由使用处的文字色决定。
 */

const ICON_GEOMETRY = {
  chevron: ['M6 9.5 L12 15.5 L18 9.5'],
  'chevron-right': ['M9.5 6 L15.5 12 L9.5 18'],
  search: [circle(11, 11, 7), 'M16.2 16.2 L21 21'],
  undo: ['M8 5.5 L3.5 10 L8 14.5', 'M3.5 10 H15 A5 5 0 0 1 15 20 H9'],
  redo: ['M16 5.5 L20.5 10 L16 14.5', 'M20.5 10 H9 A5 5 0 0 0 9 20 H15'],
  export: [
    'M12 3.5 V14',
    'M8 7.5 L12 3.5 L16 7.5',
    'M4 15.5 V19.5 A1.5 1.5 0 0 0 5.5 21 H18.5 A1.5 1.5 0 0 0 20 19.5 V15.5',
  ],
  download: [
    'M12 4 V14.5',
    'M8 10.5 L12 14.5 L16 10.5',
    'M4 15.5 V19.5 A1.5 1.5 0 0 0 5.5 21 H18.5 A1.5 1.5 0 0 0 20 19.5 V15.5',
  ],
  'zoom-in': [circle(11, 11, 7), 'M16.2 16.2 L21 21', 'M8 11 H14', 'M11 8 V14'],
  'zoom-out': [circle(11, 11, 7), 'M16.2 16.2 L21 21', 'M8 11 H14'],
  filter: ['M4 5 H20 L14.5 12 V19 L9.5 16.5 V12 Z'],
  backup: [
    ellipse(12, 6.25, 7, 2.75),
    'M5 6.25 V17.75',
    'M19 6.25 V17.75',
    'M5 12 A7 2.75 0 0 0 19 12',
    'M5 17.75 A7 2.75 0 0 0 19 17.75',
  ],
  settings: [
    'M4 7 H9.3',
    'M14.7 7 H20',
    'M4 17 H6.3',
    'M11.7 17 H20',
    circle(12, 7, 2.7),
    circle(9, 17, 2.7),
  ],
  note: [
    'M14 3 H6.5 A1.5 1.5 0 0 0 5 4.5 V19.5 A1.5 1.5 0 0 0 6.5 21 H17.5 A1.5 1.5 0 0 0 19 19.5 V8 Z',
    'M14 3 V8 H19',
    'M8.5 13 H15.5',
    'M8.5 17 H13',
  ],
  dependency: [
    circle(5.5, 5.5, 3),
    circle(18.5, 18.5, 3),
    'M7.6 7.6 L16.3 16.3',
    'M15.3 13.3 L16.3 16.3 L13.3 15.3',
  ],
  milestone: ['M12 4 L19.5 12 L12 20 L4.5 12 Z'],
  attach: [
    'M20.4 12.05 L11.9 20.55 A5.5 5.5 0 0 1 4.1 12.75 L12.6 4.25 A4 4 0 0 1 18.26 9.91 L9.76 18.41 A2.5 2.5 0 0 1 6.22 14.87 L14.02 7.07',
  ],
  image: [
    roundRect(3, 5, 18, 14, 1.5),
    circle(8.5, 10, 1.8),
    'M4.5 17 L9.5 12 L13 15.5 L16 13 L19.5 16.5',
  ],
  bold: [
    'M7.5 4.5 H13 A3.75 3.75 0 0 1 13 12 H7.5 Z',
    'M7.5 12 H14 A4 4 0 0 1 14 20 H7.5 Z',
  ],
  italic: ['M19 4.5 H10', 'M15 4.5 L9 19.5', 'M14 19.5 H5'],
  strike: [
    'M4 12 H20',
    'M15.8 7.4 C15.4 5.1 13.2 4 11 4.6 C8.6 5.2 7.4 7.4 8.2 9.4 C8.8 11 10.6 11.6 12.4 12.6 C14.6 13.8 15.6 15.6 14.6 17.6 C13.6 19.4 11 19.8 9 18.8 C7.6 18.1 6.9 16.8 7 15.4',
  ],
  code: ['M8.5 7.5 L4 12 L8.5 16.5', 'M15.5 7.5 L20 12 L15.5 16.5'],
  'list-ol': [
    'M3.6 5.2 L5.4 4 V8.6',
    'M3.4 10.8 A1.7 1.7 0 1 1 6.2 12.4 L3.4 14.8 H6.6',
    'M3.4 16.2 A1.7 1.7 0 1 1 5.6 18 A1.7 1.7 0 1 1 3.4 19.8',
    'M9 6 H20',
    'M9 12 H20',
    'M9 18 H20',
  ],
  'list-ul': [
    circle(4.75, 6, 1.4),
    circle(4.75, 12, 1.4),
    circle(4.75, 18, 1.4),
    'M9 6 H20',
    'M9 12 H20',
    'M9 18 H20',
  ],
  'list-task': [
    roundRect(2.5, 3, 6, 6, 1.2),
    'M4 6.2 L5.4 7.6 L8 5',
    roundRect(2.5, 15, 6, 6, 1.2),
    'M11.5 6 H20',
    'M11.5 18 H20',
  ],
  quote: ['M4.5 5 V19', 'M9 8.5 H20', 'M9 15.5 H16'],
  // T24 变更提议追加（T05 图标集缺 3 个笔记工具栏符号：代码块 / H2 / H3）；
  // 只增不改，沿用既有 24×24、1.5px 描边语言。
  'code-block': [
    roundRect(3, 4.5, 18, 15, 2),
    'M10.2 9.8 L8 12 L10.2 14.2',
    'M13.8 9.8 L16 12 L13.8 14.2',
  ],
  'heading-2': [
    'M4.5 6 V18',
    'M11.5 6 V18',
    'M4.5 12 H11.5',
    'M14.5 9 A1.7 1.7 0 1 1 17.3 10.6 L14.5 13 H17.7',
  ],
  'heading-3': [
    'M4.5 6 V18',
    'M11.5 6 V18',
    'M4.5 12 H11.5',
    'M14.5 9 A1.7 1.7 0 1 1 16.7 10.8 A1.7 1.7 0 1 1 14.5 12.6',
  ],
  link: [
    'M9.7 14.3 L14.3 9.7',
    'M10 13 A5 5 0 0 0 17.54 13.54 L20.54 10.54 A5 5 0 0 0 13.47 3.47 L11.75 5.18',
    'M14 11 A5 5 0 0 0 6.46 10.46 L3.46 13.46 A5 5 0 0 0 10.53 20.53 L12.24 18.82',
  ],
  table: [
    roundRect(3, 4.5, 18, 15, 1.5),
    'M3 9.5 H21',
    'M9.5 9.5 V19.5',
    'M15.5 9.5 V19.5',
  ],
  divider: ['M4 12 H20', 'M4 7.5 V16.5', 'M20 7.5 V16.5'],
  close: ['M6.5 6.5 L17.5 17.5', 'M17.5 6.5 L6.5 17.5'],
  plus: ['M12 5 V19', 'M5 12 H19'],
  calendar: [roundRect(3, 5, 18, 16, 1.5), 'M3 10 H21', 'M8 3 V6.5', 'M16 3 V6.5'],
  clock: [circle(12, 12, 8.5), 'M12 7.5 V12 H15.75'],
} as const satisfies Record<string, readonly string[]>

export type IconName = keyof typeof ICON_GEOMETRY

export const ICON_NAMES = Object.keys(ICON_GEOMETRY) as IconName[]

/** 24 网格上以两段半圆弧闭合的圆，全部图形只用 path，方便描边语言统一。 */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx} ${cy - r} A${r} ${r} 0 1 1 ${cx} ${cy + r} A${r} ${r} 0 1 1 ${cx} ${cy - r} Z`
}

function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`
}

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const right = x + w
  const bottom = y + h
  return (
    `M${x + r} ${y} H${right - r} A${r} ${r} 0 0 1 ${right} ${y + r}` +
    ` V${bottom - r} A${r} ${r} 0 0 1 ${right - r} ${bottom}` +
    ` H${x + r} A${r} ${r} 0 0 1 ${x} ${bottom - r}` +
    ` V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`
  )
}

export const ICON_STROKE_WIDTH = 1.5

export function iconSymbolId(name: IconName): string {
  return `oe-icon-${name}`
}

/** 挂在应用根节点一次即可（T07 启动流程接入），全站图标共用这张表。 */
export function IconSprite() {
  return (
    <svg data-icon-sprite="true" aria-hidden="true" style={{ display: 'none' }}>
      {ICON_NAMES.map((name) => (
        <symbol
          key={name}
          id={iconSymbolId(name)}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={ICON_STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {ICON_GEOMETRY[name].map((d) => (
            <path key={d} d={d} />
          ))}
        </symbol>
      ))}
    </svg>
  )
}

export interface IconProps {
  name: IconName
  size?: number
  /** 省略即视为装饰性图标，对辅助技术隐藏。 */
  label?: string
  className?: string
}

export function Icon({ name, size = 16, label, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? 'true' : undefined}
    >
      <use href={`#${iconSymbolId(name)}`} />
    </svg>
  )
}
