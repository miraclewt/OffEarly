// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Vault } from '../../src/domain/types'
import { createI18n } from '../../src/locales/i18n'
import { AUTOSAVE_DEBOUNCE_MS, createAutosave } from '../../src/persistence/autosave'
import type { Autosave, AutosaveStore, SaveState } from '../../src/persistence/autosave'
import { createNewVault } from '../../src/persistence/vaultRepository'
import { SaveIndicator } from '../../src/views/SaveIndicator'
import type { SaveIndicatorSource } from '../../src/views/SaveIndicator'

const NOW = new Date('2026-10-15T09:30:00.000Z')

function i18nZh() {
  return createI18n({ getLocale: () => 'zh', subscribe: () => () => {} })
}

function i18nEn() {
  return createI18n({ getLocale: () => 'en', subscribe: () => () => {} })
}

/** 最小假控制器源：只负责把三态推到组件上。 */
function fakeSource(initial: SaveState = 'saved') {
  let state = initial
  let retries = 0
  const listeners = new Set<() => void>()
  function emit() {
    for (const listener of [...listeners]) listener()
  }
  return {
    retries: () => retries,
    source: {
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      getState: () => state,
      async retry() {
        retries += 1
        state = 'saved'
        emit()
      },
    } satisfies SaveIndicatorSource,
    set(next: SaveState) {
      state = next
      emit()
    },
  }
}

/** 真 Autosave + 最小假 Store/假落盘：用来验证指示灯确实跟着保存循环走。 */
function harness() {
  let vault: Vault = createNewVault(NOW)
  let failing = false
  const listeners = new Set<() => void>()
  const writes: Vault[] = []
  function emit() {
    for (const listener of [...listeners]) listener()
  }
  const store: AutosaveStore = {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVault: () => vault,
    markSaved(revision, updatedAt) {
      vault = { ...vault, revision, updatedAt }
      emit()
      return vault
    },
  }
  const autosave: Autosave = createAutosave({
    store,
    sink: {
      async save(next) {
        if (failing) throw new Error('disk full')
        writes.push(next)
      },
    },
    now: () => NOW,
  })
  autosave.start()
  return {
    autosave,
    writes,
    failWith(value: boolean) {
      failing = value
    },
    addTask(title: string) {
      vault = {
        ...vault,
        tasks: [
          ...vault.tasks,
          {
            id: `t-${title}`,
            topicId: 'topic-1',
            title,
            status: 'todo' as const,
            kind: 'feature' as const,
            priority: 'P1' as const,
            progress: 0,
            tags: [],
            note: '',
            order: 'm',
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            archived: false,
          },
        ],
      }
      emit()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('三态文案与结构', () => {
  it('saved / dirty / error 三态各显示对应中文，data-state 同步', () => {
    const fake = fakeSource()
    const view = render(<SaveIndicator autosave={fake.source} t={i18nZh().t} />)
    const el = view.getByTestId('save-indicator')

    expect(el.getAttribute('data-state')).toBe('saved')
    expect(view.getByText('已保存')).toBeDefined()
    expect(view.queryByRole('button')).toBeNull()

    act(() => {
      fake.set('dirty')
    })
    expect(el.getAttribute('data-state')).toBe('dirty')
    expect(view.getByText('未保存')).toBeDefined()
    expect(view.queryByRole('button')).toBeNull()

    act(() => {
      fake.set('error')
    })
    expect(el.getAttribute('data-state')).toBe('error')
    expect(view.getByText('保存失败')).toBeDefined()
    expect(view.getByRole('button', { name: '重试' })).toBeDefined()
  })

  it('英文环境下三态文案切换', () => {
    const fake = fakeSource('dirty')
    const view = render(<SaveIndicator autosave={fake.source} t={i18nEn().t} />)

    expect(view.getByText('Unsaved')).toBeDefined()
    act(() => {
      fake.set('error')
    })
    expect(view.getByText('Save failed')).toBeDefined()
    expect(view.getByRole('button', { name: 'Retry' })).toBeDefined()
  })

  it('点重试会调用控制器并在成功后回到已保存', async () => {
    const fake = fakeSource('error')
    const view = render(<SaveIndicator autosave={fake.source} t={i18nZh().t} />)

    await act(async () => {
      view.getByRole('button', { name: '重试' }).click()
    })

    expect(fake.retries()).toBe(1)
    expect(view.getByText('已保存')).toBeDefined()
    expect(view.queryByRole('button')).toBeNull()
  })
})

describe('与真 Autosave 联动', () => {
  it('编辑后显示未保存，debounce 到期落盘后回到已保存', async () => {
    const h = harness()
    const view = render(<SaveIndicator autosave={h.autosave} t={i18nZh().t} />)
    expect(view.getByText('已保存')).toBeDefined()

    await act(async () => {
      h.addTask('A')
    })
    expect(view.getByText('未保存')).toBeDefined()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS)
    })
    expect(view.getByText('已保存')).toBeDefined()
    expect(h.writes).toHaveLength(1)

    h.autosave.stop()
  })

  it('保存失败显示保存失败与重试，修复后点重试恢复已保存', async () => {
    const h = harness()
    h.failWith(true)
    const view = render(<SaveIndicator autosave={h.autosave} t={i18nZh().t} />)

    await act(async () => {
      h.addTask('A')
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS)
    })
    expect(view.getByText('保存失败')).toBeDefined()
    expect(h.writes).toHaveLength(0)

    h.failWith(false)
    await act(async () => {
      view.getByRole('button', { name: '重试' }).click()
    })

    expect(view.getByText('已保存')).toBeDefined()
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]?.tasks.map((task) => task.title)).toEqual(['A'])

    h.autosave.stop()
  })
})
