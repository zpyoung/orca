import type {
  HostedReviewSnapshot,
  HostedReviewSitterActionResult,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import { encodedProject } from '../gitlab/project-path-encoding'
import { throwIfAborted, type HostedReviewSitterGitExecution } from './provider-git'
import type { HostedReviewSitterMutationTracker } from './provider-action-effect'
import {
  loadGitLabState,
  numberValue,
  runGitLabApi,
  stringValue,
  type GitLabState,
  type ProviderAction
} from './provider-gitlab-read'

function assertExpectedHead(snapshot: HostedReviewSnapshot, expectedHead: string): void {
  if (snapshot.freshness !== 'live' || snapshot.headSha !== expectedHead) {
    throw new Error(
      `GitLab review head changed from ${expectedHead} to ${snapshot.headSha || 'unknown'}.`
    )
  }
}

function assertMergeGates(snapshot: HostedReviewSnapshot, expectedHead: string): void {
  assertExpectedHead(snapshot, expectedHead)
  if (
    snapshot.lifecycle !== 'open' ||
    snapshot.draft ||
    snapshot.providerReadiness.verdict !== 'ready' ||
    snapshot.conflicts !== 'none' ||
    !snapshot.checksComplete ||
    snapshot.queue.membership === 'unknown' ||
    snapshot.checks.some(
      (check) => check.required && (check.headSha !== expectedHead || check.state !== 'passed')
    )
  ) {
    throw new Error('GitLab merge gates are no longer satisfied.')
  }
}

async function rerunChecks(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  state: GitLabState,
  action: Extract<ProviderAction, { kind: 'rerun-check' }>,
  signal: AbortSignal | undefined,
  tracker: HostedReviewSitterMutationTracker
): Promise<HostedReviewSitterActionResult> {
  assertExpectedHead(state.snapshot, action.headSha)
  const current = state.snapshot.checks.filter(
    (check) =>
      action.checkIds.includes(check.checkId) && action.observationIds.includes(check.observationId)
  )
  if (
    current.length !== action.checkIds.length ||
    current.some((check) => check.state !== 'failed')
  ) {
    throw new Error('GitLab job attempts changed before retry.')
  }
  const targets = action.checkIds.map((checkId) => checkId.match(/^job:([^:]+):(\d+)$/))
  if (targets.some((target) => !target)) {
    throw new Error('GitLab returned a failed status that cannot be retried.')
  }
  for (const target of targets) {
    throwIfAborted(signal)
    const result = JSON.parse(
      await runGitLabApi(
        definition,
        git,
        state.projectRef,
        ['-X', 'POST', `projects/${target![1]}/jobs/${target![2]}/retry`],
        { idempotent: false, signal, onDispatch: () => tracker.markDispatched() }
      )
    ) as Record<string, unknown>
    if (!numberValue(result.id)) {
      throw new Error('GitLab did not confirm the retried job attempt.')
    }
  }
  return { kind: 'rerun-requested' }
}

async function updateBranch(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  state: GitLabState,
  action: Extract<ProviderAction, { kind: 'update-branch' }>,
  signal: AbortSignal | undefined,
  tracker: HostedReviewSitterMutationTracker
): Promise<HostedReviewSitterActionResult> {
  assertExpectedHead(state.snapshot, action.headSha)
  if (state.snapshot.baseSha !== action.baseSha) {
    throw new Error('GitLab review base changed before branch update.')
  }
  const baseRef = await git.remoteRefForBranch(state.baseRefName, action.baseSha, signal)
  throwIfAborted(signal)
  if (!baseRef) {
    throw new Error('The current GitLab base commit is not available from a configured remote.')
  }
  const result = await git.updateBranch(
    {
      branch: definition.branch,
      baseRef,
      expectedHeadSha: action.headSha,
      expectedBaseSha: action.baseSha,
      mode: action.mode
    },
    signal,
    () => tracker.markDispatched()
  )
  return { kind: 'published', resultingHeadSha: result.resultingHeadSha }
}

async function mergeOrEnqueue(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  state: GitLabState,
  action: Extract<ProviderAction, { kind: 'merge' | 'enqueue' }>,
  signal: AbortSignal | undefined,
  tracker: HostedReviewSitterMutationTracker
): Promise<HostedReviewSitterActionResult> {
  assertMergeGates(state.snapshot, action.headSha)
  throwIfAborted(signal)
  const projectPath = encodedProject(state.projectRef.path)
  if (action.kind === 'merge') {
    if (state.snapshot.queue.required) {
      throw new Error('GitLab requires this merge request to use a merge train.')
    }
    const strategy = stringValue(state.project.merge_method).toLowerCase()
    const configuredMethod = ['rebase_merge', 'ff'].includes(strategy)
      ? 'rebase'
      : strategy === 'merge'
        ? 'merge'
        : null
    const squashOption = stringValue(state.project.squash_option).toLowerCase()
    if (
      (action.mergeMethod === 'squash' && squashOption === 'never') ||
      (action.mergeMethod !== 'squash' && squashOption === 'always') ||
      (action.mergeMethod !== 'squash' && action.mergeMethod !== configuredMethod)
    ) {
      throw new Error('GitLab cannot override the configured project merge strategy safely.')
    }
    throwIfAborted(signal)
    const response = JSON.parse(
      await runGitLabApi(
        definition,
        git,
        state.projectRef,
        [
          '-X',
          'PUT',
          `projects/${projectPath}/merge_requests/${definition.reviewNumber}/merge`,
          '-f',
          `sha=${action.headSha}`,
          '-f',
          `squash=${action.mergeMethod === 'squash' ? 'true' : 'false'}`,
          '-f',
          'should_remove_source_branch=false'
        ],
        { idempotent: false, signal, onDispatch: () => tracker.markDispatched() }
      )
    ) as Record<string, unknown>
    if (
      stringValue(response.state).toLowerCase() !== 'merged' &&
      !stringValue(response.merged_at)
    ) {
      throw new Error(
        stringValue(response.message) || 'GitLab did not confirm the merge request merged.'
      )
    }
    return { kind: 'none' }
  }
  if (!state.snapshot.queue.required || state.snapshot.queue.membership === 'enqueued') {
    throw new Error('GitLab merge train state no longer permits enqueue.')
  }
  throwIfAborted(signal)
  const response = JSON.parse(
    await runGitLabApi(
      definition,
      git,
      state.projectRef,
      [
        '-X',
        'POST',
        `projects/${projectPath}/merge_trains/merge_requests/${definition.reviewNumber}`,
        '-f',
        `sha=${action.headSha}`,
        '-f',
        'auto_merge=true'
      ],
      { idempotent: false, signal, onDispatch: () => tracker.markDispatched() }
    )
  ) as Record<string, unknown>
  if (!['fresh', 'idle', 'merging'].includes(stringValue(response.status).toLowerCase())) {
    throw new Error('GitLab did not confirm merge train enrollment.')
  }
  return { kind: 'none' }
}

export async function executeGitLabSitterAction(
  definition: HostedReviewSitterDefinition,
  action: ProviderAction,
  git: HostedReviewSitterGitExecution,
  signal: AbortSignal | undefined,
  tracker: HostedReviewSitterMutationTracker
): Promise<HostedReviewSitterActionResult> {
  const state = await loadGitLabState(definition, git, true, signal)
  throwIfAborted(signal)
  if (!state.sourceIdentityComplete) {
    throw new Error('The GitLab merge request source repository or branch is no longer verifiable.')
  }
  switch (action.kind) {
    case 'rerun-check':
      return rerunChecks(definition, git, state, action, signal, tracker)
    case 'update-branch':
      return updateBranch(definition, git, state, action, signal, tracker)
    case 'merge':
    case 'enqueue':
      return mergeOrEnqueue(definition, git, state, action, signal, tracker)
  }
}
