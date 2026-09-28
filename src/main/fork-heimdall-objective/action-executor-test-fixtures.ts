import { vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type {
  ObjectiveCheckAttempt,
  ObjectiveGateAttempt,
  ObjectivePlanPatchRecord,
  ObjectivePlanReviewRecord
} from './objective-store'

export const TEST_LEASE = {
  epoch: 1,
  holder: 'test-holder',
  assertHeld: vi.fn(async () => undefined),
  renewLoop: () => ({ dispose: () => undefined })
} satisfies LeaseGuard

export const contract = {
  objectiveText: 'Implement the objective.',
  tier: 'standard' as const,
  landingBar: 'files-on-disk' as const,
  maxConcurrency: 1,
  workspaceKind: 'folder' as const,
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

export const enrollment: WatcherEnrollment = {
  watcherId: 'watcher-1',
  kind: 'objective',
  workspaceKey: 'local::/workspace',
  executionHostId: 'local',
  repoId: 'repo-1',
  worktreeId: null,
  workspacePath: '/workspace',
  schedulerOwner: 'local_host_service',
  capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'on' },
  budget: { wallClockActiveMs: 60_000, turns: 10 },
  kindPayload: contract,
  enabled: true,
  paused: false,
  commandRevision: 0,
  coordinatorIdentity: { handle: 'watcher-1', paneKey: 'pane-1' },
  orchestrationRunId: null,
  createdAtMs: 1,
  terminalAtMs: null
}

export function snapshot(contentIdentity = 'new-content'): LiveSnapshot<ObjectiveWorld> {
  return {
    freshness: 'live',
    contentIdentity,
    observedAtMs: 10,
    world: {
      contract,
      workspaceKind: 'folder',
      plan: { revisions: [], nodes: [], verdicts: [], landing: [] },
      reports: [],
      budget: enrollment.budget,
      landingContext: {
        branch: null,
        headSha: null,
        worktreeContentDigest: null,
        pushTarget: null,
        hostedReview: null
      }
    }
  }
}

export function checkAttempt(
  overrides: Partial<ObjectiveCheckAttempt> = {}
): ObjectiveCheckAttempt {
  return {
    id: 'check-1',
    watcherId: 'watcher-1',
    criterionId: 'criterion-1',
    contentIdentity: 'new-content',
    executionHostId: 'host-1',
    command: 'npm test',
    epoch: 0,
    startedAtMs: 0,
    exitCode: null,
    timedOut: false,
    stdoutTail: '',
    stderrTail: '',
    completedAtMs: null,
    ownerSkip: false,
    ...overrides
  }
}

export function gateAttempt(overrides: Partial<ObjectiveGateAttempt> = {}): ObjectiveGateAttempt {
  return {
    id: 'gate-1',
    watcherId: 'watcher-1',
    gateName: 'full-suite',
    contentIdentity: 'new-content',
    executionHostId: 'host-1',
    command: 'pnpm test',
    epoch: 0,
    startedAtMs: 0,
    exitCode: null,
    timedOut: false,
    stdoutTail: '',
    stderrTail: '',
    completedAtMs: null,
    ...overrides
  }
}

export function planPatchRecord(
  overrides: Partial<ObjectivePlanPatchRecord> = {}
): ObjectivePlanPatchRecord {
  return {
    id: 'patch-1',
    watcherId: 'watcher-1',
    revisionId: 'revision-1',
    createdByDispatchId: 'dispatch-1',
    repairOrdinal: 0,
    report: { repair: { upsertTasks: [], dropTaskKeys: [] } },
    digest: 'patch-digest-1',
    status: 'pending',
    rejection: null,
    createdAtMs: 0,
    resolvedAtMs: null,
    ...overrides
  }
}

export function planReviewRecord(
  overrides: Partial<ObjectivePlanReviewRecord> = {}
): ObjectivePlanReviewRecord {
  return {
    id: 'plan-review-1',
    watcherId: 'watcher-1',
    targetKind: 'revision',
    targetId: 'revision-1',
    round: 1,
    dispatchId: 'dispatch-plan-review-1',
    report: { verdict: 'approve', assumptions: [], findings: [], summary: 'Plan looks sound.' },
    reportDigest: 'digest-1',
    createdAtMs: 0,
    ...overrides
  }
}

/** Reads a mailbox evidence entry's outer payload as a mutable bag for constructing malformed fixtures. */
export function evidencePayload(entry: LedgerEntry): Record<string, unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: evidence payload is schema-unknown; tests deliberately mutate it into malformed shapes to exercise rejection paths.
  return entry.kind === 'evidence' ? (entry.payload as Record<string, unknown>) : {}
}

/** Reads a mailbox message's inner payload as a mutable bag for constructing malformed fixtures. */
export function innerMailboxPayload(message: Record<string, unknown>): Record<string, unknown> {
  return typeof message.payload === 'object' && message.payload !== null
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: evidence payload is schema-unknown; tests deliberately mutate it into malformed shapes to exercise rejection paths.
      (message.payload as Record<string, unknown>)
    : {}
}

export function attempt(
  action: ObjectiveAction,
  overrides: Partial<AttemptEntry> = {}
): AttemptEntry {
  return {
    eventId: 'event-1',
    watcherId: 'watcher-1',
    atMs: 2,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey),
    action,
    state: 'settled',
    effect: 'indeterminate',
    dispatch: {
      spec: 'Execute the objective role.',
      taskKey: 'node-a',
      deps: [],
      dispatchKind: 'child'
    },
    dispatchId: 'dispatch-1',
    ...overrides
  }
}

export function workerDone(outcome: 'succeeded' | 'failed'): LedgerEntry {
  return {
    eventId: 'mailbox-1',
    watcherId: 'watcher-1',
    atMs: 5,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      payload: {
        dispatchId: 'dispatch-1',
        outcome,
        reportPath: '/workspace/report.json',
        filesModified: ['src/a.ts']
      }
    }
  }
}
export function workerHeartbeat(): LedgerEntry {
  return {
    eventId: 'mailbox-heartbeat',
    watcherId: 'watcher-1',
    atMs: 4,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'heartbeat',
      payload: { dispatchId: 'dispatch-1', taskId: 'task-1' }
    }
  }
}
