/**
 * Shared launcher for the ARAReader Electron E2E tests.
 *
 * Each test boots the built app (`apps/desktop/out`) against a scratch
 * userData dir (via ARAREADER_USER_DATA) so runs never touch real settings and
 * never collide with a running install's single-instance lock.
 * Build first: `npm run build`.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

export const DESKTOP_DIR = resolve(__dirname, '../apps/desktop')
export const ARTIFACTS_DIR = resolve(__dirname, 'artifacts')

const DESKTOP_MAIN = join(DESKTOP_DIR, 'out/main/index.js')

interface LaunchOptions {
  /** reuse a previous scratch dir to simulate a second launch */
  userDataDir?: string
  /** UI language override (ARAREADER_LANG); defaults to English for stable assertions */
  lang?: string
  /** absolute PDF path passed as argv, opened in a PDF tab on launch */
  openFile?: string
  /** if true, start with empty settings to test onboarding flow */
  testOnboarding?: boolean
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  if (!existsSync(DESKTOP_MAIN)) {
    throw new Error(`Missing build output at ${DESKTOP_MAIN} — run \`npm run build\` first`)
  }
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'arareader-e2e-')))
  if (!options.testOnboarding) {
    const settingsPath = join(userDataDir, 'app-settings.json')
    if (!existsSync(settingsPath)) {
      await writeFile(
        settingsPath,
        JSON.stringify({
          userPreferences: {
            onboardingCompleted: true,
            profile: {
              displayName: 'E2E User',
              fullName: 'E2E Test User',
              title: '',
              organization: '',
              email: '',
              useAsDefaultAuthor: true,
            },
          },
        }),
        'utf8',
      )
    }
  }
  const require = createRequire(join(DESKTOP_DIR, 'package.json'))
  // Outside an Electron runtime, `require('electron')` is the installed binary path
  const executablePath = require('electron') as unknown as string
  // ELECTRON_RUN_AS_NODE (set by VS Code/CI hosts) would boot Electron as
  // plain Node with no windows — strip it so the app always starts as an app
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...hostEnv } = process.env
  // Linux CI runners restrict unprivileged user namespaces (no usable SUID
  // sandbox) and run under xvfb without GPU — without these the window opens
  // but the renderer never loads. The suite drives trusted local builds only.
  // Switches go before the app path so Chromium is guaranteed to consume them
  // and they never leak into the argv the app parses for PDFs to open.
  const args: string[] = []
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu')
  args.push(DESKTOP_DIR)
  if (options.openFile) args.push(options.openFile)
  const app = await electron.launch({
    executablePath,
    args,
    env: {
      ...hostEnv,
      ARAREADER_USER_DATA: userDataDir,
      ARAREADER_LANG: options.lang ?? 'en',
      ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
    },
  })
  await app.firstWindow()
  const page = await waitForHostPage(app)
  await waitForDocumentReady(app, page)
  return { app, page, userDataDir }
}

/** the host BrowserWindow's built renderer, as it appears in its file:// URL */
const HOST_URL_PART = 'desktop/out/renderer'

/**
 * The host BrowserWindow page. `firstWindow()` can resolve to the PDF
 * WebContentsView when an argv-open creates it before Playwright attaches, so
 * identify the host by its renderer URL instead of by arrival order.
 */
async function waitForHostPage(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const candidate of app.windows()) {
      const href =
        candidate.url() || (await candidate.evaluate(() => window.location.href).catch(() => ''))
      if (href.includes(HOST_URL_PART)) return candidate
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Host window never appeared')
    await app.waitForEvent('window', { timeout: Math.min(remaining, 1_000) }).catch(() => {})
  }
}

/**
 * Playwright can attach to the Electron window mid-navigation and miss the
 * load lifecycle events entirely (Linux timing) — waitForLoadState then hangs
 * on a page that is actually loaded. Polling through evaluate uses the live
 * CDP session instead of the missed events.
 */
async function waitForDocumentReady(
  app: ElectronApplication,
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // the pre-navigation about:blank document also reports readyState complete
    const ready = await page
      .evaluate(() =>
        document.readyState !== 'loading' && window.location.href !== 'about:blank'
          ? document.readyState
          : null,
      )
      .catch(() => null)
    if (ready) return
    await new Promise((r) => setTimeout(r, 100))
  }
  // process list tells renderer-spawn failures apart from slow loads
  const diag = await app
    .evaluate(({ app: electronApp, BrowserWindow }) => ({
      processes: electronApp.getAppMetrics().map((m) => m.type),
      contents: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
    }))
    .catch((e) => String(e))
  throw new Error(`App window never loaded (url: ${page.url()}, diag: ${JSON.stringify(diag)})`)
}

/**
 * Close the app. Every spec leaves its tabs clean, so no save prompt can block
 * shutdown; if close still hangs, kill the process after 20s so the suite
 * never wedges.
 */
export async function closeReader(launched: LaunchedApp): Promise<void> {
  let killTimer: NodeJS.Timeout | undefined
  await Promise.race([
    launched.app.close().catch(() => {}),
    new Promise<void>((resolvePromise) => {
      killTimer = setTimeout(() => {
        launched.app.process().kill()
        resolvePromise()
      }, 20_000)
    }),
  ])
  if (killTimer) clearTimeout(killTimer)
}

export function screenshotPath(name: string): string {
  return join(ARTIFACTS_DIR, 'screenshots', `${name}.png`)
}

/**
 * Wait for a page whose URL contains `urlPart` (e.g. the PDF WebContentsView).
 * Checks windows that already exist before listening, so it never races the
 * view being created between launch and the first waitForEvent call.
 */
export async function waitForPageWithUrl(
  app: ElectronApplication,
  urlPart: string,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const candidate of app.windows()) {
      if (candidate.url().includes(urlPart)) return candidate
      // page.url() stays empty when attach raced navigation; ask the document
      const href = await candidate.evaluate(() => window.location.href).catch(() => '')
      if (href.includes(urlPart)) return candidate
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`No window with URL containing "${urlPart}"`)
    await app.waitForEvent('window', { timeout: Math.min(remaining, 1_000) }).catch(() => {})
  }
}
