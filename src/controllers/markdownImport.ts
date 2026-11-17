// T82 · Markdown 导入：把一个 .md 文件变成一篇笔记。
//
// 与 T62 会议导入同族（逐篇落成 NoteDoc、每篇一条命令），但转换方向相反：
// 会议是把结构化事件**渲染**成 Markdown，这里是**尽量不动**用户已有的 Markdown。
//   ① 正文原样入库：`NoteDoc.content` 存的就是 Markdown 纯文本（T24 定的存储口径），
//      所以 .md → 笔记不需要任何 HTML/JSON 往返。刻意**不**过一遍 TipTap 再序列化：
//      那会把 TipTap 不认识的写法（脚注、`<details>`、定义列表、HTML 块）静默丢掉，
//      而 AI 生成的 md 里这些很常见。「导入后少了半篇」比「原文照抄」糟得多。
//   ② 标题三选一：YAML front matter 的 `title` → 正文第一个 `# 标题` → 文件名。
//      被选作标题的那行 `#` 会从正文里**删掉**（否则文档树与正文里同一个标题出现两次）；
//      front matter 一律剥掉——它是元数据，不是正文。
//   ③ tags 落 `NoteDoc.tags`：front matter 的 `tags` 正好对上 T73 的文档标签字段，
//      没有就不写这个键（与 T73「空值不落盘」同一口径，老库形状不变）。
//
// 三条边界：CRLF → LF（Windows 生成的文件）、BOM 去掉、单文件 2MB 上限
// （再大就不是笔记而是整本书，且会把 vault.json 撑到打不开）。

import { applyCreateDoc, normalizeNoteTags } from './notebookActions'
import type { NotebookActionDeps } from './notebookActions'
import { nextDocOrder } from '../domain/notebookTree'
import type { CommandBus } from '../domain/commandBus'
import type { NoteDoc, Vault } from '../domain/types'

/** 单文件体积上限（UTF-8 字节）：超过就跳过并在面板里说明原因，不导入半个文件。 */
export const MD_IMPORT_MAX_BYTES = 2 * 1024 * 1024

/**
 * 认这些扩展名。`.txt` 也在内：AI 有时直接吐 txt，而它是 Markdown 的子集，
 * 进来之后与 .md 走完全同一条路。
 */
const MD_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mdtext', '.txt']

/** 面板 / 控制器之间交换的一个待导入文件。 */
export interface MarkdownSourceFile {
  /** 文件名（含扩展名）：标题兜底与面板展示都用它。 */
  name: string
  text: string
}

/** 标题来自哪里：面板用来提示「这个标题是猜的」。 */
export type MarkdownTitleSource = 'frontmatter' | 'heading' | 'filename'

/** 可以落库的一篇。 */
export interface MarkdownImportDoc {
  file: string
  title: string
  content: string
  tags: string[]
  titleSource: MarkdownTitleSource
  /** 原文里带 YAML front matter（已被剥掉）。 */
  hadFrontMatter: boolean
  bytes: number
  lines: number
}

export type MarkdownImportSkipReason = 'unsupported' | 'tooLarge' | 'empty'

/** 一个文件的导入结果：要么可导入，要么被跳过（含原因）。 */
export interface MarkdownImportEntry {
  file: string
  bytes: number
  doc: MarkdownImportDoc | null
  skip: MarkdownImportSkipReason | null
}

export interface FrontMatterResult {
  title: string
  tags: string[]
  /** 剥掉 front matter 之后的正文；没有 front matter 时是原文。 */
  body: string
  had: boolean
}

/** UTF-8 字节数。jsdom 早年不暴露 TextEncoder，拿不到时退回字符数（够用，不会误判上限）。 */
function utf8Length(text: string): number {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** `[a, b, c]` → ['a','b','c']（YAML 的行内数组；AI 生成的文件里最常见的写法）。 */
function splitInlineList(raw: string): string[] {
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '')
  return inner
    .split(',')
    .map((part) => unquote(part.trim()))
    .filter((part) => part !== '')
}

const ENTRY = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/
const ITEM = /^\s*[-*]\s+(.*)$/

