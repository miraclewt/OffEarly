// T62 · 会议导入：把 .ics 解析出的会议写成知识库笔记。
//
// 落点是 NoteDoc 而不是 Task，这不是随手选的：
//  - `Task.start` / `Task.due` 是 dateOnly（YYYY-MM-DD），装不下 14:00–15:00 这种时间段，
//    硬塞进去会让甘特图把一场会议算成整天工期；
//  - `Task.assignee` 是单值字符串，参会人列表无处安放；
//  - `NoteDoc` 本来就是「标题 + Markdown 正文」，`applyCreateDoc` 已支持预填正文，
//    所以这条链路零 schema 变更、零迁移。
//
// 去重靠正文里一行 ASCII 令牌（`ics:<uid>@<date>`）：可见、可删、跨语言稳定，
// 不往 schema 里加字段，也不依赖 HTML 注释（Markdown 往返会把它吃掉）。

import { applyCreateDoc } from './notebookActions'
import type { NotebookActionDeps } from './notebookActions'
import type { IcsEvent } from '../domain/ics'
import type { CommandBus } from '../domain/commandBus'
import { nextDocOrder } from '../domain/notebookTree'
import type { NoteDoc, Vault } from '../domain/types'

/** 正文模板用的文案（由视图从 i18n 取，领域层不碰 locale 表）。 */
export interface MeetingLabels {
  info: string
  time: string
  location: string
  organizer: string
  attendees: string
  recurring: string
  /** 重复会议的说明文字（`重复` 是字段名，这句才是值）。 */
  recurringValue: string
  link: string
  linkText: string
  source: string
  invite: string
  decisions: string
  todos: string
  allDay: string
  untitled: string
}

/** 去重令牌。uid 缺失时退回「日期 + 主题」，保证同一场会议不会二次成篇。 */
export function meetingKey(event: IcsEvent): string {
  const identity = event.uid !== '' ? event.uid : `~${event.dateKey}|${event.summary}`
  return `ics:${identity}@${event.dateKey}`
}

const TOKEN = /ics:[^\s@)）]+@\d{4}-\d{2}-\d{2}/g

/** 扫全库正文，收集已经导过的会议令牌。 */
export function collectMeetingKeys(docs: readonly NoteDoc[]): Set<string> {
  const keys = new Set<string>()
  for (const doc of docs) {
    for (const hit of doc.content.match(TOKEN) ?? []) keys.add(hit)
  }
  return keys
}

function timeRange(event: IcsEvent, labels: MeetingLabels): string {
  const startTime = event.start.slice(11, 16)
  if (event.allDay) return `${event.dateKey} · ${labels.allDay}`
  if (event.end === null) return `${event.dateKey} ${startTime}`
  const endDate = event.end.slice(0, 10)
  const endTime = event.end.slice(11, 16)
  if (endDate === event.dateKey) return `${event.dateKey} ${startTime}–${endTime}`
  return `${event.dateKey} ${startTime} – ${endDate} ${endTime}`
}

/** 参会人写成 `@名字`：不做 wikiLink，避免凭空生成一堆不存在的文档链接。 */
function attendeeLine(event: IcsEvent): string {
  const names = event.attendees.map((person) => `@${person.name}`).filter((text) => text !== '@')
  return names.join('、')
}

/** 邀请正文按引用块落地：原文里若带 `#` 或 `---`，不会污染本篇的大纲与分隔。 */
function quoted(text: string): string {
  return text
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n')
}

export function buildMeetingNote(
  event: IcsEvent,
  labels: MeetingLabels,
): { title: string; content: string } {
  const title = event.summary !== '' ? event.summary : labels.untitled
  const rows: string[] = [`- ${labels.time}：${timeRange(event, labels)}`]
  if (event.location !== '') rows.push(`- ${labels.location}：${event.location}`)
  if (event.organizer !== '') rows.push(`- ${labels.organizer}：${event.organizer}`)
  const people = attendeeLine(event)
  if (people !== '') rows.push(`- ${labels.attendees}：${people}`)
  if (event.recurring) rows.push(`- ${labels.recurring}：${labels.recurringValue}`)
  if (event.url !== '') rows.push(`- ${labels.link}：[${labels.linkText}](${event.url})`)
  rows.push(`- ${labels.source}：iCalendar · ${meetingKey(event)}`)

  const blocks: string[] = [`## ${labels.info}`, '', ...rows]
  if (event.description !== '') {
    blocks.push('', `## ${labels.invite}`, '', quoted(event.description))
  }
  blocks.push('', `## ${labels.decisions}`, '', `## ${labels.todos}`, '', '- [ ] ')
  return { title, content: `${blocks.join('\n')}\n` }
}

/**
 * 逐场建笔记。返回新建文档的 id 列表（顺序与 events 一致，已存在或被跳过的为 null）。
 * 每篇单独一条命令：撤销一次只回退一篇，符合「导入多为误操作、逐篇回退更安全」。
 */
export function importMeetingNotes(
  bus: CommandBus,
  vault: Vault,
  input: {
    notebookId: string
    events: readonly IcsEvent[]
    labels: MeetingLabels
    /** 已存在的令牌；不传则在函数内部扫一遍全库。 */
    existing?: ReadonlySet<string>
    /** 父级文档（null = 笔记本顶层）。 */
    parentId?: string | null
  },
  deps: NotebookActionDeps = {},
): (string | null)[] {
  // 拷一份再改：面板传进来的是 memo 出来的只读集合，就地 add 会污染上一次渲染的快照
  const existing = new Set(input.existing ?? collectMeetingKeys(vault.noteDocs))
  const parentId = input.parentId ?? null
  // 批量新建时 `vault` 是同一份旧快照，排序键必须自己往下推，否则一并导入的几篇会撞键
  let docs: NoteDoc[] = [...vault.noteDocs]
  const ids: (string | null)[] = []
  for (const event of input.events) {
    const key = meetingKey(event)
    if (existing.has(key)) {
      ids.push(null)
      continue
    }
    const note = buildMeetingNote(event, input.labels)
    const order = nextDocOrder(docs, input.notebookId, parentId)
    const id = applyCreateDoc(
      bus,
      vault,
      {
        notebookId: input.notebookId,
        parentId,
        title: note.title,
        content: note.content,
        order,
        fallbackTitle: input.labels.untitled,
      },
      deps,
    )
    if (id !== null) {
      existing.add(key)
      // 占位只用来推进排序键，不需要真实时间戳
      docs = [
        ...docs,
        {
          id,
          notebookId: input.notebookId,
          parentId,
          title: note.title,
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
