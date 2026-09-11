import type { Worktree } from '../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type { WorkspaceActivityFilterContext } from './workspace-activity-filter'

type ActivityVisibilityOptions = {
  workspaceActivity?: WorkspaceActivityFilterContext
  showSleepingWorkspaces: boolean
}

export function computeActivityVisibility<Options extends ActivityVisibilityOptions>(
  options: Options,
  compute: (options: Options) => Worktree[]
): { worktrees: Worktree[]; activityHiddenCount: number } {
  const worktrees = compute(options)
  const context = options.workspaceActivity
  if (!context || context.workspaceActivityWindow === 'all') {
    return { worktrees, activityHiddenCount: 0 }
  }
  const baseline = compute({
    ...options,
    workspaceActivity: undefined,
    showSleepingWorkspaces: true
  })
  const visible = new Set(worktrees.map(getWorktreeHostIdentity))
  const activityHiddenCount = baseline.reduce(
    (count, worktree) => count + (visible.has(getWorktreeHostIdentity(worktree)) ? 0 : 1),
    0
  )
  return { worktrees, activityHiddenCount }
}
