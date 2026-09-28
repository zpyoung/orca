import { getLatestEscalations } from '../../../shared/fork-heimdall/ledger-queries'
import type { EscalationEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import {
  DeviationSchema,
  ownerDeviationEscalationId,
  type Deviation
} from '../../../shared/fork-heimdall/owner/deviation'
import type { RunnerLedgerStore } from '../runner-state'

export { ownerDeviationEscalationId }

export const OWNER_DEVIATION_ESCALATION_KIND = 'owner-deviation'

export type OwnerDeviationEscalation = EscalationEntry & { escalationKind: 'owner-deviation' }

function isOwnerDeviationEscalation(entry: EscalationEntry): entry is OwnerDeviationEscalation {
  return entry.escalationKind === 'owner-deviation'
}

export function ownerDeviationWakeToken(entry: OwnerDeviationEscalation): string {
  const wakeId = decodeReason(entry.reason)?.wakeId
  return wakeId
    ? `${entry.escalationId}:${entry.foldCount}:${wakeId}`
    : `${entry.escalationId}:${entry.foldCount}`
}

export function ownerInterventionSubmissionSubject(
  watcherId: string,
  entry: OwnerDeviationEscalation
): string {
  return `heimdall-owner-intervention:${watcherId}:${ownerDeviationWakeToken(entry)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** When the owner's ready submission for this wake was first accepted, or null if it hasn't been. */
export function ownerInterventionAcceptedAtMs(
  ledger: WatcherLedger,
  watcherId: string,
  pending: OwnerDeviationEscalation
): number | null {
  const subject = ownerInterventionSubmissionSubject(watcherId, pending)
  const accepted = ledger.entries.find((entry) => {
    if (entry.kind !== 'evidence' || entry.evidenceKind !== 'orchestration-mailbox') {
      return false
    }
    const fact = entry.payload
    return (
      isRecord(fact) && fact.type === 'status' && fact.subject === subject && fact.body === 'ready'
    )
  })
  return accepted?.atMs ?? null
}

// `EscalationEntry.reason` is a free-form string; encoding the deviation into it round-trips the
// structured value through the same durable, dedupe-by-id mechanism a worker escalation already
// uses, without a new ledger entry kind. `wakeId` was added compatibly: legacy records omit it and
// retain their already-issued `escalationId:foldCount` token across an upgrade.
type EncodedReason = { summary: string; note: string; deviation: Deviation; wakeId?: string }

function encodeReason(deviation: Deviation, note: string, wakeId?: string): string {
  const summary = deviation.detail ? `${deviation.kind}: ${deviation.detail}` : deviation.kind
  return JSON.stringify({
    summary,
    note,
    deviation,
    ...(wakeId === undefined ? {} : { wakeId })
  } satisfies EncodedReason)
}

function decodeReason(reason: string | undefined): EncodedReason | null {
  if (!reason) {
    return null
  }
  try {
    const raw: unknown = JSON.parse(reason)
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('summary' in raw) ||
      typeof raw.summary !== 'string' ||
      !('note' in raw) ||
      typeof raw.note !== 'string' ||
      ('wakeId' in raw &&
        raw.wakeId !== undefined &&
        (typeof raw.wakeId !== 'string' || raw.wakeId.length === 0)) ||
      !('deviation' in raw)
    ) {
      return null
    }
    const deviation = DeviationSchema.safeParse(raw.deviation)
    const wakeId = 'wakeId' in raw && typeof raw.wakeId === 'string' ? raw.wakeId : undefined
    return deviation.success
      ? {
          summary: raw.summary,
          note: raw.note,
          deviation: deviation.data,
          ...(wakeId === undefined ? {} : { wakeId })
        }
      : null
  } catch {
    return null
  }
}

/** The structured deviation an owner-deviation escalation was recorded for, if it decodes cleanly. */
export function decodeOwnerDeviation(entry: OwnerDeviationEscalation): Deviation | null {
  return decodeReason(entry.reason)?.deviation ?? null
}

/** A short human-readable line for status/debug surfaces; falls back to the raw reason if undecodable. */
export function describeOwnerDeviationEscalation(entry: OwnerDeviationEscalation): string {
  const decoded = decodeReason(entry.reason)
  return decoded ? `${decoded.summary} (${decoded.note})` : (entry.reason ?? entry.escalationId)
}

/** The current owner-deviation escalation for `deviation`, if this watcher has recorded one. */
export function findOwnerDeviationEscalation(
  ledger: WatcherLedger,
  watcherId: string,
  deviation: Deviation
): OwnerDeviationEscalation | null {
  const escalationId = ownerDeviationEscalationId(watcherId, deviation)
  const entry = getLatestEscalations(ledger).find(
    (candidate) => candidate.escalationId === escalationId
  )
  return entry && isOwnerDeviationEscalation(entry) ? entry : null
}

/** The oldest still-open owner-deviation escalation, since the owner processes one turn at a time. */
export function findOldestOpenOwnerDeviation(
  ledger: WatcherLedger
): OwnerDeviationEscalation | null {
  const open = getLatestEscalations(ledger).filter(
    (entry): entry is OwnerDeviationEscalation =>
      entry.escalationKind === 'owner-deviation' && entry.status === 'open'
  )
  return open.length === 0
    ? null
    : open.reduce((oldest, candidate) => (candidate.atMs < oldest.atMs ? candidate : oldest))
}

export type DeviationRecordDependencies = {
  ledgerStore: Pick<RunnerLedgerStore, 'append' | 'read'>
  now(): number
  createId(): string
}

/**
 * Records `deviation` as an open escalation, deduping a repeat observation on a later tick the same
 * way a worker escalation dedupes. Returns the entry whether it was newly appended or already open.
 *
 * `foldCount` restarts at 1 for a fresh occurrence rather than carrying forward a prior, now-dead
 * lifecycle's count — matching `park()`'s own convention, and required so a deviation that recurs
 * after resolving gets its own full retry-once budget rather than inheriting exhaustion from the
 * earlier occurrence's history.
 */
export function recordDeviation(
  dependencies: DeviationRecordDependencies,
  watcherId: string,
  deviation: Deviation
): OwnerDeviationEscalation {
  const ledger = dependencies.ledgerStore.read(watcherId)
  const existing = findOwnerDeviationEscalation(ledger, watcherId, deviation)
  if (existing && (existing.status === 'open' || existing.status === 'escalated')) {
    return existing
  }
  const eventId = dependencies.createId()
  const entry: OwnerDeviationEscalation = {
    eventId,
    watcherId,
    atMs: dependencies.now(),
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: ownerDeviationEscalationId(watcherId, deviation),
    escalationKind: 'owner-deviation',
    status: 'open',
    foldCount: 1,
    reason: encodeReason(deviation, 'recorded', eventId)
  }
  dependencies.ledgerStore.append(watcherId, entry)
  return entry
}

/**
 * Marks the current turn as sent without spending a retry — `recordDeviation`/`reRaiseDeviation`
 * open a turn (bump `foldCount`); this only flips its note once the brief has actually gone out, so
 * a crash between recording and sending resumes as "not yet sent" rather than skipping the send.
 */
export function markOwnerTurnSent(
  dependencies: DeviationRecordDependencies,
  watcherId: string,
  current: OwnerDeviationEscalation
): OwnerDeviationEscalation {
  const decoded = decodeReason(current.reason)
  if (!decoded) {
    throw new Error(`Owner deviation escalation ${current.escalationId} does not decode`)
  }
  const entry: OwnerDeviationEscalation = {
    ...current,
    eventId: dependencies.createId(),
    atMs: dependencies.now(),
    reason: encodeReason(decoded.deviation, 'waiting-for-reply', decoded.wakeId)
  }
  dependencies.ledgerStore.append(watcherId, entry)
  return entry
}

export function ownerTurnAwaitingSend(entry: OwnerDeviationEscalation): boolean {
  return decodeReason(entry.reason)?.note !== 'waiting-for-reply'
}

/** Re-raises or re-wakes for the same deviation, bumping the retry-once counter with a fresh note. */
export function reRaiseDeviation(
  dependencies: DeviationRecordDependencies,
  watcherId: string,
  current: OwnerDeviationEscalation,
  note: string
): OwnerDeviationEscalation {
  const decoded = decodeReason(current.reason)
  if (!decoded) {
    throw new Error(`Owner deviation escalation ${current.escalationId} does not decode`)
  }
  const entry: OwnerDeviationEscalation = {
    ...current,
    eventId: dependencies.createId(),
    atMs: dependencies.now(),
    status: 'open',
    foldCount: current.foldCount + 1,
    reason: encodeReason(decoded.deviation, note, decoded.wakeId)
  }
  dependencies.ledgerStore.append(watcherId, entry)
  return entry
}

/** Marks a deviation as escalated to a human; the caller still owns the actual park transition. */
export function escalateDeviationToHuman(
  dependencies: DeviationRecordDependencies,
  watcherId: string,
  current: OwnerDeviationEscalation,
  note: string
): OwnerDeviationEscalation {
  const decoded = decodeReason(current.reason)
  const entry: OwnerDeviationEscalation = {
    ...current,
    eventId: dependencies.createId(),
    atMs: dependencies.now(),
    status: 'escalated',
    foldCount: current.foldCount + 1,
    reason: decoded ? encodeReason(decoded.deviation, note, decoded.wakeId) : note
  }
  dependencies.ledgerStore.append(watcherId, entry)
  return entry
}

export function resolveDeviation(
  dependencies: DeviationRecordDependencies,
  watcherId: string,
  current: OwnerDeviationEscalation
): void {
  dependencies.ledgerStore.append(watcherId, {
    ...current,
    eventId: dependencies.createId(),
    atMs: dependencies.now(),
    status: 'resolved',
    foldCount: current.foldCount + 1
  })
}

/**
 * Retry-once budget: `foldCount` starts at 1 on the first owner wake, 2 once re-raised, so a
 * rejection or a stall observed at 2 means the retry was already spent and the next stop is a
 * human, not a third owner turn.
 */
export function deviationRetriesExhausted(entry: OwnerDeviationEscalation): boolean {
  return entry.foldCount >= 2
}
