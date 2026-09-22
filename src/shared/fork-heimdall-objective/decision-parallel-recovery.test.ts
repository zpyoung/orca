import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '../fork-heimdall/ledger-types'
import { decideObjective } from './decision'
import { attempt, ledger, node, projection, snapshot } from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectiveDispatchRecord, ObjectiveDispatchState } from './parallel-types'

function dispatchAction(): Extract<ObjectiveAction, { kind: 'dispatch-node' }> {
  return {
    kind: 'dispatch-node',
    capability: 'implement',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: 'revision-1:core',
    revisionId: 'revision-1',
    taskKey: 'core',
    depsOrchestrationIds: []
  }
}

function durableRecord(
  state: ObjectiveDispatchState,
  overrides: Partial<ObjectiveDispatchRecord> = {}
): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: 'fingerprint-dispatch-core',
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey: 'core',
    planTaskDigest: 'plan-task-digest',
    dispatchId: 'dispatch-core',
    workspaceId: 'workspace-core',
    workspacePath: '/workspaces/core',
    baseCommit: 'base-commit',
    laneTaskKeys: ['core'],
    sessionNodeCount: 1,
    state,
    commitSha: 'commit-core',
    appliedCommitSha: null,
    reportDigest: 'report-digest',
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    createdAtMs: 10,
    completedAtMs: 40,
    terminalHandle: 'terminal-core',
    setupState: 'ready',
    reportPath: '/reports/core.json',
    report: {
      taskKey: 'core',
      summary: 'Implemented core',
      filesModified: ['src/core.ts'],
      criteriaSelfAssessment: []
    },
    task: {
      taskKey: 'core',
      title: 'Core',
      spec: 'Implement core',
      deps: [],
      criteria: [{ body: 'Core works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    },
    ...overrides
  }
}

function workerDone(): LedgerEntry {
  return {
    kind: 'evidence',
    eventId: 'done-dispatch-core',
    watcherId: 'watcher-1',
    atMs: 30,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      payload: {
        dispatchId: 'dispatch-core',
        taskId: 'orchestration-core',
        outcome: 'succeeded',
        reportPath: '/reports/core.json',
        filesModified: ['src/core.ts']
      }
    }
  }
}

function ingestAction(): Extract<ObjectiveAction, { kind: 'ingest-report' }> {
  return {
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
    reportPath: '/reports/core.json',
    filesModified: ['src/core.ts'],
    dispatchedContentIdentity: 'content-current'
  }
}

function recoveryLedger(failureClass?: 'criteria') {
  const ingestion = attempt(ingestAction(), {
    state: 'settled',
    effect: 'not-landed',
    dispatchId: 'ingestion-core'
  })
  return ledger([
    attempt(dispatchAction(), {
      state: 'settled',
      effect: 'landed',
      dispatchId: 'dispatch-core'
    }),
    workerDone(),
    failureClass === undefined ? ingestion : { ...ingestion, failureClass }
  ])
}

describe('parallel objective train recovery', () => {
  it('reissues the current apply after a paused dirty-worktree attempt does not land', () => {
    const record = durableRecord('waiting-to-apply')
    const applyAction: Extract<ObjectiveAction, { kind: 'apply-node' }> = {
      kind: 'apply-node',
      capability: 'implement',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: `apply:${record.attemptFingerprint}`,
      revisionId: 'revision-1',
      taskKey: 'core',
      dispatchId: 'dispatch-core'
    }
    const decision = decideObjective(
      snapshot(
        projection({
          nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
        }),
        {
          parallel: { effectiveMaxConcurrency: 3, runningCount: 1, dispatches: [record] }
        }
      ),
      ledger([attempt(applyAction, { state: 'settled', effect: 'not-landed' })])
    )
    expect(decision.action).toEqual(applyAction)
  })

  it('rechecks a dirty-tree pause only when normal admission allows it', () => {
    const dispatch = dispatchAction()
    const cleanContentIdentity = 'content-after-operator-cleanup'
    const plan = projection({
      nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
    })
    const pausedEntries = ledger([
      attempt(dispatch, {
        state: 'settled',
        effect: 'not-landed',
        reason: 'objective-train-paused'
      })
    ])
    const parallel = {
      effectiveMaxConcurrency: 3,
      runningCount: 0,
      note: 'Merge train paused by operator edits: src/operator.ts',
      dispatches: []
    }
    const admitted = decideObjective(
      snapshot(plan, { parallel }, cleanContentIdentity),
      pausedEntries
    )
    expect(admitted.action).toEqual({
      ...dispatch,
      contentIdentity: cleanContentIdentity
    })

    const serial = decideObjective(
      snapshot(
        plan,
        { parallel: { ...parallel, effectiveMaxConcurrency: 1 } },
        cleanContentIdentity
      ),
      pausedEntries
    )
    expect(serial.action).toEqual(admitted.action)

    const budgetBlocked = decideObjective(
      snapshot(
        plan,
        {
          budget: { wallClockActiveMs: null, turns: 0 },
          parallel
        },
        cleanContentIdentity
      ),
      pausedEntries
    )
    expect(budgetBlocked.action).toBeNull()

    const slotBlocked = decideObjective(
      snapshot(
        plan,
        { parallel: { ...parallel, effectiveMaxConcurrency: 1, runningCount: 1 } },
        cleanContentIdentity
      ),
      pausedEntries
    )
    expect(slotBlocked.action).toBeNull()
  })

  it('lets an admitted conflict continuation recheck its dirty-tree pause after budget exhaustion', () => {
    const original = dispatchAction()
    const originalAttempt = attempt(original, {
      state: 'settled',
      effect: 'landed',
      dispatchId: 'dispatch-core'
    })
    const retry = {
      ...original,
      evidenceKey: 'revision-1:core:r0',
      retryOf: original.evidenceKey
    }
    const decision = decideObjective(
      snapshot(
        projection({
          nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
        }),
        {
          budget: { wallClockActiveMs: null, turns: 0 },
          parallel: {
            effectiveMaxConcurrency: 1,
            runningCount: 1,
            dispatches: [durableRecord('resolving-conflict')]
          }
        }
      ),
      ledger([
        originalAttempt,
        attempt(retry, {
          state: 'settled',
          effect: 'not-landed',
          reason: 'objective-train-paused'
        })
      ])
    )
    expect(decision.action).toEqual(retry)
  })

  it('replays ingestion from validated and committed running or conflict checkpoints', () => {
    const plan = projection({
      nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
    })
    for (const state of ['running', 'resolving-conflict'] as const) {
      const validated = decideObjective(
        snapshot(plan, {
          parallel: {
            effectiveMaxConcurrency: 3,
            runningCount: 1,
            dispatches: [durableRecord(state, { commitSha: null })]
          }
        }),
        recoveryLedger()
      )
      expect(validated.action).toEqual(ingestAction())

      const committed = decideObjective(
        snapshot(plan, {
          parallel: {
            effectiveMaxConcurrency: 3,
            runningCount: 1,
            dispatches: [durableRecord(state)]
          }
        }),
        recoveryLedger()
      )
      expect(committed.action).toEqual(ingestAction())
    }
  })

  it('sends a deterministic conflict-check failure back through the node retry path', () => {
    const plan = projection({
      nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
    })
    const decision = decideObjective(
      snapshot(plan, {
        parallel: {
          effectiveMaxConcurrency: 3,
          runningCount: 1,
          dispatches: [durableRecord('resolving-conflict')]
        }
      }),
      recoveryLedger('criteria')
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-node',
      taskKey: 'core',
      retryOf: 'revision-1:core'
    })
  })
})
