import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'

export type WorkspaceReviewFiltersSlice = {
  hideCompletedReviewWorkspaces: boolean
  setHideCompletedReviewWorkspaces: (hidden: boolean) => void
  hidePassingCheckWorkspaces: boolean
  setHidePassingCheckWorkspaces: (hidden: boolean) => void
}

type SetAppState = Parameters<StateCreator<AppState, [], [], WorkspaceReviewFiltersSlice>>[0]

export const createWorkspaceReviewFiltersSlice = (
  set: SetAppState
): WorkspaceReviewFiltersSlice => ({
  hideCompletedReviewWorkspaces: false,
  setHideCompletedReviewWorkspaces: (hidden) => {
    if (typeof hidden !== 'boolean') {
      return
    }
    set({ hideCompletedReviewWorkspaces: hidden })
  },
  hidePassingCheckWorkspaces: false,
  setHidePassingCheckWorkspaces: (hidden) => {
    if (typeof hidden !== 'boolean') {
      return
    }
    set({ hidePassingCheckWorkspaces: hidden })
  }
})
