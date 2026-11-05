import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// The host main imports the PDF module's main/preload/shared TS sources directly
// (apps/pdf needs no build step for the host bundle), so workspace packages
// resolve to source here instead of externalized node_modules copies. The AI
// bridge pulls in the same packages the PDF module uses, so the alias list
// matches apps/pdf/electron.vite.config.ts (subpath aliases first).
const workspaceAlias = {
  '@arareader/ai-provider/providers': resolve(
    __dirname,
    '../../packages/ai-provider/src/providers.ts',
  ),
  '@arareader/agent-core': resolve(__dirname, '../../packages/agent-core/src/index.ts'),
  '@arareader/ai-provider': resolve(__dirname, '../../packages/ai-provider/src/index.ts'),
  '@arareader/ai-search': resolve(__dirname, '../../packages/ai-search/src/index.ts'),
  '@arareader/electron-utils': resolve(__dirname, '../../packages/electron-utils/src/index.ts'),
  '@arareader/file-parse': resolve(__dirname, '../../packages/file-parse/src/index.ts'),
  '@arareader/i18n': resolve(__dirname, '../../packages/i18n/src/index.ts'),
  '@arareader/project-store': resolve(__dirname, '../../packages/project-store/src/index.ts'),
}

export default defineConfig({
  main: { resolve: { alias: workspaceAlias } },
  preload: { resolve: { alias: workspaceAlias } },
  renderer: {
    resolve: { alias: workspaceAlias },
    plugins: [react()],
    publicDir: resolve(__dirname, '../../public'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    server: {
      port: 5199,
    },
  },
})
