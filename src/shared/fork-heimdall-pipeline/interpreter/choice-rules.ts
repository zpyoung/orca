import { makeAttemptFingerprint } from '../../fork-heimdall/attempt-fingerprint'
import {
  getAttemptResolution,
  getLatestAttemptForFingerprint
} from '../../fork-heimdall/ledger-queries'
import type {
  ApprovalScope,
  AttemptEntry,
  KernelAction,
  WatcherLedger
} from '../../fork-heimdall/ledger-types'
import {
  PIPELINE_ANSWER_EVIDENCE_KIND,
  PipelineAnswerEvidenceSchema,
  type PipelineAnswerEvidence
} from '../choice-types'

export function readPipelineAnswers(ledger: WatcherLedger): PipelineAnswerEvidence[] {
  return ledger.entries.flatMap((entry) => {
    if (entry.kind !== 'evidence' || entry.evidenceKind !== PIPELINE_ANSWER_EVIDENCE_KIND) {
      return []
    }
    const parsed = PipelineAnswerEvidenceSchema.safeParse(entry.payload)
    return parsed.success ? [parsed.data] : []
  })
}

export function samePipelineScope(left: ApprovalScope, right: ApprovalScope): boolean {
  return (
    left.actionKind === right.actionKind &&
    left.contentIdentity === right.contentIdentity &&
    left.evidenceKey === right.evidenceKey &&
    left.preparedCommitSha === right.preparedCommitSha
  )
}

function answerMatchesAttempt(
  answer: PipelineAnswerEvidence,
  action: KernelAction,
  attempt: AttemptEntry | null
): boolean {
  if (answer.attribution.surface !== 'owner-agent') {
    return true
  }
  if (action.kind !== 'pipeline-apply-choice' || attempt === null) {
    return false
  }
  const fingerprint = makeAttemptFingerprint(
    action.contentIdentity,
    action.kind,
    action.evidenceKey
  )
  return (
    attempt.fingerprint === fingerprint &&
    answer.attemptId === attempt.attemptId &&
    answer.attemptFingerprint === fingerprint
  )
}

function answerForActionAttempt(
  ledger: WatcherLedger,
  action: KernelAction,
  attempt: AttemptEntry | null
): PipelineAnswerEvidence | null {
  const scope: ApprovalScope = {
    actionKind: action.kind,
    contentIdentity: action.contentIdentity,
    evidenceKey: action.evidenceKey
  }
  const answers = readPipelineAnswers(ledger)
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const answer = answers[index]
    if (
      answer !== undefined &&
      samePipelineScope(answer.scope, scope) &&
      answerMatchesAttempt(answer, action, attempt)
    ) {
      return answer
    }
  }
  return null
}

export function answerForAction(
  ledger: WatcherLedger,
  action: KernelAction
): PipelineAnswerEvidence | null {
  return answerForActionAttempt(ledger, action, attemptForAction(ledger, action))
}

export function attemptForAction(ledger: WatcherLedger, action: KernelAction): AttemptEntry | null {
  const fingerprint = makeAttemptFingerprint(
    action.contentIdentity,
    action.kind,
    action.evidenceKey
  )
  return getLatestAttemptForFingerprint(ledger, fingerprint)
}

export function answerForAttempt(
  ledger: WatcherLedger,
  attempt: AttemptEntry
): PipelineAnswerEvidence | null {
  const actionFingerprint = makeAttemptFingerprint(
    attempt.action.contentIdentity,
    attempt.action.kind,
    attempt.action.evidenceKey
  )
  return attempt.fingerprint === actionFingerprint
    ? answerForActionAttempt(ledger, attempt.action, attempt)
    : null
}

export function actionAttemptEffect(
  ledger: WatcherLedger,
  attempt: AttemptEntry
): 'landed' | 'not-landed' | 'indeterminate' | undefined {
  return getAttemptResolution(ledger, attempt.attemptId)?.effect ?? attempt.effect
}

export function actionHasLanded(ledger: WatcherLedger, action: KernelAction): boolean {
  const attempt = attemptForAction(ledger, action)
  return (
    attempt !== null &&
    attempt.state === 'settled' &&
    actionAttemptEffect(ledger, attempt) === 'landed'
  )
}

export function actionIsInFlight(ledger: WatcherLedger, action: KernelAction): boolean {
  const attempt = attemptForAction(ledger, action)
  return attempt !== null && (attempt.state === 'attempted' || attempt.state === 'running')
}
