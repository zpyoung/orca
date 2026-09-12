import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  HostedReviewSitterActionResult,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import {
  assertBranchAndHead,
  assertCommitSha,
  assertCommittedPolicy,
  assertOpaqueActionId,
  assertWriteContention,
  describeContention,
  throwIfAborted,
  verifyPreparedCommit,
  withHostedReviewSitterActionEffect,
  type PublishAction
} from './agent-execution'
import { inspectHostedReviewSitterContention } from './contention'
import { resolveHostedReviewSitterGitExecution } from './provider-git'

async function verifyPublicationPreconditions(
  runtime: OrcaRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  action: PublishAction,
  actionId: string,
  signal: AbortSignal
) {
  assertOpaqueActionId(actionId)
  assertOpaqueActionId(action.preparationActionId)
  assertCommitSha(action.headSha, 'expected review head')
  assertCommitSha(action.preparedCommitSha, 'prepared commit')
  if (action.kind === 'publish-conflict-resolution') {
    assertCommitSha(action.baseSha, 'expected base')
  }
  const git = resolveHostedReviewSitterGitExecution(runtime, store, definition)
  throwIfAborted(signal)
  await assertWriteContention(runtime, store, definition, action.preparationActionId)
  await assertBranchAndHead(git, definition, action.preparedCommitSha, signal)
  await verifyPreparedCommit(
    git,
    action,
    action.preparationActionId,
    action.preparedCommitSha,
    signal
  )
  await assertCommittedPolicy(git, action.headSha, action.preparedCommitSha, signal)

  const status = await git.getStatus(signal)
  if (status.didHitLimit || status.entries.length > 0) {
    throw new Error('Hosted review publication requires an exactly clean worktree.')
  }

  // The service re-read and gated the exact approval scope immediately before this call. These
  // are the final reads before the irreversible provider-routed write; the helper pushes the
  // immutable prepared SHA rather than mutable HEAD, and normal push rejection is the remote race fence.
  const [contention, localHeadSha, remoteHeadSha] = await Promise.all([
    inspectHostedReviewSitterContention(runtime, store, definition, action.preparationActionId),
    git.currentHeadSha(signal),
    git.remoteHeadSha(signal)
  ])
  if (contention.state !== 'clear') {
    throw new Error(`Hosted review publication held by ${describeContention(contention)}.`)
  }
  if (localHeadSha !== action.preparedCommitSha) {
    throw new Error('Prepared local HEAD changed immediately before publication.')
  }
  if (remoteHeadSha !== action.headSha) {
    throw new Error(
      `Hosted review head changed from ${action.headSha} to ${remoteHeadSha ?? '<unverifiable>'}.`
    )
  }
  throwIfAborted(signal)
  return git
}

export async function publishHostedReviewSitterPreparation(
  runtime: OrcaRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  action: PublishAction,
  actionId: string,
  signal: AbortSignal
): Promise<HostedReviewSitterActionResult> {
  const git = await verifyPublicationPreconditions(
    runtime,
    store,
    definition,
    action,
    actionId,
    signal
  ).catch((error: unknown) => {
    throw withHostedReviewSitterActionEffect(error, 'none')
  })
  // Crossing this call may have published even if transport confirmation is lost.
  await git.pushCommit(action.preparedCommitSha, signal)
  return { kind: 'published', resultingHeadSha: action.preparedCommitSha }
}
