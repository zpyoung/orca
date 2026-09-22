import { createHash } from 'node:crypto'
import type { KernelAction, OwnerAdapter } from '../../../shared/fork-heimdall/kind-contract'
import {
  OWNER_INTERVENTION_ID_MAX_LENGTH,
  OWNER_INTERVENTION_TEXT_MAX_LENGTH
} from '../../../shared/fork-heimdall/owner/intervention'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { Deviation } from '../../../shared/fork-heimdall/owner/deviation'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import { searchMinimalOmissionPrefix } from '../judgment/omission-budget-search'
import {
  expandJudgmentState,
  normalizeJudgmentState,
  type JudgmentWireState
} from '../judgment/state-normalization'
import {
  compareCodeUnits,
  projectRelevantLedger,
  sanitized,
  type AttemptItem,
  type ReportItem
} from '../judgment/state-projection'
import { MAX_OWNER_REPORT_BYTES } from './owner-report-io'

/** 32 KiB matches the judgment feature's own transport budget; there is no reason an owner turn needs more. */
export const OWNER_BRIEF_MAX_STATE_BYTES = 32 * 1024
const PREVIOUS_SUBMISSION_REJECTION_MAX_CODE_UNITS = 4_096

export const KIND_AGNOSTIC_INTERVENTION_VOCABULARY = [
  '{"kind":"continue"} — nothing needs to change; let the kernel proceed.',
  '{"kind":"ask-human","question":"..."} — you cannot resolve this; ask the operator. question is' +
    ` plain text, max ${OWNER_INTERVENTION_TEXT_MAX_LENGTH} characters.`,
  '{"kind":"abandon","rationale":"..."} — the watcher should stop; state why. rationale is plain' +
    ` text, max ${OWNER_INTERVENTION_TEXT_MAX_LENGTH} characters.`,
  '{"kind":"answer-worker","messageId":"...","answer":"..."} — answer a worker\'s open question.' +
    ` messageId is max ${OWNER_INTERVENTION_ID_MAX_LENGTH} characters; answer is plain text, max` +
    ` ${OWNER_INTERVENTION_TEXT_MAX_LENGTH} characters.`,
  '{"kind":"stop-worker","dispatchId":"...","rationale":"..."} — stop one active worker without' +
    ` stopping sibling work. dispatchId is max ${OWNER_INTERVENTION_ID_MAX_LENGTH} characters;` +
    ` rationale is plain text, max ${OWNER_INTERVENTION_TEXT_MAX_LENGTH} characters.`,
  'All character limits above are JavaScript UTF-16 code units (String.length/Zod max), not UTF-8 bytes.'
].join('\n')

export type OwnerGateSummary = {
  writeTerritory: string
  landingBar: string
  budget: string
  sitterOverrides: string
  capabilityModes: string
}

export const DEFAULT_OWNER_GATE_SUMMARY: OwnerGateSummary = {
  writeTerritory:
    'An accept-report intervention may excuse a reported-vs-observed file mismatch, never a change outside write territory.',
  landingBar: "A stage skip is rejected for any stage this watcher's landing bar mandates.",
  budget:
    'Your turn is charged like a worker turn; budget exhaustion parks regardless of your answer.',
  sitterOverrides: 'You may not grant a sitter a capability this watcher withheld.',
  capabilityModes: 'A capability that is off stays off; one awaiting approval still needs a human.'
}

type PreviousSubmissionRejectionBrief = {
  reason: string
  omittedCodeUnits?: number
  reference: 'previous rejected owner submission diagnostic'
}

type OwnerBriefTruncation = {
  policy: 'oldest-history-first'
  version: 1
  omittedAttempts: number
  omitted: { completedAttempts: number }
  references: {
    completedAttempts: {
      source: 'watcher-ledger.entries[kind=attempt]'
      digest: string
    }
  }
}

export type OwnerBriefState = {
  contentIdentity: string
  deviation: unknown
  kindState: { text: string; truncated: boolean }
  triggeringReport: unknown
  previousSubmissionRejection: PreviousSubmissionRejectionBrief | null
  recentAttempts: unknown[]
  interventionVocabulary: string
  gates: OwnerGateSummary
  truncation?: OwnerBriefTruncation
}

export type OwnerBriefResult = {
  state: JudgmentWireState<OwnerBriefState>
  serializedState: string
  serializedBytes: number
  fitsStateBudget: boolean
}

function deviationSubjectId(deviation: Deviation): string | null {
  return 'dispatchId' in deviation && typeof deviation.dispatchId === 'string'
    ? deviation.dispatchId
    : null
}

