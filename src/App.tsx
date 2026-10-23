import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useStore } from 'zustand'

import { createCommandBus } from './domain/commandBus'
import type { Command, CommandBus } from './domain/commandBus'
import { createEmptyFilter } from './domain/queryEngine'
import { createVaultStore } from './domain/store'
import type { VaultStore } from './domain/store'
import type { Filter, Status, Vault } from './domain/types'
import { applyCreateTask } from './controllers/taskCreate'
import { createI18n } from './locales/i18n'
import type { I18n, LocaleSource, MsgKey, TranslateParams } from './locales/i18n'
import { createAutosave } from './persistence/autosave'
import type { Autosave } from './persistence/autosave'
import { connectDir } from './persistence/fsAdapter'
import { handleStore, verifyPermission } from './persistence/handleStore'
import type { VaultDirHandle } from './persistence/handleStore'
import { createSnapshotStore } from './persistence/snapshotStore'
import type { SnapshotStore } from './persistence/snapshotStore'
import {
  createConflictGuard,
  createRevisionWatcher,
  createSelfHealingLoader,
  createVaultRepository,
  guardCommandBus,
  readOnlyMessage,
  ReadOnlyError,
} from './persistence/vaultRepository'
import type {
  ConflictGuard,
  ConflictReport,
  ReadOnlyGuard,
  RevisionWatcher,
  SafeModeSnapshotRef,
  SelfHealingLoader,
  VaultRepository,
} from './persistence/vaultRepository'
import { VaultValidationError } from './domain/schema'
import { CommandPalette } from './views/CommandPalette'
import { ConflictDialog } from './views/ConflictDialog'
import type { ConflictLabels } from './views/ConflictDialog'
import { BoardView } from './views/BoardView'
import { GanttView } from './views/GanttView'
import { MindMapView } from './views/MindMapView'
import { NotebookView } from './views/NotebookView'
import { FilterBar } from './views/FilterBar'
import { MilestonePanel } from './views/MilestonePanel'
import { createAssetStore } from './persistence/assetStore'
import type { AssetStore } from './persistence/assetStore'
import { createTopicActions } from './controllers/topicActions'
import { createNoteAssetsPort } from './controllers/noteAssets'
import type { NoteAssetsPortHandle } from './controllers/noteAssets'
import { createBackupExportPort, createBackupImportPort } from './controllers/backupPort'
import type { BackupExportPort, BackupImportPort, BackupSnapshotPort } from './controllers/backupPort'
import { createBackupGcPort } from './controllers/backupGc'
import type { BackupGcPort } from './controllers/backupGc'
import { TaskDrawer } from './views/TaskDrawer'
import { Icon, IconSprite } from './views/IconSprite'
import { SafeModeBanner } from './views/SafeModeBanner'
import type { SafeModeLabels } from './views/SafeModeBanner'
import { SaveIndicator } from './views/SaveIndicator'
import { TopicSidebar } from './views/TopicSidebar'
import { BackupPanel } from './views/BackupPanel'
import type { BackupPanelLabels } from './views/BackupPanel'
import { SettingsPanel } from './views/SettingsPanel'
import { fs, px, sp } from './styles/scale'

const INDIGO = 'var(--oe-accent)'
const TEXT = 'var(--oe-text)'
const MUTED = 'var(--oe-text-muted)'

function LogoMark() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke={INDIGO}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17.34 14.96 A7 7 0 1 1 17.34 9.04" />
      <path d="M11 12 V7.5" />
      <path d="M11 12 L12.75 15.03" />
      <path d="M19 12 H22.5" />
      <path d="M20.6 10.1 L22.5 12 L20.6 13.9" />
    </svg>
  )
}

/**
 * 启动流程与真实环境的接缝：组件测试注入 fake ports，
 * 磁盘访问（connectDir / handleStore / VaultRepository）由此进出。
 */
export interface StartupPorts {
  loadStoredDir(): Promise<VaultDirHandle | null>
  storeDir(dir: VaultDirHandle): Promise<unknown>
  hasWritePermission(dir: VaultDirHandle): Promise<boolean>
  requestWritePermission(dir: VaultDirHandle): Promise<boolean>
  pickDir(): Promise<VaultDirHandle>
  openRepository(dir: VaultDirHandle): VaultRepository
}

function asVaultDir(handle: FileSystemDirectoryHandle): VaultDirHandle {
  return handle as VaultDirHandle
}

export function startupPorts(): StartupPorts {
  return {
    loadStoredDir: () => handleStore.load(),
    storeDir: (dir) => handleStore.save(dir),
    hasWritePermission: (dir) => verifyPermission(dir, false),
    requestWritePermission: (dir) => verifyPermission(dir, true),
    pickDir: async () => asVaultDir(await connectDir()),
    openRepository: (dir) => createVaultRepository(dir),
  }
}

/** 库打开前的 locale：按浏览器语言解析；打开后换接 VaultStore（见 useI18n）。 */
const BOOT_LOCALE: LocaleSource = { getLocale: () => 'auto', subscribe: () => () => {} }

/**
 * 打开一个库拿到的全套控制面。
 *
 * T14/T20/T27/T29 的组件都是「可挂载」的，接线统一收口在这里：
 * Store 仍是唯一状态源，落盘面/冲突闸门/自愈加载器/轮询都挂在同一份 Store 上。
 */
export interface Session {
  store: VaultStore
  repository: VaultRepository
  autosave: Autosave
  /** T10 的撤销/重做队列，外面包了 T29 的只读闸门。 */
  bus: CommandBus
  /** T29：启动自愈 + 只读安全模式。 */
  loader: SelfHealingLoader
  /** T27：写盘前的 revision 冲突闸门。 */
  conflictGuard: ConflictGuard
  /** T27：30s 轮询磁盘 revision。 */
  watcher: RevisionWatcher
  /** 与 loader 共享同一个只读开关。 */
  readOnly: ReadOnlyGuard
  /** T25：图片 sidecar 的落盘面（assets/ 与 blob URL 缓存）。 */
  assets: AssetStore
  /** T25：给 NoteEditor 的附件端口（落盘 + 显示 + 就绪通知）。 */
  noteAssets: NoteAssetsPortHandle
  /** T28：快照存储（备份面板的列表 / 立即快照 / 恢复）。 */
  snapshots: SnapshotStore
  /** T28：导出 / 导入 / gc 三个备份端口（面板是纯视图，经它们碰文件系统）。 */
  backupExport: BackupExportPort
  backupImport: BackupImportPort
  backupGc: BackupGcPort
}

