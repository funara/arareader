import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeReader, launchApp } from './helpers'

test('profile preference write failure keeps onboarding open for retry and AI skip', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-onboarding-profile-retry-'))
  const settingsPath = join(userDataDir, 'app-settings.json')
  await mkdir(settingsPath)
  const launched = await launchApp({ testOnboarding: true, userDataDir })

  try {
    const { page } = launched
    const onboarding = page.locator('.onboard-modal')
    await page.locator('#onboard-display-name').fill('Profile Retry')
    await page.locator('#onboard-full-name').fill('Profile Retry User')
    await page.getByRole('button', { name: /Next/ }).click()

    // Skip AI setup so the failing write is Home's profile persistence callback.
    await onboarding.getByRole('button', { name: 'Skip for now' }).click()
    await expect(onboarding).toBeVisible()
    await expect(onboarding.getByRole('alert')).toContainText('Could not save setup')

    await rm(settingsPath, { recursive: true, force: true })
    await onboarding.getByRole('button', { name: 'Skip for now' }).click()
    await expect(onboarding).toHaveCount(0)

    const preferences = await page.evaluate(() => window.reader.getPreferences())
    expect(preferences.profile.displayName).toBe('Profile Retry')
    expect(preferences.profile.fullName).toBe('Profile Retry User')
    expect(preferences.onboardingCompleted).toBe(true)
    expect(preferences.aiAutoSuggestions).toBe(false)
    expect(preferences.aiAutoSuggestionsConsentVersion).toBeUndefined()
    expect(
      JSON.parse(await readFile(settingsPath, 'utf8')).userPreferences.profile.displayName,
    ).toBe('Profile Retry')
  } finally {
    await closeReader(launched)
    await rm(userDataDir, { recursive: true, force: true })
  }
})
