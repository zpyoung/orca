import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  HostedReviewSitterContention,
  HostedReviewSitterActionEffect,
  HostedReviewSitterDefinition,
  PrepareConflictResolutionAction,
  PrepareFixAction,
  PublishConflictResolutionAction,
  PublishFixAction
} from '../../shared/fork-hosted-review-sitter/types'
import type { GitFileStatus, GitStatusEntry, GitStatusResult } from '../../shared/git-status-types'
import { inspectHostedReviewSitterPolicy } from './agent-policy'
import { inspectHostedReviewSitterContention } from './contention'
import type { HostedReviewSitterGitExecution } from './provider-git'

const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i
const ACTION_TRAILER = 'PR-Sitter-Action'
const SOURCE_HEAD_TRAILER = 'PR-Sitter-Source-Head'

export type PrepareAction = PrepareFixAction | PrepareConflictResolutionAction
export type PublishAction = PublishFixAction | PublishConflictResolutionAction

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return
  }
  if (signal.reason instanceof Error) {
    throw signal.reason
  }
  const error = new Error('Hosted review sitter action aborted.')
  error.name = 'AbortError'
  throw error
}
export function withHostedReviewSitterActionEffect(
  error: unknown,
  effect: Exclude<HostedReviewSitterActionEffect, 'committed'>
): Error & { effect: HostedReviewSitterActionEffect } {
  const existingEffect: HostedReviewSitterActionEffect | null =
    typeof error === 'object' &&
    error !== null &&
    'effect' in error &&
    (error.effect === 'none' || error.effect === 'committed' || error.effect === 'unknown')
      ? error.effect
      : null
  const resolvedEffect: HostedReviewSitterActionEffect = existingEffect ?? effect
  const wrapped = new Error(error instanceof Error ? error.message : String(error))
  if (error instanceof Error) {
    wrapped.name = error.name
    wrapped.stack = error.stack
  }
  return Object.assign(wrapped, { effect: resolvedEffect })
}

export function assertOpaqueActionId(actionId: string): void {
  if (!ACTION_ID_PATTERN.test(actionId)) {
    throw new Error('Hosted review sitter action id must be an unguessable opaque identifier.')
  }
}

export function assertCommitSha(sha: string, label: string): void {
  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error(`Hosted review sitter ${label} is not a complete Git commit id.`)
  }
}

export function describeContention(contention: HostedReviewSitterContention): string {
  if (contention.state === 'clear') {
    return 'clear'
  }
  if (contention.state === 'foreign-agent') {
    return `${contention.state}:${contention.sessionId}`
  }
  if (contention.state === 'sitter-fix-agent' || contention.state === 'abandoned-sitter-fix') {
    return `${contention.state}:${contention.actionId}`
  }
  return `${contention.state}:${contention.reason ?? 'unspecified'}`
}

export async function assertWriteContention(
  runtime: OrcaRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  ownActionId?: string,
  requirements?: {
    requireOwnSession?: boolean
    requireOwnIdle?: boolean
    allowDirtyAfterOwnedSessionStopped?: boolean
    reportOwnLiveSession?: boolean
  }
): Promise<void> {
  const contention = await inspectHostedReviewSitterContention(
    runtime,
    store,
    definition,
    ownActionId,
    requirements
  )
  const ownDirtyPreparation =
    contention.state === 'sitter-fix-agent' && contention.actionId === ownActionId
  if (contention.state !== 'clear' && !ownDirtyPreparation) {
    throw new Error(`Hosted review sitter write held by ${describeContention(contention)}.`)
  }
}

export async function assertBranchAndHead(
  git: HostedReviewSitterGitExecution,
  definition: HostedReviewSitterDefinition,
  expectedHeadSha: string,
  signal: AbortSignal
): Promise<void> {
  const [headSha, branchResult] = await Promise.all([
    git.currentHeadSha(signal),
    git.exec(['symbolic-ref', '--quiet', '--short', 'HEAD'], signal)
  ])
  if (headSha !== expectedHeadSha) {
    throw new Error(`Local HEAD changed from ${expectedHeadSha} to ${headSha || '<unborn>'}.`)
  }
  if (branchResult.stdout.trim() !== definition.branch) {
    throw new Error(
      `Hosted review branch changed from ${definition.branch} to ${branchResult.stdout.trim() || '<detached>'}.`
    )
  }
}

