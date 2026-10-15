import { en } from './en'
import { zh } from './zh'
import type { MsgKey } from './zh'
import type { LocaleSetting } from '../domain/types'

export type { MsgKey, NestedKeyOf } from './zh'
export type ResolvedLocale = 'zh' | 'en'
export type TranslateParams = Record<string, string | number>

/**
 * locale 由外部提供而不是模块级常量：它存在 Vault 的 settings 里，
 * 切换要能驱动视图重渲染，且启动时要跟着打开的库走（T10 的 VaultStore 即此接口的实现）。
 */
export interface LocaleSource {
  getLocale(): LocaleSetting
  subscribe(listener: () => void): () => void
}

export interface I18n {
  getLocale(): ResolvedLocale
  t(key: MsgKey, params?: TranslateParams): string
  subscribe(listener: () => void): () => void
}

/** zh 是嵌套表，en 是扁平表；统一拉平后查表不需要分结构处理。 */
function flatten(node: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') out[path] = value
    else Object.assign(out, flatten(value as Record<string, unknown>, path))
  }
  return out
}

const tables: Record<ResolvedLocale, Record<MsgKey, string>> = {
  zh: flatten(zh as Record<string, unknown>) as Record<MsgKey, string>,
  en,
}

/** 只替换 `{token}`，模板里出现但参数没给的占位符原样留着，便于发现漏传。 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  )
}

export function resolveLocale(
  setting: LocaleSetting,
  language: string = navigator.language,
): ResolvedLocale {
  if (setting !== 'auto') return setting
  return language.startsWith('zh') ? 'zh' : 'en'
}

export function createI18n(source: LocaleSource): I18n {
  let resolved = resolveLocale(source.getLocale())
  const listeners = new Set<() => void>()

  source.subscribe(() => {
    const next = resolveLocale(source.getLocale())
    // 'auto' 与显式值可能解析出同一门语言，这种情况不该惊动视图
    if (next === resolved) return
    resolved = next
    for (const listener of listeners) listener()
  })

  return {
    getLocale: () => resolved,
    t: (key, params) => interpolate(tables[resolved][key], params),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