/** 会话向外汇报的三类事件（组件只负责显示，决定权留在接线层）。 */
interface SessionHooks {
  onConflict(report: ConflictReport): void
  onRemoteChange(): void
  onWriteRejected(message: string): void
}

/**
 * 冲突时**不落盘**，但要保住 autosave 的 dirty 态：
 * 抛出哨兵错误让 autosave 停在「未保存」而不是谎报成功，弹窗随后接管。
 */
class ConflictPendingError extends Error {
  constructor() {
    super('conflict pending')
    this.name = 'ConflictPendingError'
  }
}

/**
 * 打开一个库 = 建 Store + 落盘面 + 自动保存 + 冲突闸门 + 只读闸门。
 * Store 从此是唯一状态源（T10）。
 */
function openSession(
  dir: VaultDirHandle,
  repository: VaultRepository,
  loader: SelfHealingLoader,
  vault: Vault,
  hooks: SessionHooks,
): Session {
  const store = createVaultStore(vault)
  const conflictGuard = createConflictGuard(dir, repository)
  // T28：快照存储实例——autosave 的写前快照与备份面板共用同一份（各自独立闸门）。
  const snapshots = createSnapshotStore(dir)

  // T10 的命令队列 + T29 的只读闸门：只读时 apply/undo/redo 抛 ReadOnlyError 并回调提示。
  // guardCommandBus 只覆盖写入口，undoDepth/subscribe/clear 仍透传真实队列。
  const rawBus = createCommandBus(store)
  const guarded = guardCommandBus<Command>(rawBus, loader.readOnly, hooks.onWriteRejected)
  const bus: CommandBus = {
    apply: (command) => {
      guarded.apply(command)
    },
    undo: () => guarded.undo(),
    redo: () => guarded.redo(),
    canUndo: () => guarded.canUndo?.() ?? false,
    canRedo: () => guarded.canRedo?.() ?? false,
    undoDepth: () => rawBus.undoDepth(),
    redoDepth: () => rawBus.redoDepth(),
    subscribe: (listener) => rawBus.subscribe(listener),
    clear: () => {
      rawBus.clear()
    },
  }

  const autosave = createAutosave({
    store,
    // spec 8.2「写前必有快照」：T09 的自动策略闸门（会话首存 1 份 / 距上次 ≥30min）
    // 挂在 sink.save 之前；快照失败按保存失败处理，绝不无备份覆盖。
    snapshotter: snapshots.autoSnapshotter(),
    // autosave 必须挂在同一个 store 上，否则它盯的是另一份内存，永远等不到变更。
    // sink 依次过两道闸门：只读（T29）→ 冲突（T27）。
    sink: {
      async save(next) {
        if (loader.readOnly.isReadOnly()) {
          throw new ReadOnlyError(readOnlyMessage(loader.readOnly.reason()))
        }
        const report = await conflictGuard.saveGuarded(next)
        if (report !== null) {
          hooks.onConflict(report)
          throw new ConflictPendingError()
        }
      },
    },
  })

  // T25：图片 sidecar 落盘面 + 编辑器附件端口（图片不经 vault.json，单独走 assets/）
  const assets = createAssetStore(dir)
  const noteAssets = createNoteAssetsPort(store, assets)
  // T28：备份面板的三个端口——导出/导入/附件回收（面板纯视图经它们碰文件系统）。
  const backupExport = createBackupExportPort(dir)
  const backupImport = createBackupImportPort()
  const backupGc = createBackupGcPort(store, assets)

  // T27 的 30s 轮询：磁盘变且本地不脏 → 静默重载；本地脏 → 顶栏提示，等保存时再问。
  const watcher = createRevisionWatcher({
    peekRevision: () => repository.peekRevision(),
    getMemoryRevision: () => store.getVault().revision,
    isDirty: () => autosave.isDirty(),
    reload: async () => {
      const disk = await repository.load()
      if (disk === null) return
      // 重载前后停一次：否则 setVault 会被 autosave 当成用户编辑而立刻回写
      autosave.stop()
      store.setVault(disk)
      autosave.start()
    },
    notify: () => {
      hooks.onRemoteChange()
    },
  })

  return { store, repository, autosave, bus, loader, conflictGuard, watcher, readOnly: loader.readOnly, assets, noteAssets, snapshots, backupExport, backupImport, backupGc }
}

type Phase =
  | { kind: 'booting' }
  | { kind: 'need-dir' }
  | { kind: 'need-permission'; dir: VaultDirHandle }
  | { kind: 'busy'; dir: VaultDirHandle }
  | { kind: 'empty-dir'; dir: VaultDirHandle }
  | ({ kind: 'ready'; dir: VaultDirHandle } & Session)
  | ({ kind: 'readonly'; dir: VaultDirHandle; reason: string; snapshot: SafeModeSnapshotRef | null } & Session)
  | { kind: 'safe-mode'; dir: VaultDirHandle; reason: string }
  | { kind: 'failed'; reason: string }

/** 会话 + 目录 → ready 相位（自愈恢复成功后从 readonly 回到可写）。 */
function asReady(dir: VaultDirHandle, session: Session): Phase {
  return { kind: 'ready', dir, ...session }
}

