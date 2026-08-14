import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { getCachedUnifiedTerminalTabForWorktree } from './terminal-unified-tab-lookup'
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
  gutterRowsFor: (paneKey: string) => number | undefined
  isPanePassthrough: (paneKey: string) => boolean
  commitGutterRows: (paneKey: string, rows: number) => void
  disabledReasonFor: (args: {
    paneKey: string
    targetPtyId: string | null
    recoveryPhase: PtyTransportRecoveryState['phase'] | null
  }) => string | null
  /** Wire into the confirmed-agent-exit signal (onAgentExitedRef) alongside any existing
   *  consumer — undocks a pane whose agent just confirmed exit, same as the passthrough
   *  auto-exit, this never touches panes that were never docked. */
  undockOnConfirmedAgentExit: (leafId: string) => void
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
  // Why: quarantine can arm/clear between renders with no store write to react to.
  const [, forceQuarantineRerender] = useState(0)

  const isPaneDocked = useCallback(
    (paneKey: string): boolean => terminalDockByPaneKey?.[paneKey]?.docked === true,
    [terminalDockByPaneKey]
  )
  const paneDockOwnsFocus = useCallback(
    (paneKey: string): boolean => enabled && isPaneDocked(paneKey),
    [enabled, isPaneDocked]
  )
  const gutterRowsFor = useCallback(
    (paneKey: string): number | undefined => terminalDockByPaneKey?.[paneKey]?.gutterRows,
    [terminalDockByPaneKey]
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
    },
    [resolveUnifiedTabId, setTabTerminalDockState]
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
    setTabTerminalDockState(unifiedTabId, { paneKey, docked: !isPaneDocked(paneKey) })
  }, [isPaneDocked, managerRef, resolveUnifiedTabId, setTabTerminalDockState, tabId])

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
    },
    [enabled, isPaneDocked, resolveUnifiedTabId, setTabTerminalDockState, tabId]
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
      } else {
        next.add(paneKey)
        // Why: passthrough exists so the raw terminal (not the composer) receives keys.
        activePane.terminal.focus()
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
      const keybindings = useAppStore.getState().settings?.keybindings
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
    }): string | null => {
      const parsed = parsePaneKey(disabledArgs.paneKey)
      return resolveTerminalDockDisabledReason({
        targetPtyId: disabledArgs.targetPtyId,
        recoveryPhase: disabledArgs.recoveryPhase,
        quarantined: parsed ? isTerminalInputQuarantined(parsed.tabId) : false
      })
    },
    []
  )

  // Why: passthrough auto-exit follows live agent status (not the confirmed-exit signal
  // dock undock uses), so it's a raw subscription over the currently-passthrough panes only
  // — never a full-record selector, which would re-render this component on any pane's status
  // change anywhere in the app.
  const previousAgentStatesRef = useRef<Map<string, AgentStatusState | null>>(new Map())
  useEffect(() => {
    if (!enabled) {
      return undefined
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

  return useMemo(
    () => ({
      isPaneDocked,
      paneDockOwnsFocus,
      gutterRowsFor,
      isPanePassthrough,
      commitGutterRows,
      disabledReasonFor,
      undockOnConfirmedAgentExit
    }),
    [
      commitGutterRows,
      disabledReasonFor,
      gutterRowsFor,
      isPaneDocked,
      isPanePassthrough,
      paneDockOwnsFocus,
      undockOnConfirmedAgentExit
    ]
  )
}
