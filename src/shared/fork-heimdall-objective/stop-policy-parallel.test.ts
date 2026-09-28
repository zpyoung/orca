import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '../fork-heimdall/ledger-types'
import { attempt, ledger, node, projection, snapshot } from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectiveDispatchRecord } from './parallel-types'
import {
  objectiveHasPendingDrain,
  objectiveInfraRetryExhaustedPredicate,
  objectiveWorkerEscalationPredicate
} from './stop-policy'

function dispatchAction(
  taskKey: string,
  evidenceKey = `revision-1:${taskKey}`,
  retryOf?: string
): Extract<ObjectiveAction, { kind: 'dispatch-node' }> {
  return {
    kind: 'dispatch-node',
    capability: 'implement',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey,
    revisionId: 'revision-1',
    taskKey,
    depsOrchestrationIds: [],
    ...(retryOf === undefined ? {} : { retryOf })
  }
}

function parallelDispatch(
  state: ObjectiveDispatchRecord['state'] = 'running'
): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: 'fingerprint-dispatch-1',
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey: 'core',
    dispatchId: 'dispatch-1',
    workspaceId: 'workspace-1',
    workspacePath: '/workspaces/dispatch-1',
    baseCommit: 'base-commit',
    laneTaskKeys: ['core'],
    sessionNodeCount: 1,
    state,
    commitSha: state === 'waiting-to-apply' ? 'commit-1' : null,
    appliedCommitSha: state === 'applied' ? 'commit-1' : null,
    reportDigest: state === 'running' ? null : 'report-digest',
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    planTaskDigest: 'plan-digest-core',
    createdAtMs: 10,
    completedAtMs: state === 'running' ? null : 20,
    terminalHandle: 'terminal-1',
    setupState: 'ready',
    reportPath: null,
    report: null,
    task: {
      taskKey: 'core',
      title: 'Core',
      spec: 'Implement core',
      deps: [],
      criteria: [{ body: 'Core works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
  }
}

describe('parallel objective stop policy', () => {
  it('defers budget stop while merge-train entries still need draining', () => {
    const draining = snapshot(projection(), {
      parallel: {
        effectiveMaxConcurrency: 3,
        runningCount: 1,
        dispatches: [parallelDispatch('waiting-to-apply')]
      }
    })
    expect(objectiveHasPendingDrain(draining, ledger())).toBe(true)

    draining.world.parallel = {
      effectiveMaxConcurrency: 3,
      runningCount: 0,
      dispatches: [parallelDispatch('applied')]
    }
    expect(objectiveHasPendingDrain(draining, ledger())).toBe(false)
  })

  it('does not globally stop for an escalation owned by an isolated dispatch', () => {
    const parallel = snapshot(projection(), {
      parallel: {
        effectiveMaxConcurrency: 3,
        runningCount: 1,
        dispatches: [parallelDispatch()]
      }
    })
    const escalation: LedgerEntry = {
      kind: 'evidence',
      eventId: 'event-isolated-escalation',
      watcherId: 'watcher-1',
      atMs: 20,
      origin: 'owner',
      class: 'fact',
      evidenceKind: 'orchestration-mailbox',
      source: { kind: 'orchestration', sequence: 20, messageId: 'message-isolated' },
      payload: {
        type: 'escalation',
        subject: 'Need a human decision',
        payload: { dispatchId: 'dispatch-1' }
      }
    }
    expect(objectiveWorkerEscalationPredicate.evaluate(parallel, ledger([escalation]))).toEqual({
      stop: false
    })
  })

  it('lets unrelated ready siblings progress before parking an exhausted parallel node', () => {
    const parallel = snapshot(projection({ nodes: [node('core'), node('sibling')] }), {
      parallel: { effectiveMaxConcurrency: 3, runningCount: 0, dispatches: [] }
    })
    const original = dispatchAction('core')
    const retry0 = dispatchAction('core', 'revision-1:core:r0', original.evidenceKey)
    const retry1 = dispatchAction('core', 'revision-1:core:r1', original.evidenceKey)
    const exhausted = ledger([
      { ...attempt(original, { state: 'settled', effect: 'not-landed' }), failureClass: 'infra' },
      {
        ...attempt(retry0, { state: 'settled', effect: 'not-landed' }),
        failureClass: 'environment'
      },
      { ...attempt(retry1, { state: 'settled', effect: 'not-landed' }), failureClass: 'infra' }
    ])
    expect(objectiveInfraRetryExhaustedPredicate.evaluate(parallel, exhausted)).toEqual({
      stop: false
    })
  })

  it('parks an exhausted conflict continuation with the owning conflict context', () => {
    const resolving = parallelDispatch('resolving-conflict')
    resolving.conflictPaths = ['src/shared/core.ts']
    resolving.conflictingTaskKeys = ['core']
    const parallel = snapshot(projection({ nodes: [node('core')] }), {
      parallel: {
        effectiveMaxConcurrency: 3,
        runningCount: 1,
        dispatches: [resolving]
      }
    })
    const original = dispatchAction('core')
    const retry0 = dispatchAction('core', 'revision-1:core:r0', original.evidenceKey)
    const retry1 = dispatchAction('core', 'revision-1:core:r1', original.evidenceKey)
    const exhausted = ledger([
      {
        ...attempt(original, { state: 'settled', effect: 'not-landed' }),
        failureClass: 'criteria'
      },
      { ...attempt(retry0, { state: 'settled', effect: 'not-landed' }), failureClass: 'criteria' },
      { ...attempt(retry1, { state: 'settled', effect: 'not-landed' }), failureClass: 'criteria' }
    ])
    const verdict = objectiveInfraRetryExhaustedPredicate.evaluate(parallel, exhausted)
    expect(verdict).toMatchObject({
      stop: true,
      detail: 'core'
    })
    if (!verdict.stop) {
      throw new Error('expected the predicate to fire')
    }
    expect(
      objectiveInfraRetryExhaustedPredicate.deviationForFiring?.(verdict, parallel, exhausted)
    ).toMatchObject({
      kind: 'retry-exhausted',
      taskKey: 'core',
      retryCount: 2,
      lastFailureClass: null,
      conflictPaths: ['src/shared/core.ts'],
      conflictingDispatchIds: ['dispatch-1']
    })
  })
})
