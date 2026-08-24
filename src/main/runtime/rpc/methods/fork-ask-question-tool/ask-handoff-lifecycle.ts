import { clampOrchestrationAskTimeoutMs } from '../../../../../shared/orchestration-ask-timeout'
import {
  isTerminalAskStatus,
  type AskAnswers,
  type AskEnvelope,
  type AskResultBody,
  type PersistedAskStatus
} from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskPartial, AskRegistryEvent, AskSpec } from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskDb, AskRow } from '../../../../fork-ask-question-tool/ask-db'
import { buildResultSummary } from '../../../../fork-ask-question-tool/ask-answer-value-parsing'
import { flattenAskSpecToQuestion, mapCoordinatorReply } from '../../../../fork-ask-question-tool/ask-handoff-flatten'
import { buildTimeoutResult } from '../../../../fork-ask-question-tool/ask-registry-timeout-answers'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { envelopeFromAskRow, pendingEnvelope, unknownAskEnvelope } from './ask-envelope-from-row'
import type { AskAttribution } from './ask-pane-attribution'

export type AskHandoffOrigin = { runId: string; dispatchId: string; askerHandle: string }
type HandoffListener = (event: AskRegistryEvent) => void

const listenersByRuntime = new WeakMap<object, Set<HandoffListener>>()

function listenersFor(runtime: OrcaRuntimeService): Set<HandoffListener> {
  let listeners = listenersByRuntime.get(runtime)
  if (!listeners) {
    listeners = new Set()
    listenersByRuntime.set(runtime, listeners)
  }
  return listeners
}

/**
 * Live feed of hand-off-origin transitions this module commits directly (see
 * `commitHandoffTerminal` for why those never go through `AskRegistry`) — the counterpart
 * `ask.subscribe` merges alongside `AskRegistry.onAskChanged` (tech.md C7).
 */
export function onHandoffAskChanged(runtime: OrcaRuntimeService, listener: HandoffListener): () => void {
  const listeners = listenersFor(runtime)
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitHandoff(runtime: OrcaRuntimeService, event: AskRegistryEvent): void {
  for (const listener of listenersFor(runtime)) {
    listener(event)
  }
}

/** Active-run lookup for the no-UI path (tech.md C3/C7): the identity `register` persists and the first `waitChunk` hands off to. */
export function resolveHandoffDispatch(
  attribution: AskAttribution,
  runtime: OrcaRuntimeService
): AskHandoffOrigin | null {
  const db = runtime.getOrchestrationDb()
  const dispatch = db.getActiveDispatchForIdentity(
    attribution.dispatchLookupHandle,
    attribution.paneKey ?? undefined
  )
  if (!dispatch) {
    return null
  }
  const run = db.getRun(dispatch.run_id)
  if (!run || run.legacy === 1) {
    return null
  }
  return {
    runId: run.id,
    dispatchId: dispatch.id,
    askerHandle: attribution.dispatchLookupHandle || dispatch.assignee_handle || 'unknown'
  }
}

// Why: AskDb.commitAskResult has no status guard and nothing else ever writes a handoff-origin
// row's terminal status outside this function, so a synchronous re-check-then-write here (no
// await between them) is enough to make first-commit-wins hold with no separate lock.
function commitHandoffTerminal(
  runtime: OrcaRuntimeService,
  askDb: AskDb,
  askId: string,
  status: Exclude<PersistedAskStatus, 'registered'>,
  result: AskResultBody
): AskEnvelope {
  const current = askDb.getAsk(askId)
  if (!current) {
    return unknownAskEnvelope(askId)
  }
  if (isTerminalAskStatus(current.status)) {
    return envelopeFromAskRow(current)
  }
  const row = askDb.commitAskResult(askId, { status, answersJson: JSON.stringify(result) })
  emitHandoff(runtime, {
    seq: row.seq,
    epoch: runtime.getAskServices().registry.getEpoch(),
    askId,
    paneKey: row.pane_key,
    status,
    result
  })
  return envelopeFromAskRow(row)
}

function skippedIds(spec: AskSpec): string[] {
  return spec.questions.map((question) => question.id)
}

// Why: every step here is synchronous (AskDb + OrchestrationDb are both better-sqlite3-backed),
// so re-reading handoff_question_id fresh at the top and writing it before any await is enough
// to guarantee at most one orchestration question per ask — no separate in-flight lock needed.
function ensureHandoffQuestionCreated(
  runtime: OrcaRuntimeService,
  askDb: AskDb,
  row: AskRow
): { status: 'ok'; questionId: string; dispatchId: string } | { status: 'unavailable'; envelope: AskEnvelope } {
  if (row.handoff_question_id) {
    return { status: 'ok', questionId: row.handoff_question_id, dispatchId: row.handoff_dispatch_id as string }
  }
  const spec = JSON.parse(row.spec_json) as AskSpec
  const orchestrationDb = runtime.getOrchestrationDb()
  try {
    const created = orchestrationDb.createQuestion({
      runId: row.handoff_run_id as string,
      dispatchId: row.handoff_dispatch_id as string,
      askerHandle: row.handoff_asker as string,
      question: flattenAskSpecToQuestion(spec)
    })
    askDb.setHandoffQuestionId(row.ask_id, created.question.message_id)
    runtime.notifyMessageArrived(`run:${row.handoff_run_id}`, created.message.type)
    return {
      status: 'ok',
      questionId: created.question.message_id,
      dispatchId: row.handoff_dispatch_id as string
    }
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'dispatch_inactive') {
      const envelope = commitHandoffTerminal(runtime, askDb, row.ask_id, 'unavailable', {
        answers: {},
        skipped: skippedIds(spec),
        summary: error.message
      })
      return { status: 'unavailable', envelope }
    }
    throw error
  }
}

