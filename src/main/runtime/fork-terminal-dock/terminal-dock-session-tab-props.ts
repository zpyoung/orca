import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import type { TerminalDockPaneState } from '../../../shared/fork-terminal-dock/terminal-dock-pane-state'
import { DEFAULT_GUTTER_ROWS as DEFAULT_TERMINAL_DOCK_GUTTER_ROWS } from '../../../shared/fork-terminal-dock/terminal-dock-gutter-rows'

export { DEFAULT_TERMINAL_DOCK_GUTTER_ROWS }

// Why: clients now prune retired panes via the removal path below, but this
// cap remains the backstop for clients that never prune (old clients, or a
// client that crashes before pruning); sized well above any real split layout.
export const MAX_TERMINAL_DOCK_PANE_ENTRIES = 64

/** One `session.tabs.setTabProps` dock patch: an upsert of `paneKey`, a
 *  removal of `remove`, or both — `undefined` fields mean "leave unchanged". */
export type TerminalDockPropsPatch = {
  paneKey?: string
  docked?: boolean
  gutterRows?: number
  userUndocked?: boolean
  remove?: readonly string[]
}

// Why: an unverified paneKey (syntactically valid but never bound to a host
// PTY for this tab) must not be able to evict a verified live pane's entry —
// evict unverified keys first, oldest first, and only reach into the verified
// set when unverified keys alone can't cover the overflow.
export function selectTerminalDockEvictionKeys(
  existingKeys: readonly string[],
  overflow: number,
  livePaneKeys: ReadonlySet<string> | undefined
): Set<string> {
  if (!livePaneKeys) {
    return new Set(existingKeys.slice(0, overflow))
  }
  const unverified = existingKeys.filter((key) => !livePaneKeys.has(key))
  if (unverified.length >= overflow) {
    return new Set(unverified.slice(0, overflow))
  }
  const verified = existingKeys.filter((key) => livePaneKeys.has(key))
  return new Set([...unverified, ...verified.slice(0, overflow - unverified.length)])
}

/** Upserts one pane's dock state into a per-pane record without touching any
 *  other pane's entry — the RPC patch is single-pane so other clients'
 *  concurrent updates to different panes on the same tab must survive.
 *  `livePaneKeys`, when given, is the set of paneKeys the host has verified
 *  (a live or previously-live PTY binding for this tab) — eviction at the cap
 *  prefers unverified keys so an unverified flood can't displace it. */
export function mergeTerminalDockByPaneKey(
  existing: Record<string, TerminalDockPaneState> | undefined,
  patch: { paneKey: string; docked?: boolean; gutterRows?: number; userUndocked?: boolean },
  livePaneKeys?: ReadonlySet<string>
): Record<string, TerminalDockPaneState> {
  const current = existing?.[patch.paneKey]
  const nextUserUndocked = patch.userUndocked ?? current?.userUndocked
  const nextEntry: TerminalDockPaneState = {
    docked: patch.docked ?? current?.docked ?? false,
    gutterRows: patch.gutterRows ?? current?.gutterRows ?? DEFAULT_TERMINAL_DOCK_GUTTER_ROWS,
    ...(nextUserUndocked !== undefined ? { userUndocked: nextUserUndocked } : {})
  }
  const existingKeys = existing ? Object.keys(existing) : []
  // Why: only a brand-new key can grow the record, so eviction is scoped to
  // that case — an update to an already-tracked pane never evicts anything.
  const overflow =
    current === undefined ? existingKeys.length + 1 - MAX_TERMINAL_DOCK_PANE_ENTRIES : 0
  const evicted =
    overflow > 0 ? selectTerminalDockEvictionKeys(existingKeys, overflow, livePaneKeys) : null
  const result: Record<string, TerminalDockPaneState> = {}
  for (const key of existingKeys) {
    if (!evicted?.has(key)) {
      result[key] = existing![key]!
    }
  }
  result[patch.paneKey] = nextEntry
  return result
}

/** Drops named keys from a per-pane dock record; a key that isn't present is a
 *  no-op. Returns the same reference when nothing matched, so callers can
 *  detect "no change" without a deep comparison. */
export function removeTerminalDockPaneKeys(
  existing: Record<string, TerminalDockPaneState> | undefined,
  paneKeys: readonly string[]
): Record<string, TerminalDockPaneState> | undefined {
  if (!existing || paneKeys.length === 0) {
    return existing
  }
  const toRemove = new Set(paneKeys)
  if (!Object.keys(existing).some((key) => toRemove.has(key))) {
    return existing
  }
  const result: Record<string, TerminalDockPaneState> = {}
  for (const [key, value] of Object.entries(existing)) {
    if (!toRemove.has(key)) {
      result[key] = value
    }
  }
  return result
}