/** 启动/冲突检测读到的失败统一成一行可读原因；磁盘内容此时一律不写。 */
function loadFailureReason(e: unknown): string {
  if (e instanceof VaultValidationError) {
    return e.issues.length > 0 ? `${e.message}（${e.issues.join('；')}）` : e.message
  }
  return e instanceof Error ? e.message : String(e)
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/**
 * 启动屏与看板共享一份 i18n：locale 存在库里，源就是 VaultStore。
 * 外层 useSyncExternalStore 让 settings.locale 一变整棵树就重渲染（T04 的接线收口）。
 */
function useI18n(source: LocaleSource): I18n {
  const i18n = useMemo(() => createI18n(source), [source])
  useSyncExternalStore(i18n.subscribe, i18n.getLocale)
  return i18n
}

const CARD: CSSProperties = {
  maxWidth: sp(420),
  margin: '0 auto',
  padding: px('28px 32px'),
  background: 'var(--oe-surface)',
  border: `1px solid var(--oe-separator)`,
  borderRadius: 'var(--oe-radius-overlay)',
  boxShadow: 'var(--oe-shadow-pop)',
  textAlign: 'center',
}

function StartupScreen(props: {
  icon: 'backup' | 'settings' | 'note' | 'close'
  title: string
  hint: string
  reason?: string
  primary: { label: string; onClick: () => void }
  secondary?: { label: string; onClick: () => void }
}) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <div style={CARD}>
        <Icon name={props.icon} size={28} label="" />
        <div style={{ fontSize: fs(15), fontWeight: 600, color: TEXT, marginTop: sp(12) }}>{props.title}</div>
        <div style={{ fontSize: fs(12), color: MUTED, marginTop: sp(8), lineHeight: 1.7 }}>{props.hint}</div>
        {props.reason === undefined ? null : (
          <div style={{ fontSize: fs(12), color: 'var(--oe-blocked)', marginTop: sp(8) }}>{props.reason}</div>
        )}
        <div style={{ display: 'flex', gap: sp(8), justifyContent: 'center', marginTop: sp(16) }}>
          <button
            type="button"
            onClick={props.primary.onClick}
            style={{
              padding: px('6px 16px'),
              fontSize: fs(13),
              color: 'var(--oe-on-accent)',
              background: INDIGO,
              border: 'none',
              borderRadius: 'var(--oe-radius-control)',
              cursor: 'pointer',
            }}
          >
            {props.primary.label}
          </button>
          {props.secondary === undefined ? null : (
            <button
              type="button"
              onClick={props.secondary.onClick}
              style={{
                padding: px('6px 16px'),
                fontSize: fs(13),
                color: 'var(--oe-text-secondary)',
                background: 'var(--oe-fill)',
                border: 'none',
                borderRadius: 'var(--oe-radius-control)',
                cursor: 'pointer',
              }}
            >
              {props.secondary.label}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 顶栏的撤销 / 重做（T52）。
 *
 * 背景：CommandBus 从 T10 起就有完整的 undo/redo 栈，`guardCommandBus` 也一直透传
 * canUndo / canRedo，但全库只有任务弹窗绑了 Ctrl+Z（TaskDrawer.tsx）——拖错列、归档话题、
 * 删除里程碑、删除知识库文档之后没有任何入口能退回去，用户只能去 .backup/ 找整库快照。
 *
 * 这两个按钮直接订阅 bus 的栈深通知（apply / undo / redo / clear 都会 emit），
 * 所以禁用态与快捷键永远一致，不存在"按钮亮着但按了没反应"。
 */
/**
 * T59 · 搜索浮层的挂载点。
 *
 * 为什么不直接在 App 里订阅：App 本身不订阅 vault（只有 Workspace 订阅），
 * 而 hooks 不能写在 `session === null` 的条件里。拆一个只订阅 vault 的小组件，
 * 既保住了 hooks 规则，也让浮层永远拿到最新一份任务与文档。
 */
function PaletteMount(props: {
  store: VaultStore
  open: boolean
  onOpenChange: (open: boolean) => void
  t: (key: MsgKey, params?: TranslateParams) => string
  onOpenTask: (id: string) => void
  onOpenDoc: (notebookId: string, docId: string) => void
  onSelectView: (view: 'board' | 'gantt' | 'mindmap' | 'notebook') => void
  onOpenSettings: () => void
  onOpenBackup: () => void
}) {
  const vault = useStore(props.store, (state) => state.vault)
  return <CommandPalette {...props} vault={vault} />
}

function UndoRedo(props: { bus: CommandBus; t: (key: MsgKey, params?: TranslateParams) => string }) {
  const { bus, t } = props
  const undoDepth = useSyncExternalStore(bus.subscribe, bus.undoDepth, bus.undoDepth)
  const redoDepth = useSyncExternalStore(bus.subscribe, bus.redoDepth, bus.redoDepth)
  const style = (enabled: boolean): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: sp(26),
    height: sp(24),
    padding: 0,
    color: enabled ? 'var(--oe-text-secondary)' : 'var(--oe-text-faint)',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--oe-radius-control)',
    cursor: enabled ? 'pointer' : 'default',
  })
  return (
    <div data-testid="undo-redo" style={{ display: 'flex', alignItems: 'center', gap: sp(2) }}>
      <button
        type="button"
        data-testid="undo-button"
        aria-label={t('undoRedo.undo')}
        title={t('undoRedo.undoHint')}
        disabled={undoDepth === 0}
        onClick={() => bus.undo()}
        style={style(undoDepth > 0)}
      >
        <Icon name="undo" />
      </button>
      <button
        type="button"
        data-testid="redo-button"
        aria-label={t('undoRedo.redo')}
        title={t('undoRedo.redoHint')}
        disabled={redoDepth === 0}
        onClick={() => bus.redo()}
        style={style(redoDepth > 0)}
      >
        <Icon name="redo" />
      </button>
    </div>
  )
}

/**
 * 视图宿主：vault 与 filter 只在这里派生一次，看板与甘特共用（spec §6.2）。
 * 看板走 T15 的 BoardView（根元素自带 data-testid="board"，E2E 依赖它）；
 * 甘特走 T20/T21 的 GanttView。任务详情弹窗（T17；T36 起改为居中弹窗）在 App 顶层挂载（fixed 遮罩），此处不再留挂载位。
 */