/**
 * 「这一块到底是不是 front matter」——**必须先判再剥**，因为正文里本来就会出现 `---`：
 * 一篇以分隔线开头、后面还有一条分隔线的文档，若只按「有开头又有结尾」判，
 * 开头那一整段就会被当成元数据删掉——而这正好是本模块最不能犯的错（静默丢内容）。
 *
 * 两条判据都要成立：
 *  · 至少有一行是 `键: 值`（front matter 是元数据，不是散文）；
 *  · 其余非空行只能是列表项（`- xxx`）或带冒号的缩进行（嵌套键 `  name: 张三`）。
 * 任何一行是普通散文 → 认定整块是正文，一个字都不动。
 */
function looksLikeFrontMatter(lines: readonly string[], end: number): boolean {
  let entries = 0
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]!.trim()
    if (line === '') continue
    if (ENTRY.test(line)) {
      entries += 1
      continue
    }
    if (ITEM.test(line)) continue
    if (line.includes(':')) continue
    return false
  }
  return entries > 0
}

/**
 * 极简 YAML front matter 解析：只取 `title` 与 `tags`（`tag` / `keywords` 也认），
 * 其余键一律忽略 —— 不为此引入 YAML 库，也不为一个展示用的元数据去兜整个规范。
 *
 * 三处都是刻意的宽松：
 *  · 没有闭合行（或整块看着不像元数据）→ 认定这不是 front matter，原文一个字不动；
 *  · 列表项 `- xxx` 归到它上面最近的那个键；
 *  · 值支持引号与 `[a, b]` 行内数组。
 */
export function parseFrontMatter(text: string): FrontMatterResult {
  const lines = text.split('\n')
  const none: FrontMatterResult = { title: '', tags: [], body: text, had: false }
  if (lines.length < 2 || lines[0]!.trim() !== '---') return none
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim()
    if (line === '---' || line === '...') {
      end = i
      break
    }
  }
  if (end < 0 || !looksLikeFrontMatter(lines, end)) return none

  const fields = new Map<string, string | string[]>()
  let current: string | null = null
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]!
    const item = ITEM.exec(line)
    if (item !== null) {
      // 列表项没有归属的键（front matter 写得不对）就丢掉，不猜
      if (current === null) continue
      const value = unquote(item[1]!.trim())
      const previous = fields.get(current)
      if (Array.isArray(previous)) fields.set(current, [...previous, value])
      else if (previous === undefined) fields.set(current, [value])
      else fields.set(current, [previous, value])
      continue
    }
    const entry = ENTRY.exec(line)
    if (entry === null) continue
    const key = entry[1]!.trim().toLowerCase()
    const raw = entry[2]!.trim()
    current = key
    if (raw === '') {
      fields.set(key, [])
      continue
    }
    fields.set(key, raw.startsWith('[') ? splitInlineList(raw) : unquote(raw))
  }

  const titleField = fields.get('title')
  const title = typeof titleField === 'string' ? titleField.trim() : ''
  const tagField = fields.get('tags') ?? fields.get('tag') ?? fields.get('keywords')
  const tags = Array.isArray(tagField) ? tagField : tagField === undefined ? [] : splitInlineList(tagField)
  return { title, tags, body: lines.slice(end + 1).join('\n'), had: true }
}

const ATX_H1 = /^#\s+(.+?)\s*$/

/**
 * 取「正文开头的那个一级标题」，并把它连同后面紧跟的空行一起删掉。
 * 只认 ATX（`# 标题`），且必须是**第一个非空行** —— 后面那些 `#` 是章节标题，
 * 提走它们会把正文结构砍掉一半。
 */
export function leadingHeading(body: string): { title: string; rest: string } | null {
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const hit = ATX_H1.exec(line)
    if (hit === null) return null
    return { title: hit[1]!, rest: lines.slice(i + 1).join('\n').replace(/^(\s*\n)+/, '') }
  }
  return null
}

/** `季度复盘.md` → `季度复盘`；没有扩展名或点号在开头（隐藏文件）时整个名字都算标题。 */
export function titleFromFilename(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).trim()
}

export function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase()
  return MD_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** 去掉开头的空行：front matter 后面习惯跟一个空行，留着会让笔记第一行是空的。 */
