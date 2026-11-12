import { describe, expect, it, vi } from 'vitest'
import { waitForSavesBeforeClosePrompt } from '../src/renderer/close-prompt'
import {
  isReaderInteractionLocked,
  saveStateAfterFailure,
  trackSaveInFlight,
  type PdfSaveState,
} from '../src/renderer/save-flight'

describe('in-flight save coordination', () => {
  it('does not overlap a second save after an unrelated failure and keeps close waiting for the first', async () => {
    let finish!: (ok: boolean) => void
    const write = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    const ref: { current: Promise<boolean> | null } = { current: null }
    const first = trackSaveInFlight(ref, write)

    // An unrelated operation must not replace the pending save state or its promise.
    expect(saveStateAfterFailure('saving', 'operation')).toBe('saving')
    const second = trackSaveInFlight(ref, write)
    expect(second).toBe(first)
    expect(write).toHaveBeenCalledOnce()

    let closeReady = false
    const closeBarrier = waitForSavesBeforeClosePrompt([ref.current]).then(() => {
      closeReady = true
    })
    await Promise.resolve()
    expect(closeReady).toBe(false)

    finish(true)
    await Promise.all([first, closeBarrier])
    expect(closeReady).toBe(true)
    expect(ref.current).toBeNull()
  })

  it('blocks edits for the duration of a delayed write, then unlocks the reader', async () => {
    let finish!: (ok: boolean) => void
    const ref: { current: Promise<boolean> | null } = { current: null }
    const write = trackSaveInFlight(
      ref,
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    let state: PdfSaveState = 'saving'
    const edits: string[] = []
    const edit = () => {
      if (!isReaderInteractionLocked(state)) edits.push('new edit')
    }

    edit()
    expect(edits).toEqual([])
    expect(isReaderInteractionLocked(state)).toBe(true)

    finish(true)
    await write
    state = 'saved'
    edit()
    expect(edits).toEqual(['new edit'])
    expect(isReaderInteractionLocked(state)).toBe(false)
  })

  it('keeps a pending refresh locked even if another request reports an error', () => {
    expect(isReaderInteractionLocked('error', true)).toBe(true)
    expect(isReaderInteractionLocked('error', false)).toBe(false)
  })

  it('a save failure still leaves the save state actionable', () => {
    expect(saveStateAfterFailure('saving', 'save')).toBe('error')
    expect(saveStateAfterFailure('idle', 'operation')).toBe('error')
  })
})
