import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type {
  AttemptEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { Store } from '../persistence'
import { createObjectiveActionExecutor } from './action-executor'
import { findObjectiveWorkerEvidence, type ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveForgeAccess } from './objective-forge-access'
import type { ObjectiveStore } from './objective-store'

const { readReport, validateChanges } = vi.hoisted(() => ({
  readReport: vi.fn(),
  validateChanges: vi.fn()
}))
vi.mock('./report-ingestion', () => ({
  issueObjectiveReportPath: vi.fn(),
  readObjectiveRoleReport: readReport
}))
vi.mock('./observed-workspace-changes', () => ({
  captureObjectiveWorkspaceBaseline: vi.fn(),
  validateObjectiveWorkspaceChanges: validateChanges
}))

const TEST_LEASE = {
  epoch: 1,
  assertHeld: vi.fn(async () => undefined),
  renewLoop: () => ({ dispose: () => undefined })
} satisfies LeaseGuard

const contract = {
  objectiveText: 'Implement the objective.',
  tier: 'standard' as const,
  landingBar: 'files-on-disk' as const,
  maxConcurrency: 1,
  workspaceKind: 'folder' as const,
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

const enrollment = {
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
  generation: 1,
  createdAtMs: 1,
  updatedAtMs: 1
} as unknown as WatcherEnrollment

function snapshot(contentIdentity = 'new-content'): LiveSnapshot<ObjectiveWorld> {
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

function attempt(action: ObjectiveAction, overrides: Partial<AttemptEntry> = {}): AttemptEntry {
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

function workerDone(outcome: 'succeeded' | 'failed'): LedgerEntry {
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
function workerHeartbeat(): LedgerEntry {
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

function harness(storeOverrides: Partial<ObjectiveStore> = {}) {
  const fresh = snapshot()
  const bindings = new WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>()
  bindings.set(fresh, {
    enrollment,
    contract,
    target: {
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/workspace',
      fileProvider: null
    }
  })
  const objectiveStore = {
    getPlan: () => [
      {
        taskKey: 'node-a',
        title: 'Node A',
        spec: 'Implement A',
        deps: [],
        criteria: [{ body: 'A works', shellCheckable: false, checkCommand: null }],
        declaresDependencyChange: false,
        declaredPaths: ['src/a.ts']
      }
    ],
    getTask: () => ({
      taskKey: 'node-a',
      title: 'Node A',
      spec: 'Implement A',
      deps: [],
      criteria: [{ body: 'A works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false,
      declaredPaths: ['src/a.ts']
    }),
    ...storeOverrides
  } as unknown as ObjectiveStore
  const executor = createObjectiveActionExecutor({
    store: {} as Store,
    objectiveStore,
    snapshotBindings: bindings,
    forge: {} as ObjectiveForgeAccess
  })
  return { executor, fresh }
}

const dispatchNode: ObjectiveAction = {
  kind: 'dispatch-node',
  capability: 'implement',
  visibility: 'local',
  contentIdentity: 'old-content',
  evidenceKey: 'revision-1:node-a',
  revisionId: 'revision-1',
  taskKey: 'node-a',
  depsOrchestrationIds: []
}

describe('objective action recovery', () => {
  beforeEach(() => {
    readReport.mockReset()
    validateChanges.mockReset()
    validateChanges.mockResolvedValue({ ok: true, changedPaths: ['src/a.ts'] })
  })

  it('validates a successful worker report at the original dispatch fingerprint after content changes', async () => {
    readReport.mockResolvedValue({
      ok: true,
      role: 'implementer',
      path: '/workspace/report.json',
      reportDigest: 'digest-1',
      report: {
        taskKey: 'node-a',
        summary: 'Implemented A',
        filesModified: ['src/a.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified' }]
      }
    })
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerHeartbeat(), workerDone('succeeded')]
    }
    expect(findObjectiveWorkerEvidence(ledger, 'dispatch-1')?.orchestrationTaskId).toBe('task-1')

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toBe('landed')
    expect(readReport).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptFingerprint: makeAttemptFingerprint(
          dispatchNode.contentIdentity,
          dispatchNode.kind,
          dispatchNode.evidenceKey
        ),
        mailboxReportPath: '/workspace/report.json',
        taskKey: 'node-a'
      })
    )
  })

  it('does not recover a successful worker whose observed changes contradict its report', async () => {
    readReport.mockResolvedValue({
      ok: true,
      role: 'implementer',
      path: '/workspace/report.json',
      reportDigest: 'digest-1',
      report: {
        taskKey: 'node-a',
        summary: 'Implemented A',
        filesModified: ['src/a.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified' }]
      }
    })
    validateChanges.mockResolvedValue({
      ok: false,
      reason: 'reported-files-do-not-match-observed-changes'
    })
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerDone('succeeded')]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toBe('not-landed')
  })

  it('resolves a crash before dispatch metadata as authoritatively not landed', async () => {
    const { executor, fresh } = harness()
    const crashed = attempt(dispatchNode)
    delete crashed.dispatch
    delete crashed.dispatchId
    const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [crashed] }

    await expect(executor.resolveOutcome(crashed, fresh, ledger, TEST_LEASE)).resolves.toBe(
      'not-landed'
    )
    expect(readReport).not.toHaveBeenCalled()
  })

  it('does not treat an on-disk report as success without trusted worker_done evidence', async () => {
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [attempt(dispatchNode)] }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toBe('indeterminate')
    expect(readReport).not.toHaveBeenCalled()
  })

  it('resolves a failed worker outcome as not landed without trusting a report path', async () => {
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerDone('failed')]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toBe('not-landed')
    expect(readReport).not.toHaveBeenCalled()
  })

  it('retries an absent check row while preserving indeterminate incomplete executions', () => {
    const checkAction: ObjectiveAction = {
      kind: 'run-check',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'new-content',
      evidenceKey: 'criterion-1:new-content',
      criterionId: 'criterion-1',
      command: 'npm test'
    }
    const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [] }
    const absent = harness({ getCheckAttempt: () => null })
    const incomplete = harness({
      getCheckAttempt: () => ({ completedAtMs: null }) as never
    })
    const completed = harness({
      getCheckAttempt: () => ({ completedAtMs: 12 }) as never
    })

    expect(
      absent.executor.resolveOutcome(attempt(checkAction), absent.fresh, ledger, TEST_LEASE)
    ).toBe('not-landed')
    expect(
      incomplete.executor.resolveOutcome(attempt(checkAction), incomplete.fresh, ledger, TEST_LEASE)
    ).toBe('indeterminate')
    expect(
      completed.executor.resolveOutcome(attempt(checkAction), completed.fresh, ledger, TEST_LEASE)
    ).toBe('landed')
  })
})
