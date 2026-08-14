import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { getCachedUnifiedTerminalTabForWorktree } from './terminal-unified-tab-lookup'
import { useTerminalDockLocalFallback } from './use-terminal-dock-local-fallback'
import {
  isTerminalInputQuarantined,
  subscribeTerminalInputQuarantine
} from './terminal-input-quarantine'
import { resolveTerminalDockDisabledReason } from './terminal-pane-dock-disabled-reason'
import { resolveTerminalDockShortcutAction } from './terminal-pane-dock-shortcuts'
import { shouldAutoExitPassthroughOnAgentStatus } from './terminal-pane-dock-passthrough'
import type { PtyTransportRecoveryState } from './pty-transport-types'

function resolveShortcutPlatform(): NodeJS.Platform {
  const isMac = navigator.userAgent.includes('Mac')
  const isWindows = navigator.userAgent.includes('Windows')
  return isMac ? 'darwin' : isWindows ? 'win32' : 'linux'
}

export type UseTerminalPaneDockArgs = {
  tabId: string
  worktreeId: string
  enabled: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
}

export type UseTerminalPaneDockResult = {
  isPaneDocked: (paneKey: string) => boolean
  /** Combines docked state with the experimental flag — a stale persisted `docked: true`
   *  from before the flag was disabled must not keep programmatic focus off the terminal. */
  paneDockOwnsFocus: (paneKey: string) => boolean
  gutterRowsFor: (paneKey: string) => number
  isPanePassthrough: (paneKey: string) => boolean
  commitGutterRows: (paneKey: string, rows: number) => void
  disabledReasonFor: (args: {
    paneKey: string
    targetPtyId: string | null
    recoveryPhase: PtyTransportRecoveryState['phase'] | null
    sshDisconnected?: boolean
  }) => string | null
  /** Wire into the confirmed-agent-exit signal (onAgentExitedRef) alongside any existing
   *  consumer — undocks a pane whose agent just confirmed exit, same as the passthrough
   *  auto-exit, this never touches panes that were never docked. */
  undockOnConfirmedAgentExit: (leafId: string) => void
  /** Wire into the pane-retirement signal (close/detach) alongside the store-side dock-state
   *  prune — drops a closed pane's passthrough membership and auto-exit tracking so neither
   *  lingers for a leaf id that will never be reused. */
  prunePassthroughForRetiredPane: (leafId: string) => void
}

/** Centralizes the terminal dock's TerminalPane-side state: which panes are docked (mirrored
 *  from the unified tab's persisted record), per-pane passthrough mode (ephemeral, local —
 *  never persisted or synced), and the two pane-scoped keyboard shortcuts. Kept out of
 *  TerminalPane.tsx itself so that already-3000-line file only gains a handful of call sites. */
