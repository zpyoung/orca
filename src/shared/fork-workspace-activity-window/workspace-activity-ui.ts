import {
  hydrateWorkspaceActivityWindow,
  isValidWorkspaceActivityCustomDays,
  isWorkspaceActivityWindow,
  type WorkspaceActivityWindow
} from './workspace-activity-window'

export type WorkspaceActivityUIInput = {
  workspaceActivityWindow?: unknown
  workspaceActivityCustomDays?: unknown
  hideSleepingWorkspaces?: unknown
  showSleepingWorkspaces?: unknown
  showInactiveWorkspaces?: unknown
}

export type NormalizedWorkspaceActivityUI = {
  workspaceActivityWindow: WorkspaceActivityWindow
  workspaceActivityCustomDays: number
  hideSleepingWorkspaces: boolean
}

export function normalizeWorkspaceActivityUI(
  input: WorkspaceActivityUIInput | null | undefined
): NormalizedWorkspaceActivityUI {
  const hydrated = hydrateWorkspaceActivityWindow(input ?? {})
  return {
    workspaceActivityWindow: hydrated.workspaceActivityWindow,
    workspaceActivityCustomDays: hydrated.workspaceActivityCustomDays,
    hideSleepingWorkspaces: hydrated.showSleepingWorkspaces === false
  }
}

function resolveActivityWindow(
  previousWindow: WorkspaceActivityWindow,
  explicitWindow: WorkspaceActivityWindow | undefined,
  legacyHideSleeping: boolean | undefined
): WorkspaceActivityWindow {
  if (explicitWindow !== undefined) {
    return explicitWindow
  }
  if (legacyHideSleeping === true) {
    return 'live-only'
  }
  // a bare "show sleeping" only lifts live-only: every time window already shows them, so
  // widening to 'all' would let one legacy client erase another client's window selection.
  if (legacyHideSleeping === false) {
    return previousWindow === 'live-only' ? 'all' : previousWindow
  }
  return previousWindow
}

export function mergeWorkspaceActivityUI(
  current: WorkspaceActivityUIInput | null | undefined,
  updates: WorkspaceActivityUIInput
): NormalizedWorkspaceActivityUI {
  const previous = normalizeWorkspaceActivityUI(current)
  const explicitWindow = isWorkspaceActivityWindow(updates.workspaceActivityWindow)
    ? updates.workspaceActivityWindow
    : undefined
  const legacyActivityValue =
    typeof updates.hideSleepingWorkspaces === 'boolean'
      ? updates.hideSleepingWorkspaces
      : typeof updates.showSleepingWorkspaces === 'boolean'
        ? !updates.showSleepingWorkspaces
        : typeof updates.showInactiveWorkspaces === 'boolean'
          ? !updates.showInactiveWorkspaces
          : undefined
  const workspaceActivityWindow = resolveActivityWindow(
    previous.workspaceActivityWindow,
    explicitWindow,
    legacyActivityValue
  )
  const workspaceActivityCustomDays = isValidWorkspaceActivityCustomDays(
    updates.workspaceActivityCustomDays
  )
    ? updates.workspaceActivityCustomDays
    : previous.workspaceActivityCustomDays
  return {
    workspaceActivityWindow,
    workspaceActivityCustomDays,
    hideSleepingWorkspaces: workspaceActivityWindow === 'live-only'
  }
}