function triggeringReport(reports: readonly ReportItem[], deviation: Deviation): unknown {
  const subjectId = deviationSubjectId(deviation)
  if (!subjectId) {
    return null
  }
  const report = reports.find((item) => item.subjectId === subjectId)
  return report ? sanitized(report.value) : null
}

function boundedPreviousSubmissionRejection(
  reason: string | undefined
): PreviousSubmissionRejectionBrief | null {
  if (reason === undefined) {
    return null
  }
  const includedCodeUnits = Math.min(reason.length, PREVIOUS_SUBMISSION_REJECTION_MAX_CODE_UNITS)
  return {
    reason: reason.slice(0, includedCodeUnits),
    ...(includedCodeUnits < reason.length
      ? { omittedCodeUnits: reason.length - includedCodeUnits }
      : {}),
    reference: 'previous rejected owner submission diagnostic'
  }
}

function compareAttemptChronology(left: AttemptItem, right: AttemptItem): number {
  return (
    left.atMs - right.atMs ||
    left.sourceIndex - right.sourceIndex ||
    compareCodeUnits(left.key, right.key)
  )
}

function isTriggeringAttempt(attempt: AttemptItem, deviation: Deviation): boolean {
  const subjectId = deviationSubjectId(deviation)
  if (subjectId !== null && attempt.subjectId === subjectId) {
    return true
  }
  const deviationTaskKey =
    'taskKey' in deviation && typeof deviation.taskKey === 'string' ? deviation.taskKey : null
  if (deviationTaskKey === null) {
    return false
  }
  const directTaskKey =
    typeof attempt.action.taskKey === 'string' ? attempt.action.taskKey : undefined
  const dispatch = attempt.value.dispatch
  const dispatchTaskKey =
    dispatch !== null &&
    typeof dispatch === 'object' &&
    'taskKey' in dispatch &&
    typeof dispatch.taskKey === 'string'
      ? dispatch.taskKey
      : undefined
  return directTaskKey === deviationTaskKey || dispatchTaskKey === deviationTaskKey
}

function baseState(
  contentIdentity: string,
  deviation: Deviation,
  kindState: { text: string; truncated: boolean },
  attempts: readonly AttemptItem[],
  reports: readonly ReportItem[],
  interventionVocabulary: string,
  gates: OwnerGateSummary,
  omittedAttempts: readonly AttemptItem[],
  previousSubmissionRejection: string | undefined
): OwnerBriefState {
  const omittedKeys = new Set(omittedAttempts.map((item) => item.key))
  const omissionDigest =
    omittedAttempts.length === 0
      ? null
      : createHash('sha256')
          .update(JSON.stringify(omittedAttempts.map((item) => item.key)))
          .digest('hex')
  return {
    contentIdentity,
    deviation: sanitized(deviation),
    kindState,
    triggeringReport: triggeringReport(reports, deviation),
    previousSubmissionRejection: boundedPreviousSubmissionRejection(previousSubmissionRejection),
    recentAttempts: attempts
      .filter((item) => !omittedKeys.has(item.key))
      .map((item) => sanitized(item.value)),
    interventionVocabulary,
    gates,
    ...(omissionDigest === null
      ? {}
      : {
          truncation: {
            policy: 'oldest-history-first' as const,
            version: 1 as const,
            omittedAttempts: omittedAttempts.length,
            omitted: { completedAttempts: omittedAttempts.length },
            references: {
              completedAttempts: {
                source: 'watcher-ledger.entries[kind=attempt]' as const,
                digest: `sha256:${omissionDigest}`
              }
            }
          }
        })
  }
}

function project(state: OwnerBriefState, maxStateBytes: number): OwnerBriefResult {
  const normalized = normalizeJudgmentState(state)
  return {
    state: normalized.state,
    serializedState: normalized.serializedState,
    serializedBytes: normalized.serializedBytes,
    fitsStateBudget: normalized.serializedBytes <= maxStateBytes
  }
}

/**
 * Builds the complete owner-state envelope under one byte budget. Safe completed history is omitted
 * oldest-first; live and triggering attempts, the deviation, triggering report, and rejection
 * diagnostic remain mandatory. If those cannot fit, the returned result is explicitly over budget.
 */
