// @vitest-environment jsdom
//
// T73 · `/` 斜杠命令的两条纯函数：触发判定与关键词排序。
// 组件层（菜单渲染、键盘、应用）在 `NoteEditor.test.tsx` 的 T73 一组里验。

import { describe, expect, it } from 'vitest'

import { SLASH_COMMANDS, filterSlashCommands, parseSlashTrigger } from '../../src/views/slashCommands'

describe('T73-1 · parseSlashTrigger（什么时候算在打命令）', () => {
  it('块首的 `/` 与空白后的 `/` 都算，查询串照原样取出', () => {
    expect(parseSlashTrigger('/')).toEqual({ query: '' })
    expect(parseSlashTrigger('/表')).toEqual({ query: '表' })
    expect(parseSlashTrigger('上一句 /todo')).toEqual({ query: 'todo' })
    expect(parseSlashTrigger('换行后的 /h2')).toEqual({ query: 'h2' })
  })

  it('URL / 分数 / 路径里的斜杠不算（前一字符不是空白）', () => {
    for (const sample of ['http://a.bc', 'https://x.y/z', '1/2', 'a/b', 'src/views/x.ts']) {
      expect(parseSlashTrigger(sample)).toBeNull()
    }
  })

  it('命令名里出现空白或第二个 `/` 就关菜单（那不是在选择命令）', () => {
    expect(parseSlashTrigger('/ 表')).toBeNull()
    expect(parseSlashTrigger('/表 格')).toBeNull()
    expect(parseSlashTrigger('/a/b')).toBeNull()
  })

  it('超长输入不再当作命令（查询窗口 20 字）', () => {
    expect(parseSlashTrigger(`/${'x'.repeat(21)}`)).toBeNull()
    expect(parseSlashTrigger(`/${'x'.repeat(20)}`)).toEqual({ query: 'x'.repeat(20) })
  })
})

describe('T73-2 · filterSlashCommands（搜得到、且搜得准）', () => {
  it('空查询列出全部，顺序即声明顺序', () => {
    expect(filterSlashCommands('')).toEqual(SLASH_COMMANDS)
    expect(filterSlashCommands('   ')).toEqual(SLASH_COMMANDS)
  })

  it('中文子串命中；「表」必须把「表格」排在最前（而不是「无序列表」）', () => {
    const matched = filterSlashCommands('表')
    expect(matched[0]?.id).toBe('table')
    expect(matched.map((command) => command.id)).toContain('table')
  })

  it('英文别名与符号都能搜到', () => {
    expect(filterSlashCommands('todo').map((command) => command.id)).toEqual(['task'])
    expect(filterSlashCommands('code').map((command) => command.id)).toContain('code')
    expect(filterSlashCommands('---').map((command) => command.id)).toEqual(['divider'])
  })

  it('大小写不敏感；完全相等的关键词排在前缀命中之前', () => {
    expect(filterSlashCommands('CODE')[0]?.id).toBe('code')
    expect(filterSlashCommands('h2').map((command) => command.id)).toEqual(['h2'])
  })

  it('没有命中就是空数组（菜单据此显示空态）', () => {
    expect(filterSlashCommands('没有这个命令')).toEqual([])
  })

  it('每条命令的图标与文案键都齐备（避免菜单里出现空行）', () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.icon.length).toBeGreaterThan(0)
      expect(command.label).toMatch(/^noteEditor\./)
      expect(command.hint).toMatch(/^noteEditor\./)
      expect(command.keywords.length).toBeGreaterThan(0)
    }
  })
})
