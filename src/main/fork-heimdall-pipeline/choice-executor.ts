import type {
  ActionOutcome,
  EffectCertaintyResolution
} from '../../shared/fork-heimdall/effect-certainty'
import type {
  ExecuteContext,
  KernelAction,
  LeaseGuard
} from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot } from '../../shared/fork-heimdall/snapshot'
import type { PipelineAnswerEvidence } from '../../shared/fork-heimdall-pipeline/choice-types'
import { PIPELINE_ANSWER_EVIDENCE_KIND } from '../../shared/fork-heimdall-pipeline/choice-types'
import type { PipelineKindWorld } from './pipeline-kind-read'
import { isPipelineInvalidConfigurationWorld } from './pipeline-kind-read'
import type { PipelineStore } from './pipeline-store'
import {
  pipelineMergeConflictChild,
  pipelineMergeRetryProgressPersisted,
  pipelineMergeRetryProgressPlan
} from './pipeline-owner-merge-retry'
import type { PipelineMergeRetryProgressPlan } from './pipeline-owner-merge-retry'
import {
  PipelineChoiceConfigurationError,
  appendOwnerAnswer,
  hasMatchingEvidence,
  hasMatchingLoopRoundEvidence,
  latestOutput,
  loopRoundEvidencePayload,
  nodeForIdentity,
  requirePipelineActionEvidence,
  requireExactAnswer,
  requireEvidenceWriter,
  validateChoice
} from './pipeline-choice-evidence'
import type { ChoiceIdentity } from './pipeline-choice-evidence'

export { PipelineChoiceConfigurationError }

export type PipelineChoiceExecutorDependencies = Readonly<{
  store: PipelineStore
}>

/** Applies local pipeline controls. T9 observes a transition only after the runner settles this attempt landed. */
export async function executePipelineChoice(
  action: KernelAction,
  context: ExecuteContext<PipelineKindWorld>,
  dependencies: PipelineChoiceExecutorDependencies
): Promise<ActionOutcome> {
  const world = context.snapshot.world
  if (isPipelineInvalidConfigurationWorld(world)) {
    throw new PipelineChoiceConfigurationError(
      'Pipeline choice cannot execute from an invalid configuration world'
    )
  }
  const identity = requirePipelineActionEvidence(action, world)
  const node = nodeForIdentity(world, identity)
  const answer = requireExactAnswer(action, context.ledger, world)
  validateChoice(action, answer, node, identity.cause)
  if (
    action.kind === 'pipeline-pass-gate' &&
    (node.type !== 'gate' || action.approvalRequired !== true)
  ) {
    throw new PipelineChoiceConfigurationError(
      'pipeline-pass-gate requires a person-approved gate answer'
    )
  }
  if (action.kind === 'pipeline-apply-choice' && node.type === 'gate') {
    throw new PipelineChoiceConfigurationError('Gate choices must use pipeline-pass-gate')
  }

  await appendOwnerAnswer(action, world, context)
  await context.lease.assertHeld()

  if (action.kind === 'pipeline-pass-gate' && answer.choice === 'approve') {
    dependencies.store.recordNodeOutput({
      watcherId: world.watcherId,
      instanceId: identity.instanceId,
      epoch: identity.epoch,
      attempt: identity.attempt,
      outputs: {
        decision: 'approve',
        ...(answer.comment === undefined ? {} : { comment: answer.comment })
      },
      reportSha256: null,
      nowMs: world.nowMs
    })
  }

  if (
    action.kind === 'pipeline-apply-choice' &&
    answer.choice === 'skip' &&
    identity.cause === 'merge-conflict'
  ) {
    const childInstanceId = pipelineMergeConflictChild(action, identity.nodeId, node)
    dependencies.store.setMergeProgress({
      watcherId: world.watcherId,
      mergeId: identity.instanceId,
      epoch: identity.epoch,
      childInstanceId,
      state: 'skipped'
    })
  }
  if (
    action.kind === 'pipeline-apply-choice' &&
    answer.choice === 'retry' &&
    identity.cause === 'merge-conflict'
  ) {
    const plan = pipelineMergeRetryProgressPlan(
      world,
      context.ledger,
      action,
      identity.nodeId,
      node
    )
    for (const row of plan.rows) {
      dependencies.store.setMergeProgress({
        watcherId: world.watcherId,
        mergeId: row.mergeId,
        epoch: row.epoch,
        childInstanceId: row.childInstanceId,
        state: row.state,
        commitSha: row.commitSha,
        appliedCommitSha: row.appliedCommitSha,
        conflict: row.conflict
      })
    }
  }
  if (action.kind === 'pipeline-apply-choice' && answer.choice === 'one-more-round') {
    await requireEvidenceWriter(context)(
      'pipeline-loop-round',
      loopRoundEvidencePayload(identity, context.ledger)
    )
  }

  return { effect: 'landed', result: { choice: answer.choice } }
}

