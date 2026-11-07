/** Paged view wheel paging: one page turn per wheel burst, normalized across deltaMode. */
export interface WheelGesture {
  lastAt: number
  acc: number
  locked: boolean
}

/** Rough px per line for deltaMode DOM_DELTA_LINE (the spec leaves the unit device-dependent). */
const LINE_PX = 16
/** A burst ends after this much wheel silence; a reversal starts a new one immediately. */
const BURST_GAP_MS = 120
/** Accumulated scroll that counts as a deliberate page turn. */
const TURN_PX = 20

/** Direction to turn, or null when this event belongs to an already-consumed burst. Mutates gesture. */
export function wheelPageTurn(
  gesture: WheelGesture,
  e: { deltaX: number; deltaY: number; deltaMode: number },
  now: number,
  viewportHeight: number,
): 1 | -1 | null {
  if (e.deltaY === 0) return null
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return null
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? viewportHeight : 1
  const delta = e.deltaY * unit
  const dir: 1 | -1 = delta > 0 ? 1 : -1
  const reversed = gesture.acc !== 0 && gesture.acc > 0 !== delta > 0
  if (now - gesture.lastAt > BURST_GAP_MS || reversed) {
    gesture.acc = 0
    gesture.locked = false
  }
  gesture.lastAt = now
  gesture.acc += delta
  if (gesture.locked || Math.abs(gesture.acc) < TURN_PX) return null
  gesture.locked = true
  return dir
}
