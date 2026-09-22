import { describe, expect, it, vi } from 'vitest'
import { createReportValidationProvenance } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../../shared/fork-heimdall/owner/intervention'
import {
  attempt,
  CONTRACT,
  snapshot,
  workerDone
} from '../../shared/fork-heimdall-objective/decision-test-harness'
import { ObjectiveActionResultSchema } from '../../shared/fork-heimdall-objective/objective-action-results'
import {
  OWNER_SKIP_REVIEW_DISPATCH_PREFIX,
  ObjectiveActionSchema,
  type AcceptReportAction,
  type AmendPlanAction,
  type ObjectiveAction,
  type SkipCheckAction,
  type SkipReviewAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import {
  ObjectiveDetailSchema,
  ObjectiveProjectionSchema,
  type ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import { ObjectiveOwnerInterventionSchema } from '../../shared/fork-heimdall-objective/owner-intervention'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { objectiveActionForIntervention } from './owner-adapter-actions'
import {
  acceptOwnerReport,
  amendOwnerPlan,
  skipOwnerCheck,
  skipOwnerReview
} from './owner-override-executor'

const WATCHER_ID = 'watcher-1'

const PLAN: PlannerReport = {
  plan: [
    {
      taskKey: 'core',
      title: 'Core',
      spec: 'Implement the core change',
      deps: [],
      criteria: [{ body: 'The change is correct', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    },
    {
      taskKey: 'checked',
      title: 'Checked',
      spec: 'A task with a shell-checkable criterion',
      deps: [],
      criteria: [{ body: 'The build passes', shellCheckable: true, checkCommand: 'pnpm build' }],
      declaresDependencyChange: false
    }
  ]
}

function objectiveStoreFixture(): {
  objectiveStore: ObjectiveStore
  revisionId: string
  close(): void
} {
  const database = new ObjectiveDatabase(':memory:')
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
  return { objectiveStore, revisionId: revision.revisionId, close: () => database.close() }
}

const binding = {
  enrollment: { watcherId: WATCHER_ID },
  contract: {},
  target: { executionHostId: 'local' }
} as unknown as ObjectiveSnapshotBinding

function executeContext(entries: unknown[]): ExecuteContext<ObjectiveWorld> {
  return {
    snapshot: {},
    ledger: { watcherId: WATCHER_ID, entries },
    lease: { epoch: 1, assertHeld: vi.fn(async () => undefined) },
    dispatchWorker: vi.fn()
  } as unknown as ExecuteContext<ObjectiveWorld>
}

describe('acceptOwnerReport', () => {
  it('lands the node and writes a complete attestation fact', async () => {
    const fixture = objectiveStoreFixture()
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: `${fixture.revisionId}:core`,
      revisionId: fixture.revisionId,
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const ingestReport: ObjectiveAction = {
      kind: 'ingest-report',
      capability: 'implement',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-core',
      revisionId: fixture.revisionId,
      dispatchId: 'dispatch-core',
      taskKey: 'core',
      orchestrationTaskId: 'task-dispatch-core',
      reportPath: '/outside/report.json',
      filesModified: ['src/core.ts'],
      dispatchedContentIdentity: 'content-current'
    }
    const entries = [
      attempt(dispatch, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-core' }),
      workerDone('dispatch-core'),
      // a distinct harness dispatchId keeps this attempt's synthetic id from colliding with the
      // dispatch attempt above, which shares the same real evidenceKey by production convention
      {
        ...attempt(ingestReport, {
          state: 'settled',
          effect: 'not-landed',
          reason: 'reported-files-do-not-match-observed-changes',
          dispatchId: 'ingest-report-attempt'
        }),
        result: {
          reportDigest: 'rejected-report-digest',
          reportedFiles: ['src/core.ts'],
          observedFiles: ['src/core.ts', 'docs/extra.md'],
          reportValidation: createReportValidationProvenance({
            status: 'rejected',
            code: 'workspace-invalid',
            role: 'implementer',
            dispatchId: 'dispatch-core',
            taskKey: 'core',
            reportPath: '/outside/report.json',
            reportedFiles: ['src/core.ts'],
            observedFiles: ['src/core.ts', 'docs/extra.md'],
            hostVerifiable: true
          })
        }
      }
    ]
    const action: AcceptReportAction = {
      kind: 'accept-report',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'accept-report:dispatch-core',
      recovery: 'replay-safe',
      revisionId: fixture.revisionId,
      taskKey: 'core',
      dispatchId: 'dispatch-core',
      attestation: 'The extra doc file is a benign side effect; landing anyway.'
    }
    const outcome = await acceptOwnerReport({
      action,
      binding,
      context: executeContext(entries),
      objectiveStore: fixture.objectiveStore
    })
    expect(outcome.effect).toBe('landed')
    expect(outcome.result).toMatchObject({
      kind: 'report-accepted',
      attestation: 'The extra doc file is a benign side effect; landing anyway.',
      rejectionReason: 'reported-files-do-not-match-observed-changes',
      reportedFiles: ['src/core.ts'],
      observedFiles: ['src/core.ts', 'docs/extra.md']
    })
    expect(fixture.objectiveStore.nodeForDispatch(WATCHER_ID, 'dispatch-core')).toEqual({
      revisionId: fixture.revisionId,
      taskKey: 'core'
    })
    fixture.close()
  })

  it('refuses when the dispatch never had a report rejected in the first place', async () => {
    const fixture = objectiveStoreFixture()
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: `${fixture.revisionId}:core`,
      revisionId: fixture.revisionId,
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const entries = [
      attempt(dispatch, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-core' }),
      workerDone('dispatch-core')
    ]
    const action: AcceptReportAction = {
      kind: 'accept-report',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'accept-report:dispatch-core',
      recovery: 'replay-safe',
      revisionId: fixture.revisionId,
      taskKey: 'core',
      dispatchId: 'dispatch-core',
      attestation: 'Nothing to excuse.'
    }
    const outcome = await acceptOwnerReport({
      action,
      binding,
      context: executeContext(entries),
      objectiveStore: fixture.objectiveStore
    })
    expect(outcome).toMatchObject({
      effect: 'not-landed',
      reason: 'accept-report-no-rejected-report'
    })
    fixture.close()
  })
})

describe('amendOwnerPlan', () => {
  it('carries a maximum-length attestation through parsing, action, result, and projections', async () => {
    const fixture = objectiveStoreFixture()
    fixture.objectiveStore.recordNodeDispatch({
      watcherId: WATCHER_ID,
      revisionId: fixture.revisionId,
      taskKey: 'core',
      orchestrationTaskId: 'orchestration-core',
      dispatchId: 'dispatch-core',
      dispatchedAtMs: 3
    })
    const attestation = 'a'.repeat(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
    const rawIntervention = {
      kind: 'amend-plan' as const,
      revisionId: fixture.revisionId,
      patch: {
        digest: 'amend-digest-1',
        attestation,
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
      attestation
    }
    expect(
      ObjectiveOwnerInterventionSchema.safeParse({
        ...rawIntervention,
        attestation: `${attestation}x`
      }).success
    ).toBe(false)
    expect(
      ObjectiveOwnerInterventionSchema.safeParse({
        ...rawIntervention,
        patch: { ...rawIntervention.patch, attestation: `${attestation}x` }
      }).success
    ).toBe(false)

    const intervention = ObjectiveOwnerInterventionSchema.parse(rawIntervention)
    const action = ObjectiveActionSchema.parse(
      objectiveActionForIntervention(
        intervention,
        snapshot(fixture.objectiveStore.project(WATCHER_ID))
      )
    )
    if (action.kind !== 'amend-plan') {
      throw new Error(`expected amend-plan, got ${action.kind}`)
    }
    const outcome = await amendOwnerPlan({
      action,
      binding,
      context: executeContext([]),
      objectiveStore: fixture.objectiveStore
    })
    const result = ObjectiveActionResultSchema.parse(outcome.result)
    expect(outcome.effect).toBe('landed')
    expect(result).toMatchObject({ kind: 'plan-amended', ordinal: 0, replayed: false })
    expect(result.kind === 'plan-amended' ? result.attestation : null).toBe(attestation)

    const projection = ObjectiveProjectionSchema.parse(fixture.objectiveStore.project(WATCHER_ID))
    expect(projection.revisions[0]?.amendments?.[0]?.attestation).toBe(attestation)
    const detail = ObjectiveDetailSchema.parse(fixture.objectiveStore.detail(WATCHER_ID, CONTRACT))
    expect(detail.revisions[0]?.amendments?.[0]?.attestation).toBe(attestation)
    expect(projection.nodes.find((node) => node.taskKey === 'core')?.state).toBe('succeeded')
    expect(projection.nodes.find((node) => node.taskKey === 'follow-up')).toBeTruthy()
    fixture.close()
  })

  it('refuses to drop a task whose dispatch is still in flight, derived from the ledger', async () => {
    const fixture = objectiveStoreFixture()
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: `${fixture.revisionId}:core`,
      revisionId: fixture.revisionId,
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    // running, unresolved: no dispatch row exists yet, so the store alone cannot see this is unsafe
    const entries = [attempt(dispatch, { dispatchId: 'dispatch-core' })]
    const action: AmendPlanAction = {
      kind: 'amend-plan',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'amend-plan:amend-digest-2',
      recovery: 'replay-safe',
      revisionId: fixture.revisionId,
      patch: {
        digest: 'amend-digest-2',
        attestation: 'Trying to drop a running task',
        upsertTasks: [],
        dropTaskKeys: ['core']
      },
      attestation: 'Trying to drop a running task'
    }
    const outcome = await amendOwnerPlan({
      action,
      binding,
      context: executeContext(entries),
      objectiveStore: fixture.objectiveStore
    })
    expect(outcome).toMatchObject({
      effect: 'not-landed',
      reason: 'amend-plan-drops-in-flight-node'
    })
    fixture.close()
  })
})

describe('skipOwnerReview', () => {
  it('records a synthetic approve verdict covering every criterion in the plan', async () => {
    const fixture = objectiveStoreFixture()
    const dispatchId = `${OWNER_SKIP_REVIEW_DISPATCH_PREFIX}${fixture.revisionId}:reviewer:content-current`
    const action: SkipReviewAction = {
      kind: 'skip-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: `skip-review:${dispatchId}`,
      recovery: 'replay-safe',
      revisionId: fixture.revisionId,
      role: 'reviewer',
      dispatchId,
      reviewedContentIdentity: 'content-current',
      rationale: 'The bar does not mandate a reviewer verdict for this objective.'
    }
    const outcome = await skipOwnerReview({
      action,
      binding,
      context: executeContext([]),
      objectiveStore: fixture.objectiveStore
    })
    expect(outcome.effect).toBe('landed')
    expect(outcome.result).toMatchObject({
      kind: 'review-skipped',
      role: 'reviewer',
      rationale: 'The bar does not mandate a reviewer verdict for this objective.'
    })
    expect(fixture.objectiveStore.hasVerdict(dispatchId)).toBe(true)
    const verdicts = fixture.objectiveStore.project(WATCHER_ID).verdicts
    // the projection flags this verdict as owner-synthesized purely from the dispatchId
    // namespace — this is the auditability signal a real reviewer's verdict never carries
    expect(verdicts).toEqual([
      expect.objectContaining({
        dispatchId,
        role: 'reviewer',
        verdict: 'approve',
        synthesizedByOwner: true
      })
    ])
    fixture.close()
  })

  it('leaves a real reviewer verdict unflagged, so the two stay distinguishable', () => {
    const fixture = objectiveStoreFixture()
    fixture.objectiveStore.recordVerdict({
      watcherId: WATCHER_ID,
      revisionId: fixture.revisionId,
      dispatchId: 'real-reviewer-dispatch-1',
      role: 'reviewer',
      contentIdentity: 'content-current',
      report: {
        verdict: 'approve',
        criteriaResults: [
          { taskKey: 'core', criterionIndex: 0, result: 'pass', note: 'Looks good' }
        ],
        summary: 'Approved after inspection'
      },
      reportDigest: 'digest-real-reviewer',
      createdAtMs: 10
    })
    const verdicts = fixture.objectiveStore.project(WATCHER_ID).verdicts
    expect(verdicts).toEqual([
      expect.objectContaining({ dispatchId: 'real-reviewer-dispatch-1', synthesizedByOwner: false })
    ])
    fixture.close()
  })
})

describe('skipOwnerCheck', () => {
  it('records a synthetic passing check for the named criterion', async () => {
    const fixture = objectiveStoreFixture()
    const criterionId = fixture.objectiveStore
      .project(WATCHER_ID)
      .nodes.find((node) => node.taskKey === 'checked')?.criteria[0]?.id
    if (!criterionId) {
      throw new Error('fixture did not create the shell-checkable criterion')
    }
    const action: SkipCheckAction = {
      kind: 'skip-check',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: `${criterionId}:content-current`,
      recovery: 'replay-safe',
      criterionId,
      rationale: 'Flaky in CI; the owner verified the build manually.'
    }
    const outcome = await skipOwnerCheck({
      action,
      binding,
      context: executeContext([]),
      objectiveStore: fixture.objectiveStore
    })
    expect(outcome.effect).toBe('landed')
    expect(outcome.result).toMatchObject({
      kind: 'check-skipped',
      rationale: 'Flaky in CI; the owner verified the build manually.'
    })
    const check = fixture.objectiveStore.getCheckAttempt(criterionId, 'content-current')
    expect(check?.exitCode).toBe(0)
    expect(check?.completedAtMs).not.toBeNull()
    fixture.close()
  })

  it('waives a check that already ran and failed at the same content identity', async () => {
    const fixture = objectiveStoreFixture()
    const criterionId = fixture.objectiveStore
      .project(WATCHER_ID)
      .nodes.find((node) => node.taskKey === 'checked')?.criteria[0]?.id
    if (!criterionId) {
      throw new Error('fixture did not create the shell-checkable criterion')
    }
    fixture.objectiveStore.startCheckAttempt({
      watcherId: WATCHER_ID,
      criterionId,
      contentIdentity: 'content-current',
      executionHostId: 'local',
      command: 'bash -c "exit 128"',
      epoch: 1,
      startedAtMs: 10
    })
    fixture.objectiveStore.completeCheckAttempt({
      criterionId,
      contentIdentity: 'content-current',
      exitCode: 128,
      timedOut: false,
      stdoutTail: '',
      stderrTail: 'fatal: index file smaller than expected',
      completedAtMs: 20
    })
    const action: SkipCheckAction = {
      kind: 'skip-check',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: `${criterionId}:content-current`,
      recovery: 'replay-safe',
      criterionId,
      rationale: 'The check harness cannot run; the criterion itself holds.'
    }
    const outcome = await skipOwnerCheck({
      action,
      binding,
      context: executeContext([]),
      objectiveStore: fixture.objectiveStore
    })
    expect(outcome.effect).toBe('landed')
    const check = fixture.objectiveStore.getCheckAttempt(criterionId, 'content-current')
    expect(check?.exitCode).toBe(0)
    expect(check?.ownerSkip).toBe(true)
    expect(check?.stderrTail).toContain('The check harness cannot run')
    fixture.close()
  })

  it('leaves the first waiver standing when the same skip is replayed', async () => {
    const fixture = objectiveStoreFixture()
    const criterionId = fixture.objectiveStore
      .project(WATCHER_ID)
      .nodes.find((node) => node.taskKey === 'checked')?.criteria[0]?.id
    if (!criterionId) {
      throw new Error('fixture did not create the shell-checkable criterion')
    }
    const action: SkipCheckAction = {
      kind: 'skip-check',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: `${criterionId}:content-current`,
      recovery: 'replay-safe',
      criterionId,
      rationale: 'First waiver'
    }
    await skipOwnerCheck({
      action,
      binding,
      context: executeContext([]),
      objectiveStore: fixture.objectiveStore
    })
    const first = fixture.objectiveStore.getCheckAttempt(criterionId, 'content-current')
    const outcome = await skipOwnerCheck({
      action: { ...action, rationale: 'Second waiver' },
      binding,
      context: executeContext([]),
      objectiveStore: fixture.objectiveStore
    })
    expect(outcome.effect).toBe('landed')
    const second = fixture.objectiveStore.getCheckAttempt(criterionId, 'content-current')
    expect(second).toEqual(first)
    fixture.close()
  })

  it('refuses a criterion that is not shell-checkable', async () => {
    const fixture = objectiveStoreFixture()
    const criterionId = fixture.objectiveStore
      .project(WATCHER_ID)
      .nodes.find((node) => node.taskKey === 'core')?.criteria[0]?.id
    if (!criterionId) {
      throw new Error('fixture did not create the non-shell-checkable criterion')
    }
    const action: SkipCheckAction = {
      kind: 'skip-check',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: `${criterionId}:content-current`,
      recovery: 'replay-safe',
      criterionId,
      rationale: 'Trying to skip a non-shell criterion'
    }
    const outcome = await skipOwnerCheck({
      action,
      binding,
      context: executeContext([]),
      objectiveStore: fixture.objectiveStore
    })
    expect(outcome).toMatchObject({
      effect: 'not-landed',
      reason: 'skip-check-criterion-not-shell-checkable'
    })
    fixture.close()
  })
})
