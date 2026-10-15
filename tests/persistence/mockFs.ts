// tests/persistence/mockFs.ts —— File System Access API 的手写 mock（仅测试用）

import type { VaultDirHandle } from '../../src/persistence/handleStore';

export type MockWritable = {
  chunks: unknown[];
  closed: boolean;
  write(data: unknown): Promise<void>;
  close(): Promise<void>;
};

export type MockBlob = {
  text(): Promise<string>;
};

export type MockFile = {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  size: number;
  slice(start: number, end?: number): MockBlob;
};

export type MockFileHandle = {
  kind: 'file';
  name: string;
  writable: MockWritable;
  /** 当前落盘内容（写入过的 chunk 优先，否则用初始内容），断言落盘结果用。 */
  bytes(): Uint8Array;
  getFile(): Promise<MockFile>;
  createWritable(): Promise<MockWritable>;
};

export type MockDirHandle = {
  kind: 'directory';
  name: string;
  files: Map<string, MockFileHandle>;
  dirs: Map<string, MockDirHandle>;
  getDirectoryHandle(
    child: string,
    opts?: { create?: boolean },
  ): Promise<MockDirHandle>;
  getFileHandle(child: string, opts?: { create?: boolean }): Promise<MockFileHandle>;
  removeEntry(child: string): Promise<void>;
  values(): AsyncGenerator<{ kind: 'file' | 'directory'; name: string }>;
  queryPermission(): Promise<'granted' | 'prompt' | 'denied'>;
  requestPermission(): Promise<'granted' | 'prompt' | 'denied'>;
};

export function notFound(what: string): Error {
  const e = new Error(`${what} not found`);
  e.name = 'NotFoundError';
  return e;
}

export function makeFile(
  name: string,
  init: { text?: string; bytes?: Uint8Array } = {},
): MockFileHandle {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const writable: MockWritable = {
    chunks: [],
    closed: false,
    async write(data: unknown) {
      this.chunks.push(data);
    },
    async close() {
      this.closed = true;
    },
  };
  function content(): Uint8Array {
    if (writable.chunks.length > 0) {
      const parts = writable.chunks.map((c) =>
        typeof c === 'string' ? encoder.encode(c) : (c as Uint8Array),
      );
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
      }
      return out;
    }
    if (init.text !== undefined) return encoder.encode(init.text);
    return init.bytes ?? new Uint8Array();
  }
  return {
    kind: 'file',
    name,
    writable,
    bytes: () => content(),
    async getFile() {
      const data = content();
      return {
        text: async () => decoder.decode(data),
        arrayBuffer: async () => data.slice().buffer,
        size: data.length,
        slice: (start: number, end?: number) => {
          const part = data.slice(start, end);
          return { text: async () => decoder.decode(part) };
        },
      };
    },
    async createWritable() {
      return writable;
    },
  };
}

export function makeDir(
  name: string,
  entries: { files?: MockFileHandle[]; dirs?: MockDirHandle[] } = {},
): MockDirHandle {
  const files = new Map(entries.files?.map((f) => [f.name, f]));
  const dirs = new Map(entries.dirs?.map((d) => [d.name, d]));
  const dir: MockDirHandle = {
    kind: 'directory',
    name,
    files,
    dirs,
    async getDirectoryHandle(child, opts) {
      const found = dirs.get(child);
      if (found) return found;
      if (opts?.create) {
        const created = makeDir(child);
        dirs.set(child, created);
        return created;
      }
      throw notFound(child);
    },
    async getFileHandle(child, opts) {
      const found = files.get(child);
      if (found) return found;
      if (opts?.create) {
        const created = makeFile(child);
        files.set(child, created);
        return created;
      }
      throw notFound(child);
    },
    async removeEntry(child) {
      if (files.delete(child) || dirs.delete(child)) return;
      throw notFound(child);
    },
    async *values() {
      for (const d of dirs.values()) yield { kind: 'directory' as const, name: d.name };
      for (const f of files.values()) yield { kind: 'file' as const, name: f.name };
    },
    queryPermission: async () => 'granted' as const,
    requestPermission: async () => 'granted' as const,
  };
  return dir;
}

export function asDirHandle(dir: MockDirHandle): VaultDirHandle {
  return dir as unknown as VaultDirHandle;
}
