import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { WatcherWorker } from '../../../shared/fork-heimdall/fleet-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'

export type HeimdallWorkerNavigation = NonNullable<WatcherWorker['navigation']>

export function canOpenHeimdallWorker(
  navigation: WatcherWorker['navigation']
): navigation is HeimdallWorkerNavigation {
  if (!navigation) {
    return false
  }
  return parsePaneKey(navigation.paneKey) !== null
}

export function resolveHeimdallWorkerNavigation(
  navigation: WatcherWorker['navigation'],
  ownerConnectionId: string | null
): HeimdallWorkerNavigation | null {
  if (!canOpenHeimdallWorker(navigation)) {
    return null
  }
  if (ownerConnectionId === null) {
    return navigation
  }
  if (navigation.executionHostId !== 'local') {
    return null
  }
  return {
    ...navigation,
    executionHostId: toRuntimeExecutionHostId(ownerConnectionId)
  }
}

export function openHeimdallWorker(navigation: HeimdallWorkerNavigation): boolean {
  const pane = parsePaneKey(navigation.paneKey)
  if (!pane) {
    return false
  }
  const activated = activateAndRevealWorkspace(navigation.worktreeId, {
    executionHostId: navigation.executionHostId,
    providesInitialSurface: true
  })
  if (activated === false) {
    return false
  }
  const terminalTab = (useAppStore.getState().tabsByWorktree[navigation.worktreeId] ?? []).some(
    (tab) => tab.id === pane.tabId
  )
  if (terminalTab) {
    activateTabAndFocusPane(pane.tabId, pane.leafId, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    return true
  }
  return activateStructuredAgentSessionTab({
    worktreeId: navigation.worktreeId,
    tabId: pane.tabId
  })
}
