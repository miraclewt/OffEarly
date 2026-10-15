/**
 * T32 · 假目录（File System Access API 的替身）
 *
 * 为什么必须有它：`showDirectoryPicker()` 弹的是**操作系统原生**目录选择框，
 * 任何浏览器自动化都点不到它——所以「连接数据文件夹」这一下无法原样自动化。
 *
 * 这里只替换「选目录」这一个动作：注入一个内存目录树，让 `showDirectoryPicker()`
 * 直接返回它。之后所有环节——`vault.json` 的读写、autosave、revision 冲突检测、
 * 保存前备份到 `.backup/`、`assets/` 写入——跑的都是**产品代码**，没有打桩。
 *
 * 目录树状态挂在 `window.__oe_fs` 上，**由测试显式接管**：
 * 测试可以读完 `page.evaluate` 拿到落盘快照，再在 `reload()` 前用
 * `seedFakeFs()` 把它塞回新页面，从而验证「重开数据还在」。刻意不依赖
 * `localStorage`——`file://` 下的存储配额与来源策略在浏览器间并不一致。
 */
import type { Page } from '@playwright/test'

/** 文件用 base64 存，保持与真实磁盘一致的**字节**语义（readHead 依赖字节切片）。 */
export interface FakeFsState {
  /** 路径 -> base64。路径以 `/` 分隔，不含前导斜杠。 */
  files: Record<string, string>
  /** 显式存在过的目录路径（空目录也要能列出来）。 */
  dirs: string[]
}

export const EMPTY_FS: FakeFsState = { files: {}, dirs: [] }

/** 页面内的树根键名，测试用同一常量取值。 */
export const FS_KEY = '__oe_fs'

export function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

export function fromBase64(data: string): string {
  return Buffer.from(data, 'base64').toString('utf8')
}

/** 把一棵目录树种进下一个页面（必须在 goto/reload 之前调用）。 */
export async function seedFakeFs(page: Page, state: FakeFsState): Promise<void> {
  await page.addInitScript((seed: FakeFsState) => {
    ;(window as unknown as Record<string, unknown>).__oe_fs = JSON.parse(
      JSON.stringify(seed),
    ) as FakeFsState
  }, state)
}

/** 读取页面里当前的目录树（即「磁盘」上的真实内容）。 */
export async function readFakeFs(page: Page): Promise<FakeFsState> {
  return page.evaluate((key: string) => {
    const state = (window as unknown as Record<string, unknown>)[key]
    return JSON.parse(JSON.stringify(state)) as FakeFsState
  }, FS_KEY)
}

/** 直接写入一个文件（模拟「另一端改了磁盘」）。 */
export async function writeFakeFile(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(
    ({ key, target, content }: { key: string; target: string; content: string }) => {
      const state = (window as unknown as Record<string, unknown>)[key] as FakeFsState
      state.files[target] = btoa(String.fromCharCode(...new TextEncoder().encode(content)))
    },
    { key: FS_KEY, target: path, content: text },
  )
}

/** 安装 `showDirectoryPicker` 替身。 */
export async function installFakeDirectoryPicker(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    interface State {
      files: Record<string, string>
      dirs: string[]
    }

    const root = (): State => {
      const store = (window as unknown as Record<string, unknown>)[key]
      if (store === undefined) throw new Error('fakeFs: 未调用 seedFakeFs()')
      return store as State
    }

    const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)

    const notFound = (path: string): Error => {
      const error = new Error(`fakeFs: 找不到 ${path}`)
      error.name = 'NotFoundError'
      return error
    }

    const encode = (bytes: Uint8Array): string => {
      let text = ''
      for (const byte of bytes) text += String.fromCharCode(byte)
      return btoa(text)
    }

    const decode = (text: string): Uint8Array => {
      const binary = atob(text)
      const out = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
      return out
    }

    const exists = (path: string): boolean => {
      if (path === '') return true
      const state = root()
      if (state.dirs.includes(path)) return true
      return Object.keys(state.files).some((p) => p.startsWith(`${path}/`))
    }

    function makeFileHandle(name: string, path: string) {
      return {
        kind: 'file' as const,
        name,
        async getFile(): Promise<File> {
          const stored = root().files[path]
          if (stored === undefined) throw notFound(path)
          return new File([decode(stored)] as BlobPart[], name, {
            type: 'application/octet-stream',
          })
        },
        async createWritable() {
          let buffer = new Uint8Array(0)
          return {
            async write(data: string | Uint8Array): Promise<void> {
              const chunk = typeof data === 'string' ? new TextEncoder().encode(data) : data
              const next = new Uint8Array(buffer.length + chunk.length)
              next.set(buffer)
              next.set(chunk, buffer.length)
              buffer = next
            },
            async close(): Promise<void> {
              root().files[path] = encode(buffer)
            },
          }
        },
      }
    }

    function makeDirHandle(name: string, path: string) {
      const state = (): State => root()
      return {
        kind: 'directory' as const,
        name,
        async queryPermission(): Promise<PermissionState> {
          return 'granted'
        },
        async requestPermission(): Promise<PermissionState> {
          return 'granted'
        },
        async getFileHandle(child: string, options?: { create?: boolean }) {
          const target = join(path, child)
          if (state().files[target] === undefined) {
            if (options?.create !== true) throw notFound(target)
            state().files[target] = ''
          }
          return makeFileHandle(child, target)
        },
        async getDirectoryHandle(child: string, options?: { create?: boolean }) {
          const target = join(path, child)
          if (!exists(target)) {
            if (options?.create !== true) throw notFound(target)
            state().dirs.push(target)
          }
          return makeDirHandle(child, target)
        },
        async removeEntry(child: string): Promise<void> {
          const current = state()
          const target = join(path, child)
          if (current.files[target] !== undefined) {
            delete current.files[target]
            return
          }
          if (exists(target)) {
            current.dirs = current.dirs.filter((dir) => dir !== target && !dir.startsWith(`${target}/`))
            for (const file of Object.keys(current.files)) {
              if (file.startsWith(`${target}/`)) delete current.files[file]
            }
            return
          }
          throw notFound(target)
        },
        async *values(): AsyncGenerator<{ kind: 'file'; name: string }> {
          const current = state()
          const prefix = path === '' ? '' : `${path}/`
          const names = new Set<string>()
          const collect = (candidate: string): void => {
            if (!candidate.startsWith(prefix)) return
            const rest = candidate.slice(prefix.length)
            if (rest === '' || rest.includes('/')) return
            names.add(rest)
          }
          for (const file of Object.keys(current.files)) collect(file)
          for (const dir of current.dirs) collect(dir)
          for (const entry of names) yield { kind: 'file' as const, name: entry }
        },
      }
    }

    // 必须用 defineProperty：直接 `window.showDirectoryPicker = fn` 在这版 Chromium
    // 上会被静默忽略（该操作定义在 Window 上且非可写），表现为「点了按钮永远不动」。
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: async () => makeDirHandle('vault', ''),
      configurable: true,
      writable: true,
    })
  }, FS_KEY)
}
