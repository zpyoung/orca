import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '../fork-heimdall/ledger-types'
import { decideObjective } from './decision'
import { attempt, ledger, node, projection, snapshot } from './decision-test-harness'
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

function failedDispatch(taskKey: string): ObjectiveDispatchRecord {
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
    state: 'failed',
    commitSha: null,
    appliedCommitSha: null,
    reportDigest: null,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    planTaskDigest: `plan-digest-${taskKey}`,
    createdAtMs: 10,
    completedAtMs: 40,
    terminalHandle: `terminal-${taskKey}`,
    setupState: 'retained',
    reportPath: null,
    report: null,
    task: {
      taskKey,
      title: `Task ${taskKey}`,
      spec: `Implement ${taskKey}`,
      deps: [],
      criteria: [{ body: `${taskKey} works`, shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
  }
}

function workerFailed(dispatchId: string, taskKey: string): LedgerEntry {
  return {
    kind: 'evidence',
    eventId: `failed-${dispatchId}`,
    watcherId: 'watcher-1',
    atMs: 40,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      body: 'worker failed',
      payload: {
        dispatchId,
        taskId: `orchestration-${taskKey}`,
        outcome: 'failed',
        reportPath: null,
        filesModified: []
      }
    }
  }
}

function landedFailureEntries(action: Extract<ObjectiveAction, { kind: 'dispatch-node' }>) {
  return ledger([
    attempt(action, {
      state: 'settled',
      effect: 'landed',
      dispatchId: `dispatch-${action.taskKey}`
    }),
    workerFailed(`dispatch-${action.taskKey}`, action.taskKey)
  ])
}

describe('parallel objective durable dispatch failures', () => {
  it('continues unrelated ready work before surfacing the failed node', () => {
    const failed = dispatchAction('failed')
    const plan = projection({
      nodes: [
        node('failed', { state: 'dispatched', dispatchId: 'dispatch-failed' }),
        node('sibling')
      ]
    })
    expect(
      decideObjective(
        snapshot(plan, {
          parallel: {
            effectiveMaxConcurrency: 3,
            runningCount: 0,
            dispatches: [failedDispatch('failed')]
          }
        }),
        landedFailureEntries(failed),
        true
      ).action
    ).toMatchObject({ kind: 'dispatch-node', taskKey: 'sibling' })
  })

  it('routes a settled failed record through the node-failure deviation', () => {
    const failed = dispatchAction('failed')
    const plan = projection({
      nodes: [node('failed', { state: 'dispatched', dispatchId: 'dispatch-failed' })]
    })
    const decision = decideObjective(
      snapshot(plan, {
        parallel: {
          effectiveMaxConcurrency: 3,
          runningCount: 0,
          dispatches: [failedDispatch('failed')]
        }
      }),
      landedFailureEntries(failed),
      true
    )
    expect(decision.action).toBeNull()
    if (!('deviation' in decision) || decision.deviation.kind !== 'node-failed') {
      throw new Error('expected a node-failed deviation')
    }
    expect(decision.deviation).toMatchObject({
      taskKey: 'failed',
      dispatchId: 'dispatch-failed',
      summary: 'worker failed'
    })
  })

  it('keeps an infra failure on the bounded node redispatch path', () => {
    const failed = dispatchAction('failed')
    const plan = projection({
      nodes: [node('failed', { state: 'dispatched', dispatchId: 'dispatch-failed' })]
    })
    const failedAttempt = {
      ...attempt(failed, {
        state: 'settled',
        effect: 'not-landed',
        dispatchId: 'dispatch-failed'
      }),
      failureClass: 'infra' as const
    }
    expect(
      decideObjective(
        snapshot(plan, {
          parallel: {
            effectiveMaxConcurrency: 3,
            runningCount: 0,
            dispatches: [failedDispatch('failed')]
          }
        }),
        ledger([failedAttempt]),
        true
      ).action
    ).toMatchObject({
      kind: 'dispatch-node',
      taskKey: 'failed',
      retryOf: 'revision-1:failed'
    })
  })
})
