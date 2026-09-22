import type {
  WatcherFleetActivity,
  WatcherFleetEntry,
  WatcherFleetParallelSummary,
  WatcherFleetWorkspace,
  WatcherOwnerFence
} from '../../shared/fork-heimdall/fleet-types'
import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'

const ATTENTION_RANK: Record<WatcherListEntry['status']['state'], number> = {
  escalated: 0,
  parked: 0,
  unreachable: 1,
  held: 2,
  acting: 3,
  watching: 4,
  disabled: 5,
  terminal: 6
}

export function watcherOwnerFence(entry: WatcherListEntry): WatcherOwnerFence {
  const enrollment = entry.enrollment
  return {
    executionHostId: enrollment.executionHostId,
    schedulerOwner: enrollment.schedulerOwner,
    workspaceKey: enrollment.workspaceKey,
    revision: enrollment.commandRevision
  }
}

function latestSnapshotString(traces: readonly WatcherTickTrace[], key: string): string | null {
  let latest: WatcherTickTrace | null = null
  for (const trace of traces) {
    if (
      trace.snapshot &&
      Object.hasOwn(trace.snapshot, key) &&
      (!latest || trace.seq > latest.seq)
    ) {
      latest = trace
    }
  }
  const value = latest?.snapshot?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function workspaceSummary(
  entry: WatcherListEntry,
  traces: readonly WatcherTickTrace[],
  label: string | null
): WatcherFleetWorkspace {
  const enrollment = entry.enrollment
  const payload =
    typeof enrollment.kindPayload === 'object' && enrollment.kindPayload !== null
      ? (enrollment.kindPayload as Record<string, unknown>)
      : null
  const objectiveWorkspaceKind =
    enrollment.kind === 'objective' &&
    (payload?.workspaceKind === 'git' || payload?.workspaceKind === 'folder')
      ? payload.workspaceKind
      : null
  const kind =
    enrollment.kind === 'hosted-review'
      ? 'git'
      : (objectiveWorkspaceKind ?? (enrollment.worktreeId === null ? 'folder' : 'git'))
  const withoutTrailingSeparators = enrollment.workspacePath.replace(/[\\/]+$/, '')
  const pathLabel = withoutTrailingSeparators.split(/[\\/]/).at(-1) || enrollment.workspacePath
  const hostedReviewBranch =
    enrollment.kind === 'hosted-review' && typeof payload?.branch === 'string'
      ? payload.branch.trim() || null
      : null
  return {
    label: label?.trim() || pathLabel,
    kind,
    branch:
      kind === 'folder'
        ? null
        : enrollment.kind === 'objective'
          ? latestSnapshotString(traces, 'branch')
          : hostedReviewBranch
  }
}

function activitySummary(ledger: WatcherLedger, owned: boolean): WatcherFleetActivity | undefined {
  if (!owned) {
    return undefined
  }
  const inFlight = getInFlightAttempts(ledger)
  if (inFlight.length === 0) {
    return { kind: 'waiting', count: 0, detail: null, startedAtMs: null }
  }

  let firstAgent: (typeof inFlight)[number] | null = null
  let firstCheck: (typeof inFlight)[number] | null = null
  let firstAction = inFlight[0]!
  let agentCount = 0
  let checkCount = 0
  for (const attempt of inFlight) {
    if (attempt.atMs < firstAction.atMs) {
      firstAction = attempt
    }
    if (attempt.dispatch !== undefined) {
      agentCount += 1
      if (!firstAgent || attempt.atMs < firstAgent.atMs) {
        firstAgent = attempt
      }
    } else if (attempt.action.kind === 'run-check' || attempt.action.capability === 'check') {
      checkCount += 1
      if (!firstCheck || attempt.atMs < firstCheck.atMs) {
        firstCheck = attempt
      }
    }
  }
  if (firstAgent) {
    return {
      kind: 'agent-in-flight',
      count: agentCount,
      detail: firstAgent.dispatch?.taskKey ?? firstAgent.action.kind,
      startedAtMs: firstAgent.atMs
    }
  }
  if (firstCheck) {
    return {
      kind: 'check-running',
      count: checkCount,
      detail: firstCheck.action.kind,
      startedAtMs: firstCheck.atMs
    }
  }
  return {
    kind: 'action-running',
    count: inFlight.length,
    detail: firstAction.action.kind,
    startedAtMs: firstAction.atMs
  }
}

export type LocalFleetProjectionInput = {
  ledger: WatcherLedger
  traces: readonly WatcherTickTrace[]
  workspaceLabel: string | null
  parallel?: WatcherFleetParallelSummary
}

export type LocalFleetProjectionRevision = {
  ledgerEntryCount: number
  firstLedgerEventId: string | null
  lastLedgerEventId: string | null
  traceCount: number
  firstTraceSequence: number | null
  lastTrace: string | null
}

/**
 * Compact per-watcher revision evidence for detail-only data which is not present
 * in the fleet row itself. Ledger rows are append-only, while traces are bounded
 * and only the live tail can change in place.
 */
export function localFleetProjectionRevision(
  projection: LocalFleetProjectionInput
): LocalFleetProjectionRevision {
  const firstLedgerEntry = projection.ledger.entries[0]
  const lastLedgerEntry = projection.ledger.entries.at(-1)
  const firstTrace = projection.traces[0]
  const lastTrace = projection.traces.at(-1)
  return {
    ledgerEntryCount: projection.ledger.entries.length,
    firstLedgerEventId: firstLedgerEntry?.eventId ?? null,
    lastLedgerEventId: lastLedgerEntry?.eventId ?? null,
    traceCount: projection.traces.length,
    firstTraceSequence: firstTrace?.seq ?? null,
    lastTrace: lastTrace ? (JSON.stringify(lastTrace) ?? null) : null
  }
}

export function localFleetEntry(
  entry: WatcherListEntry,
  observedAtMs: number,
  owned: boolean,
  projection: LocalFleetProjectionInput
): WatcherFleetEntry {
  const capabilityNotes: string[] = []
  if (entry.enrollment.schedulerOwner === 'ssh_bridge') {
    capabilityNotes.push(
      'SSH control requires this desktop client to stay connected; use a remote runtime for unattended work.'
    )
  }
  const kindPayload = entry.enrollment.kindPayload
  if (
    entry.enrollment.kind === 'objective' &&
    typeof kindPayload === 'object' &&
    kindPayload !== null &&
    'workspaceKind' in kindPayload &&
    kindPayload.workspaceKind === 'folder'
  ) {
    capabilityNotes.push(
      'Folder workspaces cannot create worktrees, so objective concurrency is limited to 1.'
    )
  }
  const activity = activitySummary(projection.ledger, owned)
  const parallel =
    projection.parallel &&
    entry.enrollment.kind === 'objective' &&
    typeof kindPayload === 'object' &&
    kindPayload !== null &&
    'maxConcurrency' in kindPayload &&
    typeof kindPayload.maxConcurrency === 'number'
      ? {
          ...projection.parallel,
          effectiveMaxConcurrency:
            'workspaceKind' in kindPayload && kindPayload.workspaceKind === 'folder'
              ? 1
              : kindPayload.maxConcurrency
        }
      : projection.parallel
  return {
    target: { watcherId: entry.enrollment.watcherId, connectionId: null, pairingRevision: null },
    entry,
    ownerFence: watcherOwnerFence(entry),
    observedAtMs,
    contact: 'live',
    readOnlyReason: owned ? null : 'This watcher is owned by another runtime.',
    capabilityNotes,
    paused: entry.enrollment.paused,
    workflowPhase:
      entry.enrollment.kind === 'objective'
        ? latestSnapshotString(projection.traces, 'phase')
        : entry.status.phase,
    ...(activity ? { activity } : {}),
    ...(parallel ? { parallel } : {}),
    workspace: workspaceSummary(entry, projection.traces, projection.workspaceLabel)
  }
}

export function sortLocalFleetByAttention(entries: WatcherFleetEntry[]): WatcherFleetEntry[] {
  return entries.sort((left, right) => {
    const attention =
      ATTENTION_RANK[left.entry.status.state] - ATTENTION_RANK[right.entry.status.state]
    if (attention !== 0) {
      return attention
    }
    const created = left.entry.enrollment.createdAtMs - right.entry.enrollment.createdAtMs
    return created !== 0
      ? created
      : left.entry.enrollment.watcherId.localeCompare(right.entry.enrollment.watcherId)
  })
}
