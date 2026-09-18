import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '../fork-heimdall/ledger-types'
import { decideObjective } from './decision'
import {
  attempt,
  ledger,
  projection,
  snapshot,
  WORKER_EXITED_WITHOUT_COMPLETION
} from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'

describe('objective node infra/environment redispatch', () => {
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

  it('retries a node whose latest dispatch resolved not-landed with an infra failure class', () => {
    const original = {
      ...attempt(dispatch, { state: 'settled', effect: 'not-landed', dispatchId: 'dispatch-core' }),
      failureClass: 'infra' as const
    }
    const decision = decideObjective(snapshot(projection()), ledger([original]))
    expect(decision.action).toEqual({
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:core:r0',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: [],
      retryOf: 'revision-1:core'
    })
  })

  it('stops retrying and parks once the redispatch cap is reached, without replanning', () => {
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
    const decision = decideObjective(snapshot(projection()), ledger([original, first, second]))
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({ reason: 'node-retry-exhausted' })
  })

  it('replans once a retry itself resolves as a criteria failure instead of retrying again', () => {
    const original = {
      ...attempt(dispatch, { state: 'settled', effect: 'not-landed', dispatchId: 'dispatch-core' }),
      failureClass: 'infra' as const
    }
    const retried = {
      ...attempt(retry0, {
        state: 'settled',
        effect: 'not-landed',
        dispatchId: 'dispatch-core-r0'
      }),
      failureClass: 'criteria' as const
    }
    const decision = decideObjective(snapshot(projection()), ledger([original, retried]))
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:2',
      reason: 'replan-after-failure'
    })
  })

  it('holds in-flight while an exited-without-completion attempt is unresolved, then retries once resolved', () => {
    const unresolved = attempt(dispatch, {
      state: 'settled',
      effect: 'indeterminate',
      reason: WORKER_EXITED_WITHOUT_COMPLETION,
      dispatchId: 'dispatch-core'
    })
    const firstTick = decideObjective(snapshot(projection()), ledger([unresolved]))
    expect(firstTick.action).toBeNull()
    expect(firstTick).toMatchObject({ reason: 'node-in-flight' })

    const resolution: LedgerEntry = {
      kind: 'attempt-resolved',
      eventId: 'event-resolution',
      watcherId: 'watcher-1',
      atMs: 40,
      origin: 'owner',
      class: 'fact',
      attemptId: unresolved.attemptId,
      effect: 'not-landed',
      failureClass: 'infra',
      evidence: { reason: WORKER_EXITED_WITHOUT_COMPLETION }
    }
    const secondTick = decideObjective(snapshot(projection()), ledger([unresolved, resolution]))
    expect(secondTick.action).toEqual({
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:core:r0',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: [],
      retryOf: 'revision-1:core'
    })
  })

  it('replans instead of retrying once the resolution itself lands as a criteria failure', () => {
    const unresolved = attempt(dispatch, {
      state: 'settled',
      effect: 'indeterminate',
      reason: WORKER_EXITED_WITHOUT_COMPLETION,
      dispatchId: 'dispatch-core'
    })
    const resolution: LedgerEntry = {
      kind: 'attempt-resolved',
      eventId: 'event-resolution',
      watcherId: 'watcher-1',
      atMs: 40,
      origin: 'owner',
      class: 'fact',
      attemptId: unresolved.attemptId,
      effect: 'not-landed',
      failureClass: 'criteria',
      evidence: { reason: WORKER_EXITED_WITHOUT_COMPLETION }
    }
    const decision = decideObjective(snapshot(projection()), ledger([unresolved, resolution]))
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:2',
      reason: 'replan-after-failure'
    })
  })

  it.each([
    {
      circumstance: 'an exited-without-completion attempt with no worker_done evidence (Case B)',
      reason: WORKER_EXITED_WITHOUT_COMPLETION,
      extraEntries: [] as LedgerEntry[]
    },
    {
      circumstance:
        'a cleanly failed worker_done settled indeterminate pending classification (Case A)',
      reason: 'failed',
      extraEntries: [
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
              outcome: 'failed',
              reportPath: '/outside/report.json',
              filesModified: ['src/core.ts']
            }
          }
        }
      ] as LedgerEntry[]
    }
  ] as const)(
    'cannot escape node-in-flight on its own for $circumstance; only an external resolution fact unblocks it',
    ({ reason, extraEntries }) => {
      // decide-nodes.ts has no internal timeout or retry-on-its-own-behalf: an attempt that never
      // gains an attempt-resolved fact (e.g. because resolveUncertainAttempts never got a live,
      // unparked tick to run) leaves the node in-flight indefinitely. Since settleWorker now settles
      // every non-succeeded worker_done indeterminate too, Case A shares this exposure with Case B.
      const unresolved = attempt(dispatch, {
        state: 'settled',
        effect: 'indeterminate',
        reason,
        dispatchId: 'dispatch-core'
      })
      const stableLedger = ledger([unresolved, ...extraEntries])
      const first = decideObjective(snapshot(projection()), stableLedger)
      const second = decideObjective(snapshot(projection()), stableLedger)
      expect(first).toMatchObject({ action: null, reason: 'node-in-flight' })
      expect(second).toEqual(first)
    }
  )

  it('replans a cleanly failed worker immediately, since settleWorker settles it with no failure class to classify', () => {
    // pins the gap found while verifying this phase: settleWorker (ledger-lifecycle.ts) settles a
    // worker_done{outcome:'failed'} straight to effect:'not-landed', never 'indeterminate', so
    // resolveOutcome/resolveDispatchOutcome — the only place failureClass gets computed — never
    // runs for this attempt. There is no in-flight window here at all; it replans on the same tick,
    // exactly as it did before this phase, with retryable failure classes structurally unreachable.
    const settledDirectly = attempt(dispatch, {
      state: 'settled',
      effect: 'not-landed',
      dispatchId: 'dispatch-core'
    })
    const workerDoneFailed: LedgerEntry = {
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
          outcome: 'failed',
          reportPath: '/outside/report.json',
          filesModified: ['src/core.ts']
        }
      }
    }
    const decision = decideObjective(
      snapshot(projection()),
      ledger([settledDirectly, workerDoneFailed])
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:2',
      reason: 'replan-after-failure'
    })
  })
})