function Workspace(props: {
  store: VaultStore
  view: 'board' | 'gantt' | 'mindmap' | 'notebook'
  t: (key: MsgKey, params?: TranslateParams) => string
  /** 写入口（T10 CommandBus，可能包了 T29 只读闸门）；BoardView 改列/换序经它落盘。 */
  bus: CommandBus
  /** 甘特菱形（data-gantt-milestone）点击 → 拉起里程碑面板（T18 选中契约的落点）。 */
  onOpenMilestone?: (milestoneId: string) => void
  /** 看板卡片 / 甘特条（data-gantt-bar）点击 → 拉起任务详情弹窗（T17 选中契约的落点）。 */
  onOpenTask?: (taskId: string) => void
  /** T49：知识库文档里的图片插入 / 显示（与任务笔记同一个附件端口）。 */
  noteAssets?: NoteAssetsPortHandle
  /** T50：当前界面语言（知识库导出文件用）。 */
  locale: 'zh' | 'en'
  /** T59：全局搜索命中的文档，交给知识库自己去定位。 */
  focusDoc?: { notebookId: string; docId: string; nonce: number } | null
}) {
  const { store, view, t, bus, onOpenMilestone, onOpenTask, noteAssets, locale, focusDoc } = props
  const vault = useStore(store, (state) => state.vault)
  // spec §6.2：看板与甘特共用同一份筛选结果，切视图不丢条件
  const filter = useMemo<Filter>(() => vault.settings.lastFilter ?? createEmptyFilter(), [vault.settings.lastFilter])

  // 列内新建：一个未归档话题都没有时（topicId 是必填字段）不提供入口，只给灰行说明
  const canCreateTask = useMemo(() => vault.topics.some((topic) => !topic.archived), [vault.topics])

  /**
   * `+ 新建任务` 的落点：读**实时**库（store.getVault()）而不是渲染快照——
   * 连续回车录入时，排序键才不会拿旧库算出重复的 order；
   * 命令构造在 controllers/taskCreate.ts（纯函数，单测覆盖）。
   */
  function createTask(status: Status, title: string): void {
    applyCreateTask(bus, store.getVault(), { title, status })
  }

  /**
   * 空库引导（T52）：一个未归档话题都没有时，看板顶部给一个**真能点**的入口。
   * 此前四列只重复一行灰字「先建一个话题」，而新用户唯一的入口是侧栏那个 14px 的「+」。
   * 走的是侧栏同一个写入口（topicActions），名字先落占位，随后可在侧栏改名。
   */
  function createTopicFromBoard(): void {
    createTopicActions({ store, bus }).createTopic(null, t('boardGuide.untitledTopic'))
  }

  return (
    <div style={{ display: 'flex', height: '100%', minWidth: 0, minHeight: 0 }}>
      <div
        style={{ flex: 1, minWidth: 0, minHeight: 0 }}
        // T18/T17 的选中契约只交付了 data-gantt-milestone / data-gantt-bar 标记 + props 契约，
        // GanttCanvas 的菱形与任务条都无自带 onClick——这里用事件委托捕获点击，
        // 把 id 外送给 App 拉起里程碑面板 / 任务弹窗（零侵入 GanttView/GanttCanvas）。
        onClick={(event) => {
          const el = event.target as Element | null
          if (el === null) return
          const diamond = el.closest('[data-gantt-milestone]')
          if (diamond !== null && onOpenMilestone !== undefined) {
            const id = diamond.getAttribute('data-gantt-milestone')
            if (id !== null) {
              onOpenMilestone(id)
              return
            }
          }
          const bar = el.closest('[data-gantt-bar]')
          if (bar !== null && onOpenTask !== undefined) {
            const id = bar.getAttribute('data-gantt-bar')
            if (id !== null) onOpenTask(id)
          }
        }}
      >
        {view === 'mindmap' ? (
          // T45：导图自带 onClick（节点选中留在视图本地 state），不经上面的事件委托；
          // 空态「新建」经 Workspace 的 bus（可能包了 T29 只读闸门）落盘。
          <MindMapView vault={vault} bus={bus} t={t} />
        ) : view === 'notebook' ? (
          // T49：知识库。选中态留在视图本地；文档里的 [[任务]] / [[里程碑]] 经回调拉起既有面板。
          <NotebookView
            vault={vault}
            bus={bus}
            t={t}
            assets={noteAssets}
            locale={locale}
            onOpenTask={onOpenTask}
            onOpenMilestone={onOpenMilestone}
            focusDoc={focusDoc}
          />
        ) : view === 'gantt' ? (
          <GanttView
            vault={vault}
            filter={filter}
            scale={vault.settings.ganttScale}
            t={t}
            // T22：未排期侧栏点一行 → 同一个任务弹窗（与看板卡片、甘特条同一入口）
            onOpenTask={onOpenTask}
          />
        ) : (
          <BoardView
            vault={vault}
            filter={filter}
            bus={bus}
            t={t}
            onOpenTask={onOpenTask}
            onCreateTask={canCreateTask ? createTask : undefined}
            createHint={t('newTask.noTopic')}
            onCreateTopic={canCreateTask ? undefined : createTopicFromBoard}
          />
        )}
      </div>
      {/* T36：任务详情是 fixed 居中弹窗（TaskDrawer 自带遮罩，在 App 顶层挂载），
          不再需要 T15 预留给「右侧抽屉列」的宿主占位 div —— 它没有任何引用，已删除。 */}
    </div>
  )
}

