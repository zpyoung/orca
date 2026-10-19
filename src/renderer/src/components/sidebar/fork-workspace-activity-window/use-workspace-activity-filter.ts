import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useNow } from '@/hooks/use-now'
import {
  workspaceActivityWindowDays,
  type WorkspaceActivityFilterContext
} from './workspace-activity-filter'
import { selectWorkspaceActivityFilterInputs } from './workspace-activity-filter-context'

export type { WorkspaceActivityFilterContext } from './workspace-activity-filter'
export { getWorkspaceActivityFilterContext } from './workspace-activity-filter-context'

// Why: a time-based window must age workspaces out on a quiet sidebar, so the
// cutoff re-evaluates on the shared minute clock instead of waiting for store traffic.
export const WORKSPACE_ACTIVITY_CUTOFF_TICK_MS = 60_000

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
