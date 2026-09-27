import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useNow } from '@/hooks/use-now'
import { getActiveSidebarWorkspaceId } from '../../../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import {
  workspaceActivityWindowDays,
  type WorkspaceActivityFilterContext
} from './workspace-activity-filter'
import { hydrateWorkspaceActivityWindow } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'

export type { WorkspaceActivityFilterContext } from './workspace-activity-filter'

type WorkspaceActivityFilterInputs = Omit<WorkspaceActivityFilterContext, 'now'>

// Why: a time-based window must age workspaces out on a quiet sidebar, so the
// cutoff re-evaluates on the shared minute clock instead of waiting for store traffic.
export const WORKSPACE_ACTIVITY_CUTOFF_TICK_MS = 60_000

function selectWorkspaceActivityFilterInputs(state: AppState): WorkspaceActivityFilterInputs {
  const hydrated = hydrateWorkspaceActivityWindow(state)
  return {
    workspaceActivityWindow: hydrated.workspaceActivityWindow,
    workspaceActivityCustomDays: hydrated.workspaceActivityCustomDays,
    lastVisitedAtByWorktreeId: state.lastVisitedAtByWorktreeId,
    workspaceActivityExitStamps: state.workspaceActivityExitStamps,
    selectedWorkspaceId: getActiveSidebarWorkspaceId(
      state.activeWorkspaceKey,
      state.activeWorktreeId
    ),
    selectedHostId: state.activeWorkspaceExecutionHostId ?? null
  }
}

/** Pure snapshot for non-hook callers; every call reads the clock and the given state afresh. */
export function getWorkspaceActivityFilterContext(state: AppState): WorkspaceActivityFilterContext {
  return { ...selectWorkspaceActivityFilterInputs(state), now: Date.now() }
}

/**
 * Referentially stable activity context for the sidebar visibility memos: it changes only when
 * one of its inputs changes or, for a time-based window, when the cutoff clock ticks.
 */
export function useWorkspaceActivityFilter(): WorkspaceActivityFilterContext {
  const inputs = useAppStore(useShallow(selectWorkspaceActivityFilterInputs))
  const timeBased =
    workspaceActivityWindowDays(
      inputs.workspaceActivityWindow,
      inputs.workspaceActivityCustomDays
    ) !== null
  const tick = useNow(WORKSPACE_ACTIVITY_CUTOFF_TICK_MS, timeBased)
  // Why: `now` only feeds a cutoff, so a window without one pins it and stays identity-stable
  // across the shared clock's unrelated ticks. The clock catches up one frame after enabling.
  const now = timeBased ? tick : 0
  return useMemo(() => ({ ...inputs, now }), [inputs, now])
}
