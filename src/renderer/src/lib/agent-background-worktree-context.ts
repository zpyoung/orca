import { useAppStore } from '@/store'
import type { AppState } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'

/** Resolve the renderer-owned workspace context required for a background agent launch. */
export function resolveAgentBackgroundWorktreeContext(worktreeId: string): {
  store: AppState
  worktree: Worktree
  repo: Repo | null
} {
  const store = useAppStore.getState()
  // Folder workspaces exist only in getKnownWorktreeById (#2989).
  const worktree = store.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  return {
    store,
    worktree,
    repo: store.repos.find((entry) => entry.id === worktree.repoId) ?? null
  }
}
