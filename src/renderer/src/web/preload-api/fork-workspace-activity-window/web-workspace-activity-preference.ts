import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import { mergeWorkspaceActivityUI } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-ui'

export function normalizeWebWorkspaceActivity(
  base: PersistedUIState,
  updates: Partial<PersistedUIState>
) {
  const merged = mergeWorkspaceActivityUI(base, updates)
  return {
    ...merged,
    showSleepingWorkspaces: !merged.hideSleepingWorkspaces
  }
}