export function buildOwnerBrief<TWorld, TAction extends KernelAction>(args: {
  contentIdentity: string
  snapshot: Snapshot<TWorld>
  ledger: WatcherLedger
  deviation: Deviation
  owner: OwnerAdapter<TWorld, TAction>
  maxStateBytes?: number
  previousSubmissionRejection?: string
}): OwnerBriefResult {
  const maxStateBytes = args.maxStateBytes ?? OWNER_BRIEF_MAX_STATE_BYTES
  const projected = projectRelevantLedger(args.ledger)
  const interventionVocabulary = `${KIND_AGNOSTIC_INTERVENTION_VOCABULARY}\n${args.owner.describeInterventions()}`
  const attempts = [...projected.attempts].sort(compareAttemptChronology)
  const droppableAttempts = attempts.filter(
    (attempt) => attempt.completed && !isTriggeringAttempt(attempt, args.deviation)
  )
  const kindStateByBudget = new Map<number, { text: string; truncated: boolean }>()
  const kindStateForBudget = (budget: number): { text: string; truncated: boolean } => {
    const cached = kindStateByBudget.get(budget)
    if (cached) {
      return cached
    }
    const state = args.owner.describeState(args.snapshot, args.ledger, budget, {
      deviation: args.deviation
    })
    kindStateByBudget.set(budget, state)
    return state
  }
  const build = (
    kindState: { text: string; truncated: boolean },
    dropCount: number
  ): OwnerBriefState =>
    baseState(
      args.contentIdentity,
      args.deviation,
      kindState,
      attempts,
      projected.reports,
      interventionVocabulary,
      DEFAULT_OWNER_GATE_SUMMARY,
      droppableAttempts.slice(0, dropCount),
      args.previousSubmissionRejection
    )
  const projectWithKindState = (kindState: {
    text: string
    truncated: boolean
  }): OwnerBriefResult => {
    const base = project(build(kindState, 0), maxStateBytes)
    if (base.fitsStateBudget || droppableAttempts.length === 0) {
      return base
    }
    const found = searchMinimalOmissionPrefix(droppableAttempts.length, (prefix) =>
      project(build(kindState, prefix), maxStateBytes)
    )
    return found ? found.result : base
  }

  const kindBudgetCeiling = Math.max(1, maxStateBytes)
  const fullKindState = kindStateForBudget(kindBudgetCeiling)
  const full = projectWithKindState(fullKindState)
  if (full.fitsStateBudget) {
    return full
  }

  // The kind budget is nested inside the normalized envelope, where escaping and wrapper fields
  // also cost bytes. Find the largest kind projection that fits after all safe history is gone.
  const minimumKindState = kindStateForBudget(1)
  const minimum = project(build(minimumKindState, droppableAttempts.length), maxStateBytes)
  if (!minimum.fitsStateBudget) {
    return minimum
  }
  let low = 1
  let high = kindBudgetCeiling - 1
  let best = minimumKindState
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = kindStateForBudget(middle)
    const candidateEnvelope = project(build(candidate, droppableAttempts.length), maxStateBytes)
    if (candidateEnvelope.fitsStateBudget) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return projectWithKindState(best)
}

export function expandOwnerBrief(state: JudgmentWireState<OwnerBriefState>): OwnerBriefState {
  return expandJudgmentState(state)
}

/** The full turn text sent to the owner: instructions, the bounded state, and how to answer. */
export function buildOwnerPromptText(args: {
  watcherId: string
  wakeToken: string
  runId: string
  interventionVocabulary: string
  reportPath: string
  brief: OwnerBriefResult
}): string {
  return [
    'ROLE: Heimdall owning agent',
    `A deterministic watcher (${args.watcherId}) hit something it cannot resolve on its own and is` +
      ' waiting on your answer. Reply with exactly one strict JSON object naming one intervention' +
      ' from the vocabulary below.',
    `INTERVENTION VOCABULARY:\n${args.interventionVocabulary}`,
    'GATES YOU CANNOT CROSS:',
    Object.values(DEFAULT_OWNER_GATE_SUMMARY).join('\n'),
    `STATE (bounded, oldest-history-first if truncated):\n${args.brief.serializedState}`,
    `Write your JSON answer to this exact absolute path: ${JSON.stringify(args.reportPath)}`,
    `The complete intervention file is limited to ${MAX_OWNER_REPORT_BYTES} UTF-8 bytes, independently of each field's UTF-16 code-unit limit.`,
    'Writing the report and sending "ready" submits a proposed intervention; neither confirms' +
      ' approval or execution. Report it as submitted, not completed, unless the watcher provides' +
      ' execution evidence. An approval hold requires the operator, not another owner answer.',
    'Keep every free-text response field within its advertised bound. Summarize supporting evidence' +
      ' and cite the bounded state or an existing artifact instead of pasting unlimited verbatim output.',
    'Then send, using the worker identifiers Orca supplied in your preamble:',
    `orca orchestration send --from <yourWorkerHandle> --run ${args.runId} --type status --subject "heimdall-owner-intervention:${args.watcherId}:${args.wakeToken}" --body "ready"`,
    'Orca validates the intervention before accepting "ready". If it rejects the submission,' +
      ' correct the reported field in this same report file and resend the same ready command;' +
      ' the current owner turn and retry budget remain available.'
  ].join('\n\n')
}
