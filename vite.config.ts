import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PluginOption } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

const DIST = fileURLToPath(new URL('dist', import.meta.url))

// singlefile 只负责内联，产物仍带 type="module" 且脚本位于 head。
// file:// 下必须是无 type 的经典脚本，且要在 #root 之后执行，故移到 body 末尾。
function finalizeSingleFile(): PluginOption {
  return {
    name: 'offearly-finalize',
    apply: 'build',
    enforce: 'post',
    closeBundle: {
      order: 'post',
      handler() {
        const entry = `${DIST}/index.html`
        if (!existsSync(entry)) return
        const html = readFileSync(entry, 'utf8')
        const bodies: string[] = []
        const head = html.replace(
          /[ \t]*<script type="module"[^>]*>([\s\S]*?)<\/script>[ \t]*\n?/g,
          (_m, body: string) => {
            bodies.push(body)
            return ''
          },
        )
        const inlined = bodies.map((body) => `  <script>\n${body}\n  </script>\n`).join('')
        const end = head.lastIndexOf('</body>')
        const out = end === -1 ? head : `${head.slice(0, end)}${inlined}${head.slice(end)}`
        writeFileSync(`${DIST}/OffEarly.html`, out)
        rmSync(entry)
      },
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile(), finalizeSingleFile()],
  // T32：单元测试（vitest，jsdom/node）与端到端测试（Playwright，真实 Chromium +
  // file://）跑在两套完全不同的运行时里。这里把边界钉死——只收 tests/ 下的用例，
  // 否则 vitest 会去加载 e2e/*.spec.ts 并因缺少 Playwright 运行时整片报错。
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'e2e'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000_000,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
})
