import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { closeReader, launchApp, screenshotPath, waitForPageWithUrl } from './helpers'

/** the tab-strip bridge the host preload exposes to the renderer */
interface TabsBridge {
  list(): Promise<{ id: string; kind: 'home' | 'pdf'; title: string }[]>
  close(id: string): Promise<void>
}

async function closePdfTabs(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const bridge = (window as unknown as { readerTabs: TabsBridge }).readerTabs
    const tabs = await bridge.list()
    const closed: string[] = []
    for (const tab of tabs) {
      if (tab.kind !== 'pdf') continue
      await bridge.close(tab.id)
      closed.push(tab.title)
    }
    return closed
  })
}

test.describe('home screen', () => {
  test('shows the home surface and opens the AI provider dialog', async () => {
    const launched = await launchApp()
    const { page } = launched
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))
    try {
      await expect(page.locator('.home')).toBeVisible()
      const trigger = page.locator('.ai-provider-trigger')
      await expect(trigger).toBeVisible()
      await trigger.click()
      const modal = page.locator('.ai-provider-modal')
      await expect(modal).toBeVisible()
      await page.locator('.ai-provider-close').click()
      await expect(modal).toHaveCount(0)
      await page.screenshot({ path: screenshotPath('home') })
    } finally {
      await closeReader(launched)
    }
    expect(crashes).toEqual([])
  })

  test('shows onboarding modal when name is missing and saves credentials', async () => {
    const launched = await launchApp({ testOnboarding: true })
    const { page } = launched
    try {
      const onboard = page.locator('.onboard-modal')
      await expect(onboard).toBeVisible()
      await expect(onboard.locator('.onboard-privacy-banner')).toContainText(/telemetry/i)
      await page.locator('#onboard-display-name').fill('Jhon')
      await page.locator('#onboard-full-name').fill('Jhon Doe')
      await page.locator('.onboard-modal button:has-text("Next")').click()
      await page.locator('.onboard-modal button:has-text("Get Started")').click()
      await expect(onboard).toHaveCount(0)
    } finally {
      await closeReader(launched)
    }
  })

  test('defaults to ARAReader if skipped and prompts again on subsequent launch', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-onboard-test-'))
    const launched = await launchApp({ testOnboarding: true, userDataDir })
    try {
      const onboard = launched.page.locator('.onboard-modal')
      await expect(onboard).toBeVisible()
      await launched.page.keyboard.press('Escape')
      await expect(onboard).toHaveCount(0)
      await expect(launched.page.locator('.hero-user-btn')).toContainText('ARAReader')
    } finally {
      await closeReader(launched)
    }

    // Re-launching with the same userData: should prompt again because onboardingCompleted is still false
    const relaunched = await launchApp({ testOnboarding: true, userDataDir })
    try {
      const onboardAgain = relaunched.page.locator('.onboard-modal')
      await expect(onboardAgain).toBeVisible()
    } finally {
      await closeReader(relaunched)
    }
  })

  test('shows onboarding modal if profile credentials are blanked in settings and app is reopened', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-onboard-blank-'))
    const launched = await launchApp({ testOnboarding: true, userDataDir })
    try {
      const onboard = launched.page.locator('.onboard-modal')
      await expect(onboard).toBeVisible()
      await launched.page.locator('#onboard-display-name').fill('Jhon')
      await launched.page.locator('#onboard-full-name').fill('Jhon Doe')
      await launched.page.locator('.onboard-modal button:has-text("Next")').click()
      await launched.page.locator('.onboard-modal button:has-text("Get Started")').click()
      await expect(onboard).toHaveCount(0)

      // Open Settings and blank both fields
      const userBtn = launched.page.locator('.hero-user-btn')
      await userBtn.click()
      const modal = launched.page.locator('.ai-provider-modal')
      await expect(modal).toBeVisible()
      await launched.page.locator('.settings-nav-btn:has-text("Profile")').click()
      await launched.page.locator('#profile-display-name').fill('')
      await launched.page.locator('#profile-full-name').fill('')
      await launched.page.locator('.ai-provider-modal button:has-text("Save Changes")').click()
      await expect(modal).toHaveCount(0)
    } finally {
      await closeReader(launched)
    }

    // Reopening with blank credentials prompts onboarding
    const relaunched = await launchApp({ testOnboarding: true, userDataDir })
    try {
      const onboardAgain = relaunched.page.locator('.onboard-modal')
      await expect(onboardAgain).toBeVisible()
    } finally {
      await closeReader(relaunched)
    }
  })

  test('opens the argv PDF in a tab and returns home when it closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arareader-home-'))
    const path = join(dir, 'document.pdf')
    const document = await PDFDocument.create()
    document.addPage([612, 792])
    await writeFile(path, await document.save())

    const launched = await launchApp({ openFile: path })
    const { app, page } = launched
    const crashes: string[] = []
    page.on('pageerror', (error) => crashes.push(String(error)))
    try {
      const pdf = await waitForPageWithUrl(app, 'pdf/out')
      pdf.on('pageerror', (error) => crashes.push(String(error)))
      await expect(pdf.locator('.ribbon')).toBeVisible()

      // the host tab strip stays painted above the PDF view: one Home tab plus the PDF tab
      await expect(page.locator('.tab-bar')).toBeVisible()
      await expect(page.locator('.tab-strip .tab-item', { hasText: 'document.pdf' })).toBeVisible()

      // close the PDF tab through the same bridge the tab strip uses
      expect(await closePdfTabs(page)).toEqual(['document.pdf'])
      await expect(page.locator('.tab-strip .tab-item', { hasText: 'document.pdf' })).toHaveCount(0)
      await expect(page.locator('.home')).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-after-tab-close') })
    } finally {
      await closeReader(launched)
    }
    expect(crashes).toEqual([])
  })
})
