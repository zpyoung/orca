import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '../fork-heimdall/ledger-types'
import { decideObjective } from './decision'
import {
  attempt,
  ledger,
  node,
  projection,
  snapshot,
  task as planTask
} from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectiveDispatchRecord } from './parallel-types'

function dispatchAction(taskKey: string): Extract<ObjectiveAction, { kind: 'dispatch-node' }> {
  return {
    kind: 'dispatch-node',
    capability: 'implement',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: `revision-1:${taskKey}`,
    revisionId: 'revision-1',
    taskKey,
    depsOrchestrationIds: []
  }
}

function dispatchRecord(
  taskKey: string,
  state: ObjectiveDispatchRecord['state'],
  overrides: Partial<ObjectiveDispatchRecord> = {}
): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: `fingerprint-dispatch-${taskKey}`,
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey,
    dispatchId: `dispatch-${taskKey}`,
    workspaceId: `workspace-${taskKey}`,
    workspacePath: `/workspaces/${taskKey}`,
    baseCommit: 'base-commit',
    laneTaskKeys: [taskKey],
    sessionNodeCount: 1,
    state,
    commitSha: state === 'waiting-to-apply' || state === 'applying' ? `commit-${taskKey}` : null,
    appliedCommitSha: state === 'applied' ? `applied-${taskKey}` : null,
    reportDigest: state === 'running' ? null : `report-${taskKey}`,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    planTaskDigest: `plan-digest-${taskKey}`,
    createdAtMs: 10,
    completedAtMs: state === 'running' ? null : 20,
    terminalHandle: `terminal-${taskKey}`,
    setupState: 'ready',
    reportPath: null,
    report: null,
    task: planTask(taskKey),
    ...overrides
  }
}

