// VaultStore：唯一状态源（spec 3「三条硬规则」第 1、2 条）。
//
// 纯 TS、零 React —— React 侧用 `useStore(store, selector)`（zustand/react）订阅切片。
// 本模块只依赖 zustand 与 ./types，刻意不 import `persistence/`：
// T04 的 LocaleSource 与 T08 的 AutosaveStore 都是结构化端口，VaultStore 靠形状满足它们，
// 不需要（也不允许）反向依赖上层。
//
// 不可变语义：所有改动都产生新的 vault 对象与新的数组/对象引用，
// 这样 selector 订阅可以用引用比较做「改 task 不惊动 topic 订阅者」的精确裁剪。

import { subscribeWithSelector } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'

import type { LocaleSetting, Vault } from './types'

export interface VaultStoreState {
  vault: Vault
}

export interface VaultStore {
  getState(): VaultStoreState
  getInitialState(): VaultStoreState
  /**
   * 任何变更都通知（T08 autosave 与 T04 LocaleSource 用的就是这个面）。
   * 签名照 zustand 原样带上 (state, prevState)：只收 `() => void` 的函数照样能传进来，
   * 而收窄成 0 参会让 zustand 的 `useStore` 判为不兼容。
   */
  subscribe(listener: (state: VaultStoreState, previous: VaultStoreState) => void): () => void
  /** 只有选中切片变化才通知；缺省 Object.is 比较，切片是数组/对象时传 equals。 */
  subscribeSelector<S>(
    selector: (state: VaultStoreState) => S,
    listener: (slice: S, previous: S) => void,
    equals?: (a: S, b: S) => boolean,
  ): () => void
  getVault(): Vault
  /** T04 LocaleSource：locale 存在库里，跟着打开的库走。 */
  getLocale(): LocaleSetting
  setVault(next: Vault): void
  update(recipe: (vault: Vault) => Vault): void
  /**
   * T08 AutosaveStore 的契约：保存成功后回写 revision/updatedAt，并返回 Store 现在持有的
   * 那个对象（autosave 靠引用相等识别「这条通知是我自己造成的」）。
   * 只动元数据、不换内容 —— 写盘期间用户可能又改了东西，整体替换会把它吞掉。
   */
  markSaved(revision: number, updatedAt: string): Vault
}

export function createVaultStore(initial: Vault): VaultStore {
  const store = createStore<VaultStoreState>()(subscribeWithSelector(() => ({ vault: initial })))

  return {
    getState: store.getState,
    getInitialState: store.getInitialState,
    subscribe: store.subscribe,
    subscribeSelector: (selector, listener, equals) =>
      store.subscribe(selector, listener, equals === undefined ? undefined : { equalityFn: equals }),
    getVault: () => store.getState().vault,
    getLocale: () => store.getState().vault.settings.locale,
    setVault: (next) => store.setState({ vault: next }),
    update: (recipe) => store.setState((state) => ({ vault: recipe(state.vault) })),
    markSaved: (revision, updatedAt) => {
      const next = { ...store.getState().vault, revision, updatedAt }
      store.setState({ vault: next })
      return next
    },
  }
}
