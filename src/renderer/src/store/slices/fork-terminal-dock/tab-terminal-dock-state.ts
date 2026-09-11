import type { StateCreator } from 'zustand'
import type { setWebRuntimeTabProps } from '@/runtime/web-runtime-session'
import type { remapPaneKeyTabId } from '@/runtime/web-session-tabs-sync'
import type { AppState } from '../../types'
import type { TerminalDockPaneState } from '../../../../../shared/fork-terminal-dock/terminal-dock-pane-state'
import {
  clampGutterRows,
  DEFAULT_GUTTER_ROWS
} from '../../../../../shared/fork-terminal-dock/terminal-dock-gutter-rows'
import {
  removeTerminalDockPaneKeys as removeLocalTerminalDockPaneKeys,
  writeTerminalDockPaneState
} from '@/components/terminal-pane/fork-terminal-dock/terminal-dock-pane-state'
import { findTabAndWorktree, patchTab } from '../tab-group-state'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { pruneExpiredTerminalDockPendingMutations } from '@/runtime/fork-terminal-dock/web-session-terminal-dock-reconcile'

/** The docked-composer state the tabs slice tracks per tab pane, plus the two
 *  actions that mutate it. Kept out of the slice module so the fork owns one
 *  file rather than a block inside upstream's. */
export type TabTerminalDockSlice = {
  /** Pane key -> timestamp of the most recent local dock mutation, so reconcile can
   *  hold the client's optimistic value against a stale host echo during the echo window. */
  terminalDockPendingMutationsByPaneKey: Record<string, number>
  /** Patch one pane's docked-composer state on a tab; mirrors the single-pane patch to the host. */
  setTabTerminalDockState: (
    tabId: string,
    patch: { paneKey: string; docked?: boolean; gutterRows?: number; userUndocked?: boolean }
  ) => void
  /** Drop retired pane keys from a tab's dock record and mirror the removal to the host. */
  pruneTerminalDockPaneKeys: (tabId: string, paneKeys: readonly string[]) => void
}

// shared wire bounds keep local and host gutter state from diverging
function normalizeTerminalDockGutterRows(gutterRows: number | undefined): number | undefined {
  if (gutterRows === undefined) {
    return undefined
  }
  const rounded =
    typeof gutterRows === 'number' && Number.isFinite(gutterRows)
      ? Math.round(gutterRows)
      : DEFAULT_GUTTER_ROWS
  return clampGutterRows(rounded)
}

function mergeTerminalDockPaneState(
  existing: TerminalDockPaneState | undefined,
  patch: { docked?: boolean; gutterRows?: number; userUndocked?: boolean }
): TerminalDockPaneState {
  const userUndocked = patch.userUndocked ?? existing?.userUndocked
  return {
    docked: patch.docked ?? existing?.docked ?? false,
    gutterRows:
      normalizeTerminalDockGutterRows(patch.gutterRows) ??
      existing?.gutterRows ??
      DEFAULT_GUTTER_ROWS,
    ...(userUndocked !== undefined ? { userUndocked } : {})
  }
}

function removePaneKeysFromRecord<T>(
  record: Record<string, T> | undefined,
  paneKeys: ReadonlySet<string>
): Record<string, T> | undefined {
  if (!record) {
    return record
  }
  const matchingKeys = Object.keys(record).filter((key) => paneKeys.has(key))
  if (matchingKeys.length === 0) {
    return record
  }
  const next = { ...record }
  for (const key of matchingKeys) {
    delete next[key]
  }
  return next
}

// Why: pending-mutation timestamps live outside the per-tab dock record, so closing
// a tab must drop its keys explicitly or they linger until they age out on their own.
function removeTabPaneKeysFromPendingMutations(
  record: Record<string, number>,
  tabId: string
): Record<string, number> {
  const prefix = `${tabId}:`
  let changed = false
  const next: Record<string, number> = {}
  for (const [key, mutatedAt] of Object.entries(record)) {
    if (key.startsWith(prefix)) {
      changed = true
      continue
    }
    next[key] = mutatedAt
  }
  return changed ? next : record
}

type DockMirrorContext = {
  environmentId: string
  worktreeId: string
}

type DockMirrorPatch = NonNullable<Parameters<typeof setWebRuntimeTabProps>[0]['terminalDock']>

function resolveDockMirrorContext(state: AppState, tabId: string): DockMirrorContext | null {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  if (!found || found.tab.contentType !== 'terminal') {
    return null
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, found.worktreeId)
  return environmentId ? { environmentId, worktreeId: found.worktreeId } : null
}

function withDockMirrorModules(
  state: AppState,
  tabId: string,
  mirror: (hostTabId: string, remap: typeof remapPaneKeyTabId) => DockMirrorPatch | null
): void {
  const context = resolveDockMirrorContext(state, tabId)
  if (!context) {
    return
  }
  void Promise.all([
    import('@/runtime/web-runtime-session'),
    import('@/runtime/web-session-tabs-sync')
  ]).then(([runtimeSession, sessionTabsSync]) => {
    const hostTabId =
      sessionTabsSync.resolveHostSessionTabIdForWebSessionTab(state, { ...context, tabId }) ??
      (runtimeSession.isWebTerminalSurfaceTabId(tabId)
        ? runtimeSession.toHostSessionTabId(tabId)
        : tabId)
    const terminalDock = mirror(hostTabId, sessionTabsSync.remapPaneKeyTabId)
    if (terminalDock) {
      runtimeSession.setWebRuntimeTabProps({
        worktreeId: context.worktreeId,
        tabId,
        terminalDock
      })
    }
  })
}

