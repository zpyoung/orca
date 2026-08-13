// Why this module exists: when a dead daemon endpoint is replaced (STA-2373,
// #10065), the pane remounts and re-attaches to a *fresh* shell. Keystrokes in
// flight during that window are dropped, but everything typed after re-attach
// lands on the new shell — so the surviving tail of a half-sent line is
// submitted by the user's own Enter. `echo hi; rm -rf x` can arrive as
// `cho hi; rm -rf x`: zsh fails `cho` and still runs `rm -rf x`. Before #10065
// the whole line was silently lost, so the executing tail is a new risk.
//
// Quarantine drops the remainder of the interrupted line so a mangled command
// can never be submitted. It must be keyed by tab, not by pane: recovery
// destroys the xterm that was being typed into, and the successor pane is the
// one that receives the tail.

/** Absolute cap from arming. A safety valve only — input must never wedge,
 *  even if the terminator never arrives and the pane keeps receiving data. */
const QUARANTINE_MAX_MS = 5_000
/** A gap this long proves the interrupted burst ended. Re-attach takes ~1.1s,
 *  so the tail arrives back-to-back (<100ms apart) while a human reacting to a
 *  recovered pane takes far longer — that gap is what separates the two. */
const QUARANTINE_IDLE_MS = 700

/** CR/LF submit the line; Ctrl-C abandons it. Dropping the terminator itself is
 *  the point — it is the byte that would have submitted the mangled line. */
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

function notifyQuarantineListeners(tabId: string, armed: boolean): void {
  const listeners = quarantineListeners.get(tabId)
  if (!listeners) {
    return
  }
  // snapshot: a listener unsubscribing another mid-dispatch must not skip it
  for (const listener of Array.from(listeners)) {
    try {
      listener(armed)
    } catch {
      // a subscriber's exception must never block the safety decision or the other listeners
    }
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

/** Arm only when the endpoint stopped accepting writes and may have been
 *  replaced. A recovery that always keeps the same live shell has no mangled
 *  line to suppress, and quarantining there would eat a legitimate command. */
export function armTerminalInputQuarantine(tabId: string, now: number = Date.now()): void {
  // Prune first: entries are only meaningful for QUARANTINE_MAX_MS, and a tab
  // closed mid-quarantine would otherwise leave one behind forever.
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
    cb(true)
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
