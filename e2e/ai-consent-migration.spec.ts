import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { test, expect } from '@playwright/test'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

interface CapturedRequest {
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
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'e2e-model' }] }))
        return
      }
      requests.push({ body })
      if (body.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Manual reply' } }] })}\n\ndata: [DONE]\n\n`,
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify([
                  {
                    title: 'Summarize findings',
                    subtitle: 'Quick overview',
                    prompt: 'Summarize this document',
                  },
                  {
                    title: 'List key terms',
                    subtitle: 'Terminology check',
                    prompt: 'List key terms',
                  },
                  {
                    title: 'Check the methods',
                    subtitle: 'Method review',
                    prompt: 'Explain the method',
                  },
                ]),
              },
            },
          ],
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

async function makeFixture(
  baseUrl: string,
  preference?: { value: boolean; consentVersion?: 1 },
): Promise<{ userDataDir: string; pdfPath: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-consent-migration-'))
  const documentDir = await mkdtemp(join(tmpdir(), 'arareader-consent-pdf-'))
  const pdfPath = join(documentDir, 'consent-fixture.pdf')
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  page.drawText('Consent migration fixture: local document text', { x: 60, y: 700, size: 14 })
  await writeFile(pdfPath, await document.save())

  const userPreferences: Record<string, unknown> = {
    onboardingCompleted: true,
    profile: {
      displayName: 'ARA',
      fullName: 'ARA',
      title: '',
      organization: '',
      email: '',
      useAsDefaultAuthor: true,
    },
  }
  if (preference) {
    userPreferences.aiAutoSuggestions = preference.value
    if (preference.consentVersion) {
      userPreferences.aiAutoSuggestionsConsentVersion = preference.consentVersion
    }
  }
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({ userPreferences }),
    'utf8',
  )
  await writeFile(
    join(userDataDir, 'ai-settings.json'),
    JSON.stringify({
      provider: 'custom',
      providers: {
        google: { model: '', apiKey: '' },
        custom: { model: 'e2e-model', baseUrl, apiKey: 'e2e-only-dummy-key' },
      },
    }),
    'utf8',
  )
  return { userDataDir, pdfPath }
}

async function openFixture(launched: Awaited<ReturnType<typeof launchApp>>, pdfPath: string) {
  await launched.page.evaluate(async (path) => window.reader.openPath(path), pdfPath)
  const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
  await expect(pdf.locator('.ai-welcome-hub')).toBeVisible()
  return pdf
}

async function assertNoAutomaticRequest(
  pdf: Awaited<ReturnType<typeof waitForPageWithUrl>>,
  requests: CapturedRequest[],
) {
  await pdf.waitForTimeout(2000)
  expect(requests).toHaveLength(0)
}

