/**
 * T73 · `/` 斜杠命令：把「插入块」从工具栏图标搬到一个可搜索的行内入口。
 *
 * 为什么要有它：工具栏一共 14 个图标，每个都是 24px 的纯图形——插代码块、插表格、
 * 插待办都得先在一排图标里认出来再点。写纪要时真正打断思路的不是命令少，而是**找不到入口**。
 * 斜杠命令把「我要什么」变成打字：`/表` `/todo` `/code` 都能命中。
 *
 * 三条刻意的边界：
 *  1) **不引入 `@tiptap/suggestion`**。项目把 TipTap 锁在 3.32.0 精确版本，
 *     为一个下拉再加一个包会多一份版本对齐负担；触发判定本来就是一个正则，
 *     放在这里当纯函数，单测可以直接断言（见 `parseSlashTrigger`）。
 *  2) **命令只做「当前块变成什么」**，不碰宿主（插图、双链跳转仍由 NoteEditor 接）。
 *  3) **只认行首或空白后的 `/`**。`http://`、`1/2`、路径 `a/b` 都不会误触发。
 */

import type { ChainedCommands } from '@tiptap/core'

import type { MsgKey } from '../locales/i18n'
import type { IconName } from './IconSprite'

/** 斜杠命令的静态描述。`run` 缺省表示该命令要宿主介入（插图要开文件选择器）。 */
export interface SlashCommandSpec {
  id: string
  icon: IconName
  label: MsgKey
  /** 菜单里第二列的补充说明（一句话说清它会插入什么）。 */
  hint: MsgKey
  /** 过滤关键词：中英文别名各给几个，用户打哪种都能命中。 */
  keywords: readonly string[]
  /** 命令本身：接到已经删掉 `/查询` 的那条链上，只 run 一次（一次动作 = 一条撤销项）。 */
  run?: (chain: ChainedCommands) => void
}

/**
 * 顺序即菜单默认顺序：先「最常用」（正文/标题/列表/待办），再「块级插入」（引用/代码/表格），
 * 最后是「外部资源」（图片/双链）。与工具栏的分组口径一致。
 */
export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    id: 'paragraph',
    icon: 'paragraph',
    label: 'noteEditor.slashParagraph',
    hint: 'noteEditor.slashParagraphHint',
    keywords: ['正文', '正文块', 'paragraph', 'text', 'body', 'p'],
    run: (chain) => chain.setParagraph(),
  },
  {
    id: 'h2',
    icon: 'heading-2',
    label: 'noteEditor.slashHeading2',
    hint: 'noteEditor.slashHeading2Hint',
    keywords: ['标题', '大标题', 'h2', 'heading', 'title', 'section'],
    run: (chain) => chain.toggleHeading({ level: 2 }),
  },
  {
    id: 'h3',
    icon: 'heading-3',
    label: 'noteEditor.slashHeading3',
    hint: 'noteEditor.slashHeading3Hint',
    keywords: ['小标题', '子标题', 'h3', 'heading', 'subtitle', 'subsection'],
    run: (chain) => chain.toggleHeading({ level: 3 }),
  },
  {
    id: 'bullet',
    icon: 'list-ul',
    label: 'noteEditor.slashBullet',
    hint: 'noteEditor.slashBulletHint',
    keywords: ['无序列表', '列表', 'bullet', 'list', 'ul', '-'],
    run: (chain) => chain.toggleBulletList(),
  },
  {
    id: 'ordered',
    icon: 'list-ol',
    label: 'noteEditor.slashOrdered',
    hint: 'noteEditor.slashOrderedHint',
    keywords: ['有序列表', '编号列表', 'ordered', 'numbered', 'list', 'ol', '1.'],
    run: (chain) => chain.toggleOrderedList(),
  },
  {
    id: 'task',
    icon: 'list-task',
    label: 'noteEditor.slashTask',
    hint: 'noteEditor.slashTaskHint',
    keywords: ['待办', '任务', '清单', 'todo', 'task', 'check', 'checkbox'],
    run: (chain) => chain.toggleTaskList(),
  },
  {
    id: 'quote',
    icon: 'quote',
    label: 'noteEditor.slashQuote',
    hint: 'noteEditor.slashQuoteHint',
    keywords: ['引用', 'quote', 'blockquote', '>'],
    run: (chain) => chain.toggleBlockquote(),
  },
  {
    id: 'code',
    icon: 'code-block',
    label: 'noteEditor.slashCode',
    hint: 'noteEditor.slashCodeHint',
    keywords: ['代码', '代码块', 'code', 'codeblock', 'snippet', '```'],
    run: (chain) => chain.toggleCodeBlock(),
  },
  {
    id: 'table',
    icon: 'table',
    label: 'noteEditor.slashTable',
    hint: 'noteEditor.slashTableHint',
    keywords: ['表格', 'table', 'grid', 'sheet'],
    run: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  },
  {
    id: 'divider',
    icon: 'divider',
    label: 'noteEditor.slashDivider',
    hint: 'noteEditor.slashDividerHint',
    keywords: ['分割线', '分隔线', 'divider', 'hr', 'rule', '---'],
    run: (chain) => chain.setHorizontalRule(),
  },
  {
    id: 'image',
    icon: 'image',
    label: 'noteEditor.slashImage',
    hint: 'noteEditor.slashImageHint',
    keywords: ['图片', '图', 'image', 'img', 'picture', 'photo'],
  },
  {
    id: 'wiki',
    icon: 'link',
    label: 'noteEditor.slashWiki',
    hint: 'noteEditor.slashWikiHint',
    keywords: ['双链', '关联', '引用文档', 'link', 'wikilink', 'reference', '[['],
  },
]

