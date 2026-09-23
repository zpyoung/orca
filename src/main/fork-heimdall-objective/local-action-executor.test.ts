import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { computeWorkspaceContentIdentity } from './content-identity'
import { ObjectiveDatabase } from './objective-database'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { executeObjectiveLocalAction } from './local-action-executor'
import { captureObjectiveWorkspaceBaseline } from './observed-workspace-changes'
import { issueObjectiveReportPath } from './report-ingestion'
import { ObjectiveStore } from './objective-store'

const { runCriterionCheckMock } = vi.hoisted(() => ({ runCriterionCheckMock: vi.fn() }))
vi.mock('./check-runner', () => ({ runCriterionCheck: runCriterionCheckMock }))

const WATCHER_ID = 'watcher-1'

const PLAN: PlannerReport = {
  plan: [
    {
      taskKey: 'node-1',
      title: 'Node 1',
      spec: 'Execute node one',
      deps: [],
      criteria: [
        {
          body: 'The workspace check passes',
          shellCheckable: true,
          checkCommand: 'true'
        }
      ],
      declaresDependencyChange: false
    }
  ]
}

const opened: ObjectiveDatabase[] = []

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
})

beforeEach(() => {
  runCriterionCheckMock.mockReset()
})

type ObjectiveStoreFixture = {
  objectiveStore: ObjectiveStore
  revisionId: string
  criterionId: string
}

function objectiveStoreFixture(): ObjectiveStoreFixture {
  const database = new ObjectiveDatabase(':memory:')
  opened.push(database)
  const objectiveStore = new ObjectiveStore(database)
  const revision = objectiveStore.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber: 1,
    dispatchId: 'planner-1',
    report: PLAN,
    digest: 'digest-1',
    createdAtMs: 1
  })
  objectiveStore.activatePlan({
    watcherId: WATCHER_ID,
    revisionId: revision.revisionId,
    digest: revision.digest,
    approvedAtMs: 2
  })
  const node = objectiveStore.project(WATCHER_ID).nodes[0]
  const criterion = node?.criteria[0]
  if (!node || !criterion) {
    throw new Error('Objective fixture did not create a criterion')
  }
  objectiveStore.recordNodeDispatch({
    watcherId: WATCHER_ID,
    revisionId: revision.revisionId,
    taskKey: node.taskKey,
    orchestrationTaskId: 'orchestration-node-1',
    dispatchId: 'dispatch-node-1',
    dispatchedAtMs: 3
  })
  return {
    objectiveStore,
    revisionId: revision.revisionId,
    criterionId: criterion.id
  }
}

function seedCompletedCheck(fixture: ObjectiveStoreFixture, contentIdentity: string): void {
  fixture.objectiveStore.startCheckAttempt({
    watcherId: WATCHER_ID,
    criterionId: fixture.criterionId,
    contentIdentity,
    executionHostId: 'local',
    command: 'true',
    epoch: 1,
    startedAtMs: 4
  })
  fixture.objectiveStore.completeCheckAttempt({
    criterionId: fixture.criterionId,
    contentIdentity,
    exitCode: 0,
    timedOut: false,
    stdoutTail: '',
    stderrTail: '',
    completedAtMs: 5
  })
}

const action = (contentIdentity: string, revisionId: string): ObjectiveAction => ({
  kind: 'record-landing',
  capability: 'land',
  visibility: 'local',
  contentIdentity,
  evidenceKey: `files-on-disk:${contentIdentity}`,
  recovery: 'replay-safe',
  rung: 'files-on-disk',
  revisionId
})

