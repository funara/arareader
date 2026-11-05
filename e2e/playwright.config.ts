import { defineConfig } from '@playwright/test'

/**
 * E2E config for the ARAReader desktop host.
 *
 * Tests launch the real built app (electron.launch), so they run serially —
 * parallel Electron instances fight over the GPU cache and the app's
 * single-instance lock. Run with: `npm run test:e2e` (after `npm run build`).
 */
export default defineConfig({
  testDir: '.',
  outputDir: './test-results',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  expect: { timeout: 15_000 },
  reporter: [['list']],
})
