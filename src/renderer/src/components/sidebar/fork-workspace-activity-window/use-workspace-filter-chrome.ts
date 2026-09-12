import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { WorkspaceActivityWindow } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'
import { getForkClearFilterActions, getForkFilterCount } from './workspace-filter-chrome'

export type WorkspaceFilterChrome = {
  state: {
    workspaceActivityWindow: WorkspaceActivityWindow
    workspaceActivityCustomDays: number
    hideCompletedReviewWorkspaces: boolean
    hidePassingCheckWorkspaces: boolean
  }
  clearFilters: () => void
  activeCount: number
}

export function useWorkspaceFilterChrome(): WorkspaceFilterChrome {
  const workspaceActivityWindow = useAppStore((s) => s.workspaceActivityWindow)
  const workspaceActivityCustomDays = useAppStore((s) => s.workspaceActivityCustomDays)
  const hideCompletedReviewWorkspaces = useAppStore((s) => s.hideCompletedReviewWorkspaces)
  const hidePassingCheckWorkspaces = useAppStore((s) => s.hidePassingCheckWorkspaces)
  const setWorkspaceActivityWindow = useAppStore((s) => s.setWorkspaceActivityWindow)
  const setHideCompletedReviewWorkspaces = useAppStore((s) => s.setHideCompletedReviewWorkspaces)
  const setHidePassingCheckWorkspaces = useAppStore((s) => s.setHidePassingCheckWorkspaces)

  const state = useMemo(
    () => ({
      workspaceActivityWindow,
      workspaceActivityCustomDays,
      hideCompletedReviewWorkspaces,
      hidePassingCheckWorkspaces
    }),
    [
      workspaceActivityWindow,
      workspaceActivityCustomDays,
      hideCompletedReviewWorkspaces,
      hidePassingCheckWorkspaces
    ]
  )
  const clearFilters = useCallback(() => {
    const actions = getForkClearFilterActions(state)
    if (actions.resetWorkspaceActivityWindow) {
      setWorkspaceActivityWindow('all')
    }
    if (actions.resetHideCompletedReviewWorkspaces) {
      setHideCompletedReviewWorkspaces(false)
    }
    if (actions.resetHidePassingCheckWorkspaces) {
      setHidePassingCheckWorkspaces(false)
    }
  }, [
    state,
    setWorkspaceActivityWindow,
    setHideCompletedReviewWorkspaces,
    setHidePassingCheckWorkspaces
  ])

  return { state, clearFilters, activeCount: getForkFilterCount(state) }
}
