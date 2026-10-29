/**
 * T68 · 知识库两栏宽度：跟着屏幕一起长，而不是钉死在设计稿像素上。
 *
 * 问题：书籍列 176、文档树 248 一直只乘 `--oe-ui-scale`。这个系数是为**字号**标定的
 * （让 11px 正文的物理视高落在 2.8–3.3mm），它保证的是"一行能看多少字"，不是"一栏能放下
 * 多少标题"。于是到了 27" 2K（scale 1.3）上，两栏合计只有 553px、占屏 21%，文档标题
 * 照样被省略号剪断，而右边正文两侧各空出三百多像素——中间一条窄带、两头一片白。
 *
 * 做法：在尺度档之上再乘一个**富余系数**，让两栏吃掉宽屏多出来的横向空间。
 *
 * 为什么按尺度档而不是直接按视口宽度：
 *   · 少一个 resize 监听。`useUiScale()` 已经只在跨档时通知一次，布局重算的频率与
 *     甘特图那类几何计算完全一致，不会在拖窗口时每帧重排；
 *   · 语义也对得上——用户觉得"字大了栏也该宽"和"屏大了栏也该宽"是同一件事。
 *
 * 为什么系数是离散几档而不是等比铺满：
 *   · 与 T40 的裁定同源（用户明确否掉了给缩放滑块这条路）：不同分辨率自动落在
 *     合理大小，不接受逐像素调节；
 *   · 等比铺满会让 5K 屏上的文档树宽到 1000px 以上，一行一个标题反而更难扫。
 *
 * 上限保护：最大档（5K, 2.2 × 1.4）下两栏占屏 25.5%，正文仍有富余；调大系数前先用
 * `capture/t70-*.spec.ts` 在 2560 / 3840 各拍一张，别只看算术。
 */

/** 设计稿基线（scale = 1 时的 CSS px）。 */
export const BOOKS_PANE_WIDTH = 176
export const TREE_PANE_WIDTH = 248

/**
 * 尺度档 → 富余系数。取第一个命中的档，与 `resolveUiScale` 的口径一致：
 * 2560（27" 2K）落在 1.3 档 → 1.35；3840（27" 4K）落在 1.65 档 → 1.4。
 */
export const PANE_GROWTH_BANDS: ReadonlyArray<{ minScale: number; grow: number }> = [
  { minScale: 1.6, grow: 1.4 },
  { minScale: 1.28, grow: 1.35 },
  { minScale: 1.04, grow: 1.2 },
  { minScale: 0, grow: 1 },
]

/** 当前尺度下两栏该乘多少（纯函数，供单测与推演用）。 */
export function paneGrowth(scale: number): number {
  for (const band of PANE_GROWTH_BANDS) {
    if (scale >= band.minScale) return band.grow
  }
  return 1
}

export interface NotebookPaneWidths {
  books: number
  tree: number
}

/**
 * 算出两栏的**整数 CSS 像素**宽度。
 *
 * 返回数字而不是 `sp()` 字符串：两栏宽度要参与「编辑区还剩多少」这类心算，
 * 也是 e2e 里用标题输入框宽度当代理时要对得上的量。取整是为了让相邻两栏的
 * 1px 描边落在设备像素上，避免 0.5px 的半透明分隔线。
 */
export function resolveNotebookPaneWidths(scale: number): NotebookPaneWidths {
  const factor = scale * paneGrowth(scale)
  return {
    books: Math.round(BOOKS_PANE_WIDTH * factor),
    tree: Math.round(TREE_PANE_WIDTH * factor),
  }
}
