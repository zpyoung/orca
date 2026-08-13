import { useAppStore } from '@/store'

type EnsurePipelineTabOptions = {
  targetGroupId?: string
  /** When true, activate the tab and focus the owning group (default true). */
  surfacePane?: boolean
}

type PipelineRunTabInfo = {
  runId: string
  runNumber: number
  templateName: string
}

type ExistingPipelineTab = {
  id: string
  groupId: string
}

export function getPipelineTabForRun(
  worktreeId: string,
  runId: string
): ExistingPipelineTab | null {
  return (
    (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'pipeline' && tab.entityId === runId
    ) ?? null
  )
}

function resolveGroupIdForPipelineTab(worktreeId: string, targetGroupId?: string): string | null {
  const store = useAppStore.getState()
  return (
    targetGroupId ??
    store.activeGroupIdByWorktree[worktreeId] ??
    store.groupsByWorktree[worktreeId]?.[0]?.id ??
    null
  )
}

/** True when `worktreeId` currently has a tab group to host a pipeline canvas — false for a workspace that no longer exists (e.g. a deleted one named by stale run history). */
export function canEnsurePipelineTab(worktreeId: string): boolean {
  return resolveGroupIdForPipelineTab(worktreeId) !== null
}

/** One pipeline tab per run id; focuses the existing tab for a run instead of duplicating it. */
export function ensurePipelineTab(
  worktreeId: string,
  run: PipelineRunTabInfo,
  options?: EnsurePipelineTabOptions
): string | null {
  const store = useAppStore.getState()
  // the caller always knows the run's owning workspace (it's the start flow or a
  // history reopen) — seed it now so a canvas mounted from this call never has to
  // guess its host from a pipelineRunsById entry that hasn't hydrated yet.
  store.seedPipelineRunWorkspace({
    runId: run.runId,
    workspaceId: worktreeId,
    templateName: run.templateName,
    runNumber: run.runNumber
  })
  const sourceGroupId = resolveGroupIdForPipelineTab(worktreeId, options?.targetGroupId)
  if (!sourceGroupId) {
    return null
  }

  const existing = getPipelineTabForRun(worktreeId, run.runId)
  const shouldSurface = options?.surfacePane ?? true
  if (existing) {
    if (shouldSurface && store.activeWorktreeId === worktreeId) {
      store.activateTab(existing.id)
      store.focusGroup(worktreeId, existing.groupId)
    }
    return existing.id
  }

  const tab = store.createUnifiedTab(worktreeId, 'pipeline', {
    entityId: run.runId,
    label: `${run.templateName} #${run.runNumber}`,
    targetGroupId: sourceGroupId,
    activate: shouldSurface
  })
  if (shouldSurface) {
    store.activateTab(tab.id)
    store.focusGroup(worktreeId, tab.groupId)
  }
  return tab.id
}
