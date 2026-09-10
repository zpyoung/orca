import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { WorkspaceActivityWindow } from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'
import {
  DEFAULT_WORKSPACE_ACTIVITY_CUSTOM_DAYS,
  isValidWorkspaceActivityCustomDays,
  isWorkspaceActivityWindow
} from '../../../../../shared/fork-workspace-activity-window/workspace-activity-window'
import { getWorktreeVisitKey, getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'

export type WorkspaceActivityWindowSlice = {
  workspaceActivityWindow: WorkspaceActivityWindow
  setWorkspaceActivityWindow: (window: WorkspaceActivityWindow) => void
  workspaceActivityCustomDays: number
  setWorkspaceActivityCustomDays: (days: number) => void
  showSleepingWorkspaces: boolean
  setShowSleepingWorkspaces: (show: boolean) => void
  /** Window to return to when the sleeping-workspaces toggle leaves `live-only`. */
  workspaceActivityWindowBeforeLiveOnly: WorkspaceActivityWindow
  /**
   * When each workspace was last left, keyed like the focus-recency map. Session-only, and
   * deliberately separate from `lastVisitedAtByWorktreeId`, whose contract is user-initiated
   * activations only — stamping a departure there would invert Cmd+J's recency ordering.
   */
  workspaceActivityExitStamps: Readonly<Record<string, number>>
  markWorkspaceActivityExit: (
    workspaceId: string,
    hostId?: ExecutionHostId,
    exitedAt?: number
  ) => void
}

type SetAppState = Parameters<StateCreator<AppState, [], [], WorkspaceActivityWindowSlice>>[0]

// The sleeping toggle is two states over a six-value window, so the outgoing window is
// remembered — otherwise leaving live-only lands on 'all' and the selection is destroyed.
function enterLiveOnly(current: WorkspaceActivityWindow): Partial<WorkspaceActivityWindowSlice> {
  return {
    workspaceActivityWindow: 'live-only',
    showSleepingWorkspaces: false,
    ...(current === 'live-only' ? {} : { workspaceActivityWindowBeforeLiveOnly: current })
  }
}

export const createWorkspaceActivityWindowSlice = (
  set: SetAppState
): WorkspaceActivityWindowSlice => ({
  workspaceActivityWindow: 'all',
  workspaceActivityWindowBeforeLiveOnly: 'all',
  setWorkspaceActivityWindow: (window) => {
    if (!isWorkspaceActivityWindow(window)) {
      return
    }
    set((s) =>
      window === 'live-only'
        ? enterLiveOnly(s.workspaceActivityWindow)
        : { workspaceActivityWindow: window, showSleepingWorkspaces: true }
    )
  },
  workspaceActivityCustomDays: DEFAULT_WORKSPACE_ACTIVITY_CUSTOM_DAYS,
  setWorkspaceActivityCustomDays: (days) => {
    if (!isValidWorkspaceActivityCustomDays(days)) {
      return
    }
    set({ workspaceActivityCustomDays: days })
  },
  showSleepingWorkspaces: true,
  setShowSleepingWorkspaces: (show) => {
    if (typeof show !== 'boolean') {
      return
    }
    set((s) => {
      if (!show) {
        return enterLiveOnly(s.workspaceActivityWindow)
      }
      return {
        workspaceActivityWindow:
          s.workspaceActivityWindow === 'live-only'
            ? s.workspaceActivityWindowBeforeLiveOnly
            : s.workspaceActivityWindow,
        showSleepingWorkspaces: true
      }
    })
  },
  workspaceActivityExitStamps: {},
  markWorkspaceActivityExit: (workspaceId, hostId, exitedAt) => {
    set((s) => {
      const now = exitedAt ?? Date.now()
      const previous =
        getWorktreeVisitTimestamp(s.workspaceActivityExitStamps, { id: workspaceId, hostId }) ?? 0
      if (!(now > previous)) {
        return {}
      }
      return {
        workspaceActivityExitStamps: {
          ...s.workspaceActivityExitStamps,
          [getWorktreeVisitKey(workspaceId, hostId)]: now
        }
      }
    })
  }
})
