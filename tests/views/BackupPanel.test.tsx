// @vitest-environment jsdom
//
// T26 · BackupPanel（最小版）的「清理未引用附件」入口。
//
// 口径：先「扫描」出只读清单、再「确认清理」才动 gc——两层之间必须隔一次确认。
// 组件是纯视图，gc 经 props 注入，这里用假端口验证「点了哪个、什么时候点、传给端口什么」。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackupGcPort } from '../../src/controllers/backupGc'
import { BackupPanel } from '../../src/views/BackupPanel'

function makePort(overrides: Partial<BackupGcPort> = {}): BackupGcPort {
  return {
    preview: vi.fn(async () => ({ totalCount: 0, referencedCount: 0, unreferenced: [], reclaimableBytes: 0 })),
    cleanup: vi.fn(async () => []),
    ...overrides,
  }
}

function setup(props: Partial<Parameters<typeof BackupPanel>[0]> = {}) {
  const gc = props.gc ?? makePort()
  render(<BackupPanel gc={gc} assetCount={props.assetCount} assetTotalBytes={props.assetTotalBytes} {...props} />)
  return { gc }
}

afterEach(cleanup)

describe('T26-1 · 附件概况与入口', () => {
  it('展示附件总数与总字节（人类可读单位）', () => {
    setup({ assetCount: 2, assetTotalBytes: 2048 })
    expect(screen.getByTestId('backup-panel').textContent).toContain('附件：2 个')
    expect(screen.getByTestId('backup-panel').textContent).toContain('2.0 KB')
  })

  it('没有附件时给一句空态，不给扫描入口', () => {
    setup({ assetCount: 0, assetTotalBytes: 0 })
    expect(screen.getByTestId('backup-panel').textContent).toContain('当前库还没有附件')
  })

  it('未注入 gc 端口时扫描按钮置灰', () => {
    setup({ gc: undefined, assetCount: 1, assetTotalBytes: 10 })
    expect((screen.getByTestId('backup-gc-scan') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('T26-2 · 扫描 → 展示预览（先看清再确认）', () => {
  it('点扫描调用 preview，展示未引用清单 + 可释放字节', async () => {
    const gc = makePort({
      preview: vi.fn(async () => ({
        totalCount: 3,
        referencedCount: 1,
        unreferenced: [
          { id: 'a2', filename: 'assets/a2.png', sizeBytes: 2048 },
          { id: 'a3', filename: 'assets/a3.png', sizeBytes: 1024 },
        ],
        reclaimableBytes: 3072,
      })),
    })
    setup({ gc, assetCount: 3, assetTotalBytes: 3072 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    expect(gc.preview).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('backup-gc-preview')).toBeTruthy()
    expect(screen.getByTestId('backup-gc-item-a2').textContent).toContain('assets/a2.png')
    expect(screen.getByTestId('backup-gc-reclaim').textContent).toContain('3.0 KB')
    // 扫描阶段不得触碰 cleanup
    expect(gc.cleanup).not.toHaveBeenCalled()
  })

  it('没有未引用附件 → 提示空态，不给确认按钮', async () => {
    const gc = makePort({
      preview: vi.fn(async () => ({ totalCount: 1, referencedCount: 1, unreferenced: [], reclaimableBytes: 0 })),
    })
    setup({ gc, assetCount: 1, assetTotalBytes: 10 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    expect(await screen.findByTestId('backup-gc-preview')).toBeTruthy()
    expect(screen.getByTestId('backup-gc-preview').textContent).toContain('没有可回收的附件')
    expect(screen.queryByTestId('backup-gc-confirm')).toBeNull()
  })

  it('preview 失败时展示错误，不进确认态', async () => {
    const gc = makePort({ preview: vi.fn(async () => { throw new Error('boom') }) })
    setup({ gc, assetCount: 1, assetTotalBytes: 10 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    expect(await screen.findByTestId('backup-gc-error')).toBeTruthy()
    expect(screen.queryByTestId('backup-gc-preview')).toBeNull()
  })
})

describe('T26-3 · 确认清理（第二次点击才真删）', () => {
  it('确认后把清单里的 id 全部交给 cleanup，并展示释放量', async () => {
    const gc = makePort({
      preview: vi.fn(async () => ({
        totalCount: 2,
        referencedCount: 0,
        unreferenced: [
          { id: 'a1', filename: 'assets/a1.png', sizeBytes: 100 },
          { id: 'a2', filename: 'assets/a2.png', sizeBytes: 200 },
        ],
        reclaimableBytes: 300,
      })),
      cleanup: vi.fn(async (ids) => [...ids]),
    })
    setup({ gc, assetCount: 2, assetTotalBytes: 300 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    fireEvent.click(await screen.findByTestId('backup-gc-confirm'))
    await screen.findByTestId('backup-gc-status')
    expect(gc.cleanup).toHaveBeenCalledWith(['a1', 'a2'])
    expect(screen.getByTestId('backup-gc-status').textContent).toContain('已清理 2 个附件')
  })

  it('cleanup 失败展示错误，不误报成功', async () => {
    const gc = makePort({
      preview: vi.fn(async () => ({
        totalCount: 1,
        referencedCount: 0,
        unreferenced: [{ id: 'a1', filename: 'assets/a1.png', sizeBytes: 10 }],
        reclaimableBytes: 10,
      })),
      cleanup: vi.fn(async () => { throw new Error('boom') }),
    })
    setup({ gc, assetCount: 1, assetTotalBytes: 10 })
    fireEvent.click(screen.getByTestId('backup-gc-scan'))
    fireEvent.click(await screen.findByTestId('backup-gc-confirm'))
    expect(await screen.findByTestId('backup-gc-error')).toBeTruthy()
    expect(screen.queryByTestId('backup-gc-status')).toBeNull()
  })
})
