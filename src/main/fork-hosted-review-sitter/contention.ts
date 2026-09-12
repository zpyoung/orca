import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimePathsEqual } from '../runtime/runtime-worktree-path-identity'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalListResult
} from '../../shared/runtime-terminal-contracts'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import { hostScopeCensusIsComplete } from '../../shared/runtime-listing-host-scope'
import type {
  HostedReviewSitterContention,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import { resolveHostedReviewSitterGitExecution } from './provider-git'

const CONTENTION_TERMINAL_LIMIT = 1_000
const SITTER_AGENT_TITLE_PREFIX = 'PR Sitter agent · '

export function buildHostedReviewSitterAgentTitle(sitterId: string, actionId: string): string {
  return `${SITTER_AGENT_TITLE_PREFIX}${sitterId} · ${actionId}`
}
export type HostedReviewSitterOwnedSession =
  | { state: 'absent' }
  | { state: 'active'; sessionId: string }
  | { state: 'stoppable'; sessionId: string }
  | { state: 'unverifiable'; reason: string }

function sitterActionIdFromTitle(title: string | null, sitterId: string): string | null {
  const prefix = `${SITTER_AGENT_TITLE_PREFIX}${sitterId} · `
  return title?.startsWith(prefix) && title.length > prefix.length
    ? title.slice(prefix.length)
    : null
}

function isProvenExitCause(cause: TerminalExitCause | undefined): boolean {
  return cause?.kind === 'operator_close' || cause?.kind === 'signaled' || cause?.kind === 'exited'
}

/**
 * Reads contention only from the execution host that owns the explicit workspace. An empty or
 * incomplete host answer is unknown, never proof that a terminal or agent disappeared.
 */
export async function inspectHostedReviewSitterContention(
  runtime: OrcaRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  ownActionId?: string,
  requirements: {
    requireOwnSession?: boolean
    requireOwnIdle?: boolean
    allowDirtyAfterOwnedSessionStopped?: boolean
    reportOwnLiveSession?: boolean
  } = {}
): Promise<HostedReviewSitterContention> {
  if (!definition.repoId || !definition.worktreeId || !definition.repoPath) {
    return { state: 'unverifiable', reason: 'explicit-repository-context-required' }
  }
  if (!store.getRepo(definition.repoId)) {
    return { state: 'unverifiable', reason: 'repository-context-missing' }
  }
  try {
    const workspace = await runtime.showManagedWorktree(`id:${definition.worktreeId}`)
    if (
      workspace.repoId !== definition.repoId ||
      !runtimePathsEqual(workspace.git.path, definition.repoPath)
    ) {
      return { state: 'unverifiable', reason: 'repository-workspace-context-mismatch' }
    }
  } catch (error) {
    return {
      state: 'unverifiable',
      reason: `workspace-context-unverifiable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  let listing: RuntimeTerminalListResult
  try {
    listing = await runtime.listTerminals(
      `id:${definition.worktreeId}`,
      CONTENTION_TERMINAL_LIMIT,
      {
        requireFreshPtyLiveness: true
      }
    )
  } catch (error) {
    return {
      state: 'unverifiable',
      reason: `terminal-host-unreachable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (listing.truncated || !hostScopeCensusIsComplete(listing.hostScope)) {
    return { state: 'unverifiable', reason: 'terminal-host-census-incomplete' }
  }

  let matchingOwnAgentActive = false
  let matchingOwnAgentIdle = false
  let matchingOwnAgentExited = false
  let matchingOwnSessionObserved = false
  let matchingOwnTerminalLive = false
  for (const terminal of listing.terminals) {
    const sitterActionId = sitterActionIdFromTitle(terminal.title, definition.id)
    if (isProvenExitCause(terminal.exitCause)) {
      if (sitterActionId === ownActionId) {
        matchingOwnSessionObserved = true
        matchingOwnAgentExited = true
      }
      continue
    }
    if (terminal.exitCause?.kind === 'unknown' || !terminal.connected) {
      return { state: 'unverifiable', reason: 'terminal-process-liveness-unverifiable' }
    }
    if (sitterActionId === ownActionId) {
      matchingOwnTerminalLive = true
    }

    let agentStatus: RuntimeTerminalAgentStatus
    try {
      agentStatus = await runtime.getTerminalAgentStatus(terminal.handle)
    } catch (error) {
      return {
        state: 'unverifiable',
        reason: `agent-status-unverifiable: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    // The fresh host probe positively observed that the foreground is no longer an agent.
    // `agentIdentity` is launch/history metadata and must not overrule that current evidence.
    if (!agentStatus.isRunningAgent) {
      continue
    }
    if (agentStatus.status === 'idle') {
      if (sitterActionId === ownActionId) {
        matchingOwnSessionObserved = true
        matchingOwnAgentIdle = true
        continue
      }
      return { state: 'foreign-agent', sessionId: terminal.handle }
    }
    if (agentStatus.status === null) {
      return { state: 'unverifiable', reason: 'agent-activity-unverifiable' }
    }
    if (sitterActionId === ownActionId) {
      matchingOwnSessionObserved = true
      matchingOwnAgentActive = true
      continue
    }
    return { state: 'foreign-agent', sessionId: terminal.handle }
  }
  if (requirements.allowDirtyAfterOwnedSessionStopped && matchingOwnTerminalLive) {
    return { state: 'unverifiable', reason: 'owned-agent-terminal-still-live-after-stop' }
  }
  if (requirements.requireOwnSession && !matchingOwnSessionObserved) {
    return { state: 'unverifiable', reason: 'owned-agent-session-unverifiable' }
  }
  if (requirements.requireOwnIdle && !matchingOwnAgentIdle) {
    return { state: 'unverifiable', reason: 'owned-agent-completion-unverifiable' }
  }

  const git = resolveHostedReviewSitterGitExecution(runtime, store, definition)
  let clean: boolean
  try {
    clean = await git.worktreeIsClean()
  } catch (error) {
    return {
      state: 'unverifiable',
      reason: `working-tree-unverifiable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!clean) {
    if (ownActionId && matchingOwnAgentActive) {
      return { state: 'sitter-fix-agent', actionId: ownActionId }
    }
    if (ownActionId && matchingOwnAgentIdle && requirements.requireOwnIdle) {
      return { state: 'sitter-fix-agent', actionId: ownActionId }
    }
    if (ownActionId && requirements.allowDirtyAfterOwnedSessionStopped) {
      return { state: 'sitter-fix-agent', actionId: ownActionId }
    }
    if (ownActionId && (matchingOwnAgentIdle || matchingOwnAgentExited)) {
      return {
        state: 'abandoned-sitter-fix',
        actionId: ownActionId,
        reason: 'owned-sitter-agent-finished-or-exited-with-uncommitted-changes'
      }
    }
    return { state: 'dirty', reason: 'local-changes' }
  }
  if (
    ownActionId &&
    (matchingOwnAgentActive || (requirements.reportOwnLiveSession && matchingOwnTerminalLive))
  ) {
    return { state: 'sitter-fix-agent', actionId: ownActionId }
  }
  return { state: 'clear' }
}

export async function inspectHostedReviewSitterOwnedSession(
  runtime: OrcaRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  actionId: string
): Promise<HostedReviewSitterOwnedSession> {
  if (!store.getRepo(definition.repoId)) {
    return { state: 'unverifiable', reason: 'repository-context-missing' }
  }
  try {
    const workspace = await runtime.showManagedWorktree(`id:${definition.worktreeId}`)
    if (
      workspace.repoId !== definition.repoId ||
      !runtimePathsEqual(workspace.git.path, definition.repoPath)
    ) {
      return { state: 'unverifiable', reason: 'repository-workspace-context-mismatch' }
    }
  } catch (error) {
    return {
      state: 'unverifiable',
      reason: `workspace-context-unverifiable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  let listing: RuntimeTerminalListResult
  try {
    listing = await runtime.listTerminals(
      `id:${definition.worktreeId}`,
      CONTENTION_TERMINAL_LIMIT,
      {
        requireFreshPtyLiveness: true
      }
    )
  } catch (error) {
    return {
      state: 'unverifiable',
      reason: `terminal-host-unreachable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (listing.truncated || !hostScopeCensusIsComplete(listing.hostScope)) {
    return { state: 'unverifiable', reason: 'terminal-host-census-incomplete' }
  }

  let observed: HostedReviewSitterOwnedSession = { state: 'absent' }
  for (const terminal of listing.terminals) {
    if (sitterActionIdFromTitle(terminal.title, definition.id) !== actionId) {
      continue
    }
    if (isProvenExitCause(terminal.exitCause)) {
      continue
    }
    if (observed.state !== 'absent') {
      return { state: 'unverifiable', reason: 'multiple-owned-agent-terminals-live' }
    }
    if (terminal.exitCause?.kind === 'unknown' || !terminal.connected) {
      return { state: 'unverifiable', reason: 'owned-terminal-process-liveness-unverifiable' }
    }
    let status: RuntimeTerminalAgentStatus
    try {
      status = await runtime.getTerminalAgentStatus(terminal.handle)
    } catch (error) {
      return {
        state: 'unverifiable',
        reason: `owned-agent-status-unverifiable: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (status.isRunningAgent && status.status === null) {
      return { state: 'unverifiable', reason: 'owned-agent-activity-unverifiable' }
    }
    observed =
      status.isRunningAgent && status.status !== 'idle'
        ? { state: 'active', sessionId: terminal.handle }
        : { state: 'stoppable', sessionId: terminal.handle }
  }
  return observed
}
