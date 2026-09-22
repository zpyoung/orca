import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../../shared/fork-heimdall/owner/intervention'
import type { DispatchResult, ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { projection, snapshot } from '../../shared/fork-heimdall-objective/decision-test-harness'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { deriveObjectiveFailureContext, executeObjectiveDispatch } from './dispatch-executor'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'
const runtime = {} as OrcaRuntimeService

const { issueReportPath, captureBaseline, resolveAgent, readRoleReport, buildRolePrompt } =
  vi.hoisted(() => ({
    issueReportPath: vi.fn(),
    captureBaseline: vi.fn(),
    resolveAgent: vi.fn(),
    readRoleReport: vi.fn(),
    buildRolePrompt: vi.fn()
  }))
vi.mock('./report-ingestion', () => ({
  issueObjectiveReportPath: issueReportPath,
  readObjectiveRoleReport: readRoleReport
}))
vi.mock('./observed-workspace-changes', () => ({
  captureObjectiveWorkspaceBaseline: captureBaseline
}))
vi.mock('./role-prompts', () => ({
  buildObjectiveRolePrompt: buildRolePrompt,
  resolveObjectiveRoleAgent: resolveAgent
}))

const binding: ObjectiveSnapshotBinding = {
  enrollment: {
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
    kindPayload: {},
    enabled: true,
    generation: 1,
    createdAtMs: 1,
    updatedAtMs: 1
  } as unknown as ObjectiveSnapshotBinding['enrollment'],
  contract: {
    objectiveText: 'Implement the objective.',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    workspaceKind: 'folder',
    writeTerritory: ['src/**'],
    roleAgents: {},
    sitterOverrides: {}
  },
  target: {
    kind: 'folder',
    executionHostId: 'local',
    workspacePath: '/workspace',
    fileProvider: null
  }
}

const dispatchNode: ObjectiveAction = {
  kind: 'dispatch-node',
  capability: 'implement',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'revision-1:node-a',
  revisionId: 'revision-1',
  taskKey: 'node-a',
  depsOrchestrationIds: []
}

const retryDispatchNode: ObjectiveAction = {
  ...dispatchNode,
  evidenceKey: 'revision-1:node-a:r0',
  retryOf: 'revision-1:node-a'
}

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
  clearParallelNoteWithPrefix: vi.fn()
} as unknown as ObjectiveStore

function context(
  ledger: WatcherLedger,
  dispatchResult: DispatchResult
): ExecuteContext<ObjectiveWorld> {
  return {
    snapshot: snapshot(projection({ revisions: [], nodes: [] })),
    lease: {
      epoch: 1,
      holder: 'test',
      assertHeld: vi.fn(async () => undefined),
      renewLoop: () => ({ dispose: () => undefined })
    },
    ledger,
    dispatchWorker: vi.fn(async () => dispatchResult)
  }
}

describe('executeObjectiveDispatch', () => {
  beforeEach(() => {
    issueReportPath.mockReset()
    captureBaseline.mockReset()
    resolveAgent.mockReset()
    readRoleReport.mockReset()
    buildRolePrompt.mockReset()
    issueReportPath.mockResolvedValue('/workspace/report.json')
    resolveAgent.mockReturnValue('claude')
    readRoleReport.mockResolvedValue({ ok: false, reason: 'missing' })
    buildRolePrompt.mockReturnValue('implement the task')
  })

  it('dispatches a node and returns landed with the issued report path', async () => {
    const outcome = await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store: {} as Store,
      runtime
    })
    expect(outcome).toEqual({
      effect: 'landed',
      result: { dispatchId: 'dispatch-1', reportPath: '/workspace/report.json' }
    })
  })

  it('tags a pre-dispatch failure as infra', async () => {
    resolveAgent.mockImplementation(() => {
      throw new Error('no agent configured')
    })
    const outcome = await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store: {} as Store,
      runtime
    })
    expect(outcome).toEqual({
      effect: 'not-landed',
      failureClass: 'infra',
      reason: 'no agent configured'
    })
    expect(captureBaseline).not.toHaveBeenCalled()
  })

  it('tags a refused dispatch as infra', async () => {
    const outcome = await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'refused', reason: 'fenced', detail: 'lease unavailable' }
      ),
      objectiveStore,
      store: {} as Store,
      runtime
    })
    expect(outcome).toEqual({
      effect: 'not-landed',
      failureClass: 'infra',
      reason: 'fenced',
      result: { detail: 'lease unavailable' }
    })
  })

  it('refuses a retry as infra when its original dispatch is missing from the ledger', async () => {
    const outcome = await executeObjectiveDispatch({
      action: retryDispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store: {} as Store,
      runtime
    })
    expect(outcome).toEqual({
      effect: 'not-landed',
      failureClass: 'infra',
      reason: "Objective retry's original dispatch is missing from the ledger: revision-1:node-a"
    })
    expect(captureBaseline).not.toHaveBeenCalled()
  })

  it('forwards a requested skip stage separately from the full owner rationale', async () => {
    const rationale = 'r'.repeat(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
    const plannerAction: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan:1:owner-directed:content-current',
      revisionNumber: 1,
      reason: 'owner-directed',
      requestedSkipStage: 'hosted-review',
      guidance: rationale
    }
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    executeContext.snapshot = snapshot(projection({ revisions: [], nodes: [] }))

    await executeObjectiveDispatch({
      action: plannerAction,
      binding,
      context: executeContext,
      objectiveStore,
      store: {} as Store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'planner',
        requestedSkipStage: 'hosted-review',
        ownerGuidance: rationale
      })
    )
  })

  it('defaults the concurrency cap to 1 and lanes to enabled when the world has no parallel projection', async () => {
    await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store: {} as Store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveMaxConcurrency: 1, lanesEnabled: true })
    )
  })

  it("reads the world's live effective concurrency cap so a mid-run set-concurrency reaches the next dispatch", async () => {
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    executeContext.snapshot = snapshot(projection({ revisions: [], nodes: [] }), {
      parallel: {
        effectiveMaxConcurrency: 5,
        runningCount: 2,
        dispatches: []
      }
    })

    await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: executeContext,
      objectiveStore,
      store: {} as Store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveMaxConcurrency: 5 })
    )
  })

  it('reads lanesEnabled off the contract, forwarding false only when explicitly disabled', async () => {
    await executeObjectiveDispatch({
      action: dispatchNode,
      binding: { ...binding, contract: { ...binding.contract, lanesEnabled: false } },
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store: {} as Store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(expect.objectContaining({ lanesEnabled: false }))
  })

  it('supplies the concurrency cap and lanesEnabled to a planner dispatch as well', async () => {
    const plannerAction: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan:1:initial',
      revisionNumber: 1,
      reason: 'initial'
    }
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    executeContext.snapshot = snapshot(projection({ revisions: [], nodes: [] }), {
      parallel: { effectiveMaxConcurrency: 3, runningCount: 0, dispatches: [] }
    })

    await executeObjectiveDispatch({
      action: plannerAction,
      binding,
      context: executeContext,
      objectiveStore,
      store: {} as Store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'planner', effectiveMaxConcurrency: 3, lanesEnabled: true })
    )
  })
})

