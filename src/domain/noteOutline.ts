// T58 · 阅读辅助的两个纯函数：大纲抽取与反向链接。
//
// 为什么按 Markdown 抽而不是走 ProseMirror 文档树：大纲面板要在「正文还没进编辑器」
// 时也能算（切文档的瞬间、导出时），而正文的唯一事实源就是 Markdown。
// 代码围栏里的 `# 注释` 不是标题——所以这里维护一个极小的围栏状态机。

export interface OutlineItem {
  /** 1–6，对应 # 到 ######。 */
  level: number
  text: string
  /** 在正文里的第几个标题（0 起），点击时按这个序号找编辑器里的 heading 元素。 */
  index: number
}

/** 去掉行内 Markdown 标记，只留可读文字（标题里常见 `**粗**` 与 `` `代码` ``）。 */
function plainText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim()
}

export function extractOutline(markdown: string): OutlineItem[] {
  const out: OutlineItem[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const trimmed = line.trimStart()
    if (fence !== null) {
      if (trimmed.startsWith(fence)) fence = null
      continue
    }
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fence = trimmed.slice(0, 3)
      continue
    }
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(trimmed)
    if (match === null) continue
    const text = plainText(match[2] ?? '')
    if (text === '') continue
    out.push({ level: (match[1] ?? '#').length, text, index: out.length })
  }
  return out
}

/**
 * 反向链接：正文里出现 `[[本标题]]` 的其它文档。
 * 与 `[[…]]` 的跳转口径一致——按标题精确匹配（去首尾空白），不区分大小写。
 */
export function findBacklinks(
  docs: readonly { id: string; title: string; content: string }[],
  title: string,
  selfId: string,
): { id: string; title: string }[] {
  const target = title.trim().toLowerCase()
  if (target === '') return []
  const needle = `[[${target}]]`
  const out: { id: string; title: string }[] = []
  for (const doc of docs) {
    if (doc.id === selfId) continue
    if (doc.content.toLowerCase().includes(needle)) out.push({ id: doc.id, title: doc.title })
  }
  return out
}
