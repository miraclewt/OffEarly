/**
 * 落地页素材抓取专用配置，与 e2e 回归套件分开：
 * 回归用例断言行为、不该顺手往仓库里写文件；这里反过来，只负责产出截图。
 */
import { defineConfig } from '@playwright/test'

import { APP_URL } from './playwright.config'

export default defineConfig({
  testDir: './capture',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: APP_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
    // 2x 出图，落地页在高分屏上不糊
    deviceScaleFactor: 2,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
})
