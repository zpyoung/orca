import {
  PIPELINE_ANSWER_EVIDENCE_KIND,
  parsePipelineNodeEvidenceKey,
  PipelineAnswerEvidenceSchema,
  pipelineChoiceOptions
} from '../../shared/fork-heimdall-pipeline/choice-types'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import type {
  WatcherCommand,
  WatcherCommandResult,
  WatcherOwnerFence
} from '../../shared/fork-heimdall/fleet-types'
import { getLatestApproval, sameApprovalScope } from '../../shared/fork-heimdall/ledger-queries'
import type { ApprovalScope } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { isMalformedKindPayloadEnrollment, type EnrollmentStore } from './enrollment-store'
import type { HeimdallLedgerStore } from './ledger-store'
import type { WatcherControlEscalationLifecycle } from './control-escalation-lifecycle'
import { getApprovalEscalationsToResolve } from './approval-resolution'
import type { WatcherRunnerLoop } from './runner-loop'
import type { WatcherRunner } from './runner-state'

type PipelineChoiceControlDependencies = {
  enrollments: Pick<EnrollmentStore, 'commitControl'>
  ledger: HeimdallLedgerStore
  runner(watcherId: string): WatcherRunner | null
  runnerLoop: Pick<WatcherRunnerLoop, 'schedule'>
  changed(): void
  now(): number
  createId(): string
}

