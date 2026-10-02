import * as os from 'node:os'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { approvalScopeForAction } from '../../shared/fork-heimdall/gate'
import {
  getLatestApproval,
  getLatestAttemptForFingerprint
} from '../../shared/fork-heimdall/ledger-queries'
import type { ExecuteContext, KernelAction } from '../../shared/fork-heimdall/kind-contract'
import type { ApprovalScope, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  PipelineAnswerEvidence,
  PipelineChoice,
  PipelineChoiceCause
} from '../../shared/fork-heimdall-pipeline/choice-types'
import {
  PIPELINE_ANSWER_EVIDENCE_KIND,
  PipelineChoiceSchema,
  parsePipelineNodeEvidenceKey
} from '../../shared/fork-heimdall-pipeline/choice-types'
import type { PipelineNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import { nodeIdFromInstanceId } from '../../shared/fork-heimdall-pipeline/interpreter'
import { pipelineNodeIdentity } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import {
  answerForAction,
  samePipelineScope
} from '../../shared/fork-heimdall-pipeline/interpreter/choice-rules'
import { loopRoundFacts } from '../../shared/fork-heimdall-pipeline/interpreter/loop-rules'
import type { PipelineKindWorld } from './pipeline-kind-read'
import { pipelineChoiceOptionsForNode } from './pipeline-owner-choice-policy'

export class PipelineChoiceConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PipelineChoiceConfigurationError'
  }
}

type PipelineReadyChoiceWorld = Exclude<PipelineKindWorld, { invalidConfiguration: unknown }>

export type ChoiceIdentity = Readonly<{
  instanceId: string
  nodeId: string
  epoch: number
  attempt: number
  cause: PipelineChoiceCause
  deadlineMs?: number
}>

function actionIdentity(action: KernelAction): ChoiceIdentity {
  const identity = pipelineNodeIdentity(action)
  const parsed = parsePipelineNodeEvidenceKey(action.evidenceKey)
  if (
    identity === null ||
    identity.inner !== undefined ||
    parsed === null ||
    parsed.innerContentIdentity !== undefined ||
    parsed.cause === undefined ||
    identity.instanceId !== parsed.instanceId ||
    identity.nodeId !== nodeIdFromInstanceId(parsed.instanceId) ||
    identity.epoch !== parsed.epoch ||
    identity.attempt !== parsed.attempt ||
    (parsed.cause === 'time-limit' && parsed.deadlineMs === undefined)
  ) {
    throw new PipelineChoiceConfigurationError(
      'Pipeline choice action has an invalid node identity'
    )
  }
  return {
    instanceId: parsed.instanceId,
    nodeId: identity.nodeId,
    epoch: parsed.epoch,
    attempt: parsed.attempt,
    cause: parsed.cause,
    ...(parsed.deadlineMs === undefined ? {} : { deadlineMs: parsed.deadlineMs })
  }
}

export function nodeForIdentity(
  world: PipelineReadyChoiceWorld,
  identity: ChoiceIdentity
): PipelineNode {
  const node = world.payload.document.nodes.find((candidate) => candidate.id === identity.nodeId)
  if (node === undefined) {
    throw new PipelineChoiceConfigurationError(
      `Pipeline node ${identity.nodeId} is not in the pinned document`
    )
  }
  return node
}

function actionChoice(action: KernelAction): PipelineChoice {
  const result = PipelineChoiceSchema.safeParse(action.choice)
  if (!result.success) {
    throw new PipelineChoiceConfigurationError('Pipeline choice action has no valid choice')
  }
  return result.data
}

function answerScope(action: KernelAction): ApprovalScope {
  return {
    actionKind: action.kind,
    contentIdentity: action.contentIdentity,
    evidenceKey: action.evidenceKey
  }
}