function stripLeadingBlanks(text: string): string {
  return text.replace(/^(\s*\n)+/, '')
}

/** 收尾：去掉末尾空白，非空则补一个换行（与 T62 生成笔记时的落盘形状一致）。 */
function normalizeBody(text: string): string {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed === '' ? '' : `${trimmed}\n`
}

function countLines(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/**
 * 一个文件 → 一条导入记录。跳过原因一律外抛（面板要展示），不静默丢文件：
 * 「我选了 5 个，只进来 3 个，另外 2 个去哪了」是最糟的结果。
 */
export function buildMarkdownEntry(file: MarkdownSourceFile): MarkdownImportEntry {
  const bytes = utf8Length(file.text)
  const base: MarkdownImportEntry = { file: file.name, bytes, doc: null, skip: null }
  if (!isMarkdownName(file.name)) return { ...base, skip: 'unsupported' }
  if (bytes > MD_IMPORT_MAX_BYTES) return { ...base, skip: 'tooLarge' }
  const raw = file.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (raw.trim() === '') return { ...base, skip: 'empty' }

  const matter = parseFrontMatter(raw)
  const body = stripLeadingBlanks(matter.body)
  const heading = leadingHeading(body)
  const headingTitle = heading?.title.trim() ?? ''
  // 正文里看得见的那个才是标题：front matter 与 H1 不一致时以 H1 为准，
  // 否则文档树里叫 A、打开却是 B。
  const title = headingTitle !== '' ? headingTitle : matter.title !== '' ? matter.title : titleFromFilename(file.name)
  const titleSource: MarkdownTitleSource =
    headingTitle !== '' ? 'heading' : matter.title !== '' ? 'frontmatter' : 'filename'
  const content = normalizeBody(heading === null ? body : heading.rest)
  return {
    ...base,
    doc: {
      file: file.name,
      title,
      content,
      tags: normalizeNoteTags(matter.tags),
      titleSource,
      hadFrontMatter: matter.had,
      bytes,
      lines: countLines(content),
    },
  }
}

/** 面板用：一次读完多个文件，顺序与入参一致。 */
export function buildMarkdownEntries(files: readonly MarkdownSourceFile[]): MarkdownImportEntry[] {
  return files.map(buildMarkdownEntry)
}

/**
 * 逐篇建笔记，返回新文档 id（顺序与入参一致）。
 * 每篇一条命令：撤销一次只回退一篇（批量导入里最容易出错的往往只有一两篇）。
 *
 * `vault` 在循环里是同一份旧快照，排序键必须自己往下推 —— 与 T62 `importMeetingNotes`
 * 完全同一个理由，否则一并导入的几篇会撞键。
 */
export function importMarkdownDocs(
  bus: CommandBus,
  vault: Vault,
  input: {
    notebookId: string
    docs: readonly MarkdownImportDoc[]
    fallbackTitle: string
    /** 父级文档（null = 笔记本顶层）。缺省顶层：导入的笔记自成一组，不钻进当前选中的那篇。 */
    parentId?: string | null
  },
  deps: NotebookActionDeps = {},
): (string | null)[] {
  const parentId = input.parentId ?? null
  let docs: NoteDoc[] = [...vault.noteDocs]
  const ids: (string | null)[] = []
  for (const doc of input.docs) {
    const order = nextDocOrder(docs, input.notebookId, parentId)
    const id = applyCreateDoc(
      bus,
      vault,
      {
        notebookId: input.notebookId,
        parentId,
        title: doc.title,
        content: doc.content,
        // 没有标签就一个键都不落（T73 的口径：空值 = 没有这个键）
        tags: doc.tags.length === 0 ? undefined : doc.tags,
        order,
        fallbackTitle: input.fallbackTitle,
      },
      deps,
    )
    if (id !== null) {
      // 占位只用来推进排序键，不需要真实时间戳
      docs = [
        ...docs,
        {
          id,
          notebookId: input.notebookId,
          parentId,
          title: doc.title,
          content: '',
          order,
          createdAt: '',
          updatedAt: '',
        },
      ]
    }
    ids.push(id)
  }
  return ids
}
