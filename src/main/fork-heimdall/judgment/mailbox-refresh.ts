import {
  getLastDecidedContentIdentity,
  getUnresolvedAttempts
} from '../../../shared/fork-heimdall/ledger-queries'
import { HEIMDALL_FULL_RESYNC_MS } from '../../../shared/fork-heimdall/pacing'
import { requireLiveSnapshot, type Snapshot } from '../../../shared/fork-heimdall/snapshot'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherTickTrace } from '../../../shared/fork-heimdall/tick-trace'
import type { WatcherRunner } from '../runner-state'

export type JudgmentMailboxBaseline = ReadonlySet<string> | null

export function captureJudgmentMailboxBaseline(
  snapshot: Snapshot<unknown>,
  ledger: WatcherLedger
): JudgmentMailboxBaseline {
  if (snapshot.world === null || typeof snapshot.world !== 'object') {
    return null
  }
  const judgment = (snapshot.world as Record<string, unknown>).judgment
  if (judgment === null || typeof judgment !== 'object') {
    return null
  }
  const status = (judgment as Record<string, unknown>).status
  return status === 'disabled' || status === 'remote'
    ? null
    : new Set(ledger.entries.map((entry) => entry.eventId))
}

function hasNewJudgmentEvidence(ledger: WatcherLedger, baseline: ReadonlySet<string>): boolean {
  return ledger.entries.some((entry) => {
    if (
      baseline.has(entry.eventId) ||
      entry.kind !== 'evidence' ||
      entry.evidenceKind !== 'orchestration-mailbox' ||
      entry.payload === null ||
      typeof entry.payload !== 'object' ||
      Array.isArray(entry.payload)
    ) {
      return false
    }
    const type = (entry.payload as Record<string, unknown>).type
    return type === 'worker_done' || type === 'escalation'
  })
}

export async function refreshJudgmentAfterMailbox(args: {
  runner: WatcherRunner
  ledger: WatcherLedger
  baseline: JudgmentMailboxBaseline
  trace: WatcherTickTrace
  fresh: boolean
  now: number
}): Promise<Snapshot<unknown> | null> {
  if (!args.baseline || !hasNewJudgmentEvidence(args.ledger, args.baseline)) {
    return null
  }
  const read = await args.runner.kind.read(args.runner.enrollment, { fresh: args.fresh })
  if (!args.runner.leaseGuard) {
    throw new Error('Judgment mailbox refresh reached a durable outcome without a lease')
  }
  await args.runner.leaseGuard.assertHeld()
  const snapshot = args.fresh ? requireLiveSnapshot(read) : read
  args.trace.snapshotReadCount += 1
  args.runner.lastSnapshot = snapshot
  args.trace.snapshot = args.runner.kind.describeSnapshot(snapshot)
  args.trace.contentIdentity = snapshot.contentIdentity
  if (args.fresh) {
    args.runner.lastFullResyncAtMs = args.now
    args.runner.forceFresh = false
  }
  return snapshot
}

export async function readAndRefreshJudgmentSnapshot(args: {
  runner: WatcherRunner
  ledger: WatcherLedger
  trace: WatcherTickTrace
  leaseGuard: NonNullable<WatcherRunner['leaseGuard']>
  now: () => number
  readLedger: () => WatcherLedger
  abandonPendingAttempts: (ledger: WatcherLedger) => void
  refreshWorkers: () => Promise<WatcherLedger | null>
}): Promise<{ snapshot: Snapshot<unknown>; ledger: WatcherLedger } | null> {
  let ledger = args.ledger
  const fullResyncDue =
    args.runner.forceFresh ||
    getUnresolvedAttempts(ledger).length > 0 ||
    args.runner.lastFullResyncAtMs === null ||
    args.now() - args.runner.lastFullResyncAtMs >= HEIMDALL_FULL_RESYNC_MS
  args.trace.fullResyncDue = fullResyncDue
  let snapshot = await args.runner.kind.read(args.runner.enrollment, { fresh: fullResyncDue })
  await args.leaseGuard.assertHeld()
  args.trace.snapshotReadCount += 1
  if (fullResyncDue && snapshot.freshness !== 'live') {
    throw new Error('A fresh watcher read returned a cached snapshot')
  }
  if (snapshot.freshness === 'live') {
    args.runner.lastFullResyncAtMs = args.now()
    args.runner.forceFresh = false
  }
  args.runner.lastSnapshot = snapshot
  args.trace.snapshot = args.runner.kind.describeSnapshot(snapshot)
  args.trace.contentIdentity = snapshot.contentIdentity

  const previousIdentity = getLastDecidedContentIdentity(ledger)
  if (previousIdentity && previousIdentity !== snapshot.contentIdentity) {
    args.abandonPendingAttempts(ledger)
    ledger = args.readLedger()
  }

  const baseline = captureJudgmentMailboxBaseline(snapshot, ledger)
  const refreshedLedger = await args.refreshWorkers()
  const judgmentSnapshot = await refreshJudgmentAfterMailbox({
    runner: args.runner,
    ledger: refreshedLedger ?? args.readLedger(),
    baseline,
    trace: args.trace,
    fresh: refreshedLedger !== null,
    now: args.now()
  })
  if (!refreshedLedger) {
    return null
  }
  ledger = refreshedLedger
  if (judgmentSnapshot) {
    snapshot = judgmentSnapshot
    ledger = args.readLedger()
  }
  return { snapshot, ledger }
}