export function requirePipelineActionEvidence(
  action: KernelAction,
  world: PipelineReadyChoiceWorld
): ChoiceIdentity {
  if (
    (action.kind !== 'pipeline-pass-gate' && action.kind !== 'pipeline-apply-choice') ||
    action.capability !== 'gate' ||
    action.visibility !== 'local' ||
    action.contentIdentity !== `pipeline:${world.payload.pin.contentHash}`
  ) {
    throw new PipelineChoiceConfigurationError(
      'Pipeline choice action is not a local gate control for this pinned run'
    )
  }
  const identity = actionIdentity(action)
  if (action.kind === 'pipeline-pass-gate' && identity.cause !== 'gate') {
    throw new PipelineChoiceConfigurationError('A pass-gate action must use the gate cause')
  }
  if (action.kind === 'pipeline-apply-choice' && identity.cause === 'gate') {
    throw new PipelineChoiceConfigurationError('Gate answers must use pipeline-pass-gate')
  }
  if (identity.cause === 'time-limit' && action.deadlineMs !== identity.deadlineMs) {
    throw new PipelineChoiceConfigurationError(
      'Time-limit control does not preserve its original deadline'
    )
  }
  return identity
}

function currentActionFingerprint(action: KernelAction): string {
  return makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey)
}

function ownerAnswerEvidence(
  action: KernelAction,
  world: PipelineReadyChoiceWorld
): PipelineAnswerEvidence {
  return {
    approvalEventId: `owner-agent:${currentActionFingerprint(action)}`,
    scope: answerScope(action),
    choice: actionChoice(action),
    ...(typeof action.comment === 'string' ? { comment: action.comment } : {}),
    ...(typeof action.extendMinutes === 'number' ? { extendMinutes: action.extendMinutes } : {}),
    attribution: {
      actor: { user: os.userInfo().username, host: os.hostname() },
      surface: 'owner-agent',
      atMs: world.nowMs
    }
  }
}

export function requireExactAnswer(
  action: KernelAction,
  ledger: WatcherLedger,
  world: PipelineReadyChoiceWorld
): PipelineAnswerEvidence {
  const scope = answerScope(action)
  const answer =
    answerForAction(ledger, action) ??
    (action.ownerIntervention === true ? ownerAnswerEvidence(action, world) : null)
  if (answer === null || !samePipelineScope(answer.scope, scope)) {
    throw new PipelineChoiceConfigurationError(
      'Pipeline choice action has no matching answer evidence'
    )
  }
  const actionExpected = action.kind === 'pipeline-pass-gate' ? undefined : actionChoice(action)
  if (actionExpected !== undefined && answer.choice !== actionExpected) {
    throw new PipelineChoiceConfigurationError(
      'Pipeline choice answer does not match the local control action'
    )
  }
  if (action.approvalRequired === true) {
    const approval = getLatestApproval(ledger, approvalScopeForAction(action))
    if (
      approval?.decision !== 'approved' ||
      approval.eventId !== answer.approvalEventId ||
      !samePipelineScope(answer.scope, approvalScopeForAction(action))
    ) {
      throw new PipelineChoiceConfigurationError(
        'Pipeline choice requires its exact person-approved answer scope'
      )
    }
    if (answer.attribution.surface === 'owner-agent') {
      throw new PipelineChoiceConfigurationError(
        'Owner-agent evidence cannot satisfy a person approval'
      )
    }
  } else if (answer.attribution.surface !== 'owner-agent') {
    throw new PipelineChoiceConfigurationError(
      'A non-person pipeline choice must carry owner-agent evidence'
    )
  }
  return answer
}

export function validateChoice(
  action: KernelAction,
  answer: PipelineAnswerEvidence,
  node: PipelineNode,
  cause: PipelineChoiceCause
): void {
  const options = pipelineChoiceOptionsForNode(node, cause)
  if (!options.includes(answer.choice)) {
    throw new PipelineChoiceConfigurationError(
      `Choice ${answer.choice} is not available for this pipeline node`
    )
  }
  const declared = action.options
  if (
    !Array.isArray(declared) ||
    declared.length !== options.length ||
    declared.some((item, index) => item !== options[index])
  ) {
    throw new PipelineChoiceConfigurationError(
      'Pipeline choice options do not match the pinned node'
    )
  }
  if (answer.choice === 'send-back' && answer.comment === undefined) {
    throw new PipelineChoiceConfigurationError('A send-back choice requires a comment')
  }
  if (answer.choice === 'extend' && answer.extendMinutes === undefined) {
    throw new PipelineChoiceConfigurationError('An extend choice requires extendMinutes')
  }
  if (answer.choice !== 'extend' && answer.extendMinutes !== undefined) {
    throw new PipelineChoiceConfigurationError('extendMinutes is only valid for an extend choice')
  }
}

