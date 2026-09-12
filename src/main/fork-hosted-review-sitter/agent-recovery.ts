import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  ActionLedgerEntry,
  HostedReviewSitterActionResult,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import {
  assertBranchAndHead,
  assertCommitSha,
  assertCommittedPolicy,
  assertOpaqueActionId,
  describeContention,
  verifyPreparedCommit
} from './agent-execution'
import {
  inspectHostedReviewSitterContention,
  inspectHostedReviewSitterOwnedSession
} from './contention'
import { resolveHostedReviewSitterGitExecution } from './provider-git'

export type HostedReviewSitterPreparationRecovery =
  | { state: 'running' }
  | { state: 'completed'; result: HostedReviewSitterActionResult }
  | { state: 'ambiguous'; reason: string }

export async function recoverHostedReviewSitterAgentPreparation(
  runtime: OrcaRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition,
  interrupted: ActionLedgerEntry
): Promise<HostedReviewSitterPreparationRecovery> {
  const action = interrupted.action
  if (action.kind !== 'prepare-fix' && action.kind !== 'prepare-conflict-resolution') {
    return { state: 'ambiguous', reason: 'interrupted-action-is-not-an-agent-preparation' }
  }
  try {
    assertOpaqueActionId(interrupted.actionId)
    assertCommitSha(action.headSha, 'expected head')
    if (action.kind === 'prepare-conflict-resolution') {
      assertCommitSha(action.baseSha, 'expected base')
    }
    const signal = new AbortController().signal
    const git = resolveHostedReviewSitterGitExecution(runtime, store, definition)
    const ownedSession = await inspectHostedReviewSitterOwnedSession(
      runtime,
      store,
      definition,
      interrupted.actionId
    )
    if (ownedSession.state === 'unverifiable') {
      return {
        state: 'ambiguous',
        reason: `interrupted-preparation-${ownedSession.reason}`
      }
    }
    if (ownedSession.state === 'active') {
      return { state: 'running' }
    }
    if (ownedSession.state === 'stoppable') {
      const stopped = await runtime.closeTerminal(ownedSession.sessionId)
      if (!stopped.ptyKilled) {
        return {
          state: 'ambiguous',
          reason: `owned-agent-stop-unverifiable:${stopped.ptyStopReason ?? 'unknown'}`
        }
      }
    }

    const currentHeadSha = await git.currentHeadSha(signal)
    if (currentHeadSha !== action.headSha) {
      await assertBranchAndHead(git, definition, currentHeadSha, signal)
      await verifyPreparedCommit(git, action, interrupted.actionId, currentHeadSha, signal)
      await assertCommittedPolicy(git, action.headSha, currentHeadSha, signal)
      if (!(await git.worktreeIsClean(signal))) {
        return { state: 'ambiguous', reason: 'recovered-preparation-worktree-is-dirty' }
      }
      const finalContention = await inspectHostedReviewSitterContention(
        runtime,
        store,
        definition,
        interrupted.actionId,
        { reportOwnLiveSession: true }
      )
      if (
        finalContention.state === 'sitter-fix-agent' &&
        finalContention.actionId === interrupted.actionId
      ) {
        return { state: 'running' }
      }
      if (finalContention.state !== 'clear') {
        return {
          state: 'ambiguous',
          reason: `recovered-preparation-${describeContention(finalContention)}`
        }
      }
      return {
        state: 'completed',
        result: { kind: 'prepared', preparedCommitSha: currentHeadSha }
      }
    }

    const contention = await inspectHostedReviewSitterContention(
      runtime,
      store,
      definition,
      interrupted.actionId,
      { reportOwnLiveSession: true }
    )
    if (contention.state === 'sitter-fix-agent' && contention.actionId === interrupted.actionId) {
      return { state: 'running' }
    }
    return {
      state: 'ambiguous',
      reason: `interrupted-preparation-${describeContention(contention)}`
    }
  } catch (error) {
    return {
      state: 'ambiguous',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}
