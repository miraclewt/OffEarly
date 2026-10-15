// 目录句柄持久化（IndexedDB）+ 权限恢复 + R2 降级（T06）
// 降级策略：IndexedDB 任何一步不可用（被策略禁用、脏数据、异常）都静默回退到
// 「无句柄」状态，由启动流程走重选目录路径，绝不抛错阻断启动。

export type HandleBackend = {
  get(): Promise<unknown>;
  set(value: unknown): Promise<void>;
  remove(): Promise<void>;
};

// Chromium 的 FileSystemDirectoryHandle 带权限方法，但 TS lib.dom 未声明，此处补齐
export type VaultDirHandle = FileSystemDirectoryHandle & {
  queryPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

export type DirHandleStore = {
  save(handle: VaultDirHandle): Promise<boolean>;
  load(): Promise<VaultDirHandle | null>;
  clear(): Promise<boolean>;
};

function isDirHandle(value: unknown): value is VaultDirHandle {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; queryPermission?: unknown };
  return v.kind === 'directory' && typeof v.queryPermission === 'function';
}

export function createHandleStore(backend: HandleBackend): DirHandleStore {
  return {
    async save(handle) {
      try {
        await backend.set(handle);
        return true;
      } catch {
        return false;
      }
    },
    async load() {
      try {
        const value = await backend.get();
        return isDirHandle(value) ? value : null;
      } catch {
        return null;
      }
    },
    async clear() {
      try {
        await backend.remove();
        return true;
      } catch {
        return false;
      }
    },
  };
}

const DB_NAME = 'offearly';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const DIR_KEY = 'vaultDir';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function request<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = run(tx.objectStore(STORE_NAME));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

const indexedDbBackend: HandleBackend = {
  get: () => request('readonly', (store) => store.get(DIR_KEY)).then((v) => v ?? null),
  set: (value) => request('readwrite', (store) => store.put(value, DIR_KEY)).then(() => undefined),
  remove: () => request('readwrite', (store) => store.delete(DIR_KEY)).then(() => undefined),
};

export const handleStore: DirHandleStore = createHandleStore(indexedDbBackend);

type PermissionHandle = Pick<VaultDirHandle, 'queryPermission' | 'requestPermission'>;

export async function verifyPermission(
  handle: PermissionHandle,
  requestIfDenied: boolean,
): Promise<boolean> {
  const opts = { mode: 'readwrite' } as const;
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!requestIfDenied) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}
