import { notifyTerminalInputNotSent } from './terminal-input-not-sent-notice'

// Endpoint replacement can deliver only a command suffix to a fresh shell; quarantine that interrupted line, including its terminator. Key by tab because recovery destroys the original pane (#10065, STA-2373).

/** Absolute cap from arming. A safety valve only — input must never wedge,
 *  even if the terminator never arrives and the pane keeps receiving data. */
const QUARANTINE_MAX_MS = 5_000
/** Idle gap after the first dropped byte distinguishes an interrupted typing burst from a new command; reattach delay itself cannot release it. */
const QUARANTINE_IDLE_MS = 700

/** Drop CR/LF submit or Ctrl+C abandonment too; forwarding the terminator could submit the mangled line. */
const LINE_TERMINATORS = ['\r', '\n', '\x03']

type QuarantineEntry = {
  armedAt: number
  /** null until the first quarantined byte, so the idle gate cannot fire on the
   *  re-attach delay itself. */
  lastInputAt: number | null
}

const quarantineByTabId = new Map<string, QuarantineEntry>()

type QuarantineListener = (armed: boolean) => void

const quarantineListeners = new Map<string, Set<QuarantineListener>>()
const quarantineExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function invokeQuarantineListener(listener: QuarantineListener, armed: boolean): void {
  try {
    listener(armed)
  } catch {
    // a subscriber's exception must never block the safety decision or the other listeners
  }
}

function notifyQuarantineListeners(tabId: string, armed: boolean): void {
  const listeners = quarantineListeners.get(tabId)
  if (!listeners) {
    return
  }
  // snapshot: a listener unsubscribing another mid-dispatch must not skip it
  for (const listener of Array.from(listeners)) {
    invokeQuarantineListener(listener, armed)
  }
}

function clearQuarantineExpiryTimer(tabId: string): void {
  const timer = quarantineExpiryTimers.get(tabId)
  if (timer !== undefined) {
    clearTimeout(timer)
    quarantineExpiryTimers.delete(tabId)
  }
}

function releaseQuarantine(tabId: string): void {
  quarantineByTabId.delete(tabId)
  clearQuarantineExpiryTimer(tabId)
  notifyQuarantineListeners(tabId, false)
}

function containsLineTerminator(data: string): boolean {
  return LINE_TERMINATORS.some((terminator) => data.includes(terminator))
}

/** Arm only when write rejection may mean endpoint replacement; same-shell recovery has no mangled suffix to suppress. */
export function armTerminalInputQuarantine(tabId: string, now: number = Date.now()): void {
  // Prune expired entries so tabs closed mid-quarantine do not retain them forever.
  for (const [otherTabId, entry] of quarantineByTabId) {
    if (now - entry.armedAt >= QUARANTINE_MAX_MS) {
      releaseQuarantine(otherTabId)
    }
  }
  clearQuarantineExpiryTimer(tabId)
  quarantineByTabId.set(tabId, { armedAt: now, lastInputAt: null })
  // Real wall-clock, independent of the injected `now`: this is the only path
  // that releases a pane nobody is typing into, so it cannot depend on a
  // caller ever supplying a later `now`.
  quarantineExpiryTimers.set(
    tabId,
    setTimeout(() => releaseQuarantine(tabId), QUARANTINE_MAX_MS)
  )
  notifyQuarantineListeners(tabId, true)
}

export function isTerminalInputQuarantined(tabId: string): boolean {
  return quarantineByTabId.has(tabId)
}

/**
 * Notifies `cb` with the arm state of `tabId`'s quarantine: `true` when it
 * arms, `false` when it releases (line terminator, idle gap, absolute cap, or
 * the expiry timer). A tab already armed at subscribe time fires `true`
 * immediately, so a late subscriber cannot miss a live quarantine. Returns an
 * unsubscribe function.
 */
export function subscribeTerminalInputQuarantine(
  tabId: string,
  cb: QuarantineListener
): () => void {
  let listeners = quarantineListeners.get(tabId)
  if (!listeners) {
    listeners = new Set()
    quarantineListeners.set(tabId, listeners)
  }
  listeners.add(cb)
  if (quarantineByTabId.has(tabId)) {
    invokeQuarantineListener(cb, true)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      quarantineListeners.delete(tabId)
    }
  }
}

/**
 * True when `data` belongs to the interrupted line and must not reach the fresh
 * shell. Disarms on the line terminator, on an idle gap that proves the burst
 * ended, and on the absolute cap.
 */
export function shouldDropQuarantinedTerminalInput(
  tabId: string,
  data: string,
  now: number = Date.now()
): boolean {
  const entry = quarantineByTabId.get(tabId)
  if (!entry) {
    return false
  }
  if (now - entry.armedAt >= QUARANTINE_MAX_MS) {
    releaseQuarantine(tabId)
    return false
  }
  if (entry.lastInputAt !== null && now - entry.lastInputAt >= QUARANTINE_IDLE_MS) {
    releaseQuarantine(tabId)
    return false
  }
  if (entry.lastInputAt === null) {
    // Why: dropping the user's typing silently is what made it look lost; say so once per line.
    notifyTerminalInputNotSent(tabId)
  }
  entry.lastInputAt = now
  if (containsLineTerminator(data)) {
    releaseQuarantine(tabId)
  }
  return true
}

export function _resetTerminalInputQuarantineForTests(): void {
  for (const timer of quarantineExpiryTimers.values()) {
    clearTimeout(timer)
  }
  quarantineExpiryTimers.clear()
  quarantineByTabId.clear()
  quarantineListeners.clear()
}
