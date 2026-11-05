import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { normalizePath } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
const workspaceAlias = {
  '@arareader/ai-provider/providers': resolve(
    __dirname,
    '../../packages/ai-provider/src/providers.ts',
  ),
  '@arareader/agent-core': resolve(__dirname, '../../packages/agent-core/src/index.ts'),
  '@arareader/ai-provider': resolve(__dirname, '../../packages/ai-provider/src/index.ts'),
  '@arareader/i18n': resolve(__dirname, '../../packages/i18n/src/index.ts'),
  '@arareader/ui/ai-panel.css': resolve(__dirname, '../../packages/ui/src/ai-panel.css'),
  '@arareader/ui': resolve(__dirname, '../../packages/ui/src/index.ts'),
}

// Non-embedded CMaps/standard fonts (e.g. CJK) need pdfjs data dirs, shipped with renderer output
const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(dirname(require.resolve('pdfjs-dist/package.json')))
// vite-plugin-static-copy globs require POSIX separators; join() breaks on Windows
const pdfjsDir = (sub: string) => normalizePath(join(pdfjsRoot, 'pdfjs-dist', sub))

export default defineConfig({
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@arareader/i18n'] })],
  },
  renderer: {
    resolve: { alias: workspaceAlias },
    publicDir: resolve(__dirname, '../../public'),
    plugins: [
      react(),
      viteStaticCopy({
        targets: [
          { src: pdfjsDir('cmaps'), dest: 'pdfjs' },
          { src: pdfjsDir('standard_fonts'), dest: 'pdfjs' },
          { src: pdfjsDir('wasm'), dest: 'pdfjs' },
        ],
      }),
    ],
    server: {
      port: Number(process.env.PDF_DEV_PORT) || 5176,
      strictPort: Boolean(process.env.PDF_DEV_PORT),
    },
  },
})
