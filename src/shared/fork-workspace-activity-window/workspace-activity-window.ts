export type WorkspaceActivityWindow = 'all' | 'live-only' | 'today' | 'week' | 'month' | 'custom'

export type WorkspaceActivityWindowState = {
  workspaceActivityWindow: WorkspaceActivityWindow
  workspaceActivityCustomDays: number
}

export type PersistedWorkspaceActivityWindowState = {
  workspaceActivityWindow?: WorkspaceActivityWindow
  workspaceActivityCustomDays?: number
}

export const DEFAULT_WORKSPACE_ACTIVITY_CUSTOM_DAYS = 30
export const WORKSPACE_ACTIVITY_WRITE_BASELINE_SAMPLE = {
  workspaceActivityWindow: 'all' as WorkspaceActivityWindow,
  workspaceActivityCustomDays: DEFAULT_WORKSPACE_ACTIVITY_CUSTOM_DAYS
}

export function isValidWorkspaceActivityCustomDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isWorkspaceActivityWindow(value: unknown): value is WorkspaceActivityWindow {
  return (
    value === 'all' ||
    value === 'live-only' ||
    value === 'today' ||
    value === 'week' ||
    value === 'month' ||
    value === 'custom'
  )
}

export function hydrateWorkspaceActivityWindow(ui: {
  workspaceActivityWindow?: unknown
  workspaceActivityCustomDays?: unknown
  hideSleepingWorkspaces?: unknown
  showSleepingWorkspaces?: unknown
  showInactiveWorkspaces?: unknown
}): WorkspaceActivityWindowState & { showSleepingWorkspaces: boolean } {
  // Why: ignore older positive-form keys so old profiles start from the new default (sleeping workspaces visible).
  const window = isWorkspaceActivityWindow(ui.workspaceActivityWindow)
    ? ui.workspaceActivityWindow
    : ui.hideSleepingWorkspaces === true
      ? 'live-only'
      : 'all'

  const workspaceActivityCustomDays = isValidWorkspaceActivityCustomDays(
    ui.workspaceActivityCustomDays
  )
    ? ui.workspaceActivityCustomDays
    : DEFAULT_WORKSPACE_ACTIVITY_CUSTOM_DAYS

  return {
    workspaceActivityWindow: window,
    workspaceActivityCustomDays,
    showSleepingWorkspaces: window !== 'live-only'
  }
}
