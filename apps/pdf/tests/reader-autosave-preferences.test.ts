import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_INTERVAL_MS, isAutosaveAllowed, startAutosave } from '../src/renderer/useAutosave'

describe('reader autosave preferences', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('requires enabled preference, a successful explicit save, and a writable dirty document', () => {
    const state = {
      enabled: false,
      savedOnce: false,
      dirty: true,
      saving: false,
      hasPath: true,
      readOnly: false,
      pendingDecision: false,
      closeGuardActive: false,
    }

    expect(isAutosaveAllowed(state)).toBe(false)
    state.enabled = true
    expect(isAutosaveAllowed(state)).toBe(false)
    state.savedOnce = true
    expect(isAutosaveAllowed(state)).toBe(true)
    expect(isAutosaveAllowed({ ...state, dirty: false })).toBe(false)
    expect(isAutosaveAllowed({ ...state, saving: true })).toBe(false)
    expect(isAutosaveAllowed({ ...state, hasPath: false })).toBe(false)
    expect(isAutosaveAllowed({ ...state, readOnly: true })).toBe(false)
  })

  it('honors preference and first-save changes on both timer and blur triggers', () => {
    const state = {
      enabled: false,
      savedOnce: false,
      dirty: true,
      saving: false,
      hasPath: true,
      readOnly: false,
      pendingDecision: false,
      closeGuardActive: false,
    }
    const save = vi.fn()
    const stop = startAutosave(() => isAutosaveAllowed(state), save, AUTOSAVE_INTERVAL_MS)

    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    window.dispatchEvent(new Event('blur'))
    expect(save).not.toHaveBeenCalled()

    // Enabling the preference alone must not bypass the explicit-save safeguard.
    state.enabled = true
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    window.dispatchEvent(new Event('blur'))
    expect(save).not.toHaveBeenCalled()

    // A successful explicit save opens the gate; preference changes remain live.
    state.savedOnce = true
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    window.dispatchEvent(new Event('blur'))
    expect(save).toHaveBeenCalledTimes(2)

    state.enabled = false
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    window.dispatchEvent(new Event('blur'))
    expect(save).toHaveBeenCalledTimes(2)

    state.enabled = true
    state.pendingDecision = true
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    window.dispatchEvent(new Event('blur'))
    expect(save).toHaveBeenCalledTimes(2)

    state.pendingDecision = false
    state.closeGuardActive = true
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    window.dispatchEvent(new Event('blur'))
    expect(save).toHaveBeenCalledTimes(2)

    state.closeGuardActive = false
    state.saving = true
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    window.dispatchEvent(new Event('blur'))
    expect(save).toHaveBeenCalledTimes(2)

    stop()
  })
})
