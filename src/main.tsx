import { createRoot } from 'react-dom/client'

import './styles/theme.css'
import { installUiScale } from './styles/scale'
import { App } from './App'

// T40：按视口宽度判定界面尺度并写到 :root，必须在 createRoot 之前，
// 否则首帧会用兜底的 1，窗口宽屏时能看到一次"先小后大"的跳变。
installUiScale()

createRoot(document.getElementById('root')!).render(<App />)
