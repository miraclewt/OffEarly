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

export function App() {
  return (
    <div style={{ display: 'flex', height: '100vh', margin: 0, background: '#FAFAFA', color: TEXT,
      fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif', fontSize: 14 }}>
      <aside style={{ width: 220, flex: '0 0 220px', background: '#F3F4F6', borderRight: `1px solid ${BORDER}`, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LogoMark />
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>OffEarly</div>
            <div style={{ fontSize: 11, color: MUTED }}>早下班</div>
          </div>
        </div>
      </aside>
      <main style={{ flex: 1, display: 'grid', placeItems: 'center', color: MUTED }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 15, color: TEXT }}>构建管线就绪</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>启动流程与数据文件夹连接在 T07 接入</div>
        </div>
      </main>
    </div>
  )
}
