import { describe, expect, it } from 'vitest'
import {
  NodeFailedDeviationSchema,
  ReviewBlockedDeviationSchema
} from '../fork-heimdall/owner/deviation'
import { OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH } from './contract-types'
import {
  objectiveNodeFailedDeviation,
  objectiveReportRejectedDeviation,
  objectiveReviewBlockedDeviation
} from './deviation-context'
import { decideObjective } from './decision'
import {
  attempt,
  CONTRACT,
  ledger,
  node,
  projection,
  revision,
  snapshot,
  workerDone
} from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectiveDispatchRecord } from './parallel-types'

const dispatch: ObjectiveAction = {
  kind: 'dispatch-node',
  capability: 'implement',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'revision-1:core',
  revisionId: 'revision-1',
  taskKey: 'core',
  depsOrchestrationIds: []
}

function runningDispatchRecord(
  overrides: Partial<ObjectiveDispatchRecord> = {}
): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: 'fingerprint-dispatch-core',
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey: 'core',
    dispatchId: 'dispatch-core',
    workspaceId: 'workspace-core',
    workspacePath: '/workspaces/core',
    baseCommit: 'base-commit',
    laneTaskKeys: ['core'],
    sessionNodeCount: 1,
    state: 'running',
    commitSha: null,
    appliedCommitSha: null,
    reportDigest: 'report-core',
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    planTaskDigest: 'plan-digest-core',
    createdAtMs: 10,
    completedAtMs: null,
    terminalHandle: 'terminal-core',
    setupState: 'ready',
    reportPath: '/outside/report.json',
    report: {
      taskKey: 'core',
      summary: 'Implemented core.',
      filesModified: ['src/core.ts'],
      criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified locally.' }]
    },
    task: {
      taskKey: 'core',
      title: 'Task core',
      spec: 'Implement core',
      deps: [],
      criteria: [{ body: 'core works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    },
    ...overrides
  }
}

describe('objective node deviations, owner configured', () => {
  it('emits node-failed for an already-failed node instead of replanning', () => {
    const plan = projection({
      nodes: [node('core', { state: 'failed', dispatchId: 'dispatch-core' })]
    })
    const decision = decideObjective(snapshot(plan), ledger(), true)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: { kind: 'node-failed', taskKey: 'core', dispatchId: 'dispatch-core' }
    })
  })

  it("emits report-rejected with the rejected attempt's reported and observed files", () => {
    const ingestReport: ObjectiveAction = {
      kind: 'ingest-report',
      capability: 'implement',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-core',
      revisionId: 'revision-1',
      dispatchId: 'dispatch-core',
      taskKey: 'core',
      orchestrationTaskId: 'orchestration-core',
      reportPath: '/outside/report.json',
      filesModified: ['src/core.ts'],
      dispatchedContentIdentity: 'content-current'
    }
    const dispatched = attempt(dispatch, {
      state: 'settled',
      effect: 'landed',
      dispatchId: 'dispatch-core'
    })
    const rejected = {
      // a distinct harness dispatchId keeps this attempt's synthetic id from colliding with the
      // dispatch attempt above, which shares the same real evidenceKey by production convention
      ...attempt(ingestReport, {
        state: 'settled',
        effect: 'not-landed',
        reason: 'reported-files-do-not-match-observed-changes',
        dispatchId: 'ingest-report-attempt'
      }),
      result: { reportedFiles: ['src/core.ts'], observedFiles: ['src/core.ts', 'docs/extra.md'] }
    }
    const plan = projection({
      nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
    })
    const decision = decideObjective(
      snapshot(plan),
      ledger([
        dispatched,
        rejected,
        {
          kind: 'evidence',
          eventId: 'evidence-dispatch-core',
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          evidenceKind: 'orchestration-mailbox',
          payload: {
            type: 'worker_done',
            payload: {
              dispatchId: 'dispatch-core',
              taskId: 'task-core',
              outcome: 'succeeded',
              reportPath: '/outside/report.json',
              filesModified: ['src/core.ts']
            }
          }
        }
      ]),
      true
    )
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: {
        kind: 'report-rejected',
        dispatchId: 'dispatch-core',
        taskKey: 'core',
        rejectionReason: 'reported-files-do-not-match-observed-changes',
        reportedFiles: ['src/core.ts'],
        observedFiles: ['src/core.ts', 'docs/extra.md']
      }
    })
  })

  it('carries the rejection detail into the deviation for a malformed report', () => {
    const ingestReport: ObjectiveAction = {
      kind: 'ingest-report',
      capability: 'implement',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-core',
      revisionId: 'revision-1',
      dispatchId: 'dispatch-core',
      taskKey: 'core',
      orchestrationTaskId: 'orchestration-core',
      reportPath: '/outside/report.json',
      filesModified: ['src/core.ts'],
      dispatchedContentIdentity: 'content-current'
    }
    const dispatched = attempt(dispatch, {
      state: 'settled',
      effect: 'landed',
      dispatchId: 'dispatch-core'
    })
    const rejected = {
      ...attempt(ingestReport, {
        state: 'settled',
        effect: 'not-landed',
        reason: 'implementer-report-malformed',
        dispatchId: 'ingest-report-attempt'
      }),
      result: { detail: 'summary: Invalid input: expected string, received object' }
    }
    const plan = projection({
      nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
    })
    const decision = decideObjective(
      snapshot(plan),
      ledger([
        dispatched,
        rejected,
        {
          kind: 'evidence',
          eventId: 'evidence-dispatch-core',
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          evidenceKind: 'orchestration-mailbox',
          payload: {
            type: 'worker_done',
            payload: {
              dispatchId: 'dispatch-core',
              taskId: 'task-core',
              outcome: 'succeeded',
              reportPath: '/outside/report.json',
              filesModified: ['src/core.ts']
            }
          }
        }
      ]),
      true
    )
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: {
        kind: 'report-rejected',
        dispatchId: 'dispatch-core',
        taskKey: 'core',
        rejectionReason: 'implementer-report-malformed',
        detail: 'summary: Invalid input: expected string, received object'
      }
    })
  })

  it('re-emits ingest-report under the reemission cap, then rejects once it is reached', () => {
    const dispatched = attempt(dispatch, {
      state: 'settled',
      effect: 'landed',
      dispatchId: 'dispatch-core'
    })
    const done = workerDone('dispatch-core')
    const durableReport = runningDispatchRecord()
    const plan = projection({
      nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
    })
    const snapshotWithRunningDispatch = snapshot(plan, {
      parallel: { effectiveMaxConcurrency: 1, runningCount: 1, dispatches: [durableReport] }
    })
    const originalIngest: ObjectiveAction = {
      kind: 'ingest-report',
      capability: 'implement',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-core',
      revisionId: 'revision-1',
      dispatchId: 'dispatch-core',
      taskKey: 'core',
      orchestrationTaskId: 'orchestration-core',
      reportPath: '/outside/report.json',
      filesModified: ['src/core.ts'],
      dispatchedContentIdentity: 'content-current'
    }
    const retryIngest: ObjectiveAction = {
      ...originalIngest,
      evidenceKey: 'dispatch-core#ingest-retry-1'
    }
    const failedOriginal = {
      // a distinct harness dispatchId keeps this attempt's synthetic id from colliding with the
      // dispatch attempt above, which shares the same real evidenceKey by production convention
      ...attempt(originalIngest, {
        state: 'settled',
        effect: 'not-landed',
        reason: 'git commit failed: pre-commit hook rejected the normalization commit',
        dispatchId: 'ingest-attempt-original'
      }),
      failureClass: 'infra' as const
    }
    const failedRetry = {
      ...attempt(retryIngest, {
        state: 'settled',
        effect: 'not-landed',
        reason: 'git commit failed: pre-commit hook rejected the normalization commit',
        dispatchId: 'ingest-attempt-retry-1'
      }),
      failureClass: 'infra' as const
    }

    const belowCap = decideObjective(
      snapshotWithRunningDispatch,
      ledger([dispatched, done, failedOriginal]),
      true
    )
    expect(belowCap.action).toMatchObject({
      kind: 'ingest-report',
      dispatchId: 'dispatch-core',
      evidenceKey: 'dispatch-core#ingest-retry-1'
    })

    const atCap = decideObjective(
      snapshotWithRunningDispatch,
      ledger([dispatched, done, failedOriginal, failedRetry]),
      true
    )
    expect(atCap.action).toBeNull()
    expect(atCap).toMatchObject({
      deviation: {
        kind: 'report-rejected',
        taskKey: 'core',
        dispatchId: 'dispatch-core',
        rejectionReason: 'git commit failed: pre-commit hook rejected the normalization commit'
      }
    })
  })

  it('emits retry-exhausted once the redispatch cap is reached instead of a silent park', () => {
    const retry0: ObjectiveAction = {
      ...dispatch,
      evidenceKey: 'revision-1:core:r0',
      retryOf: 'revision-1:core'
    }
    const retry1: ObjectiveAction = {
      ...dispatch,
      evidenceKey: 'revision-1:core:r1',
      retryOf: 'revision-1:core'
    }
    const original = {
      ...attempt(dispatch, { state: 'settled', effect: 'not-landed', dispatchId: 'dispatch-core' }),
      failureClass: 'infra' as const
    }
    const first = {
      ...attempt(retry0, {
        state: 'settled',
        effect: 'not-landed',
        dispatchId: 'dispatch-core-r0'
      }),
      failureClass: 'environment' as const
    }
    const second = {
      ...attempt(retry1, {
        state: 'settled',
        effect: 'not-landed',
        dispatchId: 'dispatch-core-r1'
      }),
      failureClass: 'infra' as const
    }
    const decision = decideObjective(
      snapshot(projection()),
      ledger([original, first, second]),
      true
    )
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: {
        kind: 'retry-exhausted',
        taskKey: 'core',
        retryCount: 2,
        lastFailureClass: 'infra'
      }
    })
  })

  it('emits node-failed for a non-retryable dispatch failure instead of replanning', () => {
    const failed = {
      ...attempt(dispatch, { state: 'settled', effect: 'not-landed', dispatchId: 'dispatch-core' }),
      failureClass: 'criteria' as const
    }
    const decision = decideObjective(snapshot(projection()), ledger([failed]), true)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: {
        kind: 'node-failed',
        taskKey: 'core',
        dispatchId: 'dispatch-core',
        failureClass: 'criteria'
      }
    })
  })

  it('emits node-failed when a settled dispatch landed but the worker never reported', () => {
    const settled = attempt(dispatch, {
      state: 'settled',
      effect: 'landed',
      dispatchId: 'dispatch-core'
    })
    const decision = decideObjective(snapshot(projection()), ledger([settled]), true)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: {
        kind: 'node-failed',
        taskKey: 'core',
        dispatchId: 'dispatch-core',
        failureClass: null
      }
    })
  })

  it('still repairs automatically for every site above when no owner is configured', () => {
    const failed = projection({
      nodes: [node('core', { state: 'failed', dispatchId: 'dispatch-core' })]
    })
    const decision = decideObjective(snapshot(failed), ledger())
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      shape: 'repair',
      repairRevisionId: 'revision-1',
      reason: 'replan-after-failure'
    })
    expect('deviation' in decision).toBe(false)
  })
})