// Why: dock state is host-tracked like color/pin/viewMode, so mirror local sets or they're lost on reconnect and to paired clients.
// Only the action path mirrors (never reconcile applying a host value), so the echoed snapshot can't re-trigger an outbound RPC.
// Sends only the single-pane patch (never the whole record) so two clients editing different panes can't clobber each other.
// The patch is expected to already carry normalized values (gutterRows clamped) so local and host state can't diverge.
function mirrorTabTerminalDockToHost(
  state: AppState,
  tabId: string,
  patch: { paneKey: string; docked?: boolean; gutterRows?: number; userUndocked?: boolean }
): void {
  withDockMirrorModules(state, tabId, (hostTabId, remapPaneKeyTabId) => {
    // Why: the paneKey's tab-ID segment must land under the same host tab id the
    // RPC itself targets, or the host accumulates a second, web-namespaced record.
    const hostPaneKey = remapPaneKeyTabId(patch.paneKey, () => hostTabId)
    return hostPaneKey ? { ...patch, paneKey: hostPaneKey } : null
  })
}

// Why: dock state is host-tracked like color/pin/viewMode, so mirror local pruning
// or it's lost on reconnect and to paired clients. Only the action path mirrors
// (never reconcile applying a host value), so the echoed snapshot can't re-trigger
// an outbound RPC. Sends only the removed keys (never the whole record), remapped
// to the host's tab-id namespace via the same mechanism the set path uses.
function mirrorTerminalDockPruneToHost(
  state: AppState,
  tabId: string,
  removedPaneKeys: readonly string[]
): void {
  if (removedPaneKeys.length === 0) {
    return
  }
  withDockMirrorModules(state, tabId, (hostTabId, remapPaneKeyTabId) => {
    const hostPaneKeys = removedPaneKeys
      .map((paneKey) => remapPaneKeyTabId(paneKey, () => hostTabId))
      .filter((paneKey): paneKey is string => paneKey !== null)
    return hostPaneKeys.length > 0 ? { remove: hostPaneKeys } : null
  })
}

type DockSet = Parameters<StateCreator<AppState, [], [], TabTerminalDockSlice>>[0]
type DockGet = Parameters<StateCreator<AppState, [], [], TabTerminalDockSlice>>[1]

export const TAB_TERMINAL_DOCK_INITIAL_STATE = {
  terminalDockPendingMutationsByPaneKey: {} as Record<string, number>
}

export { removeTabPaneKeysFromPendingMutations }

export function createTabTerminalDockActions(
  set: DockSet,
  get: DockGet
): Pick<TabTerminalDockSlice, 'setTabTerminalDockState' | 'pruneTerminalDockPaneKeys'> {
  return {
    setTabTerminalDockState: (tabId, patch) => {
      const normalizedGutterRows = normalizeTerminalDockGutterRows(patch.gutterRows)
      const normalizedPatch = {
        ...patch,
        ...(normalizedGutterRows !== undefined ? { gutterRows: normalizedGutterRows } : {})
      }
      let committedPaneState: TerminalDockPaneState | null = null
      set((state) => {
        const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        if (!found) {
          return {}
        }
        const nextPaneState = mergeTerminalDockPaneState(
          found.tab.terminalDockByPaneKey?.[patch.paneKey],
          normalizedPatch
        )
        committedPaneState = nextPaneState
        return {
          ...patchTab(state.unifiedTabsByWorktree, tabId, {
            terminalDockByPaneKey: {
              ...found.tab.terminalDockByPaneKey,
              [patch.paneKey]: nextPaneState
            }
          }),
          // Why: outranks a stale host echo for this pane until the mirrored RPC's own
          // echo (or the window's expiry) restores host authority — see reconcile.
          terminalDockPendingMutationsByPaneKey: {
            ...pruneExpiredTerminalDockPendingMutations(
              state.terminalDockPendingMutationsByPaneKey,
              Date.now()
            ),
            [patch.paneKey]: Date.now()
          }
        }
      })
      if (committedPaneState) {
        writeTerminalDockPaneState(patch.paneKey, committedPaneState)
      }
      mirrorTabTerminalDockToHost(get(), tabId, normalizedPatch)
    },

    pruneTerminalDockPaneKeys: (tabId, paneKeys) => {
      if (paneKeys.length === 0) {
        return
      }
      const paneKeySet = new Set(paneKeys)
      let removedKeys: string[] = []
      set((state) => {
        const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        if (!found) {
          return {}
        }
        const existing = found.tab.terminalDockByPaneKey
        const next = removePaneKeysFromRecord(existing, paneKeySet)
        if (next === existing) {
          return {}
        }
        removedKeys = Object.keys(existing!).filter((key) => paneKeySet.has(key))
        const now = Date.now()
        return {
          ...patchTab(state.unifiedTabsByWorktree, tabId, { terminalDockByPaneKey: next }),
          // Why: a pruned key must not be revived by a stale host echo still carrying it.
          terminalDockPendingMutationsByPaneKey: {
            ...pruneExpiredTerminalDockPendingMutations(
              state.terminalDockPendingMutationsByPaneKey,
              now
            ),
            ...Object.fromEntries(removedKeys.map((key) => [key, now]))
          }
        }
      })
      if (removedKeys.length > 0) {
        removeLocalTerminalDockPaneKeys(new Set(removedKeys))
      }
      mirrorTerminalDockPruneToHost(get(), tabId, removedKeys)
    }
  }
}
