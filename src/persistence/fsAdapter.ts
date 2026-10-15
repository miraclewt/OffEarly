// FsAccessAdapter：全项目唯一接触 File System Access API 的层（T06）

const SUBDIRS = ['assets', '.backup'] as const;

type DirectoryPicker = (options?: {
  id?: string;
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

export function connectDir(): Promise<FileSystemDirectoryHandle> {
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (typeof picker !== 'function') {
    throw new Error('showDirectoryPicker is unavailable in this browser');
  }
  return picker.call(globalThis, { id: 'offearly-vault', mode: 'readwrite' });
}

export async function ensureSubdirs(dir: FileSystemDirectoryHandle): Promise<void> {
  for (const name of SUBDIRS) {
    await dir.getDirectoryHandle(name, { create: true });
  }
}

function splitPath(path: string): string[] {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..')) {
    throw new Error(`Invalid path: ${path}`);
  }
  return parts;
}

async function resolveParent(
  dir: FileSystemDirectoryHandle,
  parts: readonly string[],
): Promise<FileSystemDirectoryHandle> {
  let cur = dir;
  for (const name of parts.slice(0, -1)) {
    cur = await cur.getDirectoryHandle(name);
  }
  return cur;
}

async function resolveFileHandle(
  dir: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemFileHandle> {
  const parts = splitPath(path);
  const parent = await resolveParent(dir, parts);
  return parent.getFileHandle(parts[parts.length - 1] as string, { create });
}

async function resolveDirHandle(
  dir: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let cur = dir;
  for (const name of splitPath(path)) {
    cur = await cur.getDirectoryHandle(name);
  }
  return cur;
}

export async function readText(
  dir: FileSystemDirectoryHandle,
  path: string,
): Promise<string> {
  const handle = await resolveFileHandle(dir, path, false);
  const file = await handle.getFile();
  return file.text();
}

export async function writeText(
  dir: FileSystemDirectoryHandle,
  path: string,
  content: string,
): Promise<void> {
  const handle = await resolveFileHandle(dir, path, true);
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * 只读文件头部 maxBytes 字节：peekRevision 用它避免把整份 vault.json（可达数 MB）
 * 读进内存。截断按字节进行，因此尾部可能落在多字节字符中间，调用方只做前缀匹配。
 */
export async function readHead(
  dir: FileSystemDirectoryHandle,
  path: string,
  maxBytes: number,
): Promise<{ text: string; whole: boolean }> {
  const handle = await resolveFileHandle(dir, path, false);
  const file = await handle.getFile();
  if (file.size <= maxBytes) {
    return { text: await file.text(), whole: true };
  }
  // Blob.slice 返回的仍是二进制切片，解码后即为前 maxBytes 字节的内容
  const head = await file.slice(0, maxBytes).text();
  return { text: head, whole: false };
}

export async function readBinary(
  dir: FileSystemDirectoryHandle,
  path: string,
): Promise<Uint8Array> {
  const handle = await resolveFileHandle(dir, path, false);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function writeBinary(
  dir: FileSystemDirectoryHandle,
  path: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const handle = await resolveFileHandle(dir, path, true);
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function remove(
  dir: FileSystemDirectoryHandle,
  path: string,
): Promise<boolean> {
  const parts = splitPath(path);
  const parent = await resolveParent(dir, parts);
  try {
    await parent.removeEntry(parts[parts.length - 1] as string);
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === 'NotFoundError') return false;
    throw e;
  }
}

export async function list(
  dir: FileSystemDirectoryHandle,
  dirPath: string,
): Promise<string[]> {
  const target = dirPath === '' ? dir : await resolveDirHandle(dir, dirPath);
  const names: string[] = [];
  for await (const entry of target.values()) {
    names.push(entry.name);
  }
  return names;
}
