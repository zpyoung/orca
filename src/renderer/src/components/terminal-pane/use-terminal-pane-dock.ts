import { useCallback, useMemo, useState } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { emitTerminalDockToggled } from '@/lib/terminal-dock-telemetry'
import type { AgentType } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getCachedUnifiedTerminalTabForWorktree } from './terminal-unified-tab-lookup'
import { useTerminalDockAgentLatch } from './terminal-pane-dock-agent-latch'
import { useTerminalDockLocalFallback } from './use-terminal-dock-local-fallback'
import { shouldDockTerminalComposerByDefault } from '../terminal-dock/terminal-dock-initial-state'
import { useTerminalDockDisabledReason } from './use-terminal-dock-disabled-reason'
import { useTerminalDockPassthrough } from './use-terminal-dock-passthrough'
import { useTerminalDockShortcutListener } from './use-terminal-dock-shortcut-listener'
import type { PtyTransportRecoveryState } from './pty-transport-types'

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
  setPaneDockMounted: (paneKey: string, mounted: boolean) => void
  exitPanePassthrough: (paneKey: string) => void
  /** Docks a recognized agent pane once, unless either persistence source has a decision. */
  ensurePaneDockDefault: (paneKey: string, agent: AgentType) => void
  /** The agent to render the dock with for this pane: `detectedAgent` when it's a live,
   *  recognized TUI agent; otherwise the last agent this pane was recognized as, but only
   *  while persisted-docked — so a status flap (reconnect, hook reconciliation) that clears
   *  live status without a confirmed exit can never unmount the composer. Falls back to the
   *  client-local latch when the in-memory one is empty (e.g. a renderer remount), so agent-
   *  status availability is never what decides whether a persisted dock renders. Null means
   *  render nothing, matching the caller's prior `!isTuiAgent(agent)` gate. */
  resolveDockAgent: (paneKey: string, detectedAgent: string | null) => AgentType | null
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

  const [mountedPaneKeys, setMountedPaneKeys] = useState<ReadonlySet<string>>(() => new Set())
  const { resolvedStateFor, hasLocalDockState, persistLocalDockState, forgetPane } =
    useTerminalDockLocalFallback()
  // Why: "ever echoed" is per-tab, not per-pane — a modern host's record simply omitting one
  // pane still means default (not local fallback) governs that pane, per resolveTerminalDockPaneState.
  const hostHasEverEchoed = terminalDockByPaneKey !== undefined
  const isPaneDocked = useCallback(
    (paneKey: string): boolean =>
      resolvedStateFor(paneKey, terminalDockByPaneKey?.[paneKey], hostHasEverEchoed).docked,
    [hostHasEverEchoed, resolvedStateFor, terminalDockByPaneKey]
  )
  const isPaneComposerMounted = useCallback(
    (paneKey: string): boolean => enabled && isPaneDocked(paneKey) && mountedPaneKeys.has(paneKey),
    [enabled, isPaneDocked, mountedPaneKeys]
  )
  const { agentForPane, noteDetectedAgent, resolveDockAgent, forgetPaneAgent } =
    useTerminalDockAgentLatch({ enabled, isPaneDocked })
  const passthrough = useTerminalDockPassthrough({
    enabled,
    tabId,
    managerRef,
    isPaneComposerMounted,
    agentForPane
  })
  const { isPanePassthrough, exitPanePassthrough } = passthrough
  const paneDockOwnsFocus = useCallback(
    (paneKey: string): boolean => isPaneComposerMounted(paneKey) && !isPanePassthrough(paneKey),
    [isPaneComposerMounted, isPanePassthrough]
  )
  const gutterRowsFor = useCallback(
    (paneKey: string): number =>
      resolvedStateFor(paneKey, terminalDockByPaneKey?.[paneKey], hostHasEverEchoed).gutterRows,
    [hostHasEverEchoed, resolvedStateFor, terminalDockByPaneKey]
  )
  const setPaneDockMounted = useCallback(
    (paneKey: string, mounted: boolean): void => {
      if (!mounted) {
        exitPanePassthrough(paneKey)
      }
      setMountedPaneKeys((previous) => {
        if (previous.has(paneKey) === mounted) {
          return previous
        }
        const next = new Set(previous)
        if (mounted) {
          next.add(paneKey)
        } else {
          next.delete(paneKey)
        }
        return next
      })
    },
    [exitPanePassthrough]
  )

  const resolveUnifiedTabId = useCallback((): string | null => {
    const state = useAppStore.getState()
    return (
      getCachedUnifiedTerminalTabForWorktree(state.unifiedTabsByWorktree, worktreeId, tabId)?.id ??
      null
    )
  }, [tabId, worktreeId])

  const ensurePaneDockDefault = useCallback(
    (paneKey: string, agent: AgentType): void => {
      noteDetectedAgent(paneKey, agent)
      // Local fallback only counts before the host has ever echoed — once it has, a stale
      // local entry for a pane the host record omits must not suppress the default.
      const hasPersistedDecision =
        Object.hasOwn(terminalDockByPaneKey ?? {}, paneKey) ||
        (!hostHasEverEchoed && hasLocalDockState(paneKey))
      if (!shouldDockTerminalComposerByDefault({ enabled, agent, hasPersistedDecision })) {
        return
      }
      const unifiedTabId = resolveUnifiedTabId()
      if (!unifiedTabId) {
        return
      }
      const gutterRows = gutterRowsFor(paneKey)
      setTabTerminalDockState(unifiedTabId, { paneKey, docked: true, gutterRows })
      persistLocalDockState(paneKey, { docked: true, gutterRows })
    },
    [
      enabled,
      gutterRowsFor,
      hasLocalDockState,
      hostHasEverEchoed,
      noteDetectedAgent,
      persistLocalDockState,
      resolveUnifiedTabId,
      setTabTerminalDockState,
      terminalDockByPaneKey
    ]
  )

  const commitGutterRows = useCallback(
    (paneKey: string, rows: number): void => {
      if (!enabled) {
        return
      }
      const unifiedTabId = resolveUnifiedTabId()
      if (!unifiedTabId) {
        return
      }
      setTabTerminalDockState(unifiedTabId, { paneKey, gutterRows: rows })
      persistLocalDockState(paneKey, { docked: isPaneDocked(paneKey), gutterRows: rows })
    },
    [enabled, isPaneDocked, persistLocalDockState, resolveUnifiedTabId, setTabTerminalDockState]
  )

  const toggleDockForFocusedPane = useCallback((): void => {
    if (!enabled) {
      return
    }
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
    if (!nextDocked) {
      exitPanePassthrough(paneKey)
    }
    setTabTerminalDockState(unifiedTabId, { paneKey, docked: nextDocked })
    persistLocalDockState(paneKey, { docked: nextDocked, gutterRows: gutterRowsFor(paneKey) })
    emitTerminalDockToggled({
      docked: nextDocked,
      agent:
        agentForPane(paneKey) ?? useAppStore.getState().agentStatusByPaneKey[paneKey]?.agentType
    })
  }, [
    agentForPane,
    enabled,
    exitPanePassthrough,
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
      exitPanePassthrough(paneKey)
      setTabTerminalDockState(unifiedTabId, { paneKey, docked: false })
      persistLocalDockState(paneKey, { docked: false, gutterRows: gutterRowsFor(paneKey) })
    },
    [
      enabled,
      exitPanePassthrough,
      gutterRowsFor,
      isPaneDocked,
      persistLocalDockState,
      resolveUnifiedTabId,
      setTabTerminalDockState,
      tabId
    ]
  )

  useTerminalDockShortcutListener({
    enabled,
    containerRef,
    toggleDock: toggleDockForFocusedPane,
    togglePassthrough: passthrough.togglePassthroughForFocusedPane
  })

  const disabledReasonFor = useTerminalDockDisabledReason({ enabled, tabId })

  const prunePassthroughForRetiredPane = useCallback(
    (leafId: string): void => {
      const paneKey = makePaneKey(tabId, leafId)
      forgetPaneAgent(paneKey)
      if (enabled) {
        forgetPane(paneKey)
      }
      setMountedPaneKeys((previous) => {
        if (!previous.has(paneKey)) {
          return previous
        }
        const next = new Set(previous)
        next.delete(paneKey)
        return next
      })
      passthrough.prunePassthroughForRetiredPane(leafId)
    },
    [enabled, forgetPane, forgetPaneAgent, passthrough, tabId]
  )

  return useMemo(
    () => ({
      isPaneDocked,
      paneDockOwnsFocus,
      gutterRowsFor,
      isPanePassthrough,
      setPaneDockMounted,
      exitPanePassthrough,
      ensurePaneDockDefault,
      resolveDockAgent,
      commitGutterRows,
      disabledReasonFor,
      undockOnConfirmedAgentExit,
      prunePassthroughForRetiredPane
    }),
    [
      commitGutterRows,
      disabledReasonFor,
      exitPanePassthrough,
      gutterRowsFor,
      isPaneDocked,
      isPanePassthrough,
      ensurePaneDockDefault,
      resolveDockAgent,
      paneDockOwnsFocus,
      prunePassthroughForRetiredPane,
      setPaneDockMounted,
      undockOnConfirmedAgentExit
    ]
  )
}
