import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { closeReader, launchApp, waitForPageWithUrl } from './helpers'

async function writeDistinctPages(path: string, count: number): Promise<number[]> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const widths = Array.from({ length: count }, (_, index) => 360 + index * 4)
  widths.forEach((width, index) => {
    const page = document.addPage([width, 500])
    page.drawText(`Distinct page ${index + 1}`, { x: 24, y: 450, size: 18, font })
  })
  await writeFile(path, await document.save())
  return widths
}

async function openOrganizeGrid(pdf: import('@playwright/test').Page) {
  await pdf.locator('.rb-big[title="Organize pages"]').first().click()
  const grid = pdf.locator('.pdf-organize-grid')
  await expect(grid).toBeVisible()
  return grid
}

const readOrder = (grid: import('@playwright/test').Locator) =>
  grid
    .locator('.pdf-organize-card')
    .evaluateAll((cards) => cards.map((card) => Number((card as HTMLElement).dataset.origIdx)))

const readDisplayedNumbers = (grid: import('@playwright/test').Locator) =>
  grid
    .locator('.pdf-organize-no')
    .evaluateAll((numbers) => numbers.map((number) => Number(number.textContent)))

async function startDelayedProducerProvider() {
  const requests: string[] = []
  let releaseFirstResponse!: () => void
  let resolveFirstRequest!: () => void
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve
  })
  const firstRequest = new Promise<void>((resolve) => {
    resolveFirstRequest = resolve
  })
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      requests.push(body)
      if (requests.length === 1) {
        resolveFirstRequest()
        void firstResponseGate.then(() => {
          if (res.destroyed) return
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
                        function: {
                          name: 'fill_form_field',
                          arguments: '{"name":"missing-field","value":"value"}',
                        },
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
          res.end('data: [DONE]\n\n')
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'No matching field.' } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    firstRequest,
    releaseFirstResponse,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

test.describe('Organize page reorder', () => {
  test('drag moves one page across rows, preserves selection, and saves the visible order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-organize-reorder-'))
    const path = join(dir, 'distinct-pages.pdf')
    const originalWidths = await writeDistinctPages(path, 24)
    const launched = await launchApp({ openFile: path })
    const { app, page } = launched
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))

    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      pdf.on('pageerror', (error) => crashes.push(String(error)))
      const grid = await openOrganizeGrid(pdf)
      const cards = grid.locator('.pdf-organize-card')
      await expect(cards).toHaveCount(originalWidths.length)
      const initialOrder = Array.from({ length: originalWidths.length }, (_, index) => index)
      expect(await readOrder(grid)).toEqual(initialOrder)

      const firstTop = await cards.first().evaluate((card) => card.getBoundingClientRect().top)
      const lastTop = await cards.last().evaluate((card) => card.getBoundingClientRect().top)
      expect(lastTop).toBeGreaterThan(firstTop)

      // Ctrl/Command selection does not turn a drag into a multi-page move.
      await cards.nth(0).click()
      await cards.nth(2).click({
        modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
      })
      await expect(grid.locator('.pdf-organize-card-active')).toHaveCount(2)

      // Keep the source and target onscreen: Playwright scrolls a distant target before dragging,
      // which can move the source offscreen and start the gesture on a different card.
      const nextRow = await cards.evaluateAll((items) => {
        const top = items[0]?.getBoundingClientRect().top ?? 0
        return items.findIndex((card, index) => index > 0 && card.getBoundingClientRect().top > top)
      })
      const forwardTarget = Math.min(Math.max(nextRow, 6), originalWidths.length - 1)
      await cards.first().dragTo(cards.nth(forwardTarget))
      const afterForward = [
        ...initialOrder.slice(1, forwardTarget + 1),
        0,
        ...initialOrder.slice(forwardTarget + 1),
      ]
      await expect.poll(() => readOrder(grid)).toEqual(afterForward)
      expect(await readDisplayedNumbers(grid)).toEqual(
        Array.from({ length: originalWidths.length }, (_, index) => index + 1),
      )
      expect(
        await grid
          .locator('.pdf-organize-card-active')
          .evaluateAll((active) =>
            active
              .map((card) => Number((card as HTMLElement).dataset.origIdx))
              .sort((a, b) => a - b),
          ),
      ).toEqual([0, 2])
      await expect
        .poll(() =>
          pdf.evaluate(
            () => (document.activeElement as HTMLElement | null)?.dataset.origIdx ?? null,
          ),
        )
        .toBe('0')

      // The Shift anchor follows page identity, not the old displayed position.
      await cards.nth(4).click({ modifiers: ['Shift'] })
      expect(
        await grid
          .locator('.pdf-organize-card-active')
          .evaluateAll((active) =>
            active
              .map((card) => Number((card as HTMLElement).dataset.origIdx))
              .sort((a, b) => a - b),
          ),
      ).toEqual([2, 3, 4, 5])

      // Move the same single page backward to a different row position.
      await grid.locator('.pdf-organize-card[data-orig-idx="0"]').dragTo(cards.nth(2))
      const afterBackward = [1, 2, 0, ...initialOrder.slice(3)]
      await expect.poll(() => readOrder(grid)).toEqual(afterBackward)
      expect(await readDisplayedNumbers(grid)).toEqual(
        Array.from({ length: originalWidths.length }, (_, index) => index + 1),
      )

      // A self-drop, canceled drag, and an unrelated external drop must not mutate the order.
      const pageOne = grid.locator('.pdf-organize-card[data-orig-idx="0"]')
      await pageOne.dragTo(pageOne)
      await pageOne.dragTo(grid.locator('.pdf-organize-header'))
      await pageOne.evaluate((card) => {
        const transfer = new DataTransfer()
        transfer.setData('text/plain', 'external')
        card.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        )
        card.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        )
      })
      await expect.poll(() => readOrder(grid)).toEqual(afterBackward)

      // If those no-op gestures accidentally created undo steps, this would not undo exactly one move.
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
      await pdf.keyboard.press(`${modifier}+z`)
      await expect.poll(() => readOrder(grid)).toEqual(afterForward)
      await pdf.keyboard.press(`${modifier}+Shift+z`)
      await expect.poll(() => readOrder(grid)).toEqual(afterBackward)

      // Force the moved page out of view and back: its lazy thumbnail must stay tied to page 1.
      const scroll = grid.locator('.pdf-organize-scroll')
      await scroll.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await pageOne.scrollIntoViewIfNeeded()
      const thumbnail = pageOne.locator('canvas')
      await expect(thumbnail).toBeVisible()
      const aspectRatio = await thumbnail.evaluate((canvas) => canvas.height / canvas.width)
      expect(aspectRatio).toBeCloseTo(500 / originalWidths[0]!, 2)

      await pdf.keyboard.press(`${modifier}+s`)
      await expect
        .poll(async () => {
          const saved = await PDFDocument.load(await readFile(path), { updateMetadata: false })
          return saved.getPages().map((savedPage) => savedPage.getWidth())
        })
        .toEqual(afterBackward.map((originalIndex) => originalWidths[originalIndex]!))
      await grid.locator('.pdf-organize-close').click()
    } finally {
      await closeReader(launched)
    }
    expect(crashes).toEqual([])
  })

  test('drag can place pages at the absolute first and last positions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-organize-boundaries-'))
    const path = join(dir, 'distinct-pages.pdf')
    await writeDistinctPages(path, 6)
    const launched = await launchApp({ openFile: path })

    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      const grid = await openOrganizeGrid(pdf)
      const cards = grid.locator('.pdf-organize-card')
      await expect(cards).toHaveCount(6)
      expect(await readOrder(grid)).toEqual([0, 1, 2, 3, 4, 5])

      await cards.nth(5).dragTo(cards.first())
      await expect.poll(() => readOrder(grid)).toEqual([5, 0, 1, 2, 3, 4])
      await grid.locator('.pdf-organize-card[data-orig-idx="5"]').dragTo(cards.last())
      await expect.poll(() => readOrder(grid)).toEqual([0, 1, 2, 3, 4, 5])
      expect(await readDisplayedNumbers(grid)).toEqual([1, 2, 3, 4, 5, 6])
      await pdf.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`)
      await pdf.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`)
      await expect.poll(() => readOrder(grid)).toEqual([0, 1, 2, 3, 4, 5])
    } finally {
      await closeReader(launched)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('drag auto-scrolls to an offscreen target and moves the source to the last page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-organize-autoscroll-'))
    const path = join(dir, 'distinct-pages.pdf')
    await writeDistinctPages(path, 24)
    const launched = await launchApp({ openFile: path })

    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      const grid = await openOrganizeGrid(pdf)
      const cards = grid.locator('.pdf-organize-card')
      const scroll = grid.locator('.pdf-organize-scroll')
      const scrollBox = await scroll.boundingBox()
      const sourceBox = await cards.first().boundingBox()
      expect(scrollBox).not.toBeNull()
      expect(sourceBox).not.toBeNull()
      expect(
        await cards.last().evaluate((card) => {
          const root = card.closest('.pdf-organize-scroll')!
          return card.getBoundingClientRect().bottom > root.getBoundingClientRect().bottom
        }),
      ).toBe(true)

      const startX = sourceBox!.x + sourceBox!.width / 2
      const startY = sourceBox!.y + sourceBox!.height / 2
      await pdf.mouse.move(startX, startY)
      await pdf.mouse.down()
      await pdf.mouse.move(startX + 24, startY + 12, { steps: 6 })
      await expect(cards.first()).toHaveClass(/pdf-organize-card-dragging/)
      await pdf.mouse.move(
        scrollBox!.x + scrollBox!.width / 2,
        scrollBox!.y + scrollBox!.height - 5,
        { steps: 24 },
      )
      await expect
        .poll(() => scroll.evaluate((element) => element.scrollTop), { timeout: 10_000 })
        .toBeGreaterThan(0)
      await expect
        .poll(
          () =>
            cards.last().evaluate((card) => {
              const root = card.closest('.pdf-organize-scroll')!.getBoundingClientRect()
              const target = card.getBoundingClientRect()
              return target.top >= root.top && target.bottom <= root.bottom
            }),
          { timeout: 10_000 },
        )
        .toBe(true)

      const targetBox = await cards.last().boundingBox()
      expect(targetBox).not.toBeNull()
      await pdf.mouse.move(
        targetBox!.x + targetBox!.width / 2,
        targetBox!.y + targetBox!.height / 2,
      )
      await pdf.mouse.up()
      await expect
        .poll(() => readOrder(grid))
        .toEqual([...Array.from({ length: 23 }, (_, index) => index + 1), 0])
      expect(await readDisplayedNumbers(grid)).toEqual(
        Array.from({ length: 24 }, (_, index) => index + 1),
      )
      await pdf.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`)
      await expect
        .poll(() => readOrder(grid))
        .toEqual(Array.from({ length: 24 }, (_, index) => index))
    } finally {
      await closeReader(launched)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('producer started after the grid opens disables reorder controls until it finishes', async () => {
    const provider = await startDelayedProducerProvider()
    const dir = await mkdtemp(join(tmpdir(), 'arareader-organize-producer-doc-'))
    const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-organize-producer-profile-'))
    const path = join(dir, 'distinct-pages.pdf')
    await writeDistinctPages(path, 72)
    await writeFile(
      join(userDataDir, 'app-settings.json'),
      JSON.stringify({
        userPreferences: {
          onboardingCompleted: true,
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
          custom: { model: 'e2e-model', baseUrl: provider.baseUrl, apiKey: 'e2e-key' },
        },
      }),
      'utf8',
    )
    const launched = await launchApp({ openFile: path, userDataDir })

    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      const composer = pdf.locator('.ai-composer textarea')
      await expect(composer).toBeEnabled()
      await composer.fill('Check whether a form field is available.')
      await composer.press('Enter')
      await provider.firstRequest

      const grid = await openOrganizeGrid(pdf)
      const cards = grid.locator('.pdf-organize-card')
      const later = grid.getByRole('button', { name: 'Move page later' })
      await cards.first().focus()
      await expect(later).toBeEnabled()
      await provider.releaseFirstResponse()

      await expect(later).toBeDisabled()
      await expect(cards.first()).toHaveAttribute('draggable', 'false')
      await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(2)
      await expect(later).toBeEnabled()
      await expect(cards.first()).toHaveAttribute('draggable', 'true')
    } finally {
      provider.releaseFirstResponse()
      await closeReader(launched)
      await provider.close()
      await Promise.all([
        rm(dir, { recursive: true, force: true }),
        rm(userDataDir, { recursive: true, force: true }),
      ])
    }
  })

  test('a pending deletion still allows reorder while immediate page writes stay disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-organize-pending-ops-'))
    const path = join(dir, 'distinct-pages.pdf')
    const originalWidths = await writeDistinctPages(path, 4)
    const launched = await launchApp({ openFile: path })

    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      const grid = await openOrganizeGrid(pdf)
      const cards = grid.locator('.pdf-organize-card')
      await cards.nth(1).click()
      await grid.getByRole('button', { name: 'Delete page' }).click()
      await expect(cards).toHaveCount(3)
      expect(await readOrder(grid)).toEqual([0, 2, 3])

      await cards.first().click()
      await expect(grid.getByRole('button', { name: 'Insert blank page' })).toBeDisabled()
      await expect(grid.getByRole('button', { name: 'Duplicate page' })).toBeDisabled()
      const later = grid.getByRole('button', { name: 'Move page later' })
      await expect(later).toBeEnabled()
      await later.click()
      await expect.poll(() => readOrder(grid)).toEqual([2, 0, 3])

      await pdf.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+s`)
      await expect
        .poll(async () => {
          const saved = await PDFDocument.load(await readFile(path), { updateMetadata: false })
          return saved.getPages().map((savedPage) => savedPage.getWidth())
        })
        .toEqual([originalWidths[2], originalWidths[0], originalWidths[3]])
    } finally {
      await closeReader(launched)
    }
  })

  test('earlier/later controls are accessible, honor boundaries, and retain page focus', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-organize-keyboard-'))
    const path = join(dir, 'distinct-pages.pdf')
    await writeDistinctPages(path, 3)
    const launched = await launchApp({ openFile: path })

    try {
      const pdf = await waitForPageWithUrl(launched.app, 'pdf/out')
      const grid = await openOrganizeGrid(pdf)
      const cards = grid.locator('.pdf-organize-card')
      const earlier = grid.getByRole('button', { name: 'Move page earlier' })
      const later = grid.getByRole('button', { name: 'Move page later' })

      await expect(earlier).toBeDisabled()
      await expect(later).toBeDisabled()
      await cards.first().focus()
      await expect(earlier).toBeDisabled()
      await expect(later).toBeEnabled()
      await later.click()
      await expect.poll(() => readOrder(grid)).toEqual([1, 0, 2])
      await expect
        .poll(() =>
          pdf.evaluate(
            () => (document.activeElement as HTMLElement | null)?.dataset.origIdx ?? null,
          ),
        )
        .toBe('0')

      await cards.last().focus()
      await expect(later).toBeDisabled()
      await expect(earlier).toBeEnabled()
      await pdf.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`)
      await expect.poll(() => readOrder(grid)).toEqual([0, 1, 2])
    } finally {
      await closeReader(launched)
    }
  })
})
