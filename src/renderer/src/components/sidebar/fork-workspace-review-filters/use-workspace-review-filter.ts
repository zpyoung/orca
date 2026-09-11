import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { WorkspaceReviewFilterContext } from './workspace-review-filter'

export function getWorkspaceReviewFilterContext(state: AppState): WorkspaceReviewFilterContext {
  const hideCompletedReviewWorkspaces = state.hideCompletedReviewWorkspaces
  const hidePassingCheckWorkspaces = state.hidePassingCheckWorkspaces
  const active = hideCompletedReviewWorkspaces || hidePassingCheckWorkspaces
  return {
    hideCompletedReviewWorkspaces,
    hidePassingCheckWorkspaces,
    prCache: active ? state.prCache : null,
    hostedReviewCache: active ? state.hostedReviewCache : null,
    activeRuntimeEnvironmentId: state.settings?.activeRuntimeEnvironmentId ?? null
  }
}

export function useWorkspaceReviewFilter(): WorkspaceReviewFilterContext {
  return useAppStore(useShallow((state) => getWorkspaceReviewFilterContext(state)))
}
