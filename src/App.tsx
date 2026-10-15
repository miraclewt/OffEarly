import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useStore } from 'zustand'

import { createVaultStore } from './domain/store'
import type { VaultStore } from './domain/store'
import type { Vault } from './domain/types'
import { createI18n } from './locales/i18n'
import type { I18n, LocaleSource, MsgKey } from './locales/i18n'
import { createAutosave } from './persistence/autosave'
import type { Autosave } from './persistence/autosave'
import { connectDir } from './persistence/fsAdapter'
import { handleStore, verifyPermission } from './persistence/handleStore'
import type { VaultDirHandle } from './persistence/handleStore'
import { createVaultRepository } from './persistence/vaultRepository'
import type { VaultRepository } from './persistence/vaultRepository'
import { VaultValidationError } from './domain/schema'
import { Icon, IconSprite } from './views/IconSprite'
import { SaveIndicator } from './views/SaveIndicator'

const INDIGO = '#4F46E5'
const BORDER = '#E5E7EB'
const TEXT = '#111827'
const MUTED = '#6B7280'

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

/** 打开一个库拿到的三件套。 */
export interface Session {
  store: VaultStore
  repository: VaultRepository
  autosave: Autosave
}

type Phase =
  | { kind: 'booting' }
  | { kind: 'need-dir' }
  | { kind: 'need-permission'; dir: VaultDirHandle }
  | { kind: 'busy'; dir: VaultDirHandle }
  | { kind: 'empty-dir'; dir: VaultDirHandle }
  | ({ kind: 'ready'; dir: VaultDirHandle } & Session)
  | { kind: 'safe-mode'; dir: VaultDirHandle; reason: string }
  | { kind: 'failed'; reason: string }

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

/** 打开一个库 = 建 Store + 落盘面 + 自动保存；Store 从此是唯一状态源（T10）。 */
function openSession(repository: VaultRepository, vault: Vault): Session {
  const store = createVaultStore(vault)
  return {
    repository,
    store,
    // autosave 必须挂在同一个 store 上，否则它盯的是另一份内存，永远等不到变更
    autosave: createAutosave({
      store,
      sink: { save: (next) => repository.save(next) },
    }),
  }
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
  maxWidth: 420,
  margin: '0 auto',
  padding: '28px 32px',
  background: '#FFFFFF',
  border: `1px solid ${BORDER}`,
  borderRadius: 12,
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
        <div style={{ fontSize: 15, fontWeight: 600, color: TEXT, marginTop: 12 }}>{props.title}</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 8, lineHeight: 1.7 }}>{props.hint}</div>
        {props.reason === undefined ? null : (
          <div style={{ fontSize: 12, color: '#B45309', marginTop: 8 }}>{props.reason}</div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
          <button
            type="button"
            onClick={props.primary.onClick}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              color: '#FFFFFF',
              background: INDIGO,
              border: 'none',
              borderRadius: 6,
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
                padding: '6px 16px',
                fontSize: 13,
                color: TEXT,
                background: '#FFFFFF',
                border: `1px solid ${BORDER}`,
                borderRadius: 6,
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

function EmptyBoard(props: { store: VaultStore; t: (key: MsgKey) => string }) {
  const { store, t } = props
  const vault = useStore(store, (state) => state.vault)
  return (
    <div
      data-testid="board"
      style={{ display: 'flex', gap: 12, padding: 16, height: '100%', boxSizing: 'border-box' }}
    >
      {vault.settings.boardColumns.map((col) => (
        <section
          key={col}
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: '#FFFFFF',
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            padding: 12,
            gap: 8,
          }}
        >
          <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>{t(`status.${col}`)}</span>
            <span style={{ fontSize: 12, color: MUTED }}>0</span>
          </header>
          <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <span style={{ fontSize: 12, color: MUTED }}>{t('board.emptyColumn')}</span>
          </div>
        </section>
      ))}
    </div>
  )
}

export function App(props: { ports?: StartupPorts; onSession?: (session: Session) => void }) {
  const ports = props.ports ?? startupPorts()
  const [phase, setPhase] = useState<Phase>({ kind: 'booting' })

  /** 会话建好的一次性外送口：宿主与测试由此拿到 Store/落盘面/自动保存。 */
  function makeSession(repository: VaultRepository, vault: Vault): Session {
    const session = openSession(repository, vault)
    props.onSession?.(session)
    return session
  }

  // 打开成功才记住句柄：空目录、损坏的库都不该污染下次启动
  function openDir(dir: VaultDirHandle): Promise<void> {
    setPhase({ kind: 'busy', dir })
    const repository = ports.openRepository(dir)
    return repository
      .load()
      .then((vault) => (vault === null ? null : ports.storeDir(dir).then(() => vault)))
      .then((vault) => {
        if (vault === null) {
          setPhase({ kind: 'empty-dir', dir })
          return
        }
        setPhase({ kind: 'ready', dir, ...makeSession(repository, vault) })
      })
      .catch((e: unknown) => {
        setPhase({ kind: 'safe-mode', dir, reason: loadFailureReason(e) })
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

  // 自动保存跟着会话起停；start 幂等，重复挂载也安全
  const autosave = phase.kind === 'ready' ? phase.autosave : null
  useEffect(() => {
    if (autosave === null) return
    autosave.start()
    return () => {
      autosave.stop()
    }
  }, [autosave])

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

  function handlePick() {
    void ports
      .pickDir()
      .then((dir) => openDir(dir))
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
    void repository
      .create()
      .then(async (vault) => {
        await ports.storeDir(dir)
        setPhase({ kind: 'ready', dir, ...makeSession(repository, vault) })
      })
      .catch((e: unknown) => {
        setPhase({ kind: 'failed', reason: loadFailureReason(e) })
      })
  }

  const i18n = useI18n(phase.kind === 'ready' ? phase.store : BOOT_LOCALE)
  const t = i18n.t

  let main: ReactNode
  switch (phase.kind) {
    case 'booting':
    case 'busy':
      main = (
        <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: MUTED, fontSize: 13 }}>
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
      main = <EmptyBoard store={phase.store} t={t} />
      break
    case 'safe-mode':
      main = (
        <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
          <div data-testid="safe-mode" style={{ ...CARD, borderColor: '#F59E0B' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: TEXT }}>{t('startup.safeModeTitle')}</div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 8, lineHeight: 1.7 }}>
              {t('startup.safeModeHint')}
            </div>
            <div style={{ fontSize: 12, color: '#B45309', marginTop: 8 }}>{phase.reason}</div>
            {/* T29 在此补完整横幅：[恢复此快照] [选择其他备份] [导出当前] */}
          </div>
        </div>
      )
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

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        margin: 0,
        background: '#FAFAFA',
        color: TEXT,
        fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: 14,
      }}
    >
      <IconSprite />
      <aside
        style={{
          width: 220,
          flex: '0 0 220px',
          background: '#F3F4F6',
          borderRight: `1px solid ${BORDER}`,
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LogoMark />
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>OffEarly</div>
            <div style={{ fontSize: 11, color: MUTED }}>早下班</div>
          </div>
        </div>
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* 顶栏：T15 在此补撤销/重做与视图切换，本任务先落保存指示 */}
        <header
          data-testid="topbar"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
            height: 40,
            flex: '0 0 40px',
            padding: '0 16px',
            background: '#FFFFFF',
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          {phase.kind === 'ready' ? <SaveIndicator autosave={phase.autosave} t={t} /> : null}
        </header>
        <main style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{main}</main>
      </div>
    </div>
  )
}
