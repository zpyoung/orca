import { WORKER_EXITED_WITHOUT_COMPLETION } from '../fork-heimdall/effect-certainty'
import type {
  AttemptEntry,
  EvidenceEntry,
  LedgerEntry,
  WatcherLedger
} from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  OBJECTIVE_ABSENT_REMOTE_REF_STATE,
  type ObjectiveCapabilities,
  type ObjectiveGate
} from './contract-types'
import type { ObjectiveAction } from './objective-actions'
import type {
  ObjectiveGateAttemptProjection,
  ObjectiveNodeProjection,
  ObjectivePlanPatchProjection,
  ObjectivePlanReviewProjection,
  ObjectiveProjection,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'

export { WORKER_EXITED_WITHOUT_COMPLETION }

export const CONTRACT: ObjectiveWorld['contract'] = {
  objectiveText: 'Implement the objective',
  tier: 'standard',
  landingBar: 'files-on-disk',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

export function revision(
  overrides: Partial<ObjectiveRevisionProjection> = {}
): ObjectiveRevisionProjection {
  return {
    id: 'revision-1',
    number: 1,
    status: 'approved',
    digest: 'plan-digest',
    createdByDispatchId: 'planner-dispatch',
    createdAtMs: 10,
    approvedAtMs: 20,
    ...overrides
  }
}

export function node(
  taskKey: string,
  overrides: Partial<ObjectiveNodeProjection> = {}
): ObjectiveNodeProjection {
  return {
    revisionId: 'revision-1',
    taskKey,
    deps: [],
    orchestrationTaskId: null,
    dispatchId: null,
    state: 'pending',
    criteria: [],
    ...overrides
  }
}

export function capabilities(
  overrides: Partial<ObjectiveCapabilities> = {}
): ObjectiveCapabilities {
  return { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'on', ...overrides }
}

export function patch(
  overrides: Partial<ObjectivePlanPatchProjection> = {}
): ObjectivePlanPatchProjection {
  return {
    id: 'patch-1',
    revisionId: 'revision-1',
    createdByDispatchId: 'repair-planner-1',
    repairOrdinal: 1,
    digest: 'patch-digest-1',
    status: 'pending',
    rejection: null,
    touchedTaskKeys: [],
    createdAtMs: 10,
    resolvedAtMs: null,
    ...overrides
  }
}

export function planReview(
  overrides: Partial<ObjectivePlanReviewProjection> = {}
): ObjectivePlanReviewProjection {
  return {
    id: 'plan-review-1',
    targetKind: 'revision',
    targetId: 'revision-1',
    round: 1,
    dispatchId: 'plan-review-dispatch-1',
    verdict: 'approve',
    reportDigest: 'plan-review-digest-1',
    createdAtMs: 15,
    ...overrides
  }
}

export function gate(name: string, overrides: Partial<ObjectiveGate> = {}): ObjectiveGate {
  return {
    name,
    command: 'pnpm test',
    timeoutSeconds: 1_800,
    ...overrides
  }
}

export function gateAttempt(
  overrides: Partial<ObjectiveGateAttemptProjection> = {}
): ObjectiveGateAttemptProjection {
  return {
    gateName: 'full-suite',
    contentIdentity: 'content-current',
    executionHostId: 'local',
    command: 'pnpm test',
    exitCode: 0,
    timedOut: false,
    stdoutTail: null,
    stderrTail: null,
    startedAtMs: 10,
    completedAtMs: 20,
    ...overrides
  }
}

export function projection(overrides: Partial<ObjectiveProjection> = {}): ObjectiveProjection {
  return {
    revisions: [revision()],
    nodes: [node('core')],
    verdicts: [],
    landing: [],
    ...overrides
  }
}

export function snapshot(
  plan: ObjectiveProjection,
  overrides: Partial<ObjectiveWorld> = {},
  contentIdentity = 'content-current'
): Snapshot<ObjectiveWorld> {
  return {
    freshness: 'live',
    contentIdentity,
    observedAtMs: 100,
    world: {
      contract: CONTRACT,
      workspaceKind: 'git',
      plan,
      reports: [],
      budget: { wallClockActiveMs: 60_000, turns: 20 },
      landingContext: {
        branch: 'feature/objective',
        headSha: 'head-current',
        worktreeContentDigest: 'worktree-digest',
        pushTarget: {
          remote: 'origin',
          branch: 'feature/objective',
          remoteSha: OBJECTIVE_ABSENT_REMOTE_REF_STATE
        },
        hostedReview: { provider: 'github', repoKey: 'repo-1', base: 'main' }
      },
      ...overrides
    }
  }
}

/**
 * `attemptId` is derived from `dispatchId ?? action.evidenceKey`, not the action `kind` — two
 * attempts for actions that legitimately share that string (e.g. a `dispatch-node` and the
 * `ingest-report` that follows it, whose `evidenceKey` is the same dispatchId by convention) get
 * the same synthetic id unless one call passes a distinct `options.dispatchId`. `getLatestAttempts`
 * then silently keeps only the later one, starving a decision of the earlier attempt.
 */
export function attempt(
  action: ObjectiveAction,
  options: {
    state?: AttemptEntry['state']
    effect?: AttemptEntry['effect']
    dispatchId?: string
    atMs?: number
    reason?: AttemptEntry['reason']
  } = {}
): AttemptEntry {
  const dispatchAction = action.kind.startsWith('dispatch-')
  return {
    kind: 'attempt',
    eventId: `event-${options.dispatchId ?? action.evidenceKey}`,
    watcherId: 'watcher-1',
    atMs: options.atMs ?? 30,
    origin: 'owner',
    class: 'fact',
    attemptId: `attempt-${options.dispatchId ?? action.evidenceKey}`,
    fingerprint: `fingerprint-${options.dispatchId ?? action.evidenceKey}`,
    action,
    state: options.state ?? 'running',
    ...(options.effect === undefined ? {} : { effect: options.effect }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(dispatchAction
      ? {
          dispatch: {
            spec: 'role prompt',
            taskKey: action.kind === 'dispatch-node' ? action.taskKey : action.kind,
            dispatchKind: 'child' as const
          }
        }
      : {}),
    ...(options.dispatchId === undefined ? {} : { dispatchId: options.dispatchId })
  }
}

export function workerDone(dispatchId: string, reportPath = '/outside/report.json'): EvidenceEntry {
  return {
    kind: 'evidence',
    eventId: `evidence-${dispatchId}`,
    watcherId: 'watcher-1',
    atMs: 40,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      payload: {
        dispatchId,
        taskId: `task-${dispatchId}`,
        outcome: 'succeeded',
        reportPath,
        filesModified: ['src/core.ts']
      }
    }
  }
}

export function workerHeartbeat(dispatchId: string): EvidenceEntry {
  return {
    kind: 'evidence',
    eventId: `heartbeat-${dispatchId}`,
    watcherId: 'watcher-1',
    atMs: 35,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'heartbeat',
      payload: { dispatchId, taskId: `first-task-${dispatchId}` }
    }
  }
}

export function ledger(entries: LedgerEntry[] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}