/**
 * Blocks up to `chunkMs` on the coordinator's reply (tech.md C7): creates the orchestration
 * question on the first call (idempotent across a restart via `handoff_question_id`), then polls
 * it against the orchestration-ask wall-clock deadline (`clampOrchestrationAskTimeoutMs`, anchored
 * to the ask's own `created_at` so it too survives a restart) rather than the registry's
 * liveness-based expiry, which cannot apply to a pane-less ask.
 */
export async function waitHandoffChunk(
  runtime: OrcaRuntimeService,
  askDb: AskDb,
  askId: string,
  chunkMs: number,
  signal: AbortSignal
): Promise<AskEnvelope> {
  const initial = askDb.getAsk(askId)
  if (!initial) {
    return unknownAskEnvelope(askId)
  }
  if (isTerminalAskStatus(initial.status)) {
    return envelopeFromAskRow(initial)
  }

  const ensured = ensureHandoffQuestionCreated(runtime, askDb, initial)
  if (ensured.status === 'unavailable') {
    return ensured.envelope
  }

  const spec = JSON.parse(initial.spec_json) as AskSpec
  const orchestrationDb = runtime.getOrchestrationDb()
  const overallDeadline =
    Date.parse(initial.created_at) + clampOrchestrationAskTimeoutMs(initial.timeout_ms ?? undefined)
  const chunkDeadline = Date.now() + chunkMs

  while (true) {
    const question = orchestrationDb.getQuestion(ensured.questionId)
    if (!question || question.status === 'closed') {
      return commitHandoffTerminal(runtime, askDb, askId, 'unavailable', {
        answers: {},
        skipped: skippedIds(spec),
        summary: `orchestration question ${ensured.questionId} closed because its Dispatch is inactive`
      })
    }
    if (question.status === 'answered') {
      const mapped = mapCoordinatorReply(spec, question.answer_body ?? '')
      const status: PersistedAskStatus = mapped.skipped.length === 0 ? 'answered' : 'partial'
      return commitHandoffTerminal(runtime, askDb, askId, status, mapped)
    }
    if (signal.aborted) {
      return pendingEnvelope(askId)
    }
    const now = Date.now()
    if (now >= overallDeadline) {
      const current = askDb.getAsk(askId)
      const partial: AskPartial = current?.partial_json ? (JSON.parse(current.partial_json) as AskPartial) : {}
      return commitHandoffTerminal(runtime, askDb, askId, 'timed_out', buildTimeoutResult(spec, partial))
    }
    if (now >= chunkDeadline) {
      return pendingEnvelope(askId)
    }
    await runtime.waitForMessage(`dispatch:${ensured.dispatchId}`, {
      timeoutMs: Math.min(overallDeadline - now, chunkDeadline - now),
      signal
    })
  }
}

export function cancelHandoff(runtime: OrcaRuntimeService, askDb: AskDb, askId: string): AskEnvelope {
  const row = askDb.getAsk(askId)
  if (!row) {
    return unknownAskEnvelope(askId)
  }
  if (isTerminalAskStatus(row.status)) {
    return envelopeFromAskRow(row)
  }
  const spec = JSON.parse(row.spec_json) as AskSpec
  return commitHandoffTerminal(runtime, askDb, askId, 'declined', {
    answers: {},
    skipped: skippedIds(spec),
    summary: ''
  })
}

export function commitHandoffAnswer(
  runtime: OrcaRuntimeService,
  askDb: AskDb,
  askId: string,
  answers: AskAnswers,
  skipped: string[]
): { committed: boolean } {
  const row = askDb.getAsk(askId)
  if (!row || isTerminalAskStatus(row.status)) {
    return { committed: false }
  }
  const spec = JSON.parse(row.spec_json) as AskSpec
  const status: PersistedAskStatus = skipped.length === 0 ? 'answered' : 'partial'
  commitHandoffTerminal(runtime, askDb, askId, status, {
    answers,
    skipped,
    summary: buildResultSummary(spec, answers)
  })
  return { committed: true }
}

export function updatePartialHandoff(
  runtime: OrcaRuntimeService,
  askDb: AskDb,
  askId: string,
  partial: AskPartial
): void {
  const row = askDb.getAsk(askId)
  if (!row || isTerminalAskStatus(row.status)) {
    return
  }
  const spec = JSON.parse(row.spec_json) as AskSpec
  const ids = new Set(spec.questions.map((question) => question.id))
  const filtered = Object.fromEntries(Object.entries(partial).filter(([id]) => ids.has(id)))
  const updated = askDb.updatePartial(askId, JSON.stringify(filtered))
  emitHandoff(runtime, {
    seq: updated.seq,
    epoch: runtime.getAskServices().registry.getEpoch(),
    askId,
    paneKey: updated.pane_key,
    status: 'registered',
    spec,
    partial: filtered
  })
}
