import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(process.cwd(), 'scripts', 'no-emoji.mjs')

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

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'no-emoji-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

const GRINNING = String.fromCodePoint(0x1f600)
const CHECK = String.fromCodePoint(0x2714)
const VARIATION = String.fromCodePoint(0xfe0f)
const FLAGS = `${String.fromCodePoint(0x1f1e6)}${String.fromCodePoint(0x1f1fa)}`

describe('no-emoji lint', () => {
  it('干净目录退出码 0', () => {
    const dir = fixture({ 'a.tsx': 'export const x = 1\n', 'b.css': '.x { color: red }\n' })
    try {
      const result = run(dir)
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('命中 emoji 码位退出码 1 并给出位置与码位', () => {
    const dir = fixture({ 'nested/a.ts': `// 中文注释\nconst s = 'ok ${GRINNING}'\n` })
    try {
      const result = run(dir)
      expect(result.code).toBe(1)
      expect(result.output).toContain('nested/a.ts:2:15')
      expect(result.output).toContain('U+1F600')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['U+2600–U+27BF 杂项符号', CHECK],
    ['U+FE0F 变体选择符', `a${VARIATION}b`],
    ['区域指示符（旗帜）', FLAGS],
  ])('拦截 %s', (_label, text) => {
    const dir = fixture({ 'a.md': `# t\n\n${text}\n` })
    try {
      expect(run(dir).code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不误伤箭头与中日韩文本', () => {
    const arrow = String.fromCodePoint(0x2192)
    const dir = fixture({
      'a.ts': `/** v1${arrow}v2 迁移；中文说明，标点：「」。 */\n`,
      'b.html': '<p>早下班 — 到点就走</p>\n',
    })
    try {
      const result = run(dir)
      expect(result.output).toBe('')
      expect(result.code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('忽略非文本扩展名', () => {
    const dir = fixture({ 'a.bin': `data ${GRINNING}\n`, 'b.svg': `<svg>${GRINNING}</svg>` })
    try {
      expect(run(dir).code).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('仓库现状（src 与 locales）通过检查', () => {
    const result = run()
    expect(result.code).toBe(0)
  })
})