function workerDone(dispatchId: string, taskKey: string, atMs: number): LedgerEntry {
  return {
    kind: 'evidence',
    eventId: `done-${dispatchId}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      payload: {
        dispatchId,
        taskId: `orchestration-${taskKey}`,
        outcome: 'succeeded',
        reportPath: `/reports/${taskKey}.json`,
        filesModified: [`src/${taskKey}.ts`]
      }
    }
  }
}

describe('parallel objective decisions', () => {
  it('skips an in-flight sibling and starts the ready task on the longest remaining chain', () => {
    const running = dispatchAction('running')
    const plan = projection({
      nodes: [
        node('running'),
        node('critical'),
        node('short'),
        node('critical-middle', { deps: ['critical'] }),
        node('critical-tail', { deps: ['critical-middle'] })
      ]
    })
    const decision = decideObjective(
      snapshot(plan, {
        parallel: {
          effectiveMaxConcurrency: 3,
          runningCount: 1,
          dispatches: [dispatchRecord('running', 'running')]
        }
      }),
      ledger([attempt(running, { dispatchId: 'dispatch-running' })])
    )
    expect(decision.action).toMatchObject({ kind: 'dispatch-node', taskKey: 'critical' })
  })

  it('uses original plan order to break equal critical-path ties', () => {
    const plan = projection({
      nodes: [
        node('first'),
        node('second'),
        node('first-tail', { deps: ['first'] }),
        node('second-tail', { deps: ['second'] })
      ]
    })
    expect(
      decideObjective(
        snapshot(plan, {
          parallel: { effectiveMaxConcurrency: 3, runningCount: 0, dispatches: [] }
        }),
        ledger()
      ).action
    ).toMatchObject({
      kind: 'dispatch-node',
      taskKey: 'first'
    })
  })

  it('preserves serial plan order when the effective cap is one', () => {
    const plan = projection({
      nodes: [
        node('short'),
        node('critical'),
        node('critical-middle', { deps: ['critical'] }),
        node('critical-tail', { deps: ['critical-middle'] })
      ]
    })
    expect(decideObjective(snapshot(plan), ledger()).action).toMatchObject({
      kind: 'dispatch-node',
      taskKey: 'short'
    })
  })

  it('lowers the cap by draining and observes a raised cap on the next decision', () => {
    const running = dispatchAction('running')
    const plan = projection({ nodes: [node('running'), node('next')] })
    const entries = ledger([attempt(running, { dispatchId: 'dispatch-running' })])
    const dispatches = [dispatchRecord('running', 'running')]
    expect(
      decideObjective(
        snapshot(plan, {
          parallel: { effectiveMaxConcurrency: 1, runningCount: 1, dispatches }
        }),
        entries
      ).action
    ).toBeNull()
    expect(
      decideObjective(
        snapshot(plan, {
          parallel: { effectiveMaxConcurrency: 2, runningCount: 1, dispatches }
        }),
        entries
      ).action
    ).toMatchObject({ kind: 'dispatch-node', taskKey: 'next' })
  })

  it('applies a completed dependency before admitting its join dependent', () => {
    const waiting = dispatchRecord('base', 'waiting-to-apply')
    const waitingPlan = projection({
      nodes: [
        node('base', { state: 'dispatched', dispatchId: 'dispatch-base' }),
        node('dependent', { deps: ['base'] })
      ]
    })
    expect(
      decideObjective(
        snapshot(waitingPlan, {
          parallel: { effectiveMaxConcurrency: 3, runningCount: 1, dispatches: [waiting] }
        }),
        ledger()
      ).action
    ).toMatchObject({ kind: 'apply-node', taskKey: 'base', dispatchId: 'dispatch-base' })

    const appliedPlan = projection({
      nodes: [
        node('base', {
          state: 'succeeded',
          dispatchId: 'dispatch-base',
          orchestrationTaskId: 'orchestration-base'
        }),
        node('dependent', { deps: ['base'] })
      ]
    })
    expect(
      decideObjective(
        snapshot(appliedPlan, {
          parallel: {
            effectiveMaxConcurrency: 3,
            runningCount: 0,
            dispatches: [dispatchRecord('base', 'applied')]
          }
        }),
        ledger()
      ).action
    ).toMatchObject({ kind: 'dispatch-node', taskKey: 'dependent' })
  })

  it('ingests worker reports in mailbox completion order rather than plan order', () => {
    const first = dispatchAction('first')
    const second = dispatchAction('second')
    const plan = projection({
      nodes: [
        node('first', { state: 'dispatched', dispatchId: 'dispatch-first' }),
        node('second', { state: 'dispatched', dispatchId: 'dispatch-second' })
      ]
    })
    const decision = decideObjective(
      snapshot(plan),
      ledger([
        attempt(first, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-first' }),
        attempt(second, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-second' }),
        workerDone('dispatch-first', 'first', 50),
        workerDone('dispatch-second', 'second', 40)
      ])
    )
    expect(decision.action).toMatchObject({ kind: 'ingest-report', taskKey: 'second' })
  })

  it('applies train entries in completion order', () => {
    const later = dispatchRecord('later', 'waiting-to-apply', { completedAtMs: 50 })
    const earlier = dispatchRecord('earlier', 'waiting-to-apply', { completedAtMs: 40 })
    const plan = projection({
      nodes: [
        node('later', { state: 'dispatched', dispatchId: 'dispatch-later' }),
        node('earlier', { state: 'dispatched', dispatchId: 'dispatch-earlier' })
      ]
    })
    expect(
      decideObjective(
        snapshot(plan, {
          parallel: {
            effectiveMaxConcurrency: 3,
            runningCount: 2,
            dispatches: [later, earlier]
          }
        }),
        ledger()
      ).action
    ).toMatchObject({ kind: 'apply-node', taskKey: 'earlier' })
  })

  it('drains report ingestion and apply after budget exhaustion but starts no fresh node', () => {
    const done = dispatchAction('done')
    const reportPlan = projection({
      nodes: [node('done', { state: 'dispatched', dispatchId: 'dispatch-done' })]
    })
    expect(
      decideObjective(
        snapshot(reportPlan, { budget: { wallClockActiveMs: null, turns: 0 } }),
        ledger([
          attempt(done, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-done' }),
          workerDone('dispatch-done', 'done', 40)
        ])
      ).action
    ).toMatchObject({ kind: 'ingest-report', taskKey: 'done' })

    const waiting = dispatchRecord('done', 'waiting-to-apply')
    expect(
      decideObjective(
        snapshot(reportPlan, {
          budget: { wallClockActiveMs: null, turns: 0 },
          parallel: { effectiveMaxConcurrency: 3, runningCount: 1, dispatches: [waiting] }
        }),
        ledger()
      ).action
    ).toMatchObject({ kind: 'apply-node', taskKey: 'done' })

    expect(
      decideObjective(
        snapshot(projection({ nodes: [node('fresh')] }), {
          budget: { wallClockActiveMs: null, turns: 0 },
          parallel: { effectiveMaxConcurrency: 3, runningCount: 0, dispatches: [] }
        }),
        ledger()
      ).action
    ).toBeNull()
  })

  it('continues a conflict in its occupied slot after budget exhaustion', () => {
    const original = dispatchAction('conflicted')
    const originalAttempt = attempt(original, {
      state: 'settled',
      effect: 'landed',
      dispatchId: 'dispatch-conflicted'
    })
    const resolving = dispatchRecord('conflicted', 'resolving-conflict', {
      attemptFingerprint: originalAttempt.fingerprint,
      dispatchId: 'dispatch-conflicted',
      conflictPaths: ['src/shared.ts'],
      conflictingTaskKeys: ['other'],
      conflictingDispatchIds: ['dispatch-other']
    })
    const decision = decideObjective(
      snapshot(
        projection({
          nodes: [node('conflicted', { state: 'dispatched', dispatchId: 'dispatch-conflicted' })]
        }),
        {
          budget: { wallClockActiveMs: null, turns: 0 },
          parallel: { effectiveMaxConcurrency: 1, runningCount: 1, dispatches: [resolving] }
        }
      ),
      ledger([originalAttempt])
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-node',
      taskKey: 'conflicted',
      retryOf: 'revision-1:conflicted',
      evidenceKey: 'revision-1:conflicted:r0'
    })
  })

  it('names conflict paths and both dispatches when conflict retries are exhausted', () => {
    const original = dispatchAction('conflicted')
    const retry0 = {
      ...original,
      evidenceKey: 'revision-1:conflicted:r0',
      retryOf: original.evidenceKey
    }
    const retry1 = {
      ...original,
      evidenceKey: 'revision-1:conflicted:r1',
      retryOf: original.evidenceKey
    }
    const originalAttempt = attempt(original, {
      state: 'settled',
      effect: 'landed',
      dispatchId: 'dispatch-conflicted'
    })
    const resolving = dispatchRecord('conflicted', 'resolving-conflict', {
      attemptFingerprint: originalAttempt.fingerprint,
      dispatchId: 'dispatch-conflicted',
      conflictPaths: ['src/shared.ts'],
      conflictingTaskKeys: ['other'],
      conflictingDispatchIds: ['dispatch-other']
    })
    const other = dispatchRecord('other', 'applied', { dispatchId: 'dispatch-other' })
    const decision = decideObjective(
      snapshot(
        projection({
          nodes: [
            node('conflicted', { state: 'dispatched', dispatchId: 'dispatch-conflicted' }),
            node('other', { state: 'succeeded', dispatchId: 'dispatch-other' })
          ]
        }),
        {
          parallel: {
            effectiveMaxConcurrency: 3,
            runningCount: 1,
            dispatches: [resolving, other]
          }
        }
      ),
      ledger([
        originalAttempt,
        attempt(retry0, {
          state: 'settled',
          effect: 'not-landed',
          dispatchId: 'dispatch-conflicted-r0'
        }),
        attempt(retry1, {
          state: 'settled',
          effect: 'not-landed',
          dispatchId: 'dispatch-conflicted-r1'
        })
      ]),
      true
    )
    expect(decision).toMatchObject({
      action: null,
      deviation: {
        kind: 'retry-exhausted',
        taskKey: 'conflicted',
        conflictPaths: ['src/shared.ts'],
        conflictingDispatchIds: ['dispatch-conflicted', 'dispatch-other']
      }
    })
  })

  it('routes a criteria-classified ingest rejection to the failed-node path instead of retrying', () => {
    const dispatch = dispatchAction('node-1')
    const ingestAction: Extract<ObjectiveAction, { kind: 'ingest-report' }> = {
      kind: 'ingest-report',
      capability: 'implement',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-node-1',
      revisionId: 'revision-1',
      dispatchId: 'dispatch-node-1',
      taskKey: 'node-1',
      orchestrationTaskId: 'orchestration-node-1',
      reportPath: '/reports/node-1.json',
      filesModified: ['src/node-1.ts'],
      dispatchedContentIdentity: 'content-current'
    }
    const durableReport = dispatchRecord('node-1', 'running', {
      dispatchId: 'dispatch-node-1',
      reportDigest: 'digest-node-1',
      report: {
        taskKey: 'node-1',
        summary: 'Implemented node one.',
        filesModified: ['src/node-1.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified locally.' }]
      }
    })
    const plan = projection({
      nodes: [node('node-1', { state: 'dispatched', dispatchId: 'dispatch-node-1' })]
    })
    const rejectionReason = 'Objective node HEAD does not descend from its dispatch baseline'

    const decision = decideObjective(
      snapshot(plan, {
        parallel: { effectiveMaxConcurrency: 3, runningCount: 1, dispatches: [durableReport] }
      }),
      ledger([
        attempt(dispatch, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-node-1' }),
        workerDone('dispatch-node-1', 'node-1', 40),
        {
          ...attempt(ingestAction, {
            state: 'settled',
            effect: 'not-landed',
            dispatchId: 'ingest-dispatch-node-1',
            reason: rejectionReason
          }),
          failureClass: 'criteria'
        }
      ]),
      true
    )

    expect(decision).toMatchObject({
      action: null,
      deviation: { kind: 'report-rejected', taskKey: 'node-1', rejectionReason }
    })
  })

  it('re-emits ingest-report with a fresh evidence key while under the reemission cap and classified infra', () => {
    const dispatch = dispatchAction('node-1')
    const ingestAction: Extract<ObjectiveAction, { kind: 'ingest-report' }> = {
      kind: 'ingest-report',
      capability: 'implement',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-node-1',
      revisionId: 'revision-1',
      dispatchId: 'dispatch-node-1',
      taskKey: 'node-1',
      orchestrationTaskId: 'orchestration-node-1',
      reportPath: '/reports/node-1.json',
      filesModified: ['src/node-1.ts'],
      dispatchedContentIdentity: 'content-current'
    }
    const durableReport = dispatchRecord('node-1', 'running', {
      dispatchId: 'dispatch-node-1',
      reportDigest: 'digest-node-1',
      report: {
        taskKey: 'node-1',
        summary: 'Implemented node one.',
        filesModified: ['src/node-1.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified locally.' }]
      }
    })
    const plan = projection({
      nodes: [node('node-1', { state: 'dispatched', dispatchId: 'dispatch-node-1' })]
    })

    const decision = decideObjective(
      snapshot(plan, {
        parallel: { effectiveMaxConcurrency: 3, runningCount: 1, dispatches: [durableReport] }
      }),
      ledger([
        attempt(dispatch, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-node-1' }),
        workerDone('dispatch-node-1', 'node-1', 40),
        {
          ...attempt(ingestAction, {
            state: 'settled',
            effect: 'not-landed',
            dispatchId: 'ingest-dispatch-node-1',
            reason: 'git process spawn failed: ENOENT'
          }),
          failureClass: 'infra'
        }
      ]),
      true
    )

    expect(decision.action).toMatchObject({
      kind: 'ingest-report',
      dispatchId: 'dispatch-node-1',
      evidenceKey: 'dispatch-node-1#ingest-retry-1'
    })
  })

  it('keeps planner work exclusive from implementer fanout', () => {
    const planner: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan:2',
      revisionNumber: 2,
      reason: 'replan-after-failure'
    }
    expect(
      decideObjective(
        snapshot(projection({ nodes: [node('ready')] }), {
          parallel: { effectiveMaxConcurrency: 3, runningCount: 0, dispatches: [] }
        }),
        ledger([attempt(planner, { dispatchId: 'planner-dispatch' })])
      ).action
    ).toBeNull()
  })
})