/** Records an attributed choice and resolves its held approval in one owner transaction. */
export function answerPipelineChoice(
  enrollment: WatcherEnrollment,
  expectedOwner: WatcherOwnerFence,
  command: Extract<WatcherCommand, { kind: 'answer-pipeline-choice' }>,
  dependencies: PipelineChoiceControlDependencies,
  escalations: Pick<WatcherControlEscalationLifecycle, 'appendApprovalResolution'>
): WatcherCommandResult {
  if (enrollment.kind !== 'pipeline') {
    return refused('invalid-command', 'Only pipeline watchers can answer a pipeline choice')
  }
  if (!enrollment.enabled || enrollment.paused) {
    return refused('invalid-state', 'A disabled or paused watcher cannot consume a pipeline choice')
  }
  if (
    command.scope.actionKind !== 'pipeline-pass-gate' &&
    command.scope.actionKind !== 'pipeline-apply-choice'
  ) {
    return refused('invalid-command', 'The approval scope is not a pipeline choice')
  }

  const ledger = dependencies.ledger.read(enrollment.watcherId)
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (
      !entry ||
      entry.kind !== 'evidence' ||
      entry.evidenceKind !== PIPELINE_ANSWER_EVIDENCE_KIND
    ) {
      continue
    }
    const previousAnswer = PipelineAnswerEvidenceSchema.safeParse(entry.payload)
    if (!previousAnswer.success || !sameApprovalScope(previousAnswer.data.scope, command.scope)) {
      continue
    }
    const attribution = previousAnswer.data.attribution
    const timestamp = new Date(attribution.atMs)
    const answeredAt = Number.isNaN(timestamp.getTime())
      ? `${attribution.atMs}ms`
      : timestamp.toISOString()
    return {
      status: 'refused',
      reason: 'already-resolved',
      detail: `Already answered by ${attribution.actor.user}@${attribution.actor.host} from ${attribution.surface} at ${answeredAt}`,
      resolvedBy: attribution
    }
  }

  if (getApprovalEscalationsToResolve(ledger, command.scope).length === 0) {
    return refused('invalid-state', 'This pipeline choice is no longer pending')
  }

  const payload = PipelineEnrollmentPayloadSchema.safeParse(enrollment.kindPayload)
  if (!payload.success) {
    return refused('invalid-command', 'The pipeline enrollment payload cannot be decoded')
  }
  if (command.scope.contentIdentity !== `pipeline:${payload.data.pin.contentHash}`) {
    return refused(
      'invalid-command',
      'The pipeline approval scope does not match its pinned document'
    )
  }
  const evidenceKey = parsePipelineNodeEvidenceKey(command.scope.evidenceKey)
  if (!evidenceKey?.cause) {
    return refused('invalid-command', 'The pipeline approval scope has no decodable choice cause')
  }
  if (evidenceKey.cause === 'time-limit' && evidenceKey.deadlineMs === undefined) {
    return refused('invalid-command', 'A time-limit choice requires its original deadline')
  }
  const bracket = evidenceKey.instanceId.indexOf('[')
  const nodeId = bracket === -1 ? evidenceKey.instanceId : evidenceKey.instanceId.slice(0, bracket)
  const node = payload.data.document.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) {
    return refused('invalid-command', `Pipeline node ${nodeId} is not in the pinned document`)
  }
  const isGate = command.scope.actionKind === 'pipeline-pass-gate'
  if (
    (isGate && (node.type !== 'gate' || evidenceKey.cause !== 'gate')) ||
    (!isGate && evidenceKey.cause === 'gate')
  ) {
    return refused('invalid-command', 'The pipeline approval scope does not match its node choice')
  }
  const options = pipelineChoiceOptions({
    nodeType: node.type,
    cause: evidenceKey.cause,
    ...(node.type === 'gate' && node.sendBackTo !== undefined
      ? { gateSendBackTo: node.sendBackTo }
      : {}),
    ...('onFail' in node && node.onFail?.sendBackTo !== undefined
      ? { onFailSendBackTo: node.onFail.sendBackTo }
      : {})
  })
  if (!options.includes(command.choice)) {
    return refused(
      'invalid-command',
      `Choice ${command.choice} is not available for this pipeline node`
    )
  }
  if (command.choice !== 'extend' && command.extendMinutes !== undefined) {
    return refused('invalid-command', 'extendMinutes is only valid for an extend choice')
  }
  if (command.choice === 'send-back' && command.comment === undefined) {
    return refused('invalid-command', 'A send-back choice requires a comment')
  }
  if (command.choice === 'extend' && command.extendMinutes === undefined) {
    return refused('invalid-command', 'An extend choice requires extendMinutes')
  }
  if (!command.attribution) {
    return refused('invalid-command', 'A pipeline choice answer requires attribution')
  }

  const approvalEventId = dependencies.createId()
  const atMs = dependencies.now()
  const previousApproval = getLatestApproval(ledger, command.scope)
  const answerEvidence = PipelineAnswerEvidenceSchema.parse({
    approvalEventId,
    scope: command.scope,
    choice: command.choice,
    ...(command.comment === undefined ? {} : { comment: command.comment }),
    ...(command.extendMinutes === undefined ? {} : { extendMinutes: command.extendMinutes }),
    attribution: command.attribution
  })
  const commit = dependencies.enrollments.commitControl(
    enrollment.watcherId,
    expectedOwner,
    {},
    () => {
      dependencies.ledger.append({
        eventId: approvalEventId,
        watcherId: enrollment.watcherId,
        atMs,
        origin: 'owner',
        class: 'fact',
        kind: 'approval',
        scope: command.scope,
        decision: 'approved',
        foldCount: (previousApproval?.foldCount ?? 0) + 1
      })
      dependencies.ledger.append({
        eventId: dependencies.createId(),
        watcherId: enrollment.watcherId,
        atMs,
        origin: 'owner',
        class: 'fact',
        kind: 'evidence',
        evidenceKind: PIPELINE_ANSWER_EVIDENCE_KIND,
        payload: answerEvidence
      })
      escalations.appendApprovalResolution(enrollment.watcherId, command.scope)
    }
  )
  if (commit.status === 'refused') {
    return commit
  }
  dependencies.changed()
  const committedEnrollment = commit.enrollment
  if (isMalformedKindPayloadEnrollment(committedEnrollment)) {
    throw new Error('A control mutation produced an invalid Heimdall enrollment')
  }
  const runner = dependencies.runner(enrollment.watcherId)
  if (runner) {
    runner.enrollment = committedEnrollment
    dependencies.runnerLoop.schedule(runner, 0)
  }
  return { status: 'applied', appliedAtMs: dependencies.now() }
}

/** Refuses the legacy un-attributed approval path for pipeline-choice scopes. */
export function legacyPipelineApprovalRefusal(scope: ApprovalScope): WatcherCommandResult | null {
  if (scope.actionKind !== 'pipeline-pass-gate' && scope.actionKind !== 'pipeline-apply-choice') {
    return null
  }
  return refused('invalid-command', 'Use answer-pipeline-choice to answer a pipeline choice')
}

function refused(
  reason: Extract<WatcherCommandResult, { status: 'refused' }>['reason'],
  detail: string
): WatcherCommandResult {
  return { status: 'refused', reason, detail }
}