export async function appendOwnerAnswer(
  action: KernelAction,
  world: PipelineReadyChoiceWorld,
  context: ExecuteContext<PipelineKindWorld>
): Promise<void> {
  if (action.ownerIntervention !== true) {
    return
  }
  const fingerprint = currentActionFingerprint(action)
  const attempt = getLatestAttemptForFingerprint(context.ledger, fingerprint)
  if (attempt === null || attempt.state !== 'attempted') {
    throw new PipelineChoiceConfigurationError(
      'Owner pipeline choice requires its current attempted control'
    )
  }
  const existing = answerForAction(context.ledger, action)
  if (
    existing !== null &&
    (existing.attribution.surface !== 'owner-agent' ||
      existing.choice !== actionChoice(action) ||
      existing.comment !== (typeof action.comment === 'string' ? action.comment : undefined) ||
      existing.extendMinutes !==
        (typeof action.extendMinutes === 'number' ? action.extendMinutes : undefined))
  ) {
    throw new PipelineChoiceConfigurationError(
      'Owner pipeline answer conflicts with recorded scope evidence'
    )
  }
  if (
    existing?.attemptId === attempt.attemptId &&
    existing.attemptFingerprint === attempt.fingerprint
  ) {
    return
  }
  if (context.appendEvidence === undefined) {
    throw new PipelineChoiceConfigurationError(
      'Owner pipeline choice requires ExecuteContext.appendEvidence'
    )
  }
  await context.appendEvidence(PIPELINE_ANSWER_EVIDENCE_KIND, ownerAnswerEvidence(action, world))
}

export function loopRoundEvidencePayload(
  identity: ChoiceIdentity,
  ledger: WatcherLedger
): Readonly<Record<string, unknown>> {
  const before = loopRoundFacts(ledger, identity.instanceId)
  return {
    loopId: identity.instanceId,
    epoch: identity.epoch,
    round: before.round + 1,
    extraRounds: before.extraRounds + 1
  }
}

export function hasMatchingEvidence(
  ledger: WatcherLedger,
  evidenceKind: string,
  attemptId: string,
  attemptFingerprint: string
): boolean {
  return ledger.entries.some((entry) => {
    if (entry.kind !== 'evidence' || entry.evidenceKind !== evidenceKind) {
      return false
    }
    const payload = entry.payload
    return (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      'attemptId' in payload &&
      payload.attemptId === attemptId &&
      'attemptFingerprint' in payload &&
      payload.attemptFingerprint === attemptFingerprint
    )
  })
}

export function hasMatchingLoopRoundEvidence(
  ledger: WatcherLedger,
  identity: ChoiceIdentity,
  attemptId: string,
  attemptFingerprint: string
): boolean {
  const prior = loopRoundFacts(ledger, identity.instanceId)
  return ledger.entries.some((entry) => {
    if (entry.kind !== 'evidence' || entry.evidenceKind !== 'pipeline-loop-round') {
      return false
    }
    const payload = entry.payload
    return (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      'loopId' in payload &&
      payload.loopId === identity.instanceId &&
      'epoch' in payload &&
      payload.epoch === identity.epoch &&
      'round' in payload &&
      payload.round === prior.round + 1 &&
      'extraRounds' in payload &&
      payload.extraRounds === prior.extraRounds + 1 &&
      'attemptId' in payload &&
      payload.attemptId === attemptId &&
      'attemptFingerprint' in payload &&
      payload.attemptFingerprint === attemptFingerprint
    )
  })
}

export function latestOutput(
  world: PipelineReadyChoiceWorld,
  identity: ChoiceIdentity
): Record<string, unknown> | null {
  for (let index = world.facts.outputs.length - 1; index >= 0; index -= 1) {
    const output = world.facts.outputs[index]
    if (
      output?.instanceId === identity.instanceId &&
      output.epoch === identity.epoch &&
      output.attempt === identity.attempt
    ) {
      return output.outputs
    }
  }
  return null
}

export function requireEvidenceWriter(
  context: ExecuteContext<PipelineKindWorld>
): NonNullable<ExecuteContext<PipelineKindWorld>['appendEvidence']> {
  if (context.appendEvidence === undefined) {
    throw new PipelineChoiceConfigurationError(
      'Pipeline choice execution requires ExecuteContext.appendEvidence'
    )
  }
  return context.appendEvidence
}
