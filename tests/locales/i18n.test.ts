// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement, useSyncExternalStore } from 'react'

import { createI18n, interpolate, resolveLocale } from '../../src/locales/i18n'
import type { I18n, LocaleSource } from '../../src/locales/i18n'
import { en } from '../../src/locales/en'
import type { MsgKey } from '../../src/locales/zh'
import type { LocaleSetting } from '../../src/domain/types'

/** spec 附录 A 锁定的术语表：[key, 中文, English]，一条都不能多、一条都不能少。 */
const GLOSSARY: Array<[MsgKey, string, string]> = [
  ['status.todo', '待办', 'To Do'],
  ['status.doing', '进行中', 'In Progress'],
  ['status.review', '评审中', 'In Review'],
  ['status.done', '已完成', 'Done'],
  ['topic', '话题', 'Topic'],
  ['milestone', '里程碑', 'Milestone'],
  ['dependency', '依赖', 'Dependency'],
  ['criticalPath', '关键路径', 'Critical Path'],
  ['baseline', '基线', 'Baseline'],
  ['vault', '数据库', 'Vault'],
  ['workday', '工作日', 'Workday'],
  ['workweek', '工作周', 'Workweek'],
]

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

function fakeLocale(initial: LocaleSetting): { source: LocaleSource; set: (next: LocaleSetting) => void } {
  let setting = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getLocale: () => setting,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    set: (next) => {
      setting = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function Label(props: { i18n: I18n; msgKey: MsgKey }) {
  const locale = useSyncExternalStore(props.i18n.subscribe, props.i18n.getLocale)
  return createElement('span', { 'data-locale': locale }, props.i18n.t(props.msgKey))
}

describe('消息表与键类型', () => {
  it('NestedKeyOf 只产出叶子键，不含 status 这类分支键', () => {
    const keysAreLeaves: Equal<
      MsgKey,
      | 'status.todo'
      | 'status.doing'
      | 'status.review'
      | 'status.done'
      | 'topic'
      | 'milestone'
      | 'dependency'
      | 'criticalPath'
      | 'baseline'
      | 'vault'
      | 'workday'
      | 'workweek'
    > = true
    expect(keysAreLeaves).toBe(true)
  })

  it('en 的键集合与附录 A 完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(GLOSSARY.map(([key]) => key).sort())
  })
})

describe('t() 与插值', () => {
  it('中文表按附录 A 逐字返回', () => {
    const { source } = fakeLocale('zh')
    const i18n = createI18n(source)
    for (const [key, textZh] of GLOSSARY) expect(i18n.t(key)).toBe(textZh)
  })

  it('英文表按附录 A 逐字返回', () => {
    const { source } = fakeLocale('en')
    const i18n = createI18n(source)
    for (const [key, , textEn] of GLOSSARY) expect(i18n.t(key)).toBe(textEn)
  })

  it('替换 {name} 占位符，重复出现也替换', () => {
    expect(interpolate('把事做完，早点下班。{name} 已连接 {vault}', { name: 'OffEarly', vault: '工作库' })).toBe(
      '把事做完，早点下班。OffEarly 已连接 工作库',
    )
    expect(interpolate('{n}/{n}', { n: 2 })).toBe('2/2')
  })

  it('参数缺失时保留占位符原文，无参数时原样返回', () => {
    expect(interpolate('缺少 {count} 项', {})).toBe('缺少 {count} 项')
    expect(interpolate('无占位符 {count}', undefined)).toBe('无占位符 {count}')
  })

  it('t() 把参数交给插值', () => {
    const { source } = fakeLocale('zh')
    const i18n = createI18n(source)
    expect(i18n.t('topic', { ignored: 'x' })).toBe('话题')
  })
})

describe('resolveLocale', () => {
  it('显式设置优先于浏览器语言', () => {
    expect(resolveLocale('zh', 'en-US')).toBe('zh')
    expect(resolveLocale('en', 'zh-CN')).toBe('en')
  })

  it('auto 以 zh 开头判中文，其余判英文', () => {
    for (const language of ['zh-CN', 'zh-TW', 'zh-HK', 'zh']) {
      expect(resolveLocale('auto', language)).toBe('zh')
    }
    for (const language of ['en-US', 'de-DE', 'ja-JP']) {
      expect(resolveLocale('auto', language)).toBe('en')
    }
  })

  it('省略语言时读 navigator.language', () => {
    // jsdom 默认 navigator.language = en-US
    expect(navigator.language).toBe('en-US')
    expect(resolveLocale('auto')).toBe('en')
  })
})

describe('createI18n 的切换与订阅', () => {
  it('locale 来自外部源而非模块常量', () => {
    const a = fakeLocale('zh')
    const b = fakeLocale('en')
    expect(createI18n(a.source).getLocale()).toBe('zh')
    expect(createI18n(b.source).getLocale()).toBe('en')
  })

  it('切换后 t() 返回新语言且订阅者收到一次通知', () => {
    const { source, set } = fakeLocale('zh')
    const i18n = createI18n(source)
    let notified = 0
    i18n.subscribe(() => {
      notified += 1
    })
    set('en')
    expect(i18n.getLocale()).toBe('en')
    expect(i18n.t('status.todo')).toBe('To Do')
    expect(notified).toBe(1)
  })

  it('解析结果没变时不惊动订阅者', () => {
    const { source, set } = fakeLocale('auto')
    const i18n = createI18n(source)
    let notified = 0
    i18n.subscribe(() => {
      notified += 1
    })
    expect(i18n.getLocale()).toBe('en')
    set('en')
    expect(notified).toBe(0)
    set('zh')
    expect(notified).toBe(1)
  })

  it('退订后不再收到通知', () => {
    const { source, set } = fakeLocale('zh')
    const i18n = createI18n(source)
    let notified = 0
    const unsubscribe = i18n.subscribe(() => {
      notified += 1
    })
    unsubscribe()
    set('en')
    expect(notified).toBe(0)
  })
})

describe('视图重渲染', () => {
  afterEach(() => {
    cleanup()
  })

  it('locale 切换让组件文案变化', () => {
    const { source, set } = fakeLocale('zh')
    const i18n = createI18n(source)
    const view = render(createElement(Label, { i18n, msgKey: 'status.review' }))
    expect(view.getByText('评审中').getAttribute('data-locale')).toBe('zh')

    act(() => {
      set('en')
    })
    expect(view.getByText('In Review').getAttribute('data-locale')).toBe('en')
  })
})
