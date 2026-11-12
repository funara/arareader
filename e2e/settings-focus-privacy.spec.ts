import { test, expect } from '@playwright/test'
import { closeReader, launchApp } from './helpers'

test('Settings receives focus, traps keyboard navigation, and restores focus on close', async () => {
  const launched = await launchApp()
  try {
    const { page } = launched
    const trigger = page.locator('.ai-provider-trigger')
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    const closeButton = page.locator('.ai-provider-close')
    await expect(closeButton).toBeFocused()
    await expect(page.locator('.ai-provider-actions .primary')).toBeEnabled()

    await page.keyboard.press('Shift+Tab')
    await expect(page.locator('.ai-provider-actions .primary')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(closeButton).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  } finally {
    await closeReader(launched)
  }
})
