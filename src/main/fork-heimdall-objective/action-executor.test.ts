import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKER_EXITED_WITHOUT_COMPLETION } from '../../shared/fork-heimdall/effect-certainty'
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
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
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
  holder: 'test-holder',
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
    getDispatch: () => null,
    listDispatches: () => [],
    dispatchForId: () => null,
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
    forge: {} as ObjectiveForgeAccess,
    runtime: {} as OrcaRuntimeService
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

const dispatchPlanner: ObjectiveAction = {
  kind: 'dispatch-planner',
  capability: 'plan',
  visibility: 'local',
  contentIdentity: 'old-content',
  evidenceKey: 'plan:2',
  revisionNumber: 2,
  reason: 'replan-after-failure'
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
    ).resolves.toEqual({ effect: 'landed' })
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

  it('rejects malformed completion file evidence instead of validating it as an empty list', async () => {
    const malformed = workerDone('succeeded')
    const message =
      malformed.kind === 'evidence' ? (malformed.payload as Record<string, unknown>) : {}
    const payload =
      typeof message.payload === 'object' && message.payload !== null
        ? (message.payload as Record<string, unknown>)
        : {}
    payload.filesModified = ['src/a.ts', 42]
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), malformed]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toMatchObject({
      effect: 'not-landed',
      failureClass: 'criteria',
      reportValidation: {
        status: 'rejected',
        code: 'evidence-malformed',
        reportedFiles: [],
        hostVerifiable: true
      }
    })
    expect(readReport).not.toHaveBeenCalled()
  })

  it('preserves a terminal legacy rejection cause without reading or accepting the report', async () => {
    const rejected = workerDone('failed')
    const message =
      rejected.kind === 'evidence' ? (rejected.payload as Record<string, unknown>) : {}
    const payload =
      typeof message.payload === 'object' && message.payload !== null
        ? (message.payload as Record<string, unknown>)
        : {}
    payload.reportRejection = {
      code: 'sender_not_assignee',
      reason: 'The submitting worker is not the authoritative assignee.'
    }
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), rejected]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toMatchObject({
      effect: 'not-landed',
      failureClass: 'criteria',
      reportValidation: {
        status: 'rejected',
        code: 'semantic-invalid',
        sourceCode: 'sender_not_assignee',
        detail: 'The submitting worker is not the authoritative assignee.',
        role: 'implementer',
        dispatchId: 'dispatch-1',
        taskKey: 'node-a'
      }
    })
    expect(readReport).not.toHaveBeenCalled()
    expect(validateChanges).not.toHaveBeenCalled()
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
    ).resolves.toMatchObject({
      effect: 'not-landed',
      failureClass: 'criteria',
      reportValidation: {
        status: 'rejected',
        code: 'workspace-invalid',
        detail: 'reported-files-do-not-match-observed-changes',
        hostVerifiable: true
      }
    })
  })

  it('resolves a crash before dispatch metadata as authoritatively not landed, tagged infra', async () => {
    const { executor, fresh } = harness()
    const crashed = attempt(dispatchNode)
    delete crashed.dispatch
    delete crashed.dispatchId
    const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [crashed] }

    await expect(executor.resolveOutcome(crashed, fresh, ledger, TEST_LEASE)).resolves.toEqual({
      effect: 'not-landed',
      failureClass: 'infra'
    })
    expect(readReport).not.toHaveBeenCalled()
  })

  it.each([
    { circumstance: 'without a recorded reason', reason: undefined },
    { circumstance: 'after contact loss', reason: 'contact-lost' }
  ] as const)(
    'does not trust an on-disk report $circumstance without worker_done evidence',
    async ({ reason }) => {
      const { executor, fresh } = harness()
      const uncertain = attempt(dispatchNode, reason === undefined ? {} : { reason })
      const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [uncertain] }

      await expect(executor.resolveOutcome(uncertain, fresh, ledger, TEST_LEASE)).resolves.toEqual({
        effect: 'indeterminate'
      })
      expect(readReport).not.toHaveBeenCalled()
    }
  )

  it.each([
    { role: 'implementer', action: dispatchNode },
    { role: 'planner', action: dispatchPlanner }
  ])(
    'resolves an exited $role without completion evidence as not landed, tagged infra',
    async ({ action }) => {
      const { executor, fresh } = harness()
      const exited = attempt(action, { reason: WORKER_EXITED_WITHOUT_COMPLETION })
      const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [exited] }

      await expect(executor.resolveOutcome(exited, fresh, ledger, TEST_LEASE)).resolves.toEqual({
        effect: 'not-landed',
        failureClass: 'infra'
      })
      expect(readReport).not.toHaveBeenCalled()
    }
  )

  it('prefers late worker_done evidence over an earlier exited-without-completion settlement', async () => {
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
    const exited = attempt(dispatchNode, { reason: WORKER_EXITED_WITHOUT_COMPLETION })
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [exited, workerDone('succeeded')]
    }

    await expect(executor.resolveOutcome(exited, fresh, ledger, TEST_LEASE)).resolves.toEqual({
      effect: 'landed'
    })
  })

  it('never resolves a failed worker outcome as landed, even when its report validates cleanly', async () => {
    readReport.mockResolvedValue({
      ok: true,
      role: 'implementer',
      path: '/workspace/report.json',
      reportDigest: 'digest-1',
      report: {
        taskKey: 'node-a',
        summary: 'Attempted A',
        filesModified: ['src/a.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified' }]
      }
    })
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerDone('failed')]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toEqual({ effect: 'not-landed', failureClass: 'criteria' })
  })

  it('keeps a failed task without report evidence distinct from a rejected report', async () => {
    const failed = workerDone('failed')
    const message = failed.kind === 'evidence' ? (failed.payload as Record<string, unknown>) : {}
    const payload =
      typeof message.payload === 'object' && message.payload !== null
        ? (message.payload as Record<string, unknown>)
        : {}
    delete payload.reportPath
    delete payload.filesModified
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), failed]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toEqual({ effect: 'not-landed', failureClass: 'criteria' })
    expect(readReport).not.toHaveBeenCalled()
  })

  it('resolves a failed worker outcome as not landed without an unreadable report changing that', async () => {
    readReport.mockResolvedValue({ ok: false, reason: 'missing' })
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerDone('failed')]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toMatchObject({
      effect: 'not-landed',
      failureClass: 'criteria',
      reportValidation: {
        status: 'rejected',
        code: 'missing',
        role: 'implementer',
        dispatchId: 'dispatch-1',
        hostVerifiable: true
      }
    })
    expect(readReport).toHaveBeenCalledOnce()
  })

  it('retains a bounded unverifiable classification read failure on a failed outcome', async () => {
    readReport.mockRejectedValue(
      Object.assign(new Error('ssh connection lost'), { code: 'ECONNRESET' })
    )
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerDone('failed')]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toMatchObject({
      effect: 'not-landed',
      failureClass: 'criteria',
      reportValidation: {
        status: 'unverifiable',
        code: 'read-unverifiable',
        detail: 'Report authority could not be read (ECONNRESET)',
        hostVerifiable: false
      }
    })
  })

  it('keeps a succeeded outcome indeterminate when its report authority is unverifiable', async () => {
    readReport.mockRejectedValue(new Error('ssh connection lost'))
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerDone('succeeded')]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toMatchObject({
      effect: 'indeterminate',
      reportValidation: {
        status: 'unverifiable',
        code: 'read-unverifiable',
        detail: 'Report authority could not be read',
        hostVerifiable: false
      }
    })
  })

  it('classifies a failed worker report with a failing criterion as criteria', async () => {
    readReport.mockResolvedValue({
      ok: true,
      role: 'implementer',
      path: '/workspace/report.json',
      reportDigest: 'digest-1',
      report: {
        taskKey: 'node-a',
        summary: 'Attempted A',
        filesModified: ['src/a.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'fail', note: 'Assertion failed' }]
      }
    })
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerDone('failed')]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toEqual({ effect: 'not-landed', failureClass: 'criteria' })
  })

  it('classifies a failed worker report with only unknown criteria as environment', async () => {
    readReport.mockResolvedValue({
      ok: true,
      role: 'implementer',
      path: '/workspace/report.json',
      reportDigest: 'digest-1',
      report: {
        taskKey: 'node-a',
        summary: 'Attempted A',
        filesModified: ['src/a.ts'],
        criteriaSelfAssessment: [
          { criterionIndex: 0, result: 'unknown', note: 'Sandbox unavailable' }
        ]
      }
    })
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerDone('failed')]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toEqual({ effect: 'not-landed', failureClass: 'environment' })
  })

  it('classifies a territory-violating report as criteria regardless of the worker outcome', async () => {
    readReport.mockResolvedValue({
      ok: true,
      role: 'implementer',
      path: '/workspace/report.json',
      reportDigest: 'digest-1',
      report: {
        taskKey: 'node-a',
        summary: 'Attempted A',
        filesModified: ['docs/outside.md'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified' }]
      }
    })
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchNode), workerDone('failed')]
    }

    await expect(
      executor.resolveOutcome(attempt(dispatchNode), fresh, ledger, TEST_LEASE)
    ).resolves.toMatchObject({
      effect: 'not-landed',
      failureClass: 'criteria',
      reportValidation: {
        status: 'rejected',
        code: 'semantic-invalid',
        detail: 'Implementer modified path outside write territory: docs/outside.md'
      }
    })
  })

  it('defaults an unclassifiable failed dispatch (no per-criterion signal) to criteria', async () => {
    readReport.mockResolvedValue({
      ok: true,
      role: 'planner',
      path: '/workspace/plan-report.json',
      reportDigest: 'digest-2',
      report: {
        plan: [
          {
            taskKey: 'core',
            title: 'Core',
            spec: 'Implement core',
            deps: [],
            criteria: [{ body: 'works', shellCheckable: false, checkCommand: null }],
            declaresDependencyChange: false,
            declaredPaths: ['src/core.ts']
          }
        ]
      }
    })
    const { executor, fresh } = harness()
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [attempt(dispatchPlanner, { dispatchId: 'dispatch-1' }), workerDone('failed')]
    }

    await expect(
      executor.resolveOutcome(
        attempt(dispatchPlanner, { dispatchId: 'dispatch-1' }),
        fresh,
        ledger,
        TEST_LEASE
      )
    ).resolves.toEqual({ effect: 'not-landed', failureClass: 'criteria' })
  })

  it('accepts an omitted filesModified field on a successful planner completion', async () => {
    readReport.mockResolvedValue({
      ok: true,
      role: 'planner',
      path: '/workspace/report.json',
      reportDigest: 'digest-planner',
      report: {
        plan: [
          {
            taskKey: 'core',
            title: 'Core',
            spec: 'Implement core',
            deps: [],
            criteria: [{ body: 'works', shellCheckable: false, checkCommand: null }],
            declaresDependencyChange: false,
            declaredPaths: ['src/core.ts']
          }
        ]
      }
    })
    const completion = workerDone('succeeded')
    if (completion.kind !== 'evidence') {
      throw new Error('expected completion evidence')
    }
    const message = completion.payload as { payload: Record<string, unknown> }
    delete message.payload.filesModified
    const { executor, fresh } = harness()
    const dispatched = attempt(dispatchPlanner, { dispatchId: 'dispatch-1' })
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [dispatched, completion]
    }

    await expect(executor.resolveOutcome(dispatched, fresh, ledger, TEST_LEASE)).resolves.toEqual({
      effect: 'landed'
    })
  })

  it('validates observed workspace changes against the original dispatch fingerprint for a retry', async () => {
    const originalAction: ObjectiveAction = { ...dispatchNode, evidenceKey: 'revision-1:node-a' }
    const retryAction: ObjectiveAction = {
      ...dispatchNode,
      evidenceKey: 'revision-1:node-a:r0',
      retryOf: 'revision-1:node-a'
    }
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
    const originalAttempt = attempt(originalAction, {
      attemptId: 'attempt-original',
      dispatchId: 'dispatch-original'
    })
    const retryAttempt = attempt(retryAction, {
      attemptId: 'attempt-retry',
      dispatchId: 'dispatch-1'
    })
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [originalAttempt, retryAttempt, workerDone('succeeded')]
    }

    await expect(executor.resolveOutcome(retryAttempt, fresh, ledger, TEST_LEASE)).resolves.toEqual(
      { effect: 'landed' }
    )
    expect(validateChanges).toHaveBeenCalledWith(
      expect.objectContaining({ attemptFingerprint: originalAttempt.fingerprint })
    )
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
    ).toEqual({ effect: 'not-landed' })
    expect(
      incomplete.executor.resolveOutcome(attempt(checkAction), incomplete.fresh, ledger, TEST_LEASE)
    ).toEqual({ effect: 'indeterminate' })
    expect(
      completed.executor.resolveOutcome(attempt(checkAction), completed.fresh, ledger, TEST_LEASE)
    ).toEqual({ effect: 'landed' })
  })
})
