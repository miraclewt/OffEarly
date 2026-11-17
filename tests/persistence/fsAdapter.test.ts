import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectDir,
  ensureSubdirs,
  list,
  readBinary,
  readHead,
  readText,
  remove,
  writeBinary,
  writeText,
} from '../../src/persistence/fsAdapter';
import { asDirHandle, makeDir, makeFile } from './mockFs';

afterEach(() => {
  delete (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

describe('connectDir', () => {
  it('以 readwrite 模式调用 showDirectoryPicker 并返回目录句柄', async () => {
    const picked = makeDir('vault');
    const picker = vi.fn(async (_options: { id?: string; mode?: string }) => picked);
    (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker = picker;

    const handle = await connectDir();

    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0]?.[0]).toMatchObject({ mode: 'readwrite' });
    expect(handle).toBe(picked as unknown as FileSystemDirectoryHandle);
  });
});

describe('ensureSubdirs', () => {
  it('缺失时创建 assets 与 .backup', async () => {
    const dir = makeDir('vault');

    await ensureSubdirs(asDirHandle(dir));

    expect(dir.dirs.has('assets')).toBe(true);
    expect(dir.dirs.has('.backup')).toBe(true);
  });

  it('已存在时跳过且不覆盖原目录内容', async () => {
    const existing = makeDir('assets', { files: [makeFile('a.png')] });
    const dir = makeDir('vault', { dirs: [existing] });

    await ensureSubdirs(asDirHandle(dir));

    expect(dir.dirs.get('assets')).toBe(existing);
    expect(existing.files.has('a.png')).toBe(true);
  });
});

describe('文本原语', () => {
  it('writeText 写入内容并 close 刷新', async () => {
    const file = makeFile('vault.json');
    const dir = makeDir('vault', { files: [file] });

    await writeText(asDirHandle(dir), 'vault.json', '{"a":1}');

    expect(file.writable.chunks).toEqual(['{"a":1}']);
    expect(file.writable.closed).toBe(true);
  });

  it('readText 返回文件全文', async () => {
    const dir = makeDir('vault', { files: [makeFile('vault.json', { text: 'hello' })] });

    await expect(readText(asDirHandle(dir), 'vault.json')).resolves.toBe('hello');
  });

  it('readText 对不存在的路径抛 NotFoundError', async () => {
    const dir = makeDir('vault');

    await expect(readText(asDirHandle(dir), 'vault.json')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });

  it('writeText 可创建缺失文件', async () => {
    const dir = makeDir('vault');

    await writeText(asDirHandle(dir), 'vault.json', '{}');

    const created = dir.files.get('vault.json');
    expect(created).toBeDefined();
    expect(created?.writable.chunks).toEqual(['{}']);
  });
});

describe('二进制原语', () => {
  it('writeBinary 写字节并 close 刷新', async () => {
    const file = makeFile('a.png');
    const dir = makeDir('vault', { dirs: [makeDir('assets', { files: [file] })] });
    const bytes = new Uint8Array([137, 80, 78, 71]);

    await writeBinary(asDirHandle(dir), 'assets/a.png', bytes);

    expect(file.writable.chunks).toEqual([bytes]);
    expect(file.writable.closed).toBe(true);
  });

  it('readBinary 返回字节数组', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const dir = makeDir('vault', { dirs: [makeDir('assets', { files: [makeFile('a.png', { bytes })] })] });

    const result = await readBinary(asDirHandle(dir), 'assets/a.png');

    expect(Array.from(result)).toEqual([1, 2, 3]);
  });
});

describe('嵌套路径', () => {
  it('原语经 assets 子目录解析多级路径', async () => {
    const dir = makeDir('vault', { dirs: [makeDir('assets')] });

    await writeText(asDirHandle(dir), 'assets/note.md', '# hi');

    expect(await readText(asDirHandle(dir), 'assets/note.md')).toBe('# hi');
  });

  it('拒绝含 .. 的路径且不触碰句柄', async () => {
    const dir = makeDir('vault');
    const spy = vi.spyOn(dir, 'getFileHandle');

    await expect(readText(asDirHandle(dir), '../escape')).rejects.toThrow(/path/i);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('readHead', () => {
  it('文件不超过上限时返回全文并标记 whole', async () => {
    const dir = makeDir('vault', { files: [makeFile('vault.json', { text: '{"revision":3}' })] });

    await expect(readHead(asDirHandle(dir), 'vault.json', 512)).resolves.toEqual({
      text: '{"revision":3}',
      whole: true,
    });
  });

  it('文件超过上限时只读前 maxBytes 字节并标记非 whole', async () => {
    const padding = 'x'.repeat(1000);
    const dir = makeDir('vault', { files: [makeFile('blob.json', { text: `head-${padding}` })] });

    const result = await readHead(asDirHandle(dir), 'blob.json', 5);

    expect(result).toEqual({ text: 'head-', whole: false });
  });

  it('按字节而非字符截取上限', async () => {
    // '任' 占 3 字节：6 字节上限只够两个汉字，若按字符截会得到 6 个字
    const dir = makeDir('vault', { files: [makeFile('cn.json', { text: '任务任务任务' })] });

    const result = await readHead(asDirHandle(dir), 'cn.json', 6);

    expect(result.text).toBe('任务');
    expect(result.whole).toBe(false);
  });

  it('文件不存在抛 NotFoundError', async () => {
    const dir = makeDir('vault');

    await expect(readHead(asDirHandle(dir), 'vault.json', 512)).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});

describe('remove', () => {
  it('删除已存在文件返回 true', async () => {
    const dir = makeDir('vault', { files: [makeFile('vault.json')] });

    await expect(remove(asDirHandle(dir), 'vault.json')).resolves.toBe(true);
    expect(dir.files.has('vault.json')).toBe(false);
  });

  it('文件不存在返回 false 不抛错', async () => {
    const dir = makeDir('vault');

    await expect(remove(asDirHandle(dir), 'vault.json')).resolves.toBe(false);
  });
});

describe('list', () => {
  it('返回子目录内全部条目名', async () => {
    const assets = makeDir('assets', { files: [makeFile('a.png'), makeFile('b.png')] });
    const dir = makeDir('vault', { dirs: [assets] });

    await expect(list(asDirHandle(dir), 'assets')).resolves.toEqual(['a.png', 'b.png']);
  });

  it('空路径列出根目录（含子目录与文件）', async () => {
    const dir = makeDir('vault', { files: [makeFile('vault.json')], dirs: [makeDir('assets')] });

    await expect(list(asDirHandle(dir), '')).resolves.toEqual(['assets', 'vault.json']);
  });

  it('目录不存在抛 NotFoundError', async () => {
    const dir = makeDir('vault');

    await expect(list(asDirHandle(dir), 'assets')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });
});
