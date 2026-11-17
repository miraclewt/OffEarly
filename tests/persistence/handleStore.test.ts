import { describe, expect, it, vi } from 'vitest';

import {
  createHandleStore,
  handleStore,
  verifyPermission,
  type HandleBackend,
} from '../../src/persistence/handleStore';
import { asDirHandle, makeDir, makeFile } from './mockFs';

function memoryBackend(initial: unknown = null): HandleBackend & { value: unknown } {
  return {
    value: initial,
    async get() {
      return this.value;
    },
    async set(v) {
      this.value = v;
    },
    async remove() {
      this.value = null;
    },
  };
}

function brokenBackend(): HandleBackend {
  const err = () => Promise.reject(new Error('IndexedDB blocked by policy'));
  return { get: err, set: err, remove: err };
}

describe('createHandleStore', () => {
  it('save 把句柄写入 backend 并返回 true', async () => {
    const backend = memoryBackend();
    const store = createHandleStore(backend);
    const dir = makeDir('vault');

    await expect(store.save(asDirHandle(dir))).resolves.toBe(true);
    expect(backend.value).toBe(dir);
  });

  it('重开后 load 取回同一句柄', async () => {
    const dir = makeDir('vault');
    const store = createHandleStore(memoryBackend(dir));

    await expect(store.load()).resolves.toBe(dir as unknown as FileSystemDirectoryHandle);
  });

  it('backend 为空时 load 返回 null', async () => {
    const store = createHandleStore(memoryBackend(null));

    await expect(store.load()).resolves.toBeNull();
  });

  it('load 拒绝非目录句柄的脏数据', async () => {
    const store = createHandleStore(memoryBackend(makeFile('vault.json')));

    await expect(store.load()).resolves.toBeNull();
  });

  it('clear 删除已存句柄', async () => {
    const backend = memoryBackend(makeDir('vault'));
    const store = createHandleStore(backend);

    await expect(store.clear()).resolves.toBe(true);
    expect(backend.value).toBeNull();
  });
});

describe('R2 降级：IndexedDB 不可用', () => {
  it('backend 抛错时 save=false / load=null / clear=false，均不抛错', async () => {
    const store = createHandleStore(brokenBackend());

    await expect(store.save(asDirHandle(makeDir('vault')))).resolves.toBe(false);
    await expect(store.load()).resolves.toBeNull();
    await expect(store.clear()).resolves.toBe(false);
  });

  it('默认 handleStore 在无 indexedDB 环境下 load 返回 null 不抛错', async () => {
    await expect(handleStore.load()).resolves.toBeNull();
  });
});

describe('verifyPermission', () => {
  it('queryPermission 已授权时直接通过，不请求', async () => {
    const dir = makeDir('vault');
    const handle = Object.assign(dir, {
      queryPermission: vi.fn(async () => 'granted' as const),
      requestPermission: vi.fn(async () => 'granted' as const),
    });

    await expect(verifyPermission(handle, true)).resolves.toBe(true);
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('未授权时 requestPermission 一次点击恢复', async () => {
    const dir = makeDir('vault');
    const handle = Object.assign(dir, {
      queryPermission: vi.fn(async (_opts: { mode: 'read' | 'readwrite' }) => 'prompt' as const),
      requestPermission: vi.fn(async (_opts: { mode: 'read' | 'readwrite' }) => 'granted' as const),
    });

    await expect(verifyPermission(handle, true)).resolves.toBe(true);
    expect(handle.requestPermission).toHaveBeenCalledTimes(1);
    expect(handle.requestPermission.mock.calls[0]?.[0]).toEqual({ mode: 'readwrite' });
  });

  it('requestIfDenied=false 时不打扰用户，直接返回 false', async () => {
    const dir = makeDir('vault');
    const handle = Object.assign(dir, {
      queryPermission: vi.fn(async () => 'prompt' as const),
      requestPermission: vi.fn(async () => 'granted' as const),
    });

    await expect(verifyPermission(handle, false)).resolves.toBe(false);
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('用户拒绝授权后返回 false', async () => {
    const dir = makeDir('vault');
    const handle = Object.assign(dir, {
      queryPermission: vi.fn(async () => 'prompt' as const),
      requestPermission: vi.fn(async () => 'denied' as const),
    });

    await expect(verifyPermission(handle, true)).resolves.toBe(false);
  });
});
