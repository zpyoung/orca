import { describe, expect, it } from 'vitest'
import { makeAttemptFingerprint } from './attempt-fingerprint'
import { getLatestEscalations } from './ledger-queries'
import { approvalScopeForAction, gateAction, type GateEnrollment } from './gate'
import type { KernelAction, LedgerEntry, WatcherLedger } from './ledger-types'
import type { Snapshot } from './snapshot'

const SNAPSHOT: Snapshot<Record<string, never>> = {
  freshness: 'live',
  contentIdentity: 'head-1',
  observedAtMs: 1,
  world: {}
}

const ACTION: KernelAction = {
  kind: 'publish',
  capability: 'publish',
  visibility: 'external',
  contentIdentity: 'head-1',
  evidenceKey: 'failure-1',
  expectedState: { target: 'refs/heads/main', before: 'head-1' }
}

const ENROLLMENT: GateEnrollment = {
  enabled: true,
  capabilities: { publish: 'on' },
  budget: { wallClockActiveMs: null, turns: null }
}

function ledger(...entries: LedgerEntry[]): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

const OWNER_FACT = {
  watcherId: 'watcher-1',
  origin: 'owner' as const,
  class: 'fact' as const
}

describe('gateAction', () => {
  it('applies kernel constraints in precedence order', () => {
    const disabled = {
      ...ENROLLMENT,
      enabled: false,
      parked: true,
      stopPredicateFired: true,
      budget: { wallClockActiveMs: 0, turns: 0 }
    }
    expect(
      gateAction(ACTION, { ...SNAPSHOT, contentIdentity: 'moved' }, disabled, ledger())
    ).toEqual({ verdict: 'hold', reason: 'disabled' })
    expect(gateAction(ACTION, SNAPSHOT, { ...ENROLLMENT, parked: true }, ledger())).toEqual({
      verdict: 'hold',
      reason: 'parked'
    })
    expect(
      gateAction(
        ACTION,
        SNAPSHOT,
        { ...ENROLLMENT, budget: { wallClockActiveMs: null, turns: 0 } },
        ledger()
      )
    ).toEqual({ verdict: 'hold', reason: 'budget-turns' })
    expect(
      gateAction(ACTION, SNAPSHOT, { ...ENROLLMENT, stopPredicateFired: true }, ledger())
    ).toEqual({ verdict: 'hold', reason: 'stop-predicate-fired' })
    const completed: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'attempt',
      eventId: 'precedence-completed',
      atMs: 1,
      attemptId: 'precedence-completed',
      fingerprint: makeAttemptFingerprint('head-1', 'publish', 'failure-1'),
      action: ACTION,
      state: 'settled',
      effect: 'landed'
    }
    expect(
      gateAction(
        ACTION,
        { ...SNAPSHOT, contentIdentity: 'moved' },
        { ...ENROLLMENT, capabilities: { publish: 'off' } },
        ledger(completed)
      )
    ).toEqual({ verdict: 'hold', reason: 'attempt-completed' })

    const unresolved: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'attempt',
      eventId: 'precedence-unresolved',
      atMs: 2,
      attemptId: 'precedence-unresolved',
      fingerprint: makeAttemptFingerprint('head-1', 'merge', 'merge-evidence'),
      action: { ...ACTION, kind: 'merge', evidenceKey: 'merge-evidence' },
      state: 'settled',
      effect: 'indeterminate'
    }
    expect(
      gateAction(
        ACTION,
        { ...SNAPSHOT, contentIdentity: 'moved' },
        { ...ENROLLMENT, capabilities: { publish: 'off' } },
        ledger(unresolved)
      )
    ).toEqual({ verdict: 'hold', reason: 'unresolved-attempt' })

    const running: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'attempt',
      eventId: 'precedence-running',
      atMs: 3,
      attemptId: 'precedence-running',
      fingerprint: makeAttemptFingerprint('head-1', 'prepare', 'prepare-evidence'),
      action: {
        ...ACTION,
        kind: 'prepare',
        visibility: 'local',
        evidenceKey: 'prepare-evidence',
        expectedState: undefined
      },
      state: 'running'
    }
    expect(
      gateAction(
        ACTION,
        { ...SNAPSHOT, contentIdentity: 'moved' },
        { ...ENROLLMENT, capabilities: { publish: 'off' } },
        ledger(running)
      )
    ).toEqual({ verdict: 'hold', reason: 'attempt-in-flight' })

    expect(
      gateAction(
        ACTION,
        { ...SNAPSHOT, contentIdentity: 'moved' },
        { ...ENROLLMENT, capabilities: { publish: 'off' } },
        ledger(),
        { verdict: 'escalate', reason: 'kind-preflight' }
      )
    ).toEqual({ verdict: 'hold', reason: 'stale-evidence' })
    expect(
      gateAction(ACTION, SNAPSHOT, { ...ENROLLMENT, capabilities: { publish: 'off' } }, ledger(), {
        verdict: 'escalate',
        reason: 'kind-preflight'
      })
    ).toEqual({ verdict: 'hold', reason: 'capability-off' })
    expect(
      gateAction(ACTION, SNAPSHOT, ENROLLMENT, ledger(), {
        verdict: 'escalate',
        reason: 'kind-preflight'
      })
    ).toEqual({ verdict: 'escalate', reason: 'kind-preflight' })
  })

  it('requires field-for-field approval scope equality and folds by append-only revision', () => {
    const gated = { ...ENROLLMENT, capabilities: { publish: 'gated' as const } }
    const first = gateAction(ACTION, SNAPSHOT, gated, ledger())
    expect(first).toMatchObject({
      verdict: 'hold',
      reason: 'awaiting-approval',
      escalation: { foldCount: 1 }
    })
    if (first.verdict !== 'hold' || !first.escalation) {
      throw new Error('Expected an approval escalation')
    }

    const escalation: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'escalation',
      eventId: 'escalation-event-1',
      atMs: 1,
      status: 'open',
      ...first.escalation
    }
    const second = gateAction(ACTION, SNAPSHOT, gated, ledger(escalation))
    expect(second).toMatchObject({
      verdict: 'hold',
      escalation: { escalationId: first.escalation.escalationId, foldCount: 2 }
    })
    if (second.verdict !== 'hold' || !second.escalation) {
      throw new Error('Expected a folded approval escalation revision')
    }
    const folded: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'escalation',
      eventId: 'escalation-event-2',
      atMs: 0,
      status: 'open',
      ...second.escalation
    }
    const appendOnlyLedger = ledger(escalation, folded)
    expect(appendOnlyLedger.entries).toHaveLength(2)
    expect(getLatestEscalations(appendOnlyLedger)).toEqual([folded])

    const wrongScopeApproval: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'approval',
      eventId: 'approval-1',
      atMs: 2,
      scope: { ...approvalScopeForAction(ACTION), evidenceKey: 'other' },
      decision: 'approved',
      foldCount: 1
    }
    expect(gateAction(ACTION, SNAPSHOT, gated, ledger(wrongScopeApproval))).toMatchObject({
      verdict: 'hold',
      reason: 'awaiting-approval'
    })

    const exactApproval: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'approval',
      eventId: 'approval-2',
      atMs: 3,
      scope: approvalScopeForAction(ACTION),
      decision: 'approved',
      foldCount: 1
    }
    expect(gateAction(ACTION, SNAPSHOT, gated, ledger(exactApproval))).toEqual({
      verdict: 'allow'
    })
    const rejectedRevision: LedgerEntry = {
      ...exactApproval,
      eventId: 'approval-3',
      atMs: 0,
      decision: 'rejected'
    }
    expect(
      gateAction(ACTION, SNAPSHOT, gated, ledger(exactApproval, rejectedRevision))
    ).toMatchObject({ verdict: 'hold', reason: 'awaiting-approval' })
  })

  it('deduplicates a completed attempt by fingerprint', () => {
    const fingerprint = makeAttemptFingerprint('head-1', 'publish', 'failure-1')
    const completed: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'attempt',
      eventId: 'attempt-event-1',
      atMs: 1,
      attemptId: 'attempt-1',
      fingerprint,
      action: ACTION,
      state: 'settled',
      effect: 'landed'
    }
    expect(gateAction(ACTION, SNAPSHOT, ENROLLMENT, ledger(completed))).toEqual({
      verdict: 'hold',
      reason: 'attempt-completed'
    })
  })

  it('requires new evidence before retrying a known not-landed attempt', () => {
    const failed: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'attempt',
      eventId: 'attempt-event-1',
      atMs: 1,
      attemptId: 'attempt-1',
      fingerprint: makeAttemptFingerprint('head-1', 'publish', 'failure-1'),
      action: ACTION,
      state: 'settled',
      effect: 'not-landed'
    }
    expect(gateAction(ACTION, SNAPSHOT, ENROLLMENT, ledger(failed))).toEqual({
      verdict: 'hold',
      reason: 'retry-needs-new-evidence'
    })
    expect(
      gateAction({ ...ACTION, evidenceKey: 'failure-2' }, SNAPSHOT, ENROLLMENT, ledger(failed))
    ).toEqual({ verdict: 'allow' })
  })

  it('holds external actions while an effect is unresolved but permits local work', () => {
    const unresolvedAction = { ...ACTION, kind: 'merge', evidenceKey: 'merge-1' }
    const unresolved: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'attempt',
      eventId: 'attempt-event-1',
      atMs: 1,
      attemptId: 'attempt-1',
      fingerprint: makeAttemptFingerprint('head-1', 'merge', 'merge-1'),
      action: unresolvedAction,
      state: 'settled',
      effect: 'indeterminate'
    }
    expect(gateAction(ACTION, SNAPSHOT, ENROLLMENT, ledger(unresolved))).toEqual({
      verdict: 'hold',
      reason: 'unresolved-attempt'
    })
    const local = { ...ACTION, visibility: 'local' as const, expectedState: undefined }
    expect(gateAction(local, SNAPSHOT, ENROLLMENT, ledger(unresolved))).toEqual({
      verdict: 'allow'
    })
  })

  it('does not use an approval after the content identity moves', () => {
    const scope = approvalScopeForAction(ACTION)
    const approval: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'approval',
      eventId: 'approval-1',
      atMs: 1,
      scope,
      decision: 'approved',
      foldCount: 1
    }
    const gated = { ...ENROLLMENT, capabilities: { publish: 'gated' as const } }
    expect(
      gateAction(ACTION, { ...SNAPSHOT, contentIdentity: 'head-2' }, gated, ledger(approval))
    ).toEqual({ verdict: 'hold', reason: 'stale-evidence' })
  })

  it('holds an external action that lacks expected state', () => {
    const unsafe: KernelAction = { ...ACTION }
    delete unsafe.expectedState
    expect(gateAction(unsafe, SNAPSHOT, ENROLLMENT, ledger())).toEqual({
      verdict: 'hold',
      reason: 'missing-expected-state'
    })
  })
})
