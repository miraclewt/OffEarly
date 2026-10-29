// T69 · 白板模板：架构分层 / 流程图 / 四象限 / 框架梳理。
//
// 为什么要有模板而不是只给图元：白板最难的不是画方框，是**第一笔从哪落**。空画布让人愣住，
// 一个「已经摆好骨架」的起手式把问题从「设计一张图」降成「往格子里填字」。
//
// 口径：
//   ① 模板只产出**相对坐标**（左上角为原点）+ 文案，不含 id；id 与最终位置由构造层
//      （controllers/whiteboardActions）统一生成，因此模板是纯函数、可直接单测。
//   ② 边用**节点下标**引用两端（模板内部才有的概念），构造层再把下标换成真 id ——
//      模板不需要先造 id 再回头找，也不用把 id 生成器塞进 domain。
//   ③ 文案全部走注入的 labels：domain 不 import i18n（与 mindmapActions 同一约定），
//      缺省回落中文，视图按当前语言覆盖。

import type { WhiteboardAnchor, WhiteboardArrow, WhiteboardEdge, WhiteboardNode, WhiteboardRoute, WhiteboardShape, WhiteboardTone } from './types'

export type WhiteboardTemplateId = 'architecture' | 'flow' | 'quadrant' | 'radial'

/** 模板里的文案槽位：key 在这里定义，译文由视图注入。 */
export type WhiteboardTemplateText =
  | 'archClient'
  | 'archService'
  | 'archData'
  | 'archWeb'
  | 'archMobile'
  | 'archOpenApi'
  | 'archTask'
  | 'archSchedule'
  | 'archNotify'
  | 'archDb'
  | 'archBlob'
  | 'flowStart'
  | 'flowCollect'
  | 'flowReview'
  | 'flowBuild'
  | 'flowEnd'
  | 'flowFix'
  | 'flowYes'
  | 'flowNo'
  | 'flowAgain'
  | 'quadUrgent'
  | 'quadPlan'
  | 'quadDelegate'
  | 'quadDrop'
  | 'radialCenter'
  | 'radialGoal'
  | 'radialUser'
  | 'radialData'
  | 'radialRisk'
  | 'radialTech'
  | 'radialTeam'

const DEFAULT_LABELS: Record<WhiteboardTemplateText, string> = {
  archClient: '接入层',
  archService: '服务层',
  archData: '数据层',
  archWeb: 'Web 端',
  archMobile: '移动端',
  archOpenApi: '开放 API',
  archTask: '任务服务',
  archSchedule: '排期服务',
  archNotify: '通知服务',
  archDb: '主库',
  archBlob: '对象存储',
  flowStart: '开始',
  flowCollect: '收集需求',
  flowReview: '评审通过？',
  flowBuild: '进入开发',
  flowEnd: '结束',
  flowFix: '补充材料',
  flowYes: '是',
  flowNo: '否',
  flowAgain: '改完再来',
  quadUrgent: '重要且紧急\n立即做',
  quadPlan: '重要不紧急\n排进计划',
  quadDelegate: '紧急不重要\n交给别人',
  quadDrop: '不重要不紧急\n先放着',
  radialCenter: '主题',
  radialGoal: '目标',
  radialUser: '用户',
  radialData: '数据',
  radialRisk: '风险',
  radialTech: '技术',
  radialTeam: '团队',
}

/** 模板节点 = 白板节点去掉 id（坐标是相对模板左上角的）。 */
export type WhiteboardTemplateNode = Omit<WhiteboardNode, 'id'>

/** 模板边 = 白板边去掉 id 与两端（改用节点下标）。 */
export interface WhiteboardTemplateEdge extends Omit<WhiteboardEdge, 'id' | 'from' | 'to'> {
  from: number
  to: number
}

export interface WhiteboardTemplateResult {
  width: number
  height: number
  nodes: WhiteboardTemplateNode[]
  edges: WhiteboardTemplateEdge[]
}

interface NodeInput {
  shape: WhiteboardShape
  x: number
  y: number
  width: number
  height: number
  text: string
  tone?: WhiteboardTone
}

