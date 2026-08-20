import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalDockPaneState } from '../../../../shared/types'
import { TERMINAL_DOCK_ECHO_WINDOW_MS } from '../../store/slices/fork-terminal-dock/tab-terminal-dock-state'

/** Rewrites a pane key's tab-ID segment across the mirror boundary, leaving the leaf untouched.
 *  Returns null for a key that doesn't parse, so callers drop rather than forward it verbatim. */
export function remapPaneKeyTabId(
  paneKey: string,
  remapTabId: (tabId: string) => string
): string | null {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  return makePaneKey(remapTabId(parsed.tabId), parsed.leafId)
}

// Why: dock records cross the mirror boundary keyed by the *other* side's tab id;
// entries that don't parse are dropped rather than forwarded under a wrong or stale key.
export function remapTerminalDockRecordTabId(
  record: Record<string, TerminalDockPaneState> | undefined,
  remapTabId: (tabId: string) => string
): Record<string, TerminalDockPaneState> | undefined {
  if (!record) {
    return undefined
  }
  const next: Record<string, TerminalDockPaneState> = {}
  for (const [key, value] of Object.entries(record)) {
    const remappedKey = remapPaneKeyTabId(key, remapTabId)
    if (remappedKey) {
      next[remappedKey] = value
    }
  }
  if (Object.keys(next).length > 0) {
    return next
  }
  // Why: an explicitly echoed empty record is host-authoritative and must stay
  // distinguishable from an absent field (see hostHasEverEchoed in use-terminal-pane-dock.ts);
  // a non-empty record that lost every entry to unparseable keys is not that — it still falls
  // back like an absent field.
  return Object.keys(record).length === 0 ? next : undefined
}

/** Per-pane echo precedence for terminalDockByPaneKey: a pane with a recent local
 *  mutation (`isPending`) keeps its client value against a stale host echo; a pane
 *  without one adopts the host's value, including the host's absence of that key,
 *  so paired clients still converge. Falls back wholesale to whichever side has
 *  the only record (M1: an explicitly echoed empty host record still counts). */
export function reconcileTerminalDockByPaneKey(
  hostRecord: Record<string, TerminalDockPaneState> | undefined,
  existingRecord: Record<string, TerminalDockPaneState> | undefined,
  isPending: (paneKey: string) => boolean
): Record<string, TerminalDockPaneState> | undefined {
  if (!hostRecord) {
    return existingRecord
  }
  if (!existingRecord) {
    return hostRecord
  }
  const next: Record<string, TerminalDockPaneState> = {}
  for (const key of new Set([...Object.keys(hostRecord), ...Object.keys(existingRecord)])) {
    const value = isPending(key) ? existingRecord[key] : hostRecord[key]
    if (value) {
      next[key] = value
    }
  }
  return next
}

export function pendingMutationsForTabId(
  record: Record<string, number> | undefined,
  tabId: string
): Record<string, number> | undefined {
  if (!record) {
    return undefined
  }
  const prefix = `${tabId}:`
  const next: Record<string, number> = {}
  for (const [key, mutatedAt] of Object.entries(record)) {
    if (key.startsWith(prefix)) {
      next[key] = mutatedAt
    }
  }
  return Object.keys(next).length > 0 ? next : undefined
}

// Why: pending-mutation timestamps must follow the same provisional->final tab-id
// rekey the dock record gets during handoff, or a later stale host echo finds no
// timestamp under the new key and overwrites the client's optimistic value.
export function remapPendingMutationTimestampsTabId(
  record: Record<string, number> | undefined,
  remapTabId: (tabId: string) => string
): Record<string, number> | undefined {
  if (!record) {
    return undefined
  }
  const next: Record<string, number> = {}
  for (const [key, mutatedAt] of Object.entries(record)) {
    const remappedKey = remapPaneKeyTabId(key, remapTabId)
    if (remappedKey) {
      next[remappedKey] = mutatedAt
    }
  }
  return Object.keys(next).length > 0 ? next : undefined
}

// Why: entries older than the echo window are dead by definition; drop them here
// so the record doesn't grow unbounded across pane-key churn.
export function pruneExpiredTerminalDockPendingMutations(
  record: Record<string, number> | undefined,
  now: number
): Record<string, number> | undefined {
  if (!record) {
    return undefined
  }
  let changed = false
  const next: Record<string, number> = {}
  for (const [key, mutatedAt] of Object.entries(record)) {
    if (now - mutatedAt < TERMINAL_DOCK_ECHO_WINDOW_MS) {
      next[key] = mutatedAt
    } else {
      changed = true
    }
  }
  return changed ? next : record
}
