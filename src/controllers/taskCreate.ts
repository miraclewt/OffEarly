// 新建任务：把「在某列点一下 + 一个标题」翻译成一条可 apply 的命令（纯函数，编排层）。
//
// 分层边界（spec 第 3 节）：views 只渲染 + 转发事件；领域写入一律经 T10 CommandBus。
// 本模块不碰 DOM、不读全局、不改入参，因此可脱离 React 单测（与 boardDnd.ts 同一手法）。
//
// 三条口径：
//   ① 归属话题：优先「当前正被筛选的话题」——筛选生效时新建的任务才看得见；
//      否则取第一个未归档话题；一个可用话题都没有时返回 no-topic，由视图给出提示
//      （topicId 是 Task 的必填字段，没有话题就无法构成合法任务，这里不静默兜底）。
//   ② 排序键：追加到目标列尾部（LexoRank `mid(最后一个键, undefined)`）。
//      只看**未归档**任务——归档任务不在看板上渲染，把它们算进邻居会让新任务
//      落在看不见的位置（与 boardDnd.ts 的列定义一致）。
//   ③ status=done 的任务进度必须是 100（spec 4.2 联动约束）。task.create 的 reducer
//      不做归一（只有 patch 路径过 normalizePatch），所以在构造任务时就摆正，
//      否则「直接建在已完成列」会造出一条违反不变式的数据。

import { nanoid } from 'nanoid'

import { createTaskCommand } from '../domain/commandBus'
import type { Command, CommandBus } from '../domain/commandBus'
import { mid } from '../domain/lexorank'
import type { Topic, Kind, Priority, Status, Task, Vault } from '../domain/types'
import { sortByOrder } from './boardDnd'

/** 新任务的默认属性：类别与优先级给中性初值，明细在任务详情弹窗（T17）里改。 */
export const NEW_TASK_KIND: Kind = 'feature'
export const NEW_TASK_PRIORITY: Priority = 'P2'

export interface NewTaskInput {
  /** 任务标题；空白标题抛错（视图层已拦，这里不静默兜底）。 */
  title: string
  /** 落在哪一列（= status）。 */
  status: Status
  /** 归属话题；省略即按「筛选话题 → 第一个未归档话题」推断。 */
  topicId?: string
}

export interface CreateTaskDeps {
  /** 注入 id 生成，便于测试确定化。 */
  newId?: () => string
  /** 注入时钟，便于测试确定化。 */
  now?: () => Date
}

/** 新建计划：要么落地成一条命令，要么「没有可用话题」。 */
export type CreateTaskPlan =
  | { kind: 'create'; command: Command; task: Task }
  | { kind: 'no-topic' }

function orderedTopics(topics: readonly Topic[]): Topic[] {
  return [...topics].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
}

/** 未归档且存在的话题 id。 */
function usableTopicId(vault: Vault, id: string): boolean {
  return vault.topics.some((topic) => topic.id === id && !topic.archived)
}

/**
 * 新任务的归属话题：
 *   ① 显式指定且该话题可用 → 用它；
 *   ② 否则取当前筛选里第一个可用话题（筛选生效时新任务才落在可见范围内）；
 *   ③ 否则取第一个未归档话题；
 *   ④ 一个都没有 → null（调用方转成 no-topic，提示先建话题）。
 */
export function pickDefaultTopicId(vault: Vault, preferred?: string): string | null {
  if (preferred !== undefined && usableTopicId(vault, preferred)) return preferred
  for (const id of vault.settings.lastFilter?.topicIds ?? []) {
    if (usableTopicId(vault, id)) return id
  }
  const first = orderedTopics(vault.topics).find((topic) => !topic.archived)
  return first?.id ?? null
}

/** 追加到目标列尾部的新排序键；空列取 LexoRank 的中点初值。 */
export function nextOrderFor(vault: Vault, status: Status): string {
  const column = sortByOrder(
    vault.tasks.filter((task) => !task.archived && task.status === status),
  )
  const last = column[column.length - 1]
  return mid(last?.order, undefined)
}

/**
 * 构造新任务；没有可用话题时返回 null。
 * 标题正常化：只 trim 首尾空白，内部空白与大小写原样保留（sheet 数据不进 t()）。
 */
export function buildNewTask(vault: Vault, input: NewTaskInput, deps: CreateTaskDeps = {}): Task | null {
  const title = input.title.trim()
  if (title === '') throw new Error('taskCreate: 任务标题不能为空')
  const topicId = pickDefaultTopicId(vault, input.topicId)
  if (topicId === null) return null
  const timestamp = (deps.now ?? (() => new Date()))().toISOString()
  return {
    id: (deps.newId ?? (() => nanoid()))(),
    topicId,
    title,
    status: input.status,
    kind: NEW_TASK_KIND,
    priority: NEW_TASK_PRIORITY,
    progress: input.status === 'done' ? 100 : 0,
    tags: [],
    note: '',
    order: nextOrderFor(vault, input.status),
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
  }
}

/** 只算不写：返回要 apply 的命令（复用 T10 既有的 createTaskCommand，不扩命令类型）。 */
export function planCreateTask(vault: Vault, input: NewTaskInput, deps: CreateTaskDeps = {}): CreateTaskPlan {
  const task = buildNewTask(vault, input, deps)
  if (task === null) return { kind: 'no-topic' }
  return { kind: 'create', command: createTaskCommand(task), task }
}

/**
 * 计划 + 应用。no-topic 时一个字节都不写（不污染撤销栈、不触发 autosave 的 dirty 态），
 * 视图据此提示「先建一个话题」。视图层只调这一个函数（与 applyBoardDrop 同一手法）。
 */
export function applyCreateTask(
  bus: CommandBus,
  vault: Vault,
  input: NewTaskInput,
  deps: CreateTaskDeps = {},
): CreateTaskPlan {
  const plan = planCreateTask(vault, input, deps)
  if (plan.kind === 'create') bus.apply(plan.command)
  return plan
}
