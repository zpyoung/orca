import {
  getInFlightAttempts,
  getLatestEscalations
} from '../../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { StallDeviation } from '../../../shared/fork-heimdall/owner/deviation'
import type { WorkerIdleObservation } from '../orchestration/orchestration-contract'
import { mailboxBody } from '../runner-mailbox'
import {
  decodeOwnerDeviation,
  isOwnerDeviationEscalation,
  ownerDeviationEscalationId
} from './deviation-ledger'

/** Long enough for an agent to finish a turn and pick its next tool call, short next to the backstop. */
export const OWNER_IDLE_GRACE_MS = 120_000

const MAIL_THAT_SPEAKS_FOR_THE_WORKER: Record<string, true> = {
  worker_done: true,
  question: true,
  escalation: true
}

type IdleObservation = Extract<WorkerIdleObservation, { status: 'idle' }>

export type IdleStall = {
  stall: StallDeviation
  observation: IdleObservation
}

export type IdleStallDetection = {
  stalls: IdleStall[]
  /** Delay until the earliest worker still inside its grace window becomes eligible, if any. */
  recheckInMs: number | null
}

function taskKeyOf(attempt: AttemptEntry): string | undefined {
  return 'taskKey' in attempt.action && typeof attempt.action.taskKey === 'string'
    ? attempt.action.taskKey
    : undefined
}

function workerSpokeSince(ledger: WatcherLedger, dispatchId: string, sinceMs: number): boolean {
  return ledger.entries.some((entry) => {
    if (entry.kind !== 'evidence' || entry.atMs < sinceMs) {
      return false
    }
    const body = mailboxBody(entry)
    return body?.dispatchId === dispatchId && MAIL_THAT_SPEAKS_FOR_THE_WORKER[body.type] === true
  })
}

function hasOpenWorkerChannel(ledger: WatcherLedger, dispatchId: string): boolean {
  const encoded = encodeURIComponent(dispatchId)
  return getLatestEscalations(ledger).some((entry) => {
    if (entry.status !== 'open' && entry.status !== 'escalated') {
      return false
    }
    if (entry.escalationKind === 'worker-question') {
      return entry.escalationId.startsWith(`worker-question:${dispatchId}:`)
    }
    if (entry.escalationKind === 'worker-escalation') {
      return entry.escalationId.startsWith(`worker-escalation:${encoded}:`)
    }
    if (isOwnerDeviationEscalation(entry)) {
      const deviation = decodeOwnerDeviation(entry)
      return deviation !== null && 'dispatchId' in deviation && deviation.dispatchId === dispatchId
    }
    return false
  })
}

/** Running dispatches with no open question, escalation or deviation: the only ones worth observing. */
export function idleStallCandidateDispatchIds(ledger: WatcherLedger): string[] {
  const dispatchIds = new Set<string>()
  for (const attempt of getInFlightAttempts(ledger)) {
    if (
      attempt.state === 'running' &&
      attempt.dispatchId &&
      !hasOpenWorkerChannel(ledger, attempt.dispatchId)
    ) {
      dispatchIds.add(attempt.dispatchId)
    }
  }
  return [...dispatchIds]
}

/** A resolved stall re-raises only for an idle episode that began after the one it settled. */
function settledForThisEpisode(
  ledger: WatcherLedger,
  stall: StallDeviation,
  idleSinceMs: number
): boolean {
  const escalationId = ownerDeviationEscalationId(ledger.watcherId, stall)
  const latest = getLatestEscalations(ledger).find((entry) => entry.escalationId === escalationId)
  if (!latest || !isOwnerDeviationEscalation(latest)) {
    return false
  }
  const prior = decodeOwnerDeviation(latest)
  const priorIdleSinceMs = prior?.kind === 'stall' ? prior.idleSinceMs : undefined
  return priorIdleSinceMs === undefined
    ? idleSinceMs <= latest.atMs
    : idleSinceMs <= priorIdleSinceMs
}

/**
 * Running dispatches whose worker has sat idle at its prompt for at least `graceMs` without saying
 * anything through a structured channel. Pure: liveness and the last message arrive pre-observed.
 */
export function detectIdleStall(args: {
  ledger: WatcherLedger
  nowMs: number
  observations: ReadonlyMap<string, WorkerIdleObservation>
  graceMs?: number
}): IdleStallDetection {
  const graceMs = args.graceMs ?? OWNER_IDLE_GRACE_MS
  const stalls: IdleStall[] = []
  let recheckInMs: number | null = null
  for (const attempt of getInFlightAttempts(args.ledger)) {
    const dispatchId = attempt.dispatchId
    if (attempt.state !== 'running' || !dispatchId) {
      continue
    }
    const observation = args.observations.get(dispatchId)
    if (observation?.status !== 'idle') {
      continue
    }
    const idleForMs = args.nowMs - observation.idleSinceMs
    if (
      workerSpokeSince(args.ledger, dispatchId, observation.idleSinceMs) ||
      hasOpenWorkerChannel(args.ledger, dispatchId)
    ) {
      continue
    }
    if (idleForMs < graceMs) {
      const remaining = graceMs - idleForMs
      recheckInMs = recheckInMs === null ? remaining : Math.min(recheckInMs, remaining)
      continue
    }
    const taskKey = taskKeyOf(attempt)
    const stall: StallDeviation = {
      kind: 'stall',
      what: attempt.action.kind,
      dispatchId,
      ...(taskKey ? { taskKey } : {}),
      inFlightSinceMs: Math.min(attempt.atMs, observation.idleSinceMs),
      thresholdMs: graceMs,
      trigger: 'idle',
      idleSinceMs: observation.idleSinceMs,
      ...(observation.lastMessage?.text
        ? {
            lastMessage: observation.lastMessage.text,
            messageTruncated: observation.lastMessage.truncated
          }
        : {})
    }
    if (settledForThisEpisode(args.ledger, stall, observation.idleSinceMs)) {
      continue
    }
    stalls.push({ stall, observation })
  }
  return { stalls, recheckInMs }
}