function failedNodeAttempt(args: {
  dispatchId: string
  fingerprint: string
  failureClass?: 'infra' | 'environment' | 'criteria'
}): WatcherLedger['entries'][number] {
  return {
    eventId: 'event-failed-attempt',
    watcherId: 'watcher-1',
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-failed',
    fingerprint: args.fingerprint,
    action: dispatchNode,
    state: 'settled',
    effect: 'not-landed',
    dispatchId: args.dispatchId,
    ...(args.failureClass === undefined ? {} : { failureClass: args.failureClass })
  }
}

function workerDoneEvidence(args: {
  dispatchId: string
  subject?: string
  body?: string
  reportPath?: string | null
}): WatcherLedger['entries'][number] {
  return {
    eventId: 'event-worker-done',
    watcherId: 'watcher-1',
    atMs: 5,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      payload: {
        dispatchId: args.dispatchId,
        taskId: 'orchestration-task-1',
        outcome: 'failed',
        reportPath: args.reportPath ?? null,
        filesModified: []
      },
      ...(args.subject === undefined ? {} : { subject: args.subject }),
      ...(args.body === undefined ? {} : { body: args.body })
    }
  }
}

describe('deriveObjectiveFailureContext', () => {
  const plannerReplanAfterFailure: Extract<ObjectiveAction, { kind: 'dispatch-planner' }> = {
    kind: 'dispatch-planner',
    capability: 'plan',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: 'plan:2',
    revisionNumber: 2,
    reason: 'replan-after-failure'
  }

  beforeEach(() => {
    readRoleReport.mockReset()
    readRoleReport.mockResolvedValue({ ok: false, reason: 'missing' })
  })

  it('joins the failed node, its failure class, and the worker narrative from the ledger', async () => {
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [
        failedNodeAttempt({
          dispatchId: 'dispatch-1',
          fingerprint: 'fp-1',
          failureClass: 'environment'
        }),
        workerDoneEvidence({
          dispatchId: 'dispatch-1',
          subject: 'Node A failed',
          body: 'The health check assertion failed on line 42.'
        })
      ]
    }

    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding,
      ledger,
      objectiveStore,
      activeRevisionId: 'revision-1'
    })

    expect(context).toEqual({
      taskKey: 'node-a',
      failureClass: 'environment',
      narrative: 'Node A failed\nThe health check assertion failed on line 42.',
      failingCriteria: []
    })
  })

  it('joins the specific criteria the implementer self-assessed as failed', async () => {
    readRoleReport.mockResolvedValue({
      ok: true,
      role: 'implementer',
      path: '/workspace/report.json',
      report: {
        taskKey: 'node-a',
        summary: 'Could not make the check pass.',
        filesModified: [],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'fail', note: 'Assertion mismatch.' }]
      },
      reportDigest: 'digest-1'
    })
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [
        failedNodeAttempt({
          dispatchId: 'dispatch-1',
          fingerprint: 'fp-1',
          failureClass: 'criteria'
        }),
        workerDoneEvidence({
          dispatchId: 'dispatch-1',
          body: 'Assertion failed.',
          reportPath: '/workspace/report.json'
        })
      ]
    }

    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding,
      ledger,
      objectiveStore,
      activeRevisionId: 'revision-1'
    })

    expect(context?.failingCriteria).toEqual(['A works — Assertion mismatch.'])
  })

  it('returns undefined for a reason other than replan-after-failure', async () => {
    const context = await deriveObjectiveFailureContext({
      action: { ...plannerReplanAfterFailure, reason: 'replan-after-block' },
      binding,
      ledger: { watcherId: 'watcher-1', entries: [] },
      objectiveStore,
      activeRevisionId: 'revision-1'
    })
    expect(context).toBeUndefined()
  })

  it('returns undefined when no failed dispatch-node report matches the active revision', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding,
      ledger: {
        watcherId: 'watcher-1',
        entries: [
          failedNodeAttempt({
            dispatchId: 'dispatch-1',
            fingerprint: 'fp-1',
            failureClass: 'criteria'
          }),
          workerDoneEvidence({ dispatchId: 'dispatch-1' })
        ]
      },
      objectiveStore,
      activeRevisionId: 'revision-other'
    })
    expect(context).toBeUndefined()
  })
})
