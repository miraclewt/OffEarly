import { useSyncExternalStore } from 'react'

import { currentUiScale, subscribeUiScale } from './scale'

/**
 * 订阅当前界面档位（数值）。
 *
 * 只有**要在 JS 里算几何**的组件需要它（甘特的行高 / 列宽 / 导出画布）；
 * 纯样式的组件直接用 `fs()` / `sp()` 即可——浏览器会自己跟着 CSS 变量重算，
 * 不必为此重渲染整棵树。
 */
export function useUiScale(): number {
  return useSyncExternalStore(subscribeUiScale, currentUiScale, currentUiScale)
}
