/**
 * T32 · Playwright 配置
 *
 * 关键点：**不用 webServer，不走 http**。交付物就是从 `file://` 双击打开的单文件，
 * 所以 E2E 必须用同一种方式加载它，否则测的就不是交付形态。
 */
import { defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('.', import.meta.url))
export const ARTIFACT = join(ROOT, 'dist', 'OffEarly.html')
export const APP_URL = pathToFileURL(ARTIFACT).href

if (!existsSync(ARTIFACT)) {
  throw new Error(`找不到 ${ARTIFACT}，先跑 npm run build 再跑 E2E`)
}

export default defineConfig({
  testDir: join(ROOT, 'e2e'),
  // 全流程用例共享同一份产物与浏览器实例，串行执行更好定位问题
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    baseURL: APP_URL,
    // 语言与时区都钉死：应用启动时按浏览器语言 auto 解析 locale，
    // headless 默认 en-US 会让断言的文案整体变成英文。
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium-file',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