describe('objective landing deviation, owner configured', () => {
  it('emits landing-failed instead of replanning when record-landing resolves not-landed', () => {
    const succeeded = node('core', { state: 'succeeded' })
    const plan = projection({
      revisions: [revision({ approvedAtMs: 20 })],
      nodes: [succeeded]
    })
    const recordLanding: ObjectiveAction = {
      kind: 'record-landing',
      capability: 'land',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'files-on-disk:content-current',
      rung: 'files-on-disk',
      revisionId: 'revision-1'
    }
    const failedLanding = attempt(recordLanding, {
      state: 'settled',
      effect: 'not-landed',
      reason: 'landing-evidence-stale'
    })
    const decision = decideObjective(
      snapshot(plan, { contract: { ...CONTRACT, tier: 'express' } }),
      ledger([failedLanding]),
      true
    )
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({
      deviation: {
        kind: 'landing-failed',
        rung: 'files-on-disk',
        contentIdentity: 'content-current',
        reason: 'landing-evidence-stale'
      }
    })
  })
})

describe('report summary deviation bounds', () => {
  it('preserves a task-sized summary and rejects one character over at the schema boundary', () => {
    const summary = 's'.repeat(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH)
    const nodeFailure = objectiveNodeFailedDeviation({
      taskKey: 'core',
      dispatchId: 'dispatch-core',
      failureClass: 'criteria',
      summary
    })
    const reviewBlock = objectiveReviewBlockedDeviation({
      role: 'reviewer',
      dispatchId: 'review-core',
      summary
    })
    if (nodeFailure.kind !== 'node-failed' || reviewBlock.kind !== 'review-blocked') {
      throw new Error('expected report-summary deviations')
    }
    expect([nodeFailure.summary, reviewBlock.summary]).toEqual([summary, summary])
    expect(
      NodeFailedDeviationSchema.safeParse({
        ...nodeFailure,
        summary: `${summary}x`
      }).success
    ).toBe(false)
    expect(
      ReviewBlockedDeviationSchema.safeParse({
        ...reviewBlock,
        summary: `${summary}x`
      }).success
    ).toBe(false)
  })

  it('marks abbreviated report-rejection file diagnostics without changing canonical input', () => {
    const files = Array.from({ length: 258 }, (_, index) => `src/${index}.ts`)
    const deviation = objectiveReportRejectedDeviation({
      dispatchId: 'dispatch-core',
      taskKey: 'core',
      rejectionReason: 'files mismatch',
      reportedFiles: files,
      observedFiles: []
    })
    if (deviation.kind !== 'report-rejected') {
      throw new Error('expected report rejection')
    }
    expect(deviation.reportedFiles).toHaveLength(256)
    expect(deviation.detail).toContain('reported omitted=2')
    expect(files).toHaveLength(258)
  })
})