describe('objective landing execution', () => {
  it('refuses to persist landing evidence after the workspace identity changes', async () => {
    const fixture = objectiveStoreFixture()
    const workspacePath = await mkdtemp(join(tmpdir(), 'objective-landing-'))
    try {
      await writeFile(join(workspacePath, 'result.txt'), 'before')
      const target = {
        kind: 'folder' as const,
        executionHostId: 'local' as const,
        workspacePath,
        fileProvider: null
      }
      const contentIdentity = await computeWorkspaceContentIdentity(target)
      seedCompletedCheck(fixture, contentIdentity)
      await writeFile(join(workspacePath, 'result.txt'), 'after with a different size')
      const binding = {
        enrollment: { watcherId: WATCHER_ID },
        contract: { tier: 'express' },
        target
      } as unknown as ObjectiveSnapshotBinding
      const context = {
        snapshot: { contentIdentity },
        ledger: { watcherId: WATCHER_ID, entries: [] },
        lease: { assertHeld: vi.fn(async () => undefined) },
        dispatchWorker: vi.fn()
      } as unknown as ExecuteContext<ObjectiveWorld>

      await expect(
        executeObjectiveLocalAction({
          action: action(contentIdentity, fixture.revisionId) as Extract<
            ObjectiveAction,
            { kind: 'record-landing' }
          >,
          binding,
          context,
          objectiveStore: fixture.objectiveStore
        })
      ).resolves.toEqual({ effect: 'not-landed', reason: 'landing-evidence-stale' })
      expect(fixture.objectiveStore.hasLanding(WATCHER_ID, 'files-on-disk', contentIdentity)).toBe(
        false
      )
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('re-reads identity-scoped checks instead of trusting the decision snapshot', async () => {
    const fixture = objectiveStoreFixture()
    const workspacePath = await mkdtemp(join(tmpdir(), 'objective-landing-check-'))
    try {
      const target = {
        kind: 'folder' as const,
        executionHostId: 'local' as const,
        workspacePath,
        fileProvider: null
      }
      const contentIdentity = await computeWorkspaceContentIdentity(target)
      seedCompletedCheck(fixture, `other-${contentIdentity}`)
      const binding = {
        enrollment: { watcherId: WATCHER_ID },
        contract: { tier: 'express' },
        target
      } as unknown as ObjectiveSnapshotBinding
      const context = {
        snapshot: { contentIdentity },
        ledger: { watcherId: WATCHER_ID, entries: [] },
        lease: { assertHeld: vi.fn(async () => undefined) },
        dispatchWorker: vi.fn()
      } as unknown as ExecuteContext<ObjectiveWorld>

      await expect(
        executeObjectiveLocalAction({
          action: action(contentIdentity, fixture.revisionId) as Extract<
            ObjectiveAction,
            { kind: 'record-landing' }
          >,
          binding,
          context,
          objectiveStore: fixture.objectiveStore
        })
      ).resolves.toEqual({ effect: 'not-landed', reason: 'landing-evidence-stale' })
      expect(fixture.objectiveStore.hasLanding(WATCHER_ID, 'files-on-disk', contentIdentity)).toBe(
        false
      )
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
})

describe('objective report ingestion execution', () => {
  it('returns planner schema detail without persisting a malformed plan', async () => {
    const database = new ObjectiveDatabase(':memory:')
    opened.push(database)
    const objectiveStore = new ObjectiveStore(database)
    const workspacePath = await mkdtemp(join(tmpdir(), 'objective-plan-ingestion-'))
    try {
      const target = {
        kind: 'folder' as const,
        executionHostId: 'local' as const,
        workspacePath,
        fileProvider: null
      }
      const dispatchAction = {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'revision-1',
        revisionNumber: 1,
        reason: 'initial'
      } satisfies ObjectiveAction
      const fingerprint = makeAttemptFingerprint(
        dispatchAction.contentIdentity,
        dispatchAction.kind,
        dispatchAction.evidenceKey
      )
      const reportPath = await issueObjectiveReportPath(target, fingerprint)
      await writeFile(
        reportPath,
        JSON.stringify({
          plan: [
            {
              taskKey: 'node-1',
              title: 'Node 1',
              spec: 'Execute node one',
              deps: [],
              criteria: [{ body: 'Node works', shellCheckable: false, checkCommand: null }],
              declaresDependencyChange: false,
              declaredPaths: ['src/**']
            }
          ]
        })
      )
      const ingestAction = {
        kind: 'ingest-plan',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'revision-1',
        recovery: 'replay-safe',
        dispatchId: 'dispatch-planner-1',
        revisionNumber: 1,
        reportPath
      } satisfies ObjectiveAction
      const binding = {
        enrollment: { watcherId: WATCHER_ID },
        contract: { writeTerritory: ['src/**'] },
        target
      } as unknown as ObjectiveSnapshotBinding
      const context = {
        snapshot: { contentIdentity: 'content-1' },
        ledger: {
          watcherId: WATCHER_ID,
          entries: [
            {
              eventId: 'attempt-planner-1',
              watcherId: WATCHER_ID,
              atMs: 1,
              origin: 'owner',
              class: 'fact',
              kind: 'attempt',
              attemptId: 'attempt-planner-1',
              fingerprint,
              action: dispatchAction,
              state: 'settled',
              effect: 'indeterminate',
              dispatch: {
                spec: 'Plan the objective.',
                deps: [],
                dispatchKind: 'planner'
              },
              dispatchId: 'dispatch-planner-1'
            },
            {
              eventId: 'evidence-planner-1',
              watcherId: WATCHER_ID,
              atMs: 2,
              origin: 'owner',
              class: 'fact',
              kind: 'evidence',
              evidenceKind: 'orchestration-mailbox',
              payload: {
                type: 'worker_done',
                payload: {
                  dispatchId: 'dispatch-planner-1',
                  outcome: 'succeeded',
                  reportPath,
                  filesModified: []
                }
              }
            }
          ]
        },
        lease: { assertHeld: vi.fn(async () => undefined) },
        dispatchWorker: vi.fn()
      } as unknown as ExecuteContext<ObjectiveWorld>

      await expect(
        executeObjectiveLocalAction({
          action: ingestAction,
          binding,
          context,
          objectiveStore
        })
      ).resolves.toMatchObject({
        effect: 'not-landed',
        reason: 'planner-report-malformed',
        result: {
          detail: 'plan[0].declaredPaths[0]: Path must be a concrete workspace-relative path',
          reportValidation: {
            status: 'rejected',
            code: 'malformed',
            role: 'planner',
            dispatchId: 'dispatch-planner-1',
            hostVerifiable: true
          }
        }
      })
      expect(objectiveStore.project(WATCHER_ID).revisions).toEqual([])
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it("resolves a retried dispatch-node's baseline to the ORIGINAL dispatch, not the retry", async () => {
    const database = new ObjectiveDatabase(':memory:')
    opened.push(database)
    const objectiveStore = new ObjectiveStore(database)
    const revision = objectiveStore.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'dispatch-planner-1',
      report: PLAN,
      digest: 'digest-1',
      createdAtMs: 1
    })
    objectiveStore.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 2
    })
    const workspacePath = await mkdtemp(join(tmpdir(), 'objective-retry-baseline-'))
    try {
      const target = {
        kind: 'folder' as const,
        executionHostId: 'local' as const,
        workspacePath,
        fileProvider: null
      }
      const originalAction = {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: 'content-original',
        evidenceKey: `${revision.revisionId}:node-1`,
        revisionId: revision.revisionId,
        taskKey: 'node-1',
        depsOrchestrationIds: []
      } satisfies ObjectiveAction
      const originalFingerprint = makeAttemptFingerprint(
        originalAction.contentIdentity,
        originalAction.kind,
        originalAction.evidenceKey
      )
      // the baseline is captured under the ORIGINAL dispatch's fingerprint before the workspace changes
      await captureObjectiveWorkspaceBaseline(target, originalFingerprint)
      await mkdir(join(workspacePath, 'src'), { recursive: true })
      await writeFile(join(workspacePath, 'src', 'node-1.ts'), 'export const done = true\n')

      const retryAction = {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: 'content-retry',
        evidenceKey: `${revision.revisionId}:node-1:r0`,
        revisionId: revision.revisionId,
        taskKey: 'node-1',
        depsOrchestrationIds: [],
        retryOf: originalAction.evidenceKey
      } satisfies ObjectiveAction
      const retryFingerprint = makeAttemptFingerprint(
        retryAction.contentIdentity,
        retryAction.kind,
        retryAction.evidenceKey
      )
      const reportPath = await issueObjectiveReportPath(target, retryFingerprint)
      await writeFile(
        reportPath,
        JSON.stringify({
          taskKey: 'node-1',
          summary: 'Implemented node one.',
          filesModified: ['src/node-1.ts'],
          criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified locally.' }]
        })
      )

      const binding = {
        enrollment: { watcherId: WATCHER_ID },
        contract: { writeTerritory: ['src/**'] },
        target
      } as unknown as ObjectiveSnapshotBinding
      const context = {
        snapshot: { contentIdentity: 'content-current' },
        ledger: {
          watcherId: WATCHER_ID,
          entries: [
            {
              eventId: 'attempt-node-1-original',
              watcherId: WATCHER_ID,
              atMs: 3,
              origin: 'owner',
              class: 'fact',
              kind: 'attempt',
              attemptId: 'attempt-node-1-original',
              fingerprint: originalFingerprint,
              action: originalAction,
              state: 'settled',
              effect: 'not-landed',
              dispatch: { spec: 'Implement node one.', deps: [], dispatchKind: 'child' },
              dispatchId: 'dispatch-node-1-original'
            },
            {
              eventId: 'attempt-node-1-retry',
              watcherId: WATCHER_ID,
              atMs: 4,
              origin: 'owner',
              class: 'fact',
              kind: 'attempt',
              attemptId: 'attempt-node-1-retry',
              fingerprint: retryFingerprint,
              action: retryAction,
              state: 'settled',
              effect: 'indeterminate',
              dispatch: { spec: 'Implement node one.', deps: [], dispatchKind: 'child' },
              dispatchId: 'dispatch-node-1-retry'
            },
            {
              eventId: 'evidence-node-1-retry',
              watcherId: WATCHER_ID,
              atMs: 5,
              origin: 'owner',
              class: 'fact',
              kind: 'evidence',
              evidenceKind: 'orchestration-mailbox',
              payload: {
                type: 'worker_done',
                payload: {
                  dispatchId: 'dispatch-node-1-retry',
                  taskId: 'orchestration-node-1',
                  outcome: 'succeeded',
                  reportPath,
                  filesModified: ['src/node-1.ts']
                }
              }
            }
          ]
        },
        lease: { assertHeld: vi.fn(async () => undefined) },
        dispatchWorker: vi.fn()
      } as unknown as ExecuteContext<ObjectiveWorld>

      const ingestAction = {
        kind: 'ingest-report',
        capability: 'implement',
        visibility: 'local',
        recovery: 'replay-safe',
        contentIdentity: 'content-current',
        evidenceKey: 'dispatch-node-1-retry',
        revisionId: revision.revisionId,
        dispatchId: 'dispatch-node-1-retry',
        taskKey: 'node-1',
        orchestrationTaskId: 'orchestration-node-1',
        reportPath,
        filesModified: ['src/node-1.ts'],
        dispatchedContentIdentity: retryAction.contentIdentity
      } satisfies ObjectiveAction

      const outcome = await executeObjectiveLocalAction({
        action: ingestAction,
        binding,
        context,
        objectiveStore
      })

      expect(outcome).toMatchObject({ effect: 'landed', result: { kind: 'report-ingested' } })
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
})

describe('objective gate execution', () => {
  const declaredGate = { name: 'full-suite', command: 'pnpm test', timeoutSeconds: 900 }

  async function gateFixture(): Promise<{
    fixture: ObjectiveStoreFixture
    workspacePath: string
    target: ObjectiveSnapshotBinding['target']
    contentIdentity: string
    binding: ObjectiveSnapshotBinding
    context: ExecuteContext<ObjectiveWorld>
  }> {
    const fixture = objectiveStoreFixture()
    const workspacePath = await mkdtemp(join(tmpdir(), 'objective-gate-'))
    const target = {
      kind: 'folder' as const,
      executionHostId: 'local' as const,
      workspacePath,
      fileProvider: null
    }
    const contentIdentity = await computeWorkspaceContentIdentity(target)
    const binding = {
      enrollment: { watcherId: WATCHER_ID },
      contract: { gates: [declaredGate] },
      target
    } as unknown as ObjectiveSnapshotBinding
    const context = {
      snapshot: { contentIdentity },
      ledger: { watcherId: WATCHER_ID, entries: [] },
      lease: { assertHeld: vi.fn(async () => undefined), epoch: 1 },
      dispatchWorker: vi.fn()
    } as unknown as ExecuteContext<ObjectiveWorld>
    return { fixture, workspacePath, target, contentIdentity, binding, context }
  }

  function gateAction(contentIdentity: string): Extract<ObjectiveAction, { kind: 'run-gate' }> {
    return {
      kind: 'run-gate',
      capability: 'check',
      visibility: 'local',
      contentIdentity,
      evidenceKey: `objective-gate:${declaredGate.name}:${contentIdentity}`,
      gateName: declaredGate.name,
      command: declaredGate.command,
      timeoutSeconds: declaredGate.timeoutSeconds
    }
  }

  it("runs the gate command with the action's declared timeout and persists the completed attempt", async () => {
    const { fixture, workspacePath, target, contentIdentity, binding, context } =
      await gateFixture()
    try {
      runCriterionCheckMock.mockResolvedValue({
        command: declaredGate.command,
        pass: true,
        exitCode: 0,
        timedOut: false,
        stdoutTail: 'all green',
        stderrTail: '',
        error: null,
        startedAtMs: 1,
        completedAtMs: 2,
        durationMs: 1
      })

      const outcome = await executeObjectiveLocalAction({
        action: gateAction(contentIdentity),
        binding,
        context,
        objectiveStore: fixture.objectiveStore
      })

      expect(runCriterionCheckMock).toHaveBeenCalledWith({
        command: declaredGate.command,
        target,
        timeoutSeconds: declaredGate.timeoutSeconds
      })
      expect(outcome).toMatchObject({
        effect: 'landed',
        result: {
          kind: 'check-recorded',
          naturalKey: {
            kind: 'gate-attempt',
            gateName: declaredGate.name,
            contentIdentity
          },
          exitCode: 0,
          timedOut: false
        }
      })
      expect(
        fixture.objectiveStore.getGateAttempt(WATCHER_ID, declaredGate.name, contentIdentity)
      ).toMatchObject({ exitCode: 0, timedOut: false, completedAtMs: 2 })
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('replays the same completed result without throwing when the same attempt clock repeats', async () => {
    const { fixture, workspacePath, contentIdentity, binding, context } = await gateFixture()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      runCriterionCheckMock.mockResolvedValue({
        command: declaredGate.command,
        pass: false,
        exitCode: 1,
        timedOut: false,
        stdoutTail: '',
        stderrTail: 'failed',
        error: null,
        startedAtMs: 1,
        completedAtMs: 2,
        durationMs: 1
      })

      const action = gateAction(contentIdentity)
      const first = await executeObjectiveLocalAction({
        action,
        binding,
        context,
        objectiveStore: fixture.objectiveStore
      })
      const second = await executeObjectiveLocalAction({
        action,
        binding,
        context,
        objectiveStore: fixture.objectiveStore
      })

      expect(first).toMatchObject({ effect: 'landed', result: { exitCode: 1 } })
      expect(second).toMatchObject({ effect: 'landed', result: { exitCode: 1 } })
    } finally {
      now.mockRestore()
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('refuses to run a gate command that no longer matches the enrolled declaration', async () => {
    const { fixture, workspacePath, contentIdentity, context } = await gateFixture()
    try {
      const staleBinding = {
        enrollment: { watcherId: WATCHER_ID },
        contract: { gates: [{ ...declaredGate, command: 'pnpm test:changed' }] },
        target: { kind: 'folder', executionHostId: 'local', workspacePath, fileProvider: null }
      } as unknown as ObjectiveSnapshotBinding

      const outcome = await executeObjectiveLocalAction({
        action: gateAction(contentIdentity),
        binding: staleBinding,
        context,
        objectiveStore: fixture.objectiveStore
      })

      expect(outcome).toEqual({
        effect: 'not-landed',
        reason: 'gate-declaration-mismatch'
      })
      expect(runCriterionCheckMock).not.toHaveBeenCalled()
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
})

describe('objective plan patch execution', () => {
  it('routes apply-plan-patch through the patch executor and lands the applied outcome', async () => {
    const database = new ObjectiveDatabase(':memory:')
    opened.push(database)
    const objectiveStore = new ObjectiveStore(database)
    const revision = objectiveStore.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN,
      digest: 'digest-1',
      createdAtMs: 1
    })
    objectiveStore.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 2
    })
    const patch = objectiveStore.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'dispatch-planner-repair-1',
      repairOrdinal: 1,
      report: {
        repair: {
          upsertTasks: [
            {
              taskKey: 'follow-up',
              title: 'Follow up',
              spec: 'Do the follow-up work',
              deps: [],
              criteria: [{ body: 'Follow-up is done', shellCheckable: false, checkCommand: null }],
              declaresDependencyChange: false
            }
          ],
          dropTaskKeys: []
        },
        assumptions: []
      },
      createdAtMs: 3
    })
    const binding = { enrollment: { watcherId: WATCHER_ID } } as unknown as ObjectiveSnapshotBinding
    const context = {
      snapshot: { contentIdentity: 'content-1', world: { plan: { nodes: [] } } },
      ledger: { watcherId: WATCHER_ID, entries: [] },
      lease: { assertHeld: vi.fn(async () => undefined) },
      dispatchWorker: vi.fn()
    } as unknown as ExecuteContext<ObjectiveWorld>

    const outcome = await executeObjectiveLocalAction({
      action: {
        kind: 'apply-plan-patch',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: `plan-patch:${patch.id}`,
        recovery: 'replay-safe',
        revisionId: patch.revisionId,
        patchId: patch.id,
        digest: patch.digest
      },
      binding,
      context,
      objectiveStore
    })

    expect(outcome).toMatchObject({
      effect: 'landed',
      result: { kind: 'plan-patch-applied', patchId: patch.id }
    })
    expect(objectiveStore.getPlanPatch(patch.id)?.status).toBe('applied')
  })
})

describe('objective plan review execution', () => {
  it('routes ingest-plan-review through the plan-review executor and records the verdict', async () => {
    const database = new ObjectiveDatabase(':memory:')
    opened.push(database)
    const objectiveStore = new ObjectiveStore(database)
    const revision = objectiveStore.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: PLAN,
      digest: 'digest-1',
      createdAtMs: 1
    })
    const workspacePath = await mkdtemp(join(tmpdir(), 'objective-plan-review-routing-'))
    try {
      const target = {
        kind: 'folder' as const,
        executionHostId: 'local' as const,
        workspacePath,
        fileProvider: null
      }
      const dispatchAction = {
        kind: 'dispatch-plan-review',
        capability: 'review',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: `${revision.revisionId}:1`,
        target: { kind: 'revision', revisionId: revision.revisionId },
        round: 1
      } satisfies ObjectiveAction
      const fingerprint = makeAttemptFingerprint(
        dispatchAction.contentIdentity,
        dispatchAction.kind,
        dispatchAction.evidenceKey
      )
      const reportPath = await issueObjectiveReportPath(target, fingerprint)
      await writeFile(
        reportPath,
        JSON.stringify({
          verdict: 'approve',
          assumptions: [],
          findings: [],
          summary: 'The plan is sound.'
        })
      )
      const binding = {
        enrollment: { watcherId: WATCHER_ID },
        target
      } as unknown as ObjectiveSnapshotBinding
      const context = {
        ledger: {
          watcherId: WATCHER_ID,
          entries: [
            {
              eventId: 'attempt-plan-review-1',
              watcherId: WATCHER_ID,
              atMs: 1,
              origin: 'owner',
              class: 'fact',
              kind: 'attempt',
              attemptId: 'attempt-plan-review-1',
              fingerprint,
              action: dispatchAction,
              state: 'settled',
              effect: 'indeterminate',
              dispatch: { spec: 'Review the plan.', deps: [], dispatchKind: 'reviewer' },
              dispatchId: 'dispatch-plan-review-1'
            },
            {
              eventId: 'evidence-plan-review-1',
              watcherId: WATCHER_ID,
              atMs: 2,
              origin: 'owner',
              class: 'fact',
              kind: 'evidence',
              evidenceKind: 'orchestration-mailbox',
              payload: {
                type: 'worker_done',
                payload: {
                  dispatchId: 'dispatch-plan-review-1',
                  outcome: 'succeeded',
                  reportPath,
                  filesModified: []
                }
              }
            }
          ]
        },
        lease: { assertHeld: vi.fn(async () => undefined) },
        dispatchWorker: vi.fn()
      } as unknown as ExecuteContext<ObjectiveWorld>

      const outcome = await executeObjectiveLocalAction({
        action: {
          kind: 'ingest-plan-review',
          capability: 'review',
          visibility: 'local',
          contentIdentity: 'content-1',
          evidenceKey: 'dispatch-plan-review-1',
          recovery: 'replay-safe',
          dispatchId: 'dispatch-plan-review-1',
          reportPath,
          target: { kind: 'revision', revisionId: revision.revisionId }
        },
        binding,
        context,
        objectiveStore
      })

      expect(outcome).toMatchObject({
        effect: 'landed',
        result: { kind: 'plan-review-ingested', verdict: 'approve' }
      })
      expect(objectiveStore.listPlanReviews(WATCHER_ID)).toHaveLength(1)
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
})
