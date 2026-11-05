import { describe, expect, it } from 'vitest'
import {
  defaultAiSettings,
  mergeAiSettings,
  redactAiSettings,
  resolveAiSettings,
  type AiSettings,
} from '@arareader/ai-provider'
import { isSafeRemoteUrl as isAiSearchSafeUrl, webExtract } from '@arareader/ai-search'
import { isSafeRemoteUrl } from '@arareader/electron-utils'
import {
  AI_CHANNELS,
  ATTACHMENT_IMAGE_EXTS,
  FILES_CHANNELS,
  PROJECT_CHANNELS,
} from '../src/shared/ai-api'

/** stored settings as they look on disk: both providers carry a plaintext key */
function storedWithKeys(): AiSettings {
  return resolveAiSettings(
    {
      provider: 'custom',
      providers: {
        google: { model: 'gemini-3.8-flash', apiKey: 'google-secret-key' },
        custom: {
          model: 'gpt-4o-mini',
          baseUrl: 'https://models.example.test/v1',
          apiKey: 'custom-secret-key',
        },
      },
    },
    defaultAiSettings(),
  )
}

describe('AI settings redaction', () => {
  it('never returns an apiKey, only hasApiKey', () => {
    const redacted = redactAiSettings(storedWithKeys())
    expect(redacted.provider).toBe('custom')
    expect(redacted.providers.google.apiKey).toBe('')
    expect(redacted.providers.custom.apiKey).toBe('')
    expect(redacted.providers.google.hasApiKey).toBe(true)
    expect(redacted.providers.custom.hasApiKey).toBe(true)
    // the whole IPC payload must be key-free, not just the fields we check
    expect(JSON.stringify(redacted)).not.toContain('secret')
  })

  it('marks a provider without a key as not configured', () => {
    const redacted = redactAiSettings(defaultAiSettings())
    expect(redacted.providers.google.hasApiKey).toBe(false)
    expect(redacted.providers.custom.hasApiKey).toBe(false)
    expect(redacted.providers.custom.baseUrl).toBe('')
  })
})

describe('AI settings merge', () => {
  it('keeps the stored key when the incoming (redacted) key is empty', () => {
    // The renderer only holds redacted settings, so an untouched key arrives as ''.
    const incoming: AiSettings = {
      provider: 'custom',
      providers: {
        google: { model: 'gemini-3.1-pro', apiKey: '' },
        custom: { model: 'gpt-4o-mini', baseUrl: 'https://models.example.test/v1', apiKey: '' },
      },
    }
    const merged = mergeAiSettings(storedWithKeys(), incoming)
    expect(merged.providers.google.apiKey).toBe('google-secret-key')
    expect(merged.providers.custom.apiKey).toBe('custom-secret-key')
    // non-secret edits still apply
    expect(merged.providers.google.model).toBe('gemini-3.1-pro')
    expect(merged.provider).toBe('custom')
  })

  it('replaces a key only when the incoming key is set', () => {
    const incoming: AiSettings = {
      provider: 'google',
      providers: {
        google: { model: 'gemini-3.8-flash', apiKey: 'fresh-key' },
        custom: { model: 'gpt-4o-mini', baseUrl: '', apiKey: '' },
      },
    }
    const merged = mergeAiSettings(storedWithKeys(), incoming)
    expect(merged.providers.google.apiKey).toBe('fresh-key')
    // clearing the base URL is a real edit; the custom key survives
    expect(merged.providers.custom.baseUrl).toBe('')
    expect(merged.providers.custom.apiKey).toBe('custom-secret-key')
  })
})

describe('web fetch SSRF gate', () => {
  it('refuses loopback and localhost targets', async () => {
    await expect(isAiSearchSafeUrl('http://127.0.0.1:9')).resolves.toBe(false)
    await expect(isAiSearchSafeUrl('http://localhost:8080/')).resolves.toBe(false)
    await expect(isSafeRemoteUrl('http://127.0.0.1:9')).resolves.toBe(false)
    await expect(isSafeRemoteUrl('http://localhost:8080/')).resolves.toBe(false)
    // literal public addresses are decided without DNS
    await expect(isSafeRemoteUrl('https://8.8.8.8/')).resolves.toBe(true)
  })

  it('returns no content for a loopback fetch', async () => {
    const result = await webExtract('http://127.0.0.1:9', 1000, 'full')
    expect(result.content ?? '').toBe('')
  })
})

describe('channel contract', () => {
  it('keeps the AI channel names stable across modules', () => {
    expect(AI_CHANNELS).toEqual({
      getSettings: 'ai:get-settings',
      setSettings: 'ai:set-settings',
      settingsChanged: 'ai:settings-changed',
      configure: 'ai:configure',
      configureRequest: 'ai:configure-request',
      fetchCustomModels: 'ai:fetch-custom-models',
      stream: 'ai:stream',
      streamChunk: 'ai:stream-chunk',
      streamCancel: 'ai:stream-cancel',
      cancel: 'ai:cancel',
      webSearch: 'ai:web-search',
      webFetch: 'ai:web-fetch',
      chat: 'ai:chat',
    })
    expect(FILES_CHANNELS.readImage).toBe('files:read-image')
    expect(FILES_CHANNELS.addPastedImage).toBe('files:add-pasted-image')
    expect(PROJECT_CHANNELS.rebindChat).toBe('project:rebindChat')
    expect([...ATTACHMENT_IMAGE_EXTS].sort()).toEqual(['gif', 'jpeg', 'jpg', 'png', 'webp'])
  })
})
