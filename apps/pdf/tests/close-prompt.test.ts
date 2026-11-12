import { describe, expect, it, vi } from 'vitest'
import { waitForSavesBeforeClosePrompt } from '../src/renderer/close-prompt'

describe('native close prompt write barrier', () => {
  it('acknowledges only after existing in-place and Save As writes settle', async () => {
    let finishSave!: () => void
    let finishSaveAs!: () => void
    const inPlaceSave = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    const saveAs = new Promise<void>((resolve) => {
      finishSaveAs = resolve
    })
    const ready = vi.fn()
    const acknowledged = waitForSavesBeforeClosePrompt([inPlaceSave, saveAs, null]).then(ready)

    finishSave()
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()

    finishSaveAs()
    await acknowledged
    expect(ready).toHaveBeenCalledOnce()
  })

  it('still releases the close guard if a renderer write rejects', async () => {
    await expect(
      waitForSavesBeforeClosePrompt([Promise.reject(new Error('synthetic write failure'))]),
    ).resolves.toBeUndefined()
  })
})
