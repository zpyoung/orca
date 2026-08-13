import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { activateAndRevealWorktree } from './worktree-activation'

export type PipelineTabPaletteActivationFailure = 'missing-tab' | 'missing-worktree'

export type PipelineTabPaletteActivationResult =
  | { status: 'activated'; tabId: string }
  | { status: 'failed'; reason: PipelineTabPaletteActivationFailure }

export type PipelineTabPaletteActivationTarget = {
  executionHostId?: ExecutionHostId
  tabId: string
  worktreeId: string
}

export function activatePipelineTabPaletteResult({
  executionHostId,
  tabId,
  worktreeId
}: PipelineTabPaletteActivationTarget): PipelineTabPaletteActivationResult {
  const initialState = useAppStore.getState()
  const tab = (initialState.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === tabId && candidate.contentType === 'pipeline'
  )
  if (!tab) {
    return { status: 'failed', reason: 'missing-tab' }
  }

  const worktree = initialState.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  const targetHostId = executionHostId ?? worktree.hostId
  const activated = activateAndRevealWorktree(
    worktree.id,
    targetHostId ? { executionHostId: targetHostId } : {}
  )
  if (!activated) {
    return { status: 'failed', reason: 'missing-worktree' }
  }

  const state = useAppStore.getState()
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id)
  state.activatePipelineTabSurface(worktreeId)
  return { status: 'activated', tabId: tab.id }
}
