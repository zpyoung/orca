import type { ActionOutcome, EffectCertainty } from '../../shared/fork-heimdall/effect-certainty'
import { resolveByExpectedState } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry } from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot } from '../../shared/fork-heimdall/snapshot'
import { hostedReviewAttemptFingerprint } from '../../shared/fork-hosted-review-sitter/action-identity'
import type {
  HostedReviewSitterAction,
  HostedReviewSitterActionResult,
  HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter/types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  buildHostedReviewWorkerDispatch,
  type HostedReviewWorkerDispatch
} from './agent-preparation'
import { publishHostedReviewPreparation } from './agent-publication'
import { tagHostedReviewPreDispatchError } from './provider-action-effect'
import type { HostedReviewSitterProviderAdapter } from './provider'

function providerExpectedAfter(
  action: HostedReviewSitterAction,
  result: HostedReviewSitterActionResult
): string {
  if (result.kind === 'published') {
    return result.resultingHeadSha
  }
  switch (action.kind) {
    case 'rerun-check':
      return `rerun-observed:${action.evidenceKey}`
    case 'merge':
      return `merged:${action.headSha}`
    case 'enqueue':
      return `enqueued:${action.headSha}`
    case 'prepare-fix':
    case 'publish-fix':
    case 'prepare-conflict-resolution':
    case 'publish-conflict-resolution':
    case 'update-branch':
      return action.headSha
  }
}

export async function executeHostedReviewSitterAction(
  runtime: OrcaRuntimeService,
  store: Store,
  provider: HostedReviewSitterProviderAdapter,
  action: HostedReviewSitterAction,
  context: ExecuteContext<HostedReviewWorld>
): Promise<ActionOutcome> {
  const definition = context.snapshot.world.definition
  if (action.kind === 'prepare-fix' || action.kind === 'prepare-conflict-resolution') {
    const fingerprint = hostedReviewAttemptFingerprint(action)
    let request: HostedReviewWorkerDispatch
    try {
      request = buildHostedReviewWorkerDispatch(store, definition, action, fingerprint)
      await context.lease.assertHeld()
    } catch (error) {
      throw tagHostedReviewPreDispatchError(error)
    }
    const dispatched = await context.dispatchWorker(request)
    switch (dispatched.status) {
      case 'dispatched':
        return {
          effect: 'landed',
          result: { kind: 'worker-dispatched', dispatchId: dispatched.dispatchId }
        }
      case 'refused':
        return {
          effect: 'not-landed',
          reason: `${dispatched.reason}: ${dispatched.detail}`
        }
      case 'indeterminate':
        return {
          effect: 'indeterminate',
          reason: `Worker dispatch outcome is indeterminate: ${dispatched.requestId}`
        }
    }
  }

  if (action.kind === 'publish-fix' || action.kind === 'publish-conflict-resolution') {
    return publishHostedReviewPreparation(
      runtime,
      store,
      definition,
      action,
      context.ledger,
      context.lease,
      context.snapshot.world.preparedCommit
    )
  }

  await context.lease.assertHeld()
  const result = await provider.execute(definition, action, () => context.lease.assertHeld())
  return {
    effect: 'landed',
    result,
    expectedBefore: action.expectedState.before,
    expectedAfter: providerExpectedAfter(action, result)
  }
}

function observedStateForAttempt(
  attempt: AttemptEntry,
  snapshot: LiveSnapshot<HostedReviewWorld>
): string {
  const action = attempt.action as HostedReviewSitterAction
  const review = snapshot.world.review
  switch (action.kind) {
    case 'rerun-check': {
      if (review.headSha !== action.headSha) {
        return `moved:${review.headSha}`
      }
      const old = new Set(action.observationIds)
      const current = review.checks.filter((check) => action.checkIds.includes(check.checkId))
      if (
        current.some((check) => check.headSha === action.headSha && !old.has(check.observationId))
      ) {
        return `rerun-observed:${action.evidenceKey}`
      }
      return current.length === action.checkIds.length &&
        current.every(
          (check) =>
            check.headSha === action.headSha &&
            check.state === 'failed' &&
            old.has(check.observationId)
        )
        ? action.expectedState.before
        : `check-state-moved:${action.evidenceKey}`
    }
    case 'publish-fix':
    case 'publish-conflict-resolution':
    case 'update-branch':
      return review.headSha
    case 'merge':
      if (review.lifecycle === 'merged') {
        return `merged:${action.headSha}`
      }
      return review.lifecycle === 'open' && review.headSha === action.headSha
        ? action.expectedState.before
        : `${review.lifecycle}:${review.headSha}`
    case 'enqueue':
      if (review.queue.membership === 'enqueued') {
        return `enqueued:${action.headSha}`
      }
      return review.queue.membership === 'not-enqueued' && review.headSha === action.headSha
        ? action.expectedState.before
        : `${review.queue.membership}:${review.headSha}`
    case 'prepare-fix':
    case 'prepare-conflict-resolution':
      return snapshot.world.preparedCommit?.preparationAttemptFingerprint === attempt.fingerprint
        ? attempt.fingerprint
        : 'worker-dispatch-unresolved'
  }
}

export function resolveHostedReviewSitterOutcome(
  attempt: AttemptEntry,
  snapshot: LiveSnapshot<HostedReviewWorld>
): EffectCertainty {
  const action = attempt.action as HostedReviewSitterAction
  if (action.kind === 'prepare-fix' || action.kind === 'prepare-conflict-resolution') {
    return resolveByExpectedState(
      observedStateForAttempt(attempt, snapshot),
      'worker-dispatch-definitely-not-landed',
      attempt.fingerprint
    )
  }
  if (!attempt.expectedBefore || !attempt.expectedAfter) {
    return 'indeterminate'
  }
  return resolveByExpectedState(
    observedStateForAttempt(attempt, snapshot),
    attempt.expectedBefore,
    attempt.expectedAfter
  )
}
