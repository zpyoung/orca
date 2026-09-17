import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type {
  EscalationEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type {
  UnanswerableQuestionStatus,
  WatcherQuestionState
} from './orchestration/orchestration-contract'

export type QuestionEscalationTransition = {
  entry: EscalationEntry
  status: 'resolved' | 'acknowledged'
}

export type OpenWorkerQuestion = {
  entry: EscalationEntry
  messageId: string
  dispatchId: string | null
}

/** The newest worker question still awaiting an answer, identified from its escalation id. */
export function getOpenWorkerQuestion(ledger: WatcherLedger): OpenWorkerQuestion | null {
  const entry = getLatestEscalations(ledger)
    .toReversed()
    .find(
      (candidate) =>
        candidate.escalationKind === 'worker-question' &&
        candidate.status === 'open' &&
        candidate.escalationId.startsWith('worker-question:')
    )
  if (!entry) {
    return null
  }
  const parts = entry.escalationId.split(':')
  const messageId = parts.at(-1)
  if (!messageId) {
    return null
  }
  const dispatchId = parts.length >= 3 ? parts.slice(1, -1).join(':') : null
  return { entry, messageId, dispatchId: dispatchId === 'unknown' ? null : dispatchId }
}

/** The question escalation and the park it caused: the question resolves, the park is acknowledged. */
export function getQuestionEscalationsToResolve(
  ledger: WatcherLedger,
  watcherId: string,
  messageId: string
): readonly QuestionEscalationTransition[] {
  const parkId = `park:${watcherId}:worker-question`
  const transitions: QuestionEscalationTransition[] = []
  for (const entry of getLatestEscalations(ledger)) {
    if (entry.status !== 'open') {
      continue
    }
    const matchesQuestion =
      entry.escalationKind === 'worker-question' && entry.escalationId.endsWith(`:${messageId}`)
    const matchesPark =
      entry.escalationKind === 'park-worker-question' &&
      (entry.escalationId === parkId ||
        entry.escalationId === `${parkId}:${encodeURIComponent(messageId)}`)
    if (matchesQuestion || matchesPark) {
      transitions.push({ entry, status: matchesQuestion ? 'resolved' : 'acknowledged' })
    }
  }
  return transitions
}

/**
 * The ledger entries that retire a worker question nobody can answer any more, plus the evidence
 * recording why. Empty when the escalation is already closed, so callers can treat it as idempotent.
 */
export function voidedWorkerQuestionEntries(
  ledger: WatcherLedger,
  watcherId: string,
  messageId: string,
  reason: UnanswerableQuestionStatus,
  stamp: { atMs: number; createId(): string }
): readonly LedgerEntry[] {
  const transitions = getQuestionEscalationsToResolve(ledger, watcherId, messageId)
  if (transitions.length === 0) {
    return []
  }
  return [
    {
      eventId: stamp.createId(),
      watcherId,
      atMs: stamp.atMs,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'worker-question-void',
      payload: { messageId, reason }
    },
    ...transitions.map(({ entry, status }) => ({
      ...entry,
      eventId: stamp.createId(),
      atMs: stamp.atMs,
      status,
      foldCount: entry.foldCount + 1
    }))
  ]
}

export type QuestionLedgerAccess = {
  read(watcherId: string): WatcherLedger
  append(entry: LedgerEntry): void
  now(): number
  createId(): string
}

export function appendAnsweredQuestionTransitions(
  access: QuestionLedgerAccess,
  watcherId: string,
  messageId: string
): void {
  for (const { entry, status } of getQuestionEscalationsToResolve(
    access.read(watcherId),
    watcherId,
    messageId
  )) {
    access.append({
      ...entry,
      eventId: access.createId(),
      atMs: access.now(),
      status,
      foldCount: entry.foldCount + 1
    })
  }
}

export function appendVoidedQuestionTransitions(
  access: QuestionLedgerAccess,
  watcherId: string,
  messageId: string,
  reason: UnanswerableQuestionStatus
): void {
  for (const entry of voidedWorkerQuestionEntries(
    access.read(watcherId),
    watcherId,
    messageId,
    reason,
    { atMs: access.now(), createId: access.createId }
  )) {
    access.append(entry)
  }
}

/** Retires an open question whose thread can no longer take an answer, so `resume` stops refusing. */
export async function voidUnanswerableQuestion(
  access: QuestionLedgerAccess,
  readQuestion: (messageId: string) => Promise<WatcherQuestionState>,
  watcherId: string
): Promise<void> {
  const open = getOpenWorkerQuestion(access.read(watcherId))
  if (!open) {
    return
  }
  const state = await readQuestion(open.messageId)
  if (state.status === 'pending' || state.status === 'unverifiable') {
    return
  }
  appendVoidedQuestionTransitions(access, watcherId, open.messageId, state.status)
}