export function assertPolicyAllows(status: GitStatusResult, patch: string): void {
  const violation = inspectHostedReviewSitterPolicy(status, patch)
  if (violation) {
    throw new Error(
      `Hosted review agent policy escalation: ${violation.reason}${violation.path ? ` (${violation.path})` : ''}.`
    )
  }
}

function commitSubject(action: PrepareAction): string {
  if (action.kind === 'prepare-conflict-resolution') {
    return 'chore: prepare hosted review conflict resolution'
  }
  const check = action.checkKey
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 72)
  return check ? `fix: repair ${check}` : 'fix: repair hosted review checks'
}

export function buildPreparedCommitMessage(action: PrepareAction, actionId: string): string {
  return [
    commitSubject(action),
    '',
    `${ACTION_TRAILER}: ${actionId}`,
    `${SOURCE_HEAD_TRAILER}: ${action.headSha}`
  ].join('\n')
}

export async function verifyPreparedCommit(
  git: HostedReviewSitterGitExecution,
  action: PrepareAction | PublishAction,
  preparationActionId: string,
  preparedCommitSha: string,
  signal: AbortSignal
): Promise<void> {
  assertCommitSha(preparedCommitSha, 'prepared commit')
  const [parentsResult, messageResult] = await Promise.all([
    git.exec(['rev-list', '--parents', '-n', '1', preparedCommitSha], signal),
    git.exec(['show', '-s', '--format=%B', preparedCommitSha], signal)
  ])
  const [observedCommit, ...parents] = parentsResult.stdout.trim().split(/\s+/)
  if (observedCommit !== preparedCommitSha || parents[0] !== action.headSha) {
    throw new Error(
      'Prepared commit does not descend directly from the expected hosted review head.'
    )
  }
  if (action.kind === 'prepare-fix' || action.kind === 'publish-fix') {
    if (parents.length !== 1) {
      throw new Error('Prepared checks fix must be a single-parent commit.')
    }
  } else if (parents.length !== 2 || parents[1] !== action.baseSha) {
    throw new Error('Prepared conflict resolution must merge the exact expected base commit.')
  }
  const normalizedMessage = messageResult.stdout.replace(/\r\n/g, '\n')
  if (!normalizedMessage.split('\n').includes(`${ACTION_TRAILER}: ${preparationActionId}`)) {
    throw new Error('Prepared commit is missing its exact PR Sitter action ownership trailer.')
  }
  if (!normalizedMessage.split('\n').includes(`${SOURCE_HEAD_TRAILER}: ${action.headSha}`)) {
    throw new Error('Prepared commit is missing its exact source-head trailer.')
  }
}

function gitStatusFromNameStatus(output: string): GitStatusResult {
  const fields = output.split('\0')
  const entries: GitStatusEntry[] = []
  const statusByCode: Record<string, GitFileStatus> = {
    A: 'added',
    D: 'deleted',
    M: 'modified',
    T: 'modified',
    U: 'modified'
  }
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const code = fields[index]?.charAt(0) ?? ''
    const path = fields[index + 1]
    const status = statusByCode[code]
    if (!path || !status) {
      throw new Error('Prepared commit returned an unsupported or malformed changed-path record.')
    }
    entries.push({ path, status, area: 'staged' })
  }
  return { entries, conflictOperation: 'unknown' }
}

export async function assertCommittedPolicy(
  git: HostedReviewSitterGitExecution,
  sourceHeadSha: string,
  preparedCommitSha: string,
  signal: AbortSignal
): Promise<void> {
  const [names, patch] = await Promise.all([
    git.exec(
      ['diff', '--name-status', '--no-renames', '-z', sourceHeadSha, preparedCommitSha, '--'],
      signal
    ),
    git.exec(
      ['diff', '--no-ext-diff', '--unified=0', sourceHeadSha, preparedCommitSha, '--'],
      signal
    )
  ])
  assertPolicyAllows(gitStatusFromNameStatus(names.stdout), patch.stdout)
}
