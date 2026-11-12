import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { test, expect } from '@playwright/test'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

/**
 * R8: the "adaptive AI recommendations" scan is on by default and sends the
 * document name, outline and an excerpt of the first pages to the configured
 * provider when a PDF opens. These two tests prove what the app actually sends
 * and that switching the preference off prevents the request entirely.
 *
 * A loopback OpenAI-compatible server stands in for the provider: no paid call,
 * no external network, and the request body is inspectable as evidence.
 */

const SUGGESTION_JSON = JSON.stringify([
  { title: 'Summarize findings', subtitle: 'Quick overview', prompt: 'Summarize this document' },
  { title: 'List key terms', subtitle: 'Terminology check', prompt: 'List the key terms' },
  { title: 'Check the methods', subtitle: 'Method review', prompt: 'Explain the method' },
])

interface CapturedRequest {
  url: string
  body: string
}

async function startFakeProvider(): Promise<{
  baseUrl: string
  requests: CapturedRequest[]
  close: () => Promise<void>
}> {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: SUGGESTION_JSON } }],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

async function makeProfile(
  baseUrl: string,
  aiAutoSuggestions: boolean,
): Promise<{
  userDataDir: string
  pdfPath: string
}> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-ai-scan-'))
  const dir = await mkdtemp(join(tmpdir(), 'arareader-ai-scan-doc-'))
  const pdfPath = join(dir, 'paper.pdf')
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  page.drawText('Adaptive scan fixture: Method and Results', { x: 60, y: 700, size: 14 })
  document.addPage([612, 792])
  await writeFile(pdfPath, await document.save())

  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        aiAutoSuggestions,
        aiAutoSuggestionsConsentVersion: 1,
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
  // Provider settings live in their own file; only the base URL is needed for
  // useAiReady to consider the assistant configured.
  await writeFile(
    join(userDataDir, 'ai-settings.json'),
    JSON.stringify({
      provider: 'custom',
      providers: {
        google: { model: '', apiKey: '' },
        custom: { model: 'e2e-model', baseUrl, apiKey: 'e2e-key' },
      },
    }),
    'utf8',
  )
  return { userDataDir, pdfPath }
}

test.describe('adaptive suggestion scan (R8)', () => {
  test('opening a PDF sends the labelled document context to the configured provider', async () => {
    const provider = await startFakeProvider()
    const { userDataDir, pdfPath } = await makeProfile(provider.baseUrl, true)
    const launched = await launchApp({ openFile: pdfPath, userDataDir })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBeGreaterThan(0)

      const body = provider.requests[0]!.body
      expect(body).toContain('BEGIN_UNTRUSTED_DOCUMENT_CONTENT')
      expect(body).toContain('END_UNTRUSTED_DOCUMENT_CONTENT')
      expect(body).toContain('paper.pdf')
      expect(body).toContain('Adaptive scan fixture')
      expect(provider.requests[0]!.url).toContain('/chat/completions')

      // The tailored suggestion actually reaches the UI (the scan is not silent)
      await expect(pdf.locator('.ai-welcome-hub')).toContainText('Tailored to this document')
    } finally {
      await closeReader(launched)
      await provider.close()
    }
  })

  for (const enabled of [true, false]) {
    test(`recent PDF with archived history respects scan preference: ${enabled}`, async () => {
      const provider = await startFakeProvider()
      const { userDataDir, pdfPath } = await makeProfile(provider.baseUrl, enabled)
      const chatId = createHash('sha256').update(pdfPath).digest('hex').slice(0, 16)
      const projectDir = join(userDataDir, 'projects', 'default')
      const chatsDir = join(projectDir, 'chats')
      await mkdir(chatsDir, { recursive: true })
      await writeFile(join(userDataDir, 'recent.json'), JSON.stringify([pdfPath]))
      await writeFile(
        join(userDataDir, 'projects', 'index.json'),
        JSON.stringify({
          projects: [],
          fileMap: { [pdfPath]: 'default' },
          chatIdByPath: { [pdfPath]: chatId },
        }),
      )
      await writeFile(
        join(projectDir, 'project.json'),
        JSON.stringify({
          id: 'default',
          name: 'Default Project',
          createdAt: '',
          updatedAt: '',
          files: [pdfPath],
        }),
      )
      const transcript = [
        { seq: 0, ts: '', role: 'user', text: 'previous question' },
        { seq: 1, ts: '', role: 'assistant', text: 'previous answer' },
      ]
      await writeFile(
        join(chatsDir, `${chatId}.jsonl`),
        `${transcript.map((message) => JSON.stringify(message)).join('\n')}\n`,
      )
      const launched = await launchApp({ userDataDir })
      try {
        await launched.page.locator('.recent-item').filter({ hasText: 'paper.pdf' }).click()
        const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
        await expect(pdf.getByRole('button', { name: 'History' })).toBeVisible()
        if (enabled) {
          await expect.poll(() => provider.requests.length, { timeout: 5000 }).toBe(1)
          await expect(pdf.locator('.ai-welcome-hub')).toContainText('Tailored to this document')
        } else {
          await pdf.waitForTimeout(1500)
          expect(provider.requests).toHaveLength(0)
        }
        await expect(
          pdf
            .locator('.ai-panel-header-actions')
            .getByRole('button', { name: 'Analyze document context' }),
        ).toBeVisible()
        await pdf.getByRole('button', { name: 'History' }).click()
        await expect(pdf.locator('.ai-msg-historic')).toHaveCount(2)
        await pdf.getByRole('button', { name: 'History' }).click()
        if (enabled) {
          await expect(pdf.locator('.ai-welcome-hub')).toContainText('Tailored to this document')
        }
        expect(provider.requests).toHaveLength(enabled ? 1 : 0)
      } finally {
        await closeReader(launched)
        await provider.close()
      }
    })
  }

  test('turning the preference off prevents the automatic request', async () => {
    const provider = await startFakeProvider()
    const { userDataDir, pdfPath } = await makeProfile(provider.baseUrl, false)
    const launched = await launchApp({ openFile: pdfPath, userDataDir })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      // the panel is up and configured (so a scan would be possible)…
      await expect(pdf.locator('.ai-welcome-hub')).toBeVisible()
      // …but no provider call is made, even after the scan's own startup window
      await pdf.waitForTimeout(3000)
      expect(provider.requests).toHaveLength(0)
      await expect(pdf.locator('.ai-welcome-hub')).not.toContainText('Tailored to this document')
    } finally {
      await closeReader(launched)
      await provider.close()
    }
  })
})
