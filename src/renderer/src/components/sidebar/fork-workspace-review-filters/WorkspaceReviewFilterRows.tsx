import { CheckCheck, GitMerge } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { FilterToggleRow } from '../FilterToggleRow'

export function WorkspaceReviewFilterRows() {
  const hideCompleted = useAppStore((state) => state.hideCompletedReviewWorkspaces)
  const setHideCompleted = useAppStore((state) => state.setHideCompletedReviewWorkspaces)
  const hidePassing = useAppStore((state) => state.hidePassingCheckWorkspaces)
  const setHidePassing = useAppStore((state) => state.setHidePassingCheckWorkspaces)

  return (
    <>
      <FilterToggleRow
        icon={<GitMerge className="size-3.5" />}
        label={translate(
          'auto.components.sidebar.WorkspaceReviewFilterRows.hideCompleted',
          'Hide merged/closed reviews'
        )}
        checked={hideCompleted}
        onChange={setHideCompleted}
      />
      <FilterToggleRow
        icon={<CheckCheck className="size-3.5" />}
        label={translate(
          'auto.components.sidebar.WorkspaceReviewFilterRows.hidePassing',
          'Hide passing checks'
        )}
        checked={hidePassing}
        onChange={setHidePassing}
      />
    </>
  )
}
