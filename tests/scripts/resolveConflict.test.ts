import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'resolve-conflict.mjs')

const fixtures: string[] = []

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Run {
  code: number
  output: string
}

function run(...args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function fixture(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oe-rc-'))
  fixtures.push(dir)
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

const read = (path: string): string => readFileSync(path, 'utf8')

describe('resolve-conflict 并集', () => {
  it('纯追加冲突取并集：两侧条目都在、段间空一行、标记清空', () => {
    const path = fixture(
      'task.md',
      [
        '# 完成记录',
        '',
        '<<<<<<< HEAD',
        '- [2026-10-16] T22 | 左',
        '=======',
        '- [2026-10-16] T24 | 右',
        '>>>>>>> lane',
        '',
        '尾巴',
        '',
      ].join('\n'),
    )

    const result = run(path, '--write')

    expect(result.code).toBe(0)
    expect(read(path)).toBe(
      ['# 完成记录', '', '- [2026-10-16] T22 | 左', '', '- [2026-10-16] T24 | 右', '', '尾巴', ''].join(
        '\n',
      ),
    )
    expect(result.output).toContain('blocks=1 leftover=0')
  })

  it('默认 dry-run 不写盘，只在输出里说明', () => {
    const source = ['<<<<<<< HEAD', 'A', '=======', 'B', '>>>>>>> lane', ''].join('\n')
    const path = fixture('dry.md', source)

    const result = run(path)

    expect(result.code).toBe(0)
    expect(read(path)).toBe(source)
    expect(result.output).toContain('dry-run')
  })

  it('没有冲突块时直接跳过，内容一个字不动', () => {
    const source = '# 干净\n\n- 一条\n'
    const path = fixture('clean.md', source)

    const result = run(path, '--write')

    expect(result.code).toBe(0)
    expect(read(path)).toBe(source)
    expect(result.output).toContain('无冲突块')
  })

  it('保持原有行尾（CRLF 文件不被打成 LF）', () => {
    const path = fixture(
      'crlf.md',
      ['a', '<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> lane', ''].join('\r\n'),
    )

    run(path, '--write')

    expect(read(path)).toBe(['a', 'x', '', 'y', ''].join('\r\n'))
  })
})

describe('resolve-conflict 总表禁区', () => {
  const table = (left: string, right: string): string =>
    ['## 总表', '<<<<<<< HEAD', left, '=======', right, '>>>>>>> lane', ''].join('\n')

  it('同一任务号两侧各改一次 → 报错退出且不写盘', () => {
    const source = table('- [x] **T16** 筛选（已做）', '- [ ] **T16** 筛选（未做）')
    const path = fixture('table.md', source)

    const result = run(path, '--write')

    expect(result.code).not.toBe(0)
    expect(result.output).toContain('T16')
    expect(result.output).toContain('状态取较晚完成者')
    expect(read(path)).toBe(source)
  })

  it('两侧是不同任务号时照常并集（不误伤）', () => {
    const path = fixture('table.md', table('- [x] **T16** 筛选', '- [x] **T17** 详情'))

    const result = run(path, '--write')

    expect(result.code).toBe(0)
    expect(read(path)).toContain('T16')
    expect(read(path)).toContain('T17')
  })
})

describe('resolve-conflict 选项与容错', () => {
  it('--brace-after-head 在 head 段后补一行闭合，供 zh.ts 嵌套表使用', () => {
    const path = fixture(
      'zh.ts',
      [
        'export const zh = {',
        '  sidebar: {',
        '<<<<<<< HEAD',
        "    card: 'c',",
        '=======',
        "    milestonePanel: 'm',",
        '>>>>>>> lane',
        '  },',
        '} as const',
        '',
      ].join('\n'),
    )

    const result = run(path, '--brace-after-head', path, '--write')
    const merged = read(path).split('\n')

    expect(result.code).toBe(0)
    expect(merged.slice(0, 7)).toEqual([
      'export const zh = {',
      '  sidebar: {',
      "    card: 'c',",
      '  },',
      '',
      "    milestonePanel: 'm',",
      '  },',
    ])
  })

  it('标记不完整（缺 >>>>>>>）时报错且不写盘', () => {
    const source = ['<<<<<<< HEAD', 'A', '=======', 'B', ''].join('\n')
    const path = fixture('broken.md', source)

    const result = run(path, '--write')

    expect(result.code).not.toBe(0)
    expect(result.output).toContain('冲突标记不完整')
    expect(read(path)).toBe(source)
  })

  it('不给文件或给未知参数时明确报错', () => {
    expect(run().code).not.toBe(0)
    expect(run('--nope').code).not.toBe(0)
  })
})
