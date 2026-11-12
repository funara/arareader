export type PdfSaveState = 'idle' | 'saving' | 'saved' | 'error'
export type PdfSaveFailureKind = 'save' | 'operation'

export function trackSaveInFlight<T>(
  ref: { current: Promise<T> | null },
  run: () => Promise<T>,
): Promise<T> {
  if (ref.current) return ref.current
  const tracked = run().finally(() => {
    if (ref.current === tracked) ref.current = null
  })
  ref.current = tracked
  return tracked
}

export function isReaderInteractionLocked(state: PdfSaveState, operationBusy = false): boolean {
  return state === 'saving' || operationBusy
}

export function saveStateAfterFailure(
  current: PdfSaveState,
  kind: PdfSaveFailureKind,
): PdfSaveState {
  return kind === 'operation' && current === 'saving' ? current : 'error'
}
