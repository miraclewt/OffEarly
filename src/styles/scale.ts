/**
 * T40 · 界面尺度：让同一份界面在不同分辨率/DPI 下都保持"合理的大小"
 *
 * 问题：全库 180+ 处字号都是内联的裸像素（`fontSize: 11`）。裸 px 的物理大小
 * 完全由屏幕决定 —— 27" 4K 全屏时 11px 只有 1080p 上的 56%，小到看不清；
 * 而用户改浏览器默认字号、改系统文本缩放，对这些显式 px 一律无效。
 *
 * 做法分两层：
 *   ① **换算**：`fs(11)` / `sp(8)` 把设计稿里的像素值展开成
 *      `calc(11px * var(--oe-ui-scale))`。保留原始数值（改造是机械的、可回滚的），
 *      只让它跟着一个全局旋钮走。字号用 `fs`、间距/尺寸用 `sp`，实现相同，
 *      分开只为读代码时知道这一处是"字"还是"空"。
 *   ② **判定**：`installUiScale()` 在启动与窗口尺寸变化时按视口宽度算出档位，
 *      写到 `:root` 的 `--oe-ui-scale`。
 *
 * 为什么按"视口宽度"判定就够：
 *   CSS px 的物理大小 = 25.4 × devicePixelRatio / PPI，而视口宽度 = 物理宽 / dpr。
 *   系统缩放（dpr）已经把高 DPI 屏折算成等效视口了 —— 27" 4K@150% 的视口是 2560，
 *   正好等于 27" 2K@100%；两者 CSS px 的物理大小都是 0.233mm。所以"视口宽 + 假设
 *   屏幕尺寸随分辨率增长"的分档，能把这几类常见组合都归到同一档，不需要屏幕对角线。
 *
 * 为什么是离散档而不是连续缩放：
 *   甘特图的行虚拟化窗口、dnd-kit 的落点测量、PNG 导出的 2x 画布都依赖确定的像素值，
 *   连续缩放会让它们在拖动中反复重算并漂移。档位切换只在跨过阈值时发生一次。
 *
 * 注意：**这里只管"多大"**。真正的布局降级（窄屏收侧栏、看板横向滚）是另一层，
 * 不靠放大缩小解决。
 */

/** 字号（font-size 设计值 → 跟随全局尺度）。 */
export function fs(px: number): string {
  return `calc(${px}px * var(--oe-ui-scale, 1))`
}

/** 间距与尺寸（padding / gap / 行高 / 侧栏宽…），与字号同源，保证"字大了空也大"。 */
export function sp(px: number): string {
  return `calc(${px}px * var(--oe-ui-scale, 1))`
}

const PX_IN_STRING = /(-?\d+(?:\.\d+)?)px/g

/**
 * 把 CSS 简写字符串里的像素一起换算：`px('0 16px')` → `'0 calc(16px * var(…))'`。
 *
 * 两类**刻意不缩放**的：
 *   · 边框宽度（`1px solid`）——放大到 1.65px 会发虚，描边保持物理 1 设备像素更清晰；
 *   · `blur(...)` 半径——那是视觉柔化，不是布局尺寸，跟着放大会同时放大合成开销。
 */