/** 一次待补全的斜杠输入：`from` 是 `/` 的绝对位置，`query` 是 `/` 之后已经打的字。 */
export interface SlashTrigger {
  from: number
  query: string
}

/**
 * 从光标前的纯文本里判断「是否正在打斜杠命令」。
 *
 * `textBefore` 必须以光标处结尾（调用方用 `doc.textBetween(from - N, from)` 取），
 * 返回的 `query` 长度为 0 时表示刚敲下 `/`——此时菜单就把全部命令列出来。
 *
 * 判定规则（三条都是为了让「误触发」不可能发生）：
 *  · `/` 前必须是**块首或空白**（含换行）——于是 `http://`、`a/b`、`1/2` 都不算；
 *  · `/` 后不能有空白或第二个 `/`（命令名是一段连续字符）——于是打错字自动关菜单；
 *  · 最多 20 个字符的查询窗口——再长就不是在选命令了。
 */
export function parseSlashTrigger(textBefore: string): { query: string } | null {
  const matched = /(?:^|[\s\u00a0])\/([^\s/]{0,20})$/.exec(textBefore)
  if (matched === null) return null
  return { query: matched[1] ?? '' }
}

/**
 * 关键词过滤：空查询返回全部（刚敲 `/` 就把菜单列满，用户看得见有什么可选）。
 *
 * 匹配是**子串**，但结果按「贴得多紧」排序：
 *  `0` 完全相等 → `1` 前缀命中 → `2` 只是包含。
 * 为什么需要这一步：中文里 `表` 既在「表格」里也在「列表」里，纯按声明顺序排的话
 * 打 `表` 会先看到「无序列表」——排序之后 `表格` 一定在第一行，Enter 一次就到。
 */
export function filterSlashCommands(query: string): readonly SlashCommandSpec[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return SLASH_COMMANDS
  const scored: { command: SlashCommandSpec; rank: number; order: number }[] = []
  SLASH_COMMANDS.forEach((command, order) => {
    let best = -1
    for (const keyword of command.keywords) {
      const haystack = keyword.toLowerCase()
      const at = haystack.indexOf(needle)
      if (at === -1) continue
      const rank = at === 0 ? (haystack.length === needle.length ? 0 : 1) : 2
      if (best === -1 || rank < best) best = rank
    }
    if (best !== -1) scored.push({ command, rank: best, order })
  })
  return scored.sort((a, b) => a.rank - b.rank || a.order - b.order).map((entry) => entry.command)
}