test.describe('automatic AI sharing consent migration', () => {
  test('missing preference is off, but a user-started AI chat still reaches the provider', async () => {
    const provider = await startFakeProvider()
    const { userDataDir, pdfPath } = await makeFixture(provider.baseUrl)
    const launched = await launchApp({ userDataDir })
    try {
      const preferences = await launched.page.evaluate(() => window.reader.getPreferences())
      expect(preferences.aiAutoSuggestions).toBe(false)
      expect(preferences.aiAutoSuggestionsConsentVersion).toBeUndefined()

      const pdf = await openFixture(launched, pdfPath)
      await assertNoAutomaticRequest(pdf, provider.requests)
      await pdf.locator('.ai-composer textarea').fill('Please summarize this document manually.')
      await pdf.locator('.ai-composer textarea').press('Enter')
      await expect.poll(() => provider.requests.length, { timeout: 15_000 }).toBe(1)
      expect(provider.requests[0]!.body).toContain('Please summarize this document manually.')
    } finally {
      await closeReader(launched)
      await provider.close()
    }
  })

  test('legacy true without consent proof stays off until Settings explicitly enables it', async () => {
    const provider = await startFakeProvider()
    const { userDataDir, pdfPath } = await makeFixture(provider.baseUrl, { value: true })
    const launched = await launchApp({ userDataDir })
    try {
      const pdf = await openFixture(launched, pdfPath)
      await assertNoAutomaticRequest(pdf, provider.requests)
      const preferences = await launched.page.evaluate(() => window.reader.getPreferences())
      expect(preferences.aiAutoSuggestions).toBe(false)
      expect(preferences.aiAutoSuggestionsConsentVersion).toBeUndefined()

      const pdfTab = await launched.page.evaluate(
        async () => (await window.readerTabs.list()).find((tab) => tab.kind === 'pdf')?.id,
      )
      if (!pdfTab) throw new Error('Opened PDF tab was not listed by the host.')
      await launched.page.evaluate(async () => window.readerTabs.activate('home'))
      await launched.page.locator('.ai-provider-trigger').click()
      await expect(launched.page.getByRole('button', { name: 'Save Changes' })).toBeEnabled()
      await launched.page.locator('.settings-nav-btn').filter({ hasText: 'Preferences' }).click()
      const aiToggle = launched.page
        .locator('.settings-toggle-row')
        .filter({ hasText: 'Adaptive AI recommendations on document open' })
        .locator('input[type="checkbox"]')
      await expect(aiToggle).not.toBeChecked()
      await aiToggle.click()
      await expect
        .poll(async () => {
          const saved = await launched.page.evaluate(() => window.reader.getPreferences())
          return [saved.aiAutoSuggestions, saved.aiAutoSuggestionsConsentVersion]
        })
        .toEqual([true, 1])
      expect(
        (await launched.page.evaluate(() => window.reader.getPreferences()))
          .aiAutoSuggestionsConsentAction,
      ).toBeUndefined()
      await expect.poll(() => provider.requests.length, { timeout: 15_000 }).toBe(1)
      await launched.page.evaluate(
        async (stalePreferences) => window.reader.setPreferences(stalePreferences),
        preferences,
      )
      await expect
        .poll(async () => {
          const saved = await launched.page.evaluate(() => window.reader.getPreferences())
          return [saved.aiAutoSuggestions, saved.aiAutoSuggestionsConsentVersion]
        })
        .toEqual([true, 1])
      await pdf.waitForTimeout(1500)
      expect(provider.requests).toHaveLength(1)
      await launched.page.locator('.ai-provider-close').click()
      await launched.page.evaluate(async (id) => window.readerTabs.activate(id), pdfTab)
      expect(provider.requests[0]!.body).toContain('Consent migration fixture')
    } finally {
      await closeReader(launched)
      await provider.close()
    }
  })

  test('a PDF view cannot forge the explicit AI-sharing consent action', async () => {
    const provider = await startFakeProvider()
    const { userDataDir, pdfPath } = await makeFixture(provider.baseUrl)
    const launched = await launchApp({ userDataDir })
    try {
      const pdf = await openFixture(launched, pdfPath)
      const preferences = await pdf.evaluate(() => window.pdfApi.getPreferences())
      await pdf.evaluate(
        async (current) =>
          window.pdfApi.setPreferences({
            ...current,
            aiAutoSuggestions: true,
            aiAutoSuggestionsConsentVersion: 1,
            aiAutoSuggestionsConsentAction: true,
          }),
        preferences,
      )

      const persisted = await launched.page.evaluate(() => window.reader.getPreferences())
      expect(persisted.aiAutoSuggestions).toBe(false)
      expect(persisted.aiAutoSuggestionsConsentVersion).toBeUndefined()
      await assertNoAutomaticRequest(pdf, provider.requests)
    } finally {
      await closeReader(launched)
      await provider.close()
    }
  })

  test('an explicitly saved off choice sends no automatic request', async () => {
    const provider = await startFakeProvider()
    const { userDataDir, pdfPath } = await makeFixture(provider.baseUrl, {
      value: false,
      consentVersion: 1,
    })
    const launched = await launchApp({ userDataDir })
    try {
      const preferences = await launched.page.evaluate(() => window.reader.getPreferences())
      await launched.page.evaluate(
        async (stalePreferences) =>
          window.reader.setPreferences({
            ...stalePreferences,
            aiAutoSuggestions: true,
          }),
        preferences,
      )
      const persisted = await launched.page.evaluate(() => window.reader.getPreferences())
      expect(persisted.aiAutoSuggestions).toBe(false)
      expect(persisted.aiAutoSuggestionsConsentVersion).toBe(1)
      const pdf = await openFixture(launched, pdfPath)
      await assertNoAutomaticRequest(pdf, provider.requests)
    } finally {
      await closeReader(launched)
      await provider.close()
    }
  })

  test('only an explicitly saved on choice sends the bounded document context', async () => {
    const provider = await startFakeProvider()
    const { userDataDir, pdfPath } = await makeFixture(provider.baseUrl, {
      value: true,
      consentVersion: 1,
    })
    const launched = await launchApp({ userDataDir })
    try {
      await openFixture(launched, pdfPath)
      await expect.poll(() => provider.requests.length, { timeout: 15_000 }).toBe(1)
      const body = provider.requests[0]!.body
      expect(body).toContain('BEGIN_UNTRUSTED_DOCUMENT_CONTENT')
      expect(body).toContain('END_UNTRUSTED_DOCUMENT_CONTENT')
      expect(body).toContain('consent-fixture.pdf')
      expect(body).toContain('Consent migration fixture')
    } finally {
      await closeReader(launched)
      await provider.close()
    }
  })
})