export function px(value: string): string {
  return value.replace(PX_IN_STRING, (match, num: string, offset: number) => {
    const after = value.slice(offset + match.length, offset + match.length + 10)
    if (/^\s+(solid|dashed|dotted|double)/.test(after)) return match
    if (/blur\(\s*$/.test(value.slice(0, offset))) return match
    if (num === '0') return match
    return `calc(${num}px * var(--oe-ui-scale, 1))`
  })
}

/**
 * 档位表：以视口 CSS 宽度为界，从宽到窄取第一个命中的档。
 *
 * 标定方法：让"11px 正文"在任何屏上的物理视高落在 **2.8–3.3mm**。
 * 锚点 24" 1080p@100%（0.277mm/CSS px），下表末列即此推算值：
 *
 *   视口（场景）                         mm/CSS px   scale   11px 视高
 *   1920  24" 1080p@100%                  0.277      1.05     3.20mm
 *   2560  27" 2K@100% / 4K@150%           0.233      1.30     3.33mm
 *   3840  27" 4K@100%                     0.156      1.65     2.83mm
 *   5120  27" 5K@100%                     0.117      2.20     2.82mm
 *   1280  14" 1080p@150%（视口窄但 px 大） 0.242      0.95     2.53mm
 *
 * 三个刻意的取舍（都是用户实测拍板的，别再"修正"回去）：
 *   · 4K 给 1.65 而非"打平 1080p"所需的 1.67，更不是 1.8 —— 1.5 被判定"偏小"、
 *     1.8 被判定"太大"，1.65 是两者之间唯一没被否的落点；
 *   · 4K / 5K 档比 1080p **略小**（2.83 vs 3.20mm）：高 DPI 屏的物理尺寸大，
 *     留一点密度让一屏多看几行，比严格打平更讨喜；
 *   · 1280 档不再往下缩：视口窄通常意味着高 DPI 小屏，那里 CSS px 本身就有 0.24mm。
 */
export const UI_SCALE_BANDS: ReadonlyArray<{ minWidth: number; scale: number }> = [
  { minWidth: 4800, scale: 2.2 },
  { minWidth: 3400, scale: 1.65 },
  { minWidth: 2500, scale: 1.3 },
  { minWidth: 2100, scale: 1.15 },
  { minWidth: 1800, scale: 1.05 },
  { minWidth: 1350, scale: 1 },
  { minWidth: 0, scale: 0.95 },
]

/** 由视口宽度判定缩放档（纯函数，便于测试与手动覆盖）。 */
export function resolveUiScale(width: number): number {
  for (const band of UI_SCALE_BANDS) {
    if (width >= band.minWidth) return band.scale
  }
  return 1
}

/**
 * 本机试档用的临时覆盖：`OffEarly.html?uiScale=1.65`。
 *
 * 分档表只能按"视口宽≈屏幕尺寸"的统计假设去猜，永远猜不准某一个人的屏；
 * 挨个改数字重新构建又太慢。所以在 URL 上留一个口子，用来在自己的显示器上
 * 一眼比对——**不落盘、不进设置、不影响别人**，刷新即失效。
 * 合法区间 0.8–2.4，越界或非数字一律忽略（回退到自动分档）。
 */
export function readScaleOverride(win: Window): number | null {
  let raw: string | null = null
  try {
    raw = new URLSearchParams(win.location?.search ?? '').get('uiScale')
  } catch {
    return null
  }
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0.8 || value > 2.4) return null
  return value
}

export interface UiScaleHandle {
  /** 当前生效的缩放值。 */
  current(): number
  /** 解除监听并恢复默认值（主要给测试与热更新用）。 */
  dispose(): void
}

/**
 * JS 侧的当前档位。
 *
 * 样式表里的 `calc(… * var(--oe-ui-scale))` 是浏览器自己解的，React 不用管；
 * 但**甘特图这类要在 JS 里做几何运算的**（行虚拟化按行高除、箭头拐点、PNG 导出画布）
 * 必须拿到同一个数字，否则"字放大了、行没放开"就会被裁切。所以同一个档位
 * 既写进 CSS 变量，也留在模块状态里，由 `pxNum()` 取用。
 *
 * 默认 1：单测（jsdom）里没人调 `installUiScale`，一切按设计稿像素跑。
 */
let activeScale = 1
const scaleListeners = new Set<() => void>()

export function currentUiScale(): number {
  return activeScale
}

/** 订阅档位变化（`useUiScale` 就是包了它一层的 React 钩子）。 */
export function subscribeUiScale(listener: () => void): () => void {
  scaleListeners.add(listener)
  return () => {
    scaleListeners.delete(listener)
  }
}

function setActiveScale(next: number): void {
  if (next === activeScale) return
  activeScale = next
  for (const listener of [...scaleListeners]) listener()
}

/** 给 JS 侧的数值换算：`pxNum(GANTT_ROW_HEIGHT)`。 */
export function pxNum(value: number): number {
  return value * activeScale
}

/**
 * 把档位写到 `:root` 的 `--oe-ui-scale`，并在窗口尺寸变化时跟随。
 *
 * - 只在档位**真正变化**时写样式，避免拖窗口时每帧触发整棵树重算；
 * - 首帧同步写入（在 `createRoot` 之前调用），避免"先小后大"的闪动；
 * - 同时写 `data-ui-scale` 便于 e2e 与人工核对当前档；
 * - 带 `?uiScale=` 时以 URL 为准，且不再跟随窗口变化（试档用，见 `readScaleOverride`）。
 */
export function installUiScale(win: Window = window): UiScaleHandle {
  const doc = win.document
  const root = doc.documentElement
  const forced = readScaleOverride(win)
  let current = forced ?? resolveUiScale(win.innerWidth)
  let frame = 0

  const write = () => {
    root.style.setProperty('--oe-ui-scale', String(current))
    root.dataset['uiScale'] = String(current)
    setActiveScale(current)
  }

  const measure = () => {
    frame = 0
    if (forced !== null) return
    const next = resolveUiScale(win.innerWidth)
    if (next === current) return
    current = next
    write()
  }

  const schedule = () => {
    if (frame !== 0) return
    frame = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(measure) : win.setTimeout(measure, 16)
  }

  write()
  win.addEventListener('resize', schedule)

  return {
    current: () => current,
    dispose: () => {
      win.removeEventListener('resize', schedule)
      if (frame === 0) return
      if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frame)
      else win.clearTimeout(frame)
      frame = 0
    },
  }
}