interface EdgeInput {
  from: number
  to: number
  route?: WhiteboardRoute
  arrow?: WhiteboardArrow
  dashed?: boolean
  fromAnchor?: WhiteboardAnchor
  toAnchor?: WhiteboardAnchor
  label?: string
}

function node(input: NodeInput): WhiteboardTemplateNode {
  return {
    shape: input.shape,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    text: input.text,
    tone: input.tone ?? 'plain',
  }
}

function edge(input: EdgeInput): WhiteboardTemplateEdge {
  return {
    from: input.from,
    to: input.to,
    route: input.route ?? 'ortho',
    arrow: input.arrow ?? 'end',
    dashed: input.dashed ?? false,
    fromAnchor: input.fromAnchor ?? 'auto',
    toAnchor: input.toAnchor ?? 'auto',
    label: input.label ?? '',
  }
}

/** 架构分层：三层框 + 每层若干服务 + 自上而下的调用箭头。 */
function architecture(labels: Record<WhiteboardTemplateText, string>): WhiteboardTemplateResult {
  const nodes: WhiteboardTemplateNode[] = [
    node({ shape: 'frame', x: 0, y: 0, width: 720, height: 152, text: labels.archClient, tone: 'muted' }),
    node({ shape: 'rect', x: 24, y: 56, width: 200, height: 64, text: labels.archWeb, tone: 'accent' }),
    node({ shape: 'rect', x: 260, y: 56, width: 200, height: 64, text: labels.archMobile, tone: 'accent' }),
    node({ shape: 'rect', x: 496, y: 56, width: 200, height: 64, text: labels.archOpenApi, tone: 'accent' }),
    node({ shape: 'frame', x: 0, y: 184, width: 720, height: 152, text: labels.archService, tone: 'muted' }),
    node({ shape: 'rect', x: 24, y: 240, width: 200, height: 64, text: labels.archTask }),
    node({ shape: 'rect', x: 260, y: 240, width: 200, height: 64, text: labels.archSchedule }),
    node({ shape: 'rect', x: 496, y: 240, width: 200, height: 64, text: labels.archNotify }),
    node({ shape: 'frame', x: 0, y: 368, width: 720, height: 152, text: labels.archData, tone: 'muted' }),
    node({ shape: 'rect', x: 24, y: 424, width: 320, height: 64, text: labels.archDb, tone: 'ok' }),
    node({ shape: 'rect', x: 376, y: 424, width: 320, height: 64, text: labels.archBlob, tone: 'ok' }),
  ]
  const edges: WhiteboardTemplateEdge[] = [
    edge({ from: 1, to: 5 }),
    edge({ from: 2, to: 5 }),
    edge({ from: 3, to: 6 }),
    edge({ from: 5, to: 9 }),
    edge({ from: 6, to: 9 }),
    edge({ from: 7, to: 10 }),
  ]
  return { width: 720, height: 520, nodes, edges }
}

/** 流程图：开始 → 收集 → 判断 →（是）开发 → 结束，判断 →（否）补材料 → 回到收集。 */
function flow(labels: Record<WhiteboardTemplateText, string>): WhiteboardTemplateResult {
  const nodes: WhiteboardTemplateNode[] = [
    node({ shape: 'round', x: 110, y: 0, width: 180, height: 52, text: labels.flowStart, tone: 'accent' }),
    node({ shape: 'rect', x: 110, y: 92, width: 180, height: 56, text: labels.flowCollect }),
    node({ shape: 'diamond', x: 110, y: 188, width: 180, height: 104, text: labels.flowReview, tone: 'warn' }),
    node({ shape: 'rect', x: 110, y: 332, width: 180, height: 56, text: labels.flowBuild }),
    node({ shape: 'round', x: 110, y: 428, width: 180, height: 52, text: labels.flowEnd, tone: 'ok' }),
    node({ shape: 'rect', x: 360, y: 188, width: 180, height: 104, text: labels.flowFix, tone: 'danger' }),
  ]
  const edges: WhiteboardTemplateEdge[] = [
    edge({ from: 0, to: 1 }),
    edge({ from: 1, to: 2 }),
    edge({ from: 2, to: 3, label: labels.flowYes }),
    edge({ from: 3, to: 4 }),
    edge({ from: 2, to: 5, label: labels.flowNo }),
    // 回路走虚线：视觉上一眼区分「主干」与「返工」
    edge({ from: 5, to: 1, dashed: true, label: labels.flowAgain }),
  ]
  return { width: 560, height: 480, nodes, edges }
}

