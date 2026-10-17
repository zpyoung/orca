import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { LoopWorktreeSummary } from '../../../src/shared/fork-loops/loop-types'
import type { Worktree } from './workspace-list-sections'

type WorktreeWithLoop = Worktree & { loop?: LoopWorktreeSummary }

export function areWorktreeListsEqual(
  left: readonly Worktree[],
  right: readonly Worktree[]
): boolean {
  if (left === right) {
    return true
  }
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    if (!areWorktreesEqual(left[index]!, right[index]!)) {
      return false
    }
  }
  return true
}

function areWorktreesEqual(left: WorktreeWithLoop, right: WorktreeWithLoop): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.repoId === right.repoId &&
    left.repo === right.repo &&
    left.branch === right.branch &&
    (left.hostId ?? null) === (right.hostId ?? null) &&
    (left.terminalPlatform ?? null) === (right.terminalPlatform ?? null) &&
    left.displayName === right.displayName &&
    (left.workspaceStatus ?? null) === (right.workspaceStatus ?? null) &&
    (left.sortOrder ?? null) === (right.sortOrder ?? null) &&
    (left.manualOrder ?? null) === (right.manualOrder ?? null) &&
    (left.lastActivityAt ?? null) === (right.lastActivityAt ?? null) &&
    (left.createdAt ?? null) === (right.createdAt ?? null) &&
    left.path === right.path &&
    (left.isArchived ?? false) === (right.isArchived ?? false) &&
    (left.isMainWorktree ?? false) === (right.isMainWorktree ?? false) &&
    (left.hasHostSidebarActivity ?? false) === (right.hasHostSidebarActivity ?? false) &&
    (left.worktreeInstanceId ?? null) === (right.worktreeInstanceId ?? null) &&
    (left.lineageWorktreeInstanceId ?? null) === (right.lineageWorktreeInstanceId ?? null) &&
    (left.parentWorktreeInstanceId ?? null) === (right.parentWorktreeInstanceId ?? null) &&
    (left.parentWorktreeId ?? null) === (right.parentWorktreeId ?? null) &&
    areStringArraysEqual(left.childWorktreeIds ?? [], right.childWorktreeIds ?? []) &&
    left.liveTerminalCount === right.liveTerminalCount &&
    left.hasAttachedPty === right.hasAttachedPty &&
    left.preview === right.preview &&
    left.unread === right.unread &&
    (left.lastOutputAt ?? null) === (right.lastOutputAt ?? null) &&
    left.isPinned === right.isPinned &&
    (left.isActive ?? false) === (right.isActive ?? false) &&
    (left.linkedIssue ?? null) === (right.linkedIssue ?? null) &&
    (left.linkedLinearIssue ?? null) === (right.linkedLinearIssue ?? null) &&
    (left.linkedGitLabMR ?? null) === (right.linkedGitLabMR ?? null) &&
    (left.linkedGitLabIssue ?? null) === (right.linkedGitLabIssue ?? null) &&
    (left.comment ?? '') === (right.comment ?? '') &&
    (left.status ?? null) === (right.status ?? null) &&
    (left.workingMode ?? null) === (right.workingMode ?? null) &&
    arePullRequestsEqual(left.linkedPR, right.linkedPR) &&
    areAgentRowsEqual(left.agents ?? [], right.agents ?? []) &&
    areLoopSummariesEqual(left.loop, right.loop)
  )
}

function areLoopSummariesEqual(
  left: LoopWorktreeSummary | undefined,
  right: LoopWorktreeSummary | undefined
): boolean {
  if (!left || !right) {
    return left === right
  }
  return (
    left.loopCount === right.loopCount &&
    left.primary.id === right.primary.id &&
    left.primary.state === right.primary.state &&
    left.primary.pauseReason === right.primary.pauseReason &&
    left.primary.iterationsCompleted === right.primary.iterationsCompleted &&
    left.primary.maxIterations === right.primary.maxIterations
  )
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) {
    return true
  }
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

function arePullRequestsEqual(left: Worktree['linkedPR'], right: Worktree['linkedPR']): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right) {
    return false
  }
  return left.number === right.number && left.state === right.state
}

function areAgentRowsEqual(
  left: readonly RuntimeWorktreeAgentRow[],
  right: readonly RuntimeWorktreeAgentRow[]
): boolean {
  if (left === right) {
    return true
  }
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (
      a.paneKey !== b.paneKey ||
      a.parentPaneKey !== b.parentPaneKey ||
      a.state !== b.state ||
      a.workingMode !== b.workingMode ||
      a.agentType !== b.agentType ||
      a.prompt !== b.prompt ||
      a.lastAssistantMessage !== b.lastAssistantMessage ||
      a.toolName !== b.toolName ||
      a.toolInput !== b.toolInput ||
      a.interrupted !== b.interrupted ||
      !areMainAgentsEqual(a.mainAgent, b.mainAgent) ||
      a.stateStartedAt !== b.stateStartedAt ||
      a.updatedAt !== b.updatedAt
    ) {
      return false
    }
  }
  return true
}

function areMainAgentsEqual(
  left: RuntimeWorktreeAgentRow['mainAgent'],
  right: RuntimeWorktreeAgentRow['mainAgent']
): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right) {
    return false
  }
  return (
    left.state === right.state &&
    left.outcome === right.outcome &&
    left.stateStartedAt === right.stateStartedAt &&
    left.stopping === right.stopping
  )
}
