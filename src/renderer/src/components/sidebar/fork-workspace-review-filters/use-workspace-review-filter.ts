import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { WorkspaceReviewFilterContext } from './workspace-review-filter'
import { getWorkspaceReviewFilterContext } from './workspace-review-filter-context'

export { getWorkspaceReviewFilterContext } from './workspace-review-filter-context'

export function useWorkspaceReviewFilter(): WorkspaceReviewFilterContext {
  return useAppStore(useShallow((state) => getWorkspaceReviewFilterContext(state)))
}