// Removal runs before the upsert so a patch that both prunes and sets a pane
// on the same call frees its own capacity instead of tripping the cap above.
export function applyTerminalDockByPaneKeyPatch(
  existing: Record<string, TerminalDockPaneState> | undefined,
  patch: TerminalDockPropsPatch,
  livePaneKeys?: ReadonlySet<string>
): Record<string, TerminalDockPaneState> | undefined {
  const pruned = patch.remove?.length
    ? removeTerminalDockPaneKeys(existing, patch.remove)
    : existing
  if (patch.paneKey === undefined) {
    return pruned
  }
  return mergeTerminalDockByPaneKey(
    pruned,
    {
      paneKey: patch.paneKey,
      docked: patch.docked,
      gutterRows: patch.gutterRows,
      userUndocked: patch.userUndocked
    },
    livePaneKeys
  )
}

export function terminalDockPatchFragment(
  existing: Record<string, TerminalDockPaneState> | undefined,
  patch: TerminalDockPropsPatch | undefined,
  livePaneKeys?: ReadonlySet<string>
): { terminalDockByPaneKey?: Record<string, TerminalDockPaneState> } {
  if (!patch) {
    return {}
  }
  const next = applyTerminalDockByPaneKeyPatch(existing, patch, livePaneKeys)
  return next !== undefined ? { terminalDockByPaneKey: next } : {}
}

export function terminalDockPaneStatesEqual(
  a: TerminalDockPaneState | undefined,
  b: TerminalDockPaneState | undefined
): boolean {
  if (a === b) {
    return true
  }
  return (
    a !== undefined &&
    b !== undefined &&
    a.docked === b.docked &&
    a.gutterRows === b.gutterRows &&
    (a.userUndocked ?? false) === (b.userUndocked ?? false)
  )
}

/** Merges one terminal tab's renderer-published dock record against the
 *  snapshot main already holds, per pane key, instead of letting a full
 *  renderer republish clobber another client's single-pane RPC patch.
 *  `rendererKnown` is the record from the *previous* accepted renderer
 *  publication for this tab: a key absent from `incoming` that `rendererKnown`
 *  never had either is another client's pane the renderer never saw, so it
 *  survives; a key `rendererKnown` did have is a genuine local prune. A key
 *  whose incoming value still matches `rendererKnown` (the renderer hasn't
 *  touched it since) yields to a diverged `existing` value from elsewhere. */
export function mergeRendererTerminalDockByPaneKey(
  incoming: Record<string, TerminalDockPaneState> | undefined,
  existing: Record<string, TerminalDockPaneState> | undefined,
  rendererKnown: Record<string, TerminalDockPaneState> | undefined
): Record<string, TerminalDockPaneState> | undefined {
  if (incoming === undefined || existing === undefined) {
    return incoming ?? existing
  }
  const merged: Record<string, TerminalDockPaneState> = {}
  for (const key of new Set([...Object.keys(incoming), ...Object.keys(existing)])) {
    const incomingValue = incoming[key]
    const existingValue = existing[key]
    if (incomingValue === undefined) {
      if (rendererKnown?.[key] !== undefined) {
        continue
      }
      if (existingValue) {
        merged[key] = existingValue
      }
      continue
    }
    const rendererStillEchoingKnownValue = terminalDockPaneStatesEqual(
      incomingValue,
      rendererKnown?.[key]
    )
    merged[key] =
      rendererStillEchoingKnownValue &&
      existingValue &&
      !terminalDockPaneStatesEqual(existingValue, incomingValue)
        ? existingValue
        : incomingValue
  }
  return merged
}

/** Applies {@link mergeRendererTerminalDockByPaneKey} across every terminal
 *  tab in a renderer's graph publication before it can overwrite the stored
 *  snapshot wholesale — see that function for the merge rule. */
export function mergeRendererTerminalDockAcrossSnapshot(
  incomingSnapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined,
  rendererKnownByParentTabId:
    | ReadonlyMap<string, Record<string, TerminalDockPaneState> | undefined>
    | undefined
): RuntimeMobileSessionTabsSnapshot {
  if (!existing) {
    return incomingSnapshot
  }
  const existingByParentTabId = new Map<string, Record<string, TerminalDockPaneState> | undefined>()
  for (const tab of existing.tabs) {
    if (tab.type === 'terminal') {
      existingByParentTabId.set(tab.parentTabId, tab.terminalDockByPaneKey)
    }
  }
  let changed = false
  const tabs = incomingSnapshot.tabs.map((tab) => {
    if (tab.type !== 'terminal') {
      return tab
    }
    const merged = mergeRendererTerminalDockByPaneKey(
      tab.terminalDockByPaneKey,
      existingByParentTabId.get(tab.parentTabId),
      rendererKnownByParentTabId?.get(tab.parentTabId)
    )
    if (merged === tab.terminalDockByPaneKey) {
      return tab
    }
    changed = true
    return { ...tab, terminalDockByPaneKey: merged }
  })
  return changed ? { ...incomingSnapshot, tabs } : incomingSnapshot
}

export function buildRendererDockByPaneKeyBaseline(
  tabs: readonly RuntimeMobileSessionSnapshotTab[]
): ReadonlyMap<string, Record<string, TerminalDockPaneState> | undefined> {
  const baseline = new Map<string, Record<string, TerminalDockPaneState> | undefined>()
  for (const tab of tabs) {
    if (tab.type === 'terminal') {
      baseline.set(tab.parentTabId, tab.terminalDockByPaneKey)
    }
  }
  return baseline
}
