/**
 * T72 · 知识库左栏宽度：笔记本列已经并进文档树顶部的切换器，只剩一栏要算。
 *
 * 之前是三栏并列（话题 220 / 笔记本 176 / 文档树 248）。1080 宽窗口下正文只剩 436px，
 * 而笔记本列里常常只有两行内容——**每一栏都按"列"的规格收费，实际却是"一行字"的体积**。
 * 现在笔记本降级成文档树头部的一个下拉切换器：切换 / 重命名 / 新建 / 删除的能力一个不少，
 * 但不再单独占一列，正文凭空多出 176px。
 *
 * 宽度仍然跟着屏幕一起长，而不是钉死在设计稿像素上（T68 的原判）：
 *   · 这个系数是为**字号**标定的（让 11px 正文的物理视高落在 2.8–3.3mm），
 *     它保证的是"一行能看多少字"，不是"一栏能放下多少标题"；
 *   · 所以文档树在尺度档之上再乘一个**富余系数**，吃掉宽屏多出来的横向空间。
 *
 * 为什么按尺度档而不是直接按视口宽度：
 *   · 少一个 resize 监听。`useUiScale()` 已经只在跨档时通知一次；
 *   · 语义也对得上——用户觉得"字大了栏也该宽"和"屏大了栏也该宽"是同一件事。
 *
 * 为什么系数是离散几档而不是等比铺满：
 *   · 与 T40 的裁定同源（用户明确否掉了给缩放滑块这条路）；
 *   · 等比铺满会让 5K 屏上的文档树宽到 1000px 以上，一行一个标题反而更难扫。
 *
 * 上限保护：最大档（5K, 2.2 × 1.4）下单栏占屏约 12.5%，正文仍有富余；
 * 调大系数前先用 `capture/` 下的用例在 2560 / 3840 各拍一张，别只看算术。
 */

/** 设计稿基线（scale = 1 时的 CSS px）。 */
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

/** 当前尺度下这一栏该乘多少（纯函数，供单测与推演用）。 */
export function paneGrowth(scale: number): number {
  for (const band of PANE_GROWTH_BANDS) {
    if (scale >= band.minScale) return band.grow
  }
  return 1
}

export interface NotebookPaneWidths {
  tree: number
}

/**
 * 算出文档树栏的**整数 CSS 像素**宽度。
 *
 * 返回数字而不是 `sp()` 字符串：宽度要参与「编辑区还剩多少」这类心算，
 * 也是 e2e 里用标题输入框宽度当代理时要对得上的量。取整是为了让 1px 描边落在
 * 设备像素上，避免 0.5px 的半透明分隔线。
 */
export function resolveNotebookPaneWidths(scale: number): NotebookPaneWidths {
  const factor = scale * paneGrowth(scale)
  return {
    tree: Math.round(TREE_PANE_WIDTH * factor),
  }
}