export function useTerminalPaneDock(args: UseTerminalPaneDockArgs): UseTerminalPaneDockResult {
  const { tabId, worktreeId, enabled, managerRef, containerRef } = args

  const terminalDockByPaneKey = useAppStore(
    (store) =>
      getCachedUnifiedTerminalTabForWorktree(store.unifiedTabsByWorktree, worktreeId, tabId)
        ?.terminalDockByPaneKey
  )
  const setTabTerminalDockState = useAppStore((store) => store.setTabTerminalDockState)

  const [passthroughPaneKeys, setPassthroughPaneKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Why: passthrough auto-exit compares against this per pane; keyed by paneKey rather than
  // reset per passthrough session so a pane's entry survives across the Set churn of toggling.
  const previousAgentStatesRef = useRef<Map<string, AgentStatusState | null>>(new Map())
  // Why: quarantine can arm/clear between renders with no store write to react to.
  const [, forceQuarantineRerender] = useState(0)

  const { resolvedStateFor, persistLocalDockState, forgetPane } = useTerminalDockLocalFallback()
  // Why: "ever echoed" is per-tab, not per-pane — a modern host's record simply omitting one
  // pane still means default (not local fallback) governs that pane, per resolveTerminalDockPaneState.
  const hostHasEverEchoed = terminalDockByPaneKey !== undefined
  const isPaneDocked = useCallback(
    (paneKey: string): boolean =>
      resolvedStateFor(paneKey, terminalDockByPaneKey?.[paneKey], hostHasEverEchoed).docked,
    [hostHasEverEchoed, resolvedStateFor, terminalDockByPaneKey]
  )
  const paneDockOwnsFocus = useCallback(
    (paneKey: string): boolean => enabled && isPaneDocked(paneKey),
    [enabled, isPaneDocked]
  )
  const gutterRowsFor = useCallback(
    (paneKey: string): number =>
      resolvedStateFor(paneKey, terminalDockByPaneKey?.[paneKey], hostHasEverEchoed).gutterRows,
    [hostHasEverEchoed, resolvedStateFor, terminalDockByPaneKey]
  )
  const isPanePassthrough = useCallback(
    (paneKey: string): boolean => passthroughPaneKeys.has(paneKey),
    [passthroughPaneKeys]
  )

  const resolveUnifiedTabId = useCallback((): string | null => {
    const state = useAppStore.getState()
    return (
      getCachedUnifiedTerminalTabForWorktree(state.unifiedTabsByWorktree, worktreeId, tabId)?.id ??
      null
    )
  }, [tabId, worktreeId])

  const commitGutterRows = useCallback(
    (paneKey: string, rows: number): void => {
      const unifiedTabId = resolveUnifiedTabId()
      if (!unifiedTabId) {
        return
      }
      setTabTerminalDockState(unifiedTabId, { paneKey, gutterRows: rows })
      persistLocalDockState(paneKey, { docked: isPaneDocked(paneKey), gutterRows: rows })
    },
    [isPaneDocked, persistLocalDockState, resolveUnifiedTabId, setTabTerminalDockState]
  )

  const toggleDockForFocusedPane = useCallback((): void => {
    const activeLeafId = managerRef.current?.getActivePane()?.leafId
    if (!activeLeafId) {
      return
    }
    const unifiedTabId = resolveUnifiedTabId()
    if (!unifiedTabId) {
      return
    }
    const paneKey = makePaneKey(tabId, activeLeafId)
    const nextDocked = !isPaneDocked(paneKey)
    setTabTerminalDockState(unifiedTabId, { paneKey, docked: nextDocked })
    persistLocalDockState(paneKey, { docked: nextDocked, gutterRows: gutterRowsFor(paneKey) })
  }, [
    gutterRowsFor,
    isPaneDocked,
    managerRef,
    persistLocalDockState,
    resolveUnifiedTabId,
    setTabTerminalDockState,
    tabId
  ])

  const undockOnConfirmedAgentExit = useCallback(
    (leafId: string): void => {
      // Why: the flag is the kill switch — disabled means no dock state gets written, even
      // to clean up a stale `docked: true` left over from before it was turned off.
      if (!enabled) {
        return
      }
      const paneKey = makePaneKey(tabId, leafId)
      if (!isPaneDocked(paneKey)) {
        return
      }
      const unifiedTabId = resolveUnifiedTabId()
      if (!unifiedTabId) {
        return
      }
      setTabTerminalDockState(unifiedTabId, { paneKey, docked: false })
      persistLocalDockState(paneKey, { docked: false, gutterRows: gutterRowsFor(paneKey) })
    },
    [
      enabled,
      gutterRowsFor,
      isPaneDocked,
      persistLocalDockState,
      resolveUnifiedTabId,
      setTabTerminalDockState,
      tabId
    ]
  )

  const togglePassthroughForFocusedPane = useCallback((): void => {
    const activePane = managerRef.current?.getActivePane()
    if (!activePane) {
      return
    }
    const paneKey = makePaneKey(tabId, activePane.leafId)
    setPassthroughPaneKeys((previous) => {
      const next = new Set(previous)
      if (next.has(paneKey)) {
        next.delete(paneKey)
        previousAgentStatesRef.current.delete(paneKey)
      } else {
        next.add(paneKey)
        // Why: passthrough exists so the raw terminal (not the composer) receives keys.
        activePane.terminal.focus()
        // Why: without this seed, the auto-exit subscription's first observed status change
        // has no baseline to compare against — if that first change is the real
        // working->non-working transition, previousState reads null and auto-exit never fires.
        const currentState = useAppStore.getState().agentStatusByPaneKey[paneKey]?.state ?? null
        previousAgentStatesRef.current.set(paneKey, currentState)
      }
      return next
    })
  }, [managerRef, tabId])

  // Why: window-level and keybinding-driven (not xterm's custom key handler) because a
  // docked pane's steady-state focus is the composer, not xterm, so the dock/passthrough
  // toggles must fire regardless of which of the two currently has DOM focus.
  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const container = containerRef.current
      if (!container || !(event.target instanceof Node) || !container.contains(event.target)) {
        return
      }
      // Why: the store's keybindings slice (from ~/.orca/keybindings.json), same source every
      // other terminal.* shortcut resolves against — not the legacy settings.keybindings field,
      // which the shortcuts UI never writes to.
      const keybindings = useAppStore.getState().keybindings
      const action = resolveTerminalDockShortcutAction(
        event,
        resolveShortcutPlatform(),
        keybindings
      )
      if (action === 'toggleDock') {
        event.preventDefault()
        toggleDockForFocusedPane()
      } else if (action === 'togglePassthrough') {
        event.preventDefault()
        togglePassthroughForFocusedPane()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [containerRef, enabled, toggleDockForFocusedPane, togglePassthroughForFocusedPane])

  // Why: quarantine has no store-backed change event; a raw subscription is the only way
  // to react to it arming/clearing without polling every render.
  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    return subscribeTerminalInputQuarantine(tabId, () => {
      forceQuarantineRerender((count) => count + 1)
    })
  }, [enabled, tabId])

  const disabledReasonFor = useCallback(
    (disabledArgs: {
      paneKey: string
      targetPtyId: string | null
      recoveryPhase: PtyTransportRecoveryState['phase'] | null
      sshDisconnected?: boolean
    }): string | null => {
      const parsed = parsePaneKey(disabledArgs.paneKey)
      return resolveTerminalDockDisabledReason({
        targetPtyId: disabledArgs.targetPtyId,
        recoveryPhase: disabledArgs.recoveryPhase,
        quarantined: parsed ? isTerminalInputQuarantined(parsed.tabId) : false,
        sshDisconnected: disabledArgs.sshDisconnected
      })
    },
    []
  )

  // Why: passthrough auto-exit follows live agent status (not the confirmed-exit signal
  // dock undock uses), so it's a raw subscription over the currently-passthrough panes only
  // — never a full-record selector, which would re-render this component on any pane's status
  // change anywhere in the app.
  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    // Why: catches a pane whose passthrough entry seed was lost to a remount of this hook
    // (subscription install) rather than a fresh toggle — the toggle-time seed above covers
    // the common case, this is the defensive backstop for the set already being non-empty.
    for (const paneKey of passthroughPaneKeys) {
      if (!previousAgentStatesRef.current.has(paneKey)) {
        const currentState = useAppStore.getState().agentStatusByPaneKey[paneKey]?.state ?? null
        previousAgentStatesRef.current.set(paneKey, currentState)
      }
    }
    return useAppStore.subscribe(() => {
      if (passthroughPaneKeys.size === 0) {
        return
      }
      const agentStatusByPaneKey = useAppStore.getState().agentStatusByPaneKey
      for (const paneKey of passthroughPaneKeys) {
        const entry = agentStatusByPaneKey[paneKey]
        const previousState = previousAgentStatesRef.current.get(paneKey) ?? null
        const nextState = entry?.state ?? null
        if (nextState === previousState) {
          continue
        }
        previousAgentStatesRef.current.set(paneKey, nextState)
        if (
          shouldAutoExitPassthroughOnAgentStatus({
            previousState,
            nextState,
            agentType: entry?.agentType
          })
        ) {
          previousAgentStatesRef.current.delete(paneKey)
          setPassthroughPaneKeys((previous) => {
            if (!previous.has(paneKey)) {
              return previous
            }
            const next = new Set(previous)
            next.delete(paneKey)
            return next
          })
        }
      }
    })
  }, [enabled, passthroughPaneKeys])

  const prunePassthroughForRetiredPane = useCallback(
    (leafId: string): void => {
      const paneKey = makePaneKey(tabId, leafId)
      previousAgentStatesRef.current.delete(paneKey)
      forgetPane(paneKey)
      setPassthroughPaneKeys((previous) => {
        if (!previous.has(paneKey)) {
          return previous
        }
        const next = new Set(previous)
        next.delete(paneKey)
        return next
      })
    },
    [forgetPane, tabId]
  )

  return useMemo(
    () => ({
      isPaneDocked,
      paneDockOwnsFocus,
      gutterRowsFor,
      isPanePassthrough,
      commitGutterRows,
      disabledReasonFor,
      undockOnConfirmedAgentExit,
      prunePassthroughForRetiredPane
    }),
    [
      commitGutterRows,
      disabledReasonFor,
      gutterRowsFor,
      isPaneDocked,
      isPanePassthrough,
      paneDockOwnsFocus,
      prunePassthroughForRetiredPane,
      undockOnConfirmedAgentExit
    ]
  )
}