export function App(props: { ports?: StartupPorts; onSession?: (session: Session) => void }) {
  // ports 必须稳定：startupPorts() 每次调用都返回新对象，
  // 若直接内联，启动 effect（依赖 [ports]）会在每次渲染后重跑，
  // 反复 setPhase 形成渲染死循环，用户点击推进的相位会被立刻覆盖回 need-dir。
  const ports = useMemo(() => props.ports ?? startupPorts(), [props.ports])
  const [phase, setPhase] = useState<Phase>({ kind: 'booting' })
  const [view, setView] = useState<'board' | 'gantt' | 'mindmap' | 'notebook'>('board')
  const [conflict, setConflict] = useState<ConflictReport | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // 里程碑面板（T18）：受控开合 + 选中态。侧栏入口与甘特菱形点击共用同一面板。
  const [milestoneOpen, setMilestoneOpen] = useState(false)
  const [milestoneSelectedId, setMilestoneSelectedId] = useState<string | null>(null)
  // T17 任务详情弹窗（T36 起居中弹窗）：受控开合 + 选中任务 id。
  // 看板卡片、甘特条、未排期侧栏三处点击共用同一入口。
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null)
  // T16 筛选面板：受控开合（侧栏「筛选器」入口拉起）。
  const [filterOpen, setFilterOpen] = useState(false)
  // T28 备份面板：受控开合（侧栏「备份」入口拉起）。
  const [backupOpen, setBackupOpen] = useState(false)
  // T35 设置面板：受控开合（侧栏「设置」入口拉起，此前是 shell.panelPending 占位）。
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** T59 · 全局搜索浮层；焦点目标用于「搜到文档后直接在那个笔记本里打开它」。 */
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [focusDoc, setFocusDoc] = useState<{ notebookId: string; docId: string; nonce: number } | null>(null)

  /** 会话事件出口：组件只显示，决定权留在这一层。 */
  const hooks = useMemo<SessionHooks>(
    () => ({
      onConflict: (report) => {
        setConflict(report)
      },
      onRemoteChange: () => {
        setNotice({ key: 'shell.remoteUpdated' })
      },
      onWriteRejected: (message) => {
        setNotice({ text: message })
      },
    }),
    [],
  )

  /** 会话建好的一次性外送口：宿主与测试由此拿到 Store/落盘面/自动保存。 */
  function makeSession(
    dir: VaultDirHandle,
    repository: VaultRepository,
    loader: SelfHealingLoader,
    vault: Vault,
  ): Session {
    const session = openSession(dir, repository, loader, vault, hooks)
    props.onSession?.(session)
    return session
  }

  /**
   * 打开目录：T29 的自愈加载器替换裸 repository.load()——
   * 磁盘坏掉时先试最近快照（readonly），再也没有才进 safemode；两条路都不写盘。
   */
  function openDir(dir: VaultDirHandle): Promise<void> {
    setPhase({ kind: 'busy', dir })
    const repository = ports.openRepository(dir)
    const loader = createSelfHealingLoader(dir, repository)
    return loader
      .load()
      .then((outcome) => {
        if (outcome.status === 'empty') {
          setPhase({ kind: 'empty-dir', dir })
          return
        }
        if (outcome.status === 'healthy' && outcome.vault !== null) {
          // 只有健康打开才记住句柄：空目录、损坏的库都不该污染下次启动
          return ports.storeDir(dir).then(() => {
            setPhase({ kind: 'ready', dir, ...makeSession(dir, repository, loader, outcome.vault as Vault) })
          })
        }
        if (outcome.status === 'readonly' && outcome.vault !== null) {
          setPhase({
            kind: 'readonly',
            dir,
            reason: outcome.reason ?? '',
            snapshot: outcome.snapshot,
            ...makeSession(dir, repository, loader, outcome.vault),
          })
          return
        }
        setPhase({ kind: 'safe-mode', dir, reason: outcome.reason ?? '' })
      })
      .catch((e: unknown) => {
        setPhase({ kind: 'failed', reason: loadFailureReason(e) })
      })
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const handle = await ports.loadStoredDir()
      if (cancelled) return
      if (handle === null) {
        setPhase({ kind: 'need-dir' })
        return
      }
      if (!(await ports.hasWritePermission(handle))) {
        setPhase({ kind: 'need-permission', dir: handle })
        return
      }
      await openDir(handle)
    })().catch((e: unknown) => {
      if (!cancelled) setPhase({ kind: 'failed', reason: loadFailureReason(e) })
    })
    return () => {
      cancelled = true
    }
  }, [ports])

  const session = phase.kind === 'ready' || phase.kind === 'readonly' ? phase : null

  // 自动保存跟着会话起停；只读安全模式下不起——那是「一个字节都不许写」的相位
  const autosave = phase.kind === 'ready' ? phase.autosave : null
  useEffect(() => {
    if (autosave === null) return
    autosave.start()
    return () => {
      autosave.stop()
    }
  }, [autosave])

  // T27 的磁盘轮询也只在可写会话里跑
  useEffect(() => {
    if (autosave === null || session === null) return
    const watcher = session.watcher
    watcher.start()
    return () => {
      watcher.stop()
    }
  }, [autosave, session])

  // T25：换库 / 卸载时回收全部 blob URL（不 revoke 会一直占着内存）
  const noteAssets = session?.noteAssets ?? null
  useEffect(() => {
    if (noteAssets === null) return
    return () => {
      noteAssets.dispose()
    }
  }, [noteAssets])

  // T59 · Ctrl/Cmd + K 打开全局搜索。只在已连接库时生效——
  // 启动页 / 安全模式下没有可搜的内容，抢这个键只会让人困惑。
  useEffect(() => {
    if (phase.kind !== 'ready') return
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setPaletteOpen((open) => !open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [phase.kind])

  // Ctrl+S / Cmd+S 立即落盘（spec 8.2）
  useEffect(() => {
    if (autosave === null) return
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void autosave?.saveNow()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [autosave])

  /**
   * T52：全局撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）。
   *
   * 三条边界，缺一条就会和既有交互打架：
   *   ① 输入框 / contenteditable 里的 Ctrl+Z 归浏览器——笔记正文有自己的历史栈，
   *      抢过来会把「撤销刚打的字」变成「撤销十分钟前的拖拽」；
   *   ② 任务弹窗打开时由它自己处理（它会先把正在编辑的标题草稿提交，再退栈）；
   *   ③ 只读安全模式 / 没有会话时压根不挂（bus 的写入口已被 T29 的闸门封住）。
   */
  useEffect(() => {
    if (session === null) return
    const bus = session.bus
    function isEditable(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      if (target.isContentEditable) return true
      const tag = target.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      const redo = (key === 'z' && event.shiftKey) || key === 'y'
      const undo = key === 'z' && !event.shiftKey
      if (!undo && !redo) return
      if (drawerOpen || isEditable(event.target)) return
      event.preventDefault()
      if (undo) bus.undo()
      else bus.redo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [session, drawerOpen])

  function handlePick() {
    void ports
      .pickDir()
      .then((dir) => {
        return openDir(dir)
      })
      .catch((e: unknown) => {
        if (isAbort(e)) {
          setPhase({ kind: 'need-dir' })
        } else {
          setPhase({ kind: 'failed', reason: loadFailureReason(e) })
        }
      })
  }

  function handleGrant(dir: VaultDirHandle) {
    void ports.requestWritePermission(dir).then((granted) => {
      if (granted) void openDir(dir)
    })
  }

  function handleCreate(dir: VaultDirHandle) {
    const repository = ports.openRepository(dir)
    const loader = createSelfHealingLoader(dir, repository)
    void repository
      .create()
      .then(async (vault) => {
        await ports.storeDir(dir)
        setPhase({ kind: 'ready', dir, ...makeSession(dir, repository, loader, vault) })
      })
      .catch((e: unknown) => {
        setPhase({ kind: 'failed', reason: loadFailureReason(e) })
      })
  }

  /** 冲突三选：解决完一律把 autosave 停一次再起，让它以新基线重新计数（脏态归零）。 */
  function resolveConflict(choice: 'mine' | 'disk' | 'export') {
    if (session === null || conflict === null) return
    const local = session.store.getVault()
    const reset = (vault: Vault | null): void => {
      session.autosave.stop()
      if (vault !== null) session.store.setVault(vault)
      session.autosave.start()
    }
    void (async () => {
      try {
        if (choice === 'mine') {
          const { revision } = await session.conflictGuard.keepMine(local)
          // 磁盘已经是本地内容了：把 Store 的 revision 对齐，避免下一次保存又被判成冲突
          session.store.markSaved(revision, new Date().toISOString())
          reset(null)
          setNotice({ key: 'conflict.resolved' })
        } else if (choice === 'disk') {
          const result = await session.conflictGuard.takeDisk(local)
          reset(result.vault)
          setNotice({ key: 'conflict.resolved' })
        } else {
          const result = await session.conflictGuard.exportMine(local)
          reset(result.vault)
          setNotice({ key: 'shell.exported', params: { name: result.filename } })
        }
      } catch (e: unknown) {
        // 失败就保持冲突未决：弹窗自己会显示错误，用户可再选
        setNotice({ text: loadFailureReason(e) })
        return
      }
      setConflict(null)
    })()
  }

  const i18n = useI18n(session === null ? BOOT_LOCALE : session.store)
  const t = i18n.t

  const conflictLabels: Partial<ConflictLabels> = {
    title: t('conflict.title'),
    hint: t('conflict.hint'),
    droppedWarning: t('conflict.droppedWarning'),
    keepMine: t('conflict.keepMine'),
    takeDisk: t('conflict.takeDisk'),
    exportCopy: t('conflict.exportCopy'),
    keepMineHint: t('conflict.keepMineHint'),
    takeDiskHint: t('conflict.takeDiskHint'),
    exportCopyHint: t('conflict.exportCopyHint'),
    busy: t('conflict.busy'),
    failed: t('conflict.failed'),
    resolved: t('conflict.resolved'),
  }

  const safeModeLabels: Partial<SafeModeLabels> = {
    title: t('safemode.title'),
    hint: t('safemode.hint'),
    snapshotLine: t('safemode.snapshotLine'),
    noSnapshot: t('safemode.noSnapshot'),
    restore: t('safemode.restore'),
    restoreHint: t('safemode.restoreHint'),
    chooseOther: t('safemode.chooseOther'),
    chooseOtherHint: t('safemode.chooseOtherHint'),
    exportCurrent: t('safemode.exportCurrent'),
    exportCurrentHint: t('safemode.exportCurrentHint'),
    busy: t('safemode.busy'),
    failed: t('safemode.failed'),
    resolved: t('safemode.resolved'),
  }

  /**
   * T52：备份面板文案（与 conflict / safemode 同一手法）。
   * 这个面板此前只带中文兜底、完全不看 locale，英文界面下整屏中文。
   */
  const backupLabels: Partial<BackupPanelLabels> = {
    title: t('backupPanel.title'),
    attachments: t('backupPanel.attachments'),
    noAssets: t('backupPanel.noAssets'),
    scan: t('backupPanel.scan'),
    scanHint: t('backupPanel.scanHint'),
    scanning: t('backupPanel.scanning'),
    unreferenced: t('backupPanel.unreferenced'),
    reclaimable: t('backupPanel.reclaimable'),
    empty: t('backupPanel.empty'),
    confirm: t('backupPanel.confirm'),
    confirmHint: t('backupPanel.confirmHint'),
    cleaning: t('backupPanel.cleaning'),
    cleaned: t('backupPanel.cleaned'),
    failed: t('backupPanel.failed'),
    snapshots: t('backupPanel.snapshots'),
    snapshotEmpty: t('backupPanel.snapshotEmpty'),
    snapshotNow: t('backupPanel.snapshotNow'),
    snapshotting: t('backupPanel.snapshotting'),
    snapshotHint: t('backupPanel.snapshotHint'),
    taskCount: t('backupPanel.taskCount'),
    restore: t('backupPanel.restore'),
    restoreConfirm: t('backupPanel.restoreConfirm'),
    restoreConfirmAction: t('backupPanel.restoreConfirmAction'),
    restoring: t('backupPanel.restoring'),
    restored: t('backupPanel.restored'),
    export: t('backupPanel.export'),
    exporting: t('backupPanel.exporting'),
    exported: t('backupPanel.exported'),
    import: t('backupPanel.import'),
    importFile: t('backupPanel.importFile'),
    importDir: t('backupPanel.importDir'),
    importPreview: t('backupPanel.importPreview'),
    importConfirm: t('backupPanel.importConfirm'),
    importConfirmHint: t('backupPanel.importConfirmHint'),
    importing: t('backupPanel.importing'),
    imported: t('backupPanel.imported'),
    cancel: t('backupPanel.cancel'),
  }

  let main: ReactNode
  switch (phase.kind) {
    case 'booting':
    case 'busy':
      main = (
        <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: MUTED, fontSize: fs(13) }}>
          {t('startup.busy')}
        </div>
      )
      break
    case 'need-dir':
      main = (
        <StartupScreen
          icon="backup"
          title={t('startup.connectTitle')}
          hint={t('startup.connectHint')}
          primary={{ label: t('startup.connectButton'), onClick: handlePick }}
        />
      )
      break
    case 'need-permission':
      main = (
        <StartupScreen
          icon="settings"
          title={t('startup.permissionTitle')}
          hint={t('startup.permissionHint')}
          primary={{ label: t('startup.permissionButton'), onClick: () => handleGrant(phase.dir) }}
        />
      )
      break
    case 'empty-dir':
      main = (
        <StartupScreen
          icon="note"
          title={t('startup.createTitle')}
          hint={t('startup.createHint')}
          primary={{ label: t('startup.createConfirm'), onClick: () => handleCreate(phase.dir) }}
          secondary={{ label: t('startup.createCancel'), onClick: () => setPhase({ kind: 'need-dir' }) }}
        />
      )
      break
    case 'ready':
    case 'readonly':
      main = (
        <Workspace
          store={phase.store}
          view={view}
          t={t}
          bus={phase.bus}
          onOpenMilestone={(id) => {
            setMilestoneSelectedId(id)
            setMilestoneOpen(true)
          }}
          onOpenTask={(id) => {
            setDrawerTaskId(id)
            setDrawerOpen(true)
          }}
          noteAssets={phase.noteAssets}
          locale={i18n.getLocale() === 'en' ? 'en' : 'zh'}
          focusDoc={focusDoc}
        />
      )
      break
    case 'safe-mode':
      // 自愈也没能救回来：这里只提供横幅（vault 不可用，故无内容可展示）
      main = <div data-testid="safe-mode" style={{ height: '100%' }} />
      break
    case 'failed':
      main = (
        <StartupScreen
          icon="close"
          title={t('startup.errorTitle')}
          hint={t('startup.errorTitle')}
          reason={phase.reason}
          primary={{ label: t('startup.errorRetry'), onClick: () => setPhase({ kind: 'need-dir' }) }}
        />
      )
      break
  }

  const safeMode =
    phase.kind === 'readonly'
      ? { reason: phase.reason, snapshot: phase.snapshot }
      : phase.kind === 'safe-mode'
        ? { reason: phase.reason, snapshot: null }
        : null

  /**
   * T28 收尾：只读 / 安全模式相位下的「选择其他备份」端口（此前是 panelPlaceholder）。
   * · 只读相位带完整 Session，恢复走 `loader.restoreSnapshot`（内部先留底、再解除只读）；
   * · safe-mode 相位**没有会话**（库坏到连快照都没认出来），只能拿 dir 现场造一个快照存储
   *   去列 .backup/，恢复后重新 `openDir` 建会话——磁盘已被覆盖，重新加载就是健康库。
   */
  const recoverySnapshots = (): BackupSnapshotPort | undefined => {
    if (phase.kind === 'readonly') {
      const active = phase
      return {
        list: () => active.snapshots.list(),
        snapshot: () => active.snapshots.snapshot(),
        async restore(id) {
          const { vault } = await active.loader.restoreSnapshot(id)
          active.autosave.stop()
          active.store.setVault(vault)
          setPhase(asReady(active.dir, active))
          setBackupOpen(false)
        },
      }
    }
    if (phase.kind === 'safe-mode') {
      const dir = phase.dir
      return {
        list: () => createSnapshotStore(dir).list(),
        snapshot: () => createSnapshotStore(dir).snapshot(),
        async restore(id) {
          await createSnapshotStore(dir).restore(id)
          setBackupOpen(false)
          // 磁盘已恢复，重新走一遍启动流程（含记句柄 / 建会话）
          await openDir(dir)
        },
      }
    }
    return undefined
  }

  /** 横幅三个出口：恢复走 loader，导出走 loader；「选择其他备份」开备份面板挑快照。 */
  const banner = (): ReactNode => {
    if (safeMode === null) return null
    const active = phase.kind === 'readonly' ? phase : null
    if (active === null) {
      return (
        <SafeModeBanner
          reason={safeMode.reason}
          snapshot={null}
          labels={safeModeLabels}
          onRestore={() => {}}
          // T28 收尾：开备份面板，从 .backup/ 里挑一份载入（safe-mode 无会话，走现场造的快照存储）
          onChooseOther={() => setBackupOpen(true)}
          onExportCurrent={() => {}}
        />
      )
    }
    return (
      <SafeModeBanner
        reason={safeMode.reason}
        snapshot={safeMode.snapshot}
        labels={safeModeLabels}
        onRestore={async () => {
          const target = safeMode.snapshot
          if (target === null) return
          // restoreSnapshot 内部先给当前文件留底再覆盖，并解除只读
          const { vault } = await active.loader.restoreSnapshot(target.id)
          active.autosave.stop()
          active.store.setVault(vault)
          setPhase(asReady(active.dir, active))
        }}
        // T28 收尾：同上（只读相位带会话，恢复走 loader.restoreSnapshot 并解除只读）
        onChooseOther={() => setBackupOpen(true)}
        onExportCurrent={async () => {
          const { filename } = await active.loader.exportCurrent(active.store.getVault())
          setNotice({ key: 'shell.exported', params: { name: filename } })
        }}
      />
    )
  }

  const recovery = recoverySnapshots()

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        // T52：外壳最小宽度。窗口拖到 800 宽时，顶栏分段控件与列头会被压成竖排、
        // 卡片内容整个消失（页面还凭空多出横向滚动）。桌面工具可以「不支持这么窄」，
        // 但不该「压碎」——给一个下限，让它老老实实横向滚，而不是把布局挤烂。
        // 1024 是本轮实测里最后一档还能正常读的宽度（卡片 meta 行已在 T52 修过）。
        minWidth: sp(1024),
        margin: 0,
        background: 'var(--oe-bg)',
        color: TEXT,
        fontFamily: 'var(--oe-font)',
        fontSize: fs(14),
      }}
    >
      <IconSprite />
      {banner()}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside
          style={{
            // T40：侧栏宽度与顶栏高度跟随界面尺度——大屏上若只放大字号不加宽，
            // 话题名会被更早截断，反而比小屏更难读。
            width: sp(220),
            flex: `0 0 ${sp(220)}`,
            background: 'var(--oe-material-sidebar)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            borderRight: '1px solid var(--oe-separator)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: sp(8), padding: sp(16) }}>
            <LogoMark />
            <div>
              <div style={{ fontSize: fs(15), fontWeight: 650, letterSpacing: '-0.01em' }}>OffEarly</div>
              <div style={{ fontSize: fs(11), color: MUTED }}>早下班</div>
            </div>
          </div>
          {session === null ? null : (
            <TopicSidebar
              store={session.store}
              bus={session.bus}
              t={t}
              onOpenMilestones={() => {
                setMilestoneSelectedId(null)
                setMilestoneOpen(true)
              }}
              onOpenFilters={() => {
                setFilterOpen(true)
              }}
              onOpenBackup={() => setBackupOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              style={{ flex: 1, minHeight: 0 }}
            />
          )}
        </aside>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <header
            data-testid="topbar"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: sp(12),
              height: sp(44),
              flex: `0 0 ${sp(44)}`,
              padding: `0 ${sp(16)}`,
              background: 'var(--oe-material-bar)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              borderBottom: '1px solid var(--oe-separator)',
            }}
          >
            {/* 视图切换与顶栏提示；撤销/重做（T52）挂在视图切换右侧 */}
            {session === null ? null : (
              <div role="group" className="oe-seg" style={{ marginRight: 'auto' }}>
                {(['board', 'gantt', 'mindmap', 'notebook'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    data-testid={`view-${mode}`}
                    aria-pressed={view === mode}
                    onClick={() => {
                      setView(mode)
                    }}
                  >
                    {mode === 'board'
                      ? t('shell.viewBoard')
                      : mode === 'gantt'
                        ? t('shell.viewGantt')
                        : mode === 'mindmap'
                          ? t('shell.viewMindmap')
                          : t('shell.viewNotebook')}
                  </button>
                ))}
              </div>
            )}
            {session === null ? null : <UndoRedo bus={session.bus} t={t} />}
            {notice === null ? null : (
              <span data-testid="shell-notice" style={{ fontSize: fs(12), color: 'var(--oe-blocked)' }}>
                {'text' in notice ? notice.text : t(notice.key, notice.params)}
              </span>
            )}
            {phase.kind === 'ready' ? <SaveIndicator autosave={phase.autosave} t={t} /> : null}
          </header>
          <main style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{main}</main>
        </div>
      </div>
      {session === null ? null : (
        <MilestonePanel
          store={session.store}
          t={t}
          open={milestoneOpen}
          onOpenChange={setMilestoneOpen}
          selectedId={milestoneSelectedId}
          onSelect={(milestone) => setMilestoneSelectedId(milestone?.id ?? null)}
        />
      )}
      {session === null ? null : (
        <TaskDrawer
          store={session.store}
          bus={session.bus}
          t={t}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          taskId={drawerTaskId}
          onSelect={(task) => setDrawerTaskId(task?.id ?? null)}
          // T52：面板头部的保存指示（插槽早就存在，只是没人传）。
          // 顶栏那个「已保存」在弹窗打开时被遮罩整个盖住，用户在弹窗里改完标题 / 进度
          // 完全看不出有没有落盘。
          autosave={phase.kind === 'ready' ? phase.autosave : undefined}
          // T25：图片三条插入路径 + blob URL 显示都经这个端口（编辑器本身不碰文件系统）
          assets={session.noteAssets}
          // T24：笔记里的 [[标题]] 点击跳转——同名多任务取第一条任务候选；
          // 只命中里程碑则开里程碑面板并选中；标题已不存在（matches 为空）时静默不动。
          onNavigateNoteLink={(_title, matches) => {
            const task = matches.find((match) => match.kind === 'task')
            if (task !== undefined) {
              setDrawerTaskId(task.id)
              setDrawerOpen(true)
              return
            }
            const milestone = matches.find((match) => match.kind === 'milestone')
            if (milestone !== undefined) {
              setMilestoneSelectedId(milestone.id)
              setMilestoneOpen(true)
            }
          }}
        />
      )}
      {session === null ? null : (
        <PaletteMount
          store={session.store}
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          t={t}
          onOpenTask={(id) => {
            setDrawerTaskId(id)
            setDrawerOpen(true)
          }}
          onOpenDoc={(notebookId, docId) => {
            setView('notebook')
            // nonce 让「同一篇文档连搜两次」也能重新定位（视图可能已经挂着）
            setFocusDoc({ notebookId, docId, nonce: Date.now() })
          }}
          onSelectView={setView}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenBackup={() => setBackupOpen(true)}
        />
      )}
      {session === null ? null : (
        <FilterBar store={session.store} bus={session.bus} t={t} open={filterOpen} onOpenChange={setFilterOpen} />
      )}
      {session === null ? null : (
        <SettingsPanel
          store={session.store}
          bus={session.bus}
          t={t}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
      {session === null && recovery === undefined ? null : (
        <BackupPanel
          open={backupOpen}
          onOpenChange={setBackupOpen}
          labels={backupLabels}
          // 无会话（safe-mode）时各端口缺失，面板对应分区自动置灰，只留快照可用
          gc={session?.backupGc}
          assetCount={session?.store.getVault().assets.length ?? 0}
          assetTotalBytes={session?.store.getVault().assets.reduce((sum, a) => sum + a.sizeBytes, 0) ?? 0}
          snapshots={session?.snapshots ?? recovery}
          exporter={session?.backupExport}
          importer={session?.backupImport}
          currentTaskCount={session?.store.getVault().tasks.length ?? 0}
          // 导入确认：停 autosave → 覆盖内存 → 直写磁盘 → 重启 autosave（导入是明确覆盖，不走冲突弹窗）
          onImported={(vault) => {
            if (session === null) return
            session.autosave.stop()
            session.store.setVault(vault)
            void session.repository
              .save(vault)
              .catch(() => setNotice({ text: '导入写入失败' }))
              .finally(() => session.autosave.start())
          }}
          // 恢复完成：磁盘已被 SnapshotStore.restore 覆盖，重新 load 回内存
          onRestored={() => {
            if (session === null) return
            session.autosave.stop()
            void session.repository
              .load()
              .then((disk) => {
                if (disk !== null) session.store.setVault(disk)
              })
              .finally(() => session.autosave.start())
          }}
        />
      )}
      {conflict === null ? null : (
        <ConflictDialog
          report={conflict}
          labels={conflictLabels}
          onKeepMine={() => {
            resolveConflict('mine')
          }}
          onTakeDisk={() => {
            resolveConflict('disk')
          }}
          onExportCopy={() => {
            resolveConflict('export')
          }}
        />
      )}
    </div>
  )
}

type Notice = { key: MsgKey; params?: TranslateParams } | { text: string }
