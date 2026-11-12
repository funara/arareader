import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { closeReader, launchApp } from './helpers'

test.describe('onboarding AI setup recovery', () => {
  test('a failed AI-settings write keeps inputs and consent choice for retry', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-onboarding-retry-'))
    const blockedSettingsPath = join(userDataDir, 'ai-settings.json')
    await mkdir(blockedSettingsPath)
    const launched = await launchApp({ testOnboarding: true, userDataDir })
    try {
      const page = launched.page
      const onboarding = page.locator('.onboard-modal')
      await page.locator('#onboard-display-name').fill('ARA')
      await page.locator('#onboard-full-name').fill('ARA')
      await page.getByRole('button', { name: /Next/ }).click()
      const consent = onboarding.getByRole('checkbox', {
        name: 'Allow automatic AI recommendations when opening PDFs',
      })
      await expect(consent).not.toBeChecked()
      await expect(onboarding).toContainText('up to 1,200 characters')
      await expect(onboarding).toContainText('configured provider')
      await consent.check()
      await page.locator('#onboard-google-key').fill('e2e-only-dummy-key')
      await page.getByRole('button', { name: 'Get Started' }).click()

      await expect(onboarding.getByRole('alert')).toContainText('Could not save setup')
      await expect(page.locator('#onboard-google-key')).toHaveValue('e2e-only-dummy-key')
      await expect(consent).toBeChecked()

      await rm(blockedSettingsPath, { recursive: true, force: true })
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(onboarding).toHaveCount(0)
      const preferences = await page.evaluate(() => window.reader.getPreferences())
      expect(preferences.aiAutoSuggestions).toBe(true)
      expect(preferences.aiAutoSuggestionsConsentVersion).toBe(1)
      expect(preferences.aiAutoSuggestionsConsentAction).toBeUndefined()
    } finally {
      await closeReader(launched)
    }
  })

  test('Skip for now bypasses failed AI settings and does not create consent', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-onboarding-skip-'))
    const blockedSettingsPath = join(userDataDir, 'ai-settings.json')
    await mkdir(blockedSettingsPath)
    const launched = await launchApp({ testOnboarding: true, userDataDir })
    try {
      const page = launched.page
      const onboarding = page.locator('.onboard-modal')
      await page.locator('#onboard-display-name').fill('ARA')
      await page.getByRole('button', { name: /Next/ }).click()
      await onboarding
        .getByRole('checkbox', { name: 'Allow automatic AI recommendations when opening PDFs' })
        .check()
      await page.getByRole('button', { name: 'Skip for now' }).click()
      await expect(onboarding).toHaveCount(0)
      await expect((await stat(blockedSettingsPath)).isDirectory()).toBe(true)
      const preferences = await page.evaluate(() => window.reader.getPreferences())
      expect(preferences.aiAutoSuggestions).toBe(false)
      expect(preferences.aiAutoSuggestionsConsentVersion).toBeUndefined()
    } finally {
      await closeReader(launched)
    }
  })
})