/** 四象限：2×2 四个色块，各带一行结论（文本里 `\n` 由视图按 pre-wrap 渲染）。 */
function quadrant(labels: Record<WhiteboardTemplateText, string>): WhiteboardTemplateResult {
  const nodes: WhiteboardTemplateNode[] = [
    node({ shape: 'rect', x: 0, y: 0, width: 300, height: 240, text: labels.quadUrgent, tone: 'danger' }),
    node({ shape: 'rect', x: 320, y: 0, width: 300, height: 240, text: labels.quadPlan, tone: 'accent' }),
    node({ shape: 'rect', x: 0, y: 260, width: 300, height: 240, text: labels.quadDelegate, tone: 'warn' }),
    node({ shape: 'rect', x: 320, y: 260, width: 300, height: 240, text: labels.quadDrop, tone: 'muted' }),
  ]
  return { width: 620, height: 500, nodes, edges: [] }
}

/** 框架梳理：中心主题 + 六条放射分支（直线，像一张关系草图）。 */
function radial(labels: Record<WhiteboardTemplateText, string>): WhiteboardTemplateResult {
  const center = { x: 300, y: 230, width: 200, height: 100 }
  const nodes: WhiteboardTemplateNode[] = [
    node({ shape: 'ellipse', ...center, text: labels.radialCenter, tone: 'accent' }),
    node({ shape: 'rect', x: 40, y: 40, width: 168, height: 56, text: labels.radialGoal }),
    node({ shape: 'rect', x: 40, y: 240, width: 168, height: 56, text: labels.radialUser }),
    node({ shape: 'rect', x: 40, y: 440, width: 168, height: 56, text: labels.radialData }),
    node({ shape: 'rect', x: 592, y: 40, width: 168, height: 56, text: labels.radialRisk }),
    node({ shape: 'rect', x: 592, y: 240, width: 168, height: 56, text: labels.radialTech }),
    node({ shape: 'rect', x: 592, y: 440, width: 168, height: 56, text: labels.radialTeam }),
  ]
  // 六条分支各自从**不同边**出发：全走 auto 会挤在左右两个中点上叠成三条线
  const sides: WhiteboardAnchor[] = ['top', 'left', 'bottom', 'top', 'right', 'bottom']
  const edges: WhiteboardTemplateEdge[] = [1, 2, 3, 4, 5, 6].map((index, offset) =>
    edge({ from: 0, to: index, route: 'straight', arrow: 'none', fromAnchor: sides[offset] ?? 'auto' }),
  )
  return { width: 800, height: 560, nodes, edges }
}

const BUILDERS: Record<WhiteboardTemplateId, (labels: Record<WhiteboardTemplateText, string>) => WhiteboardTemplateResult> = {
  architecture,
  flow,
  quadrant,
  radial,
}

/** 模板顺序即工具栏里的顺序：从「结构图」到「想法的形状」。 */
export const WHITEBOARD_TEMPLATE_ORDER: readonly WhiteboardTemplateId[] = ['architecture', 'flow', 'quadrant', 'radial']

/**
 * 生成模板（相对坐标，左上角为原点）。`labels` 缺项回落中文默认值——
 * 视图应把当前语言的译文整份传进来，缺项只发生在漏翻了一两个词条时。
 */
export function buildWhiteboardTemplate(
  id: WhiteboardTemplateId,
  labels: Partial<Record<WhiteboardTemplateText, string>> = {},
): WhiteboardTemplateResult {
  const merged = { ...DEFAULT_LABELS, ...labels }
  return BUILDERS[id](merged)
}

export { DEFAULT_LABELS as WHITEBOARD_TEMPLATE_DEFAULT_LABELS }
