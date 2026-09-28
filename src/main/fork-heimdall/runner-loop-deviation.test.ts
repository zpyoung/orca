import { describe, expect, it, vi } from 'vitest'
import type { EvidenceEntry, LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import { enrollmentInput, harness, kind } from './kernel-service-test-harness'

vi.mock('electron', () => ({}))

/**
 * `bug-146`: before this fix, `WatcherRunnerWorkerLifecycle.refresh()` returned `null` for a
 * worker-question and every other unresolved-attempt branch, which made `runner-loop.ts`'s tick
 * return before it ever reached `stopLifecycle.evaluate()` — so a *different*, otherwise-unrelated
 * stop predicate on the same watcher never got evaluated on a tick that also happened to carry a
 * worker question. This test fails against the pre-fix code because the predicate spy is never
 * called; it does not depend on any owner configuration, since the fix applies unconditionally.
 */
function questionMailboxEntry(watcherId: string): LedgerEntry {
  const entry: EvidenceEntry = {
    eventId: 'mail-question-1',
    watcherId,
    atMs: 5,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    source: { kind: 'orchestration', sequence: 0, messageId: 'message-1' },
    payload: {
      type: 'question',
      body: 'Which branch should I use?',
      payload: { dispatchId: 'dispatch-1' }
    }
  }
  return entry
}

describe('bug-146: a deviation-producing tick still reaches stop-policy evaluation', () => {
  it('evaluates every stop predicate on a tick that also parks for a worker question', async () => {
    const stopPredicateEvaluate = vi.fn(() => ({ stop: false as const }))
    let pendingMailbox: LedgerEntry[] = []
    const world = await harness({ mailbox: () => pendingMailbox })
    world.service.registerKind(
      kind({
        decide: () => ({ action: null, reason: 'quiet', considered: [] }),
        stopPredicates: [{ id: 'unrelated-predicate', evaluate: stopPredicateEvaluate }]
      })
    )
    const result = await world.service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    pendingMailbox = [questionMailboxEntry(watcherId)]
    await world.service.reconcileForTesting(watcherId)

    expect(stopPredicateEvaluate).toHaveBeenCalled()
    const entry = (await world.service.list())[0]
    expect(entry?.status.state).toBe('parked')
    expect(entry?.status.parkReason?.kind).toBe('worker-question')
  })
})

describe('no owner configured leaves worker-lifecycle deviations unrecorded', () => {
  it('does not append an owner-deviation escalation for an unowned watcher', async () => {
    let pendingMailbox: LedgerEntry[] = []
    const world = await harness({ mailbox: () => pendingMailbox })
    world.service.registerKind(kind())
    const result = await world.service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    pendingMailbox = [questionMailboxEntry(watcherId)]
    await world.service.reconcileForTesting(watcherId)

    const entries = world.ledgerStore.read(watcherId).entries
    expect(
      entries.some(
        (item) => item.kind === 'escalation' && item.escalationKind === 'owner-deviation'
      )
    ).toBe(false)
  })
})

describe('gate-detected deviations are also unrecorded without an owner', () => {
  it('leaves a kind-emitted deviation as plain watching when no owner is configured', async () => {
    const world = await harness()
    world.service.registerKind(
      kind({
        decide: () => ({
          action: null,
          deviation: {
            kind: 'check-failed',
            criterionId: 'criterion-1',
            command: 'pnpm test',
            exitCode: 1,
            timedOut: false
          }
        })
      })
    )
    const result = await world.service.enroll(enrollmentInput())
    if (result.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = result.entry.enrollment.watcherId
    await world.service.reconcileForTesting(watcherId)

    const entries = world.ledgerStore.read(watcherId).entries
    expect(
      entries.some(
        (item) => item.kind === 'escalation' && item.escalationKind === 'owner-deviation'
      )
    ).toBe(false)
    const entry = (await world.service.list())[0]
    expect(entry?.status.state).toBe('watching')
  })
})
