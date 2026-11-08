import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { test, expect } from '@playwright/test'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

/**
 * R1/R2/R5 truthfulness in the real app: what a run says after an action landed
 * and the provider then failed, and what an interrupted conversation says once it
 * is moved into the earlier-conversation block.
 *
 * A loopback OpenAI-compatible SSE server stands in for the provider: request 1
 * returns a single tool call, and the follow-up request is either a hard failure
 * or a stream that never ends (so the run is guaranteed to still be busy when the
 * test presses New chat). No paid call, no external network.
 */

type SecondTurn = 'fail' | 'hold'

interface CapturedRequest {
  body: string
}

async function startFakeProvider(
  second: SecondTurn,
  toolName: string,
  toolArgs: string,
): Promise<{
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
      requests.push({ body })
      // a tool result in the payload means the tool already ran: this is turn 2
      const toolRan = body.includes('"role":"tool"')
      if (!toolRan) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      type: 'function',
                      function: { name: toolName, arguments: toolArgs },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        )
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      if (second === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'provider exploded' } }))
        return
      }
      // hold: stream one delta, then keep the connection open (never finish)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'Here is what page 1 says.' } }],
        })}\n\n`,
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

async function makeProfile(baseUrl: string): Promise<{ userDataDir: string; pdfPath: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-ai-failure-'))
  const dir = await mkdtemp(join(tmpdir(), 'arareader-ai-failure-doc-'))
  const pdfPath = join(dir, 'document.pdf')
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  page.drawText('Failure fixture: page one text', { x: 60, y: 700, size: 14 })
  document.addPage([612, 792])
  await writeFile(pdfPath, await document.save())

  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({
      userPreferences: {
        onboardingCompleted: true,
        // keep request counting deterministic: no document scan on open
        aiAutoSuggestions: false,
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

test.describe('pdf ai failure reporting (R1/R5)', () => {
  test('a completed action survives a later provider failure, with no blind retry', async () => {
    const provider = await startFakeProvider('fail', 'delete_page', '{"page":2}')
    const { userDataDir, pdfPath } = await makeProfile(provider.baseUrl)
    const launched = await launchApp({ openFile: pdfPath, userDataDir })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await pdf.locator('.ai-composer textarea').fill('delete page 2')
      await pdf.locator('.ai-composer textarea').press('Enter')

      // the action ran, then the follow-up request failed
      await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(2)
      const assistant = pdf.locator('.ai-msg-assistant')
      await expect(assistant).toContainText('Delete page 2')
      await expect(pdf.locator('.ai-msg-status')).toHaveText('Failed')

      // the run must not end in a green completion, and the card must say so
      await expect(pdf.locator('.ai-process-done-label')).not.toContainText('✓ Completed')
      await expect(pdf.locator('.ai-process-box')).toContainText('Failed after 1 completed action')

      // the request WAS delivered: no "Not delivered" claim
      await expect(pdf.locator('.ai-msg-user .ai-msg-undelivered')).toHaveCount(0)
      // and no replay that would delete a second page
      await expect(pdf.locator('.ai-msg-user .ai-retry-btn')).toHaveCount(0)
      await expect(pdf.locator('.ai-msg-assistant .ai-msg-undelivered')).toContainText(
        'already applied and will not be repeated',
      )

      // evidence the delete really landed: the document is dirty and undoable
      await expect(pdf.locator('.tb-save-pending')).toBeVisible()
      await pdf.keyboard.press('Control+z')
      await expect(pdf.locator('.tb-save-pending')).toHaveCount(0, { timeout: 15_000 })
    } finally {
      await closeReader(launched)
      await provider.close()
    }
  })

  test('New chat during a run keeps the earlier conversation with its real (stopped) outcome', async () => {
    const provider = await startFakeProvider('hold', 'read_pages', '{"start":1,"end":1}')
    const { userDataDir, pdfPath } = await makeProfile(provider.baseUrl)
    const launched = await launchApp({ openFile: pdfPath, userDataDir })
    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      await pdf.locator('.ai-composer textarea').fill('what does page 1 say?')
      await pdf.locator('.ai-composer textarea').press('Enter')

      // the tool ran and the follow-up turn is still open: the run is busy, not finished
      await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(2)
      await expect(pdf.locator('.ai-msg-assistant')).toContainText('Read pages 1-1')
      await expect(pdf.locator('.ai-typing')).toHaveCount(1)

      await pdf.locator('.ai-panel-header-actions button[aria-label="New chat"]').click()

      // The frozen conversation is reachable, and it says what really happened:
      // stopped, never a green "✓ Completed" for a run that was interrupted.
      await pdf.getByRole('button', { name: 'History' }).click()
      const earlier = pdf.locator('.ai-history-sep')
      await expect(earlier).toHaveText(/Earlier conversation \(2\)/)
      await expect(pdf.locator('.ai-msg-historic')).toHaveCount(2)
      await expect(pdf.locator('.ai-msg-historic .ai-msg-status')).toHaveText('Stopped')
      await expect(pdf.locator('.ai-msg-historic .ai-process-done-label')).not.toContainText(
        '✓ Completed',
      )
      await expect(pdf.locator('.ai-msg-historic .ai-process-box')).toContainText('Stopped')
      // the action that really ran is still listed in the frozen conversation
      await expect(pdf.locator('.ai-msg-historic.ai-msg-assistant')).toContainText('Read pages 1-1')
      // the new conversation starts empty and idle
      await expect(pdf.locator('.ai-chat > .ai-msg')).toHaveCount(0)
      await expect(pdf.locator('.ai-typing')).toHaveCount(0)
    } finally {
      await closeReader(launched)
      await provider.close()
    }
  })
})