function actionResolution(
  action: KernelAction,
  attempt: AttemptEntry,
  fresh: LiveSnapshot<PipelineKindWorld>,
  ledger: WatcherLedger
): EffectCertaintyResolution {
  if (isPipelineInvalidConfigurationWorld(fresh.world)) {
    return { effect: 'indeterminate' }
  }
  let identity: ChoiceIdentity
  let answer: PipelineAnswerEvidence
  let mergeSkipTarget: string | undefined
  let mergeRetryPlan: PipelineMergeRetryProgressPlan | undefined
  try {
    identity = requirePipelineActionEvidence(action, fresh.world)
    const node = nodeForIdentity(fresh.world, identity)
    answer = requireExactAnswer(action, ledger, fresh.world)
    validateChoice(action, answer, node, identity.cause)
    if (
      action.kind === 'pipeline-pass-gate' &&
      (node.type !== 'gate' || action.approvalRequired !== true)
    ) {
      return { effect: 'not-landed' }
    }
    if (action.kind === 'pipeline-apply-choice' && node.type === 'gate') {
      return { effect: 'not-landed' }
    }
    if (
      action.kind === 'pipeline-apply-choice' &&
      answer.choice === 'skip' &&
      identity.cause === 'merge-conflict'
    ) {
      mergeSkipTarget = pipelineMergeConflictChild(action, identity.nodeId, node)
    }
    if (
      action.kind === 'pipeline-apply-choice' &&
      answer.choice === 'retry' &&
      identity.cause === 'merge-conflict'
    ) {
      mergeRetryPlan = pipelineMergeRetryProgressPlan(
        fresh.world,
        ledger,
        action,
        identity.nodeId,
        node
      )
    }
  } catch {
    return { effect: 'not-landed' }
  }

  const fingerprint = attempt.fingerprint
  if (
    answer.attribution.surface === 'owner-agent' &&
    !hasMatchingEvidence(ledger, PIPELINE_ANSWER_EVIDENCE_KIND, attempt.attemptId, fingerprint)
  ) {
    return { effect: 'not-landed' }
  }
  if (action.kind === 'pipeline-pass-gate' && answer.choice === 'approve') {
    const outputs = latestOutput(fresh.world, identity)
    if (
      outputs?.decision !== 'approve' ||
      (answer.comment !== undefined && outputs.comment !== answer.comment)
    ) {
      return { effect: 'not-landed' }
    }
  }
  if (mergeSkipTarget !== undefined) {
    const skipped = fresh.world.facts.mergeProgress.some(
      (row) =>
        row.mergeId === identity.instanceId &&
        row.epoch === identity.epoch &&
        row.childInstanceId === mergeSkipTarget &&
        row.state === 'skipped'
    )
    if (!skipped) {
      return { effect: 'not-landed' }
    }
  }
  if (
    mergeRetryPlan !== undefined &&
    !pipelineMergeRetryProgressPersisted(fresh.world, mergeRetryPlan)
  ) {
    return { effect: 'not-landed' }
  }
  if (
    action.kind === 'pipeline-apply-choice' &&
    answer.choice === 'one-more-round' &&
    !hasMatchingLoopRoundEvidence(ledger, identity, attempt.attemptId, fingerprint)
  ) {
    return { effect: 'not-landed' }
  }
  return { effect: 'landed' }
}

/** Resolves only local choice effects; gate, merge, and Loop writes are checked in their durable stores. */
export function resolvePipelineChoiceOutcome(
  attempt: AttemptEntry,
  fresh: LiveSnapshot<PipelineKindWorld>,
  ledger: WatcherLedger,
  _lease: LeaseGuard
): EffectCertaintyResolution {
  if (
    attempt.action.kind !== 'pipeline-pass-gate' &&
    attempt.action.kind !== 'pipeline-apply-choice'
  ) {
    return { effect: 'not-landed' }
  }
  return actionResolution(attempt.action, attempt, fresh, ledger)
}
