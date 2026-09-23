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

  it('folds the exact open approval scope across unrelated entries without reopening a resolution', () => {
    const scopedAction = { ...ACTION, preparedCommitSha: 'prepared-1' }
    const scope = approvalScopeForAction(scopedAction)
    const gated = { ...ENROLLMENT, capabilities: { publish: 'gated' as const } }
    const matchingOpen: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'escalation',
      eventId: 'approval-open',
      atMs: 1,
      escalationId: 'approval-logical-1',
      escalationKind: 'awaiting-approval',
      status: 'open',
      foldCount: 3,
      approvalScope: scope
    }
    const matchingEscalated: LedgerEntry = {
      ...matchingOpen,
      eventId: 'approval-escalated',
      atMs: 2,
      status: 'escalated',
      foldCount: matchingOpen.foldCount + 1
    }
    const workerQuestion: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'escalation',
      eventId: 'worker-question',
      atMs: 2,
      escalationId: 'worker-question:dispatch-1:message-1',
      escalationKind: 'worker-question',
      status: 'open',
      foldCount: 1
    }
    const otherScope: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'escalation',
      eventId: 'other-scope',
      atMs: 3,
      escalationId: 'approval-logical-2',
      escalationKind: 'awaiting-approval',
      status: 'open',
      foldCount: 7,
      approvalScope: { ...scope, preparedCommitSha: 'prepared-2' }
    }
    const parked: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'escalation',
      eventId: 'parked',
      atMs: 4,
      escalationId: 'park:watcher-1:worker-question:message-1',
      escalationKind: 'park-worker-question',
      status: 'open',
      foldCount: 1
    }

    const folded = gateAction(
      scopedAction,
      SNAPSHOT,
      gated,
      ledger(matchingOpen, matchingEscalated, workerQuestion, otherScope, parked)
    )
    expect(folded).toMatchObject({
      verdict: 'hold',
      escalation: {
        escalationId: matchingOpen.escalationId,
        foldCount: matchingEscalated.foldCount + 1,
        approvalScope: scope
      }
    })

    const resolved: LedgerEntry = {
      ...matchingEscalated,
      eventId: 'approval-resolved',
      atMs: 5,
      status: 'resolved',
      foldCount: matchingEscalated.foldCount + 1
    }
    const fresh = gateAction(
      scopedAction,
      SNAPSHOT,
      gated,
      ledger(matchingOpen, matchingEscalated, workerQuestion, otherScope, parked, resolved)
    )
    expect(fresh).toMatchObject({
      verdict: 'hold',
      escalation: { foldCount: 1, approvalScope: scope }
    })
    if (fresh.verdict !== 'hold' || !fresh.escalation) {
      throw new Error('Expected a fresh approval escalation')
    }
    expect(fresh.escalation.escalationId).not.toBe(matchingOpen.escalationId)
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

  it('reuses the original approval once a bounded auto-redispatch carries its evidence key', () => {
    const retry = { ...ACTION, evidenceKey: 'failure-2', retryOf: ACTION.evidenceKey }
    const gated = { ...ENROLLMENT, capabilities: { publish: 'gated' as const } }
    const approval: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'approval',
      eventId: 'approval-1',
      atMs: 1,
      scope: approvalScopeForAction(ACTION),
      decision: 'approved',
      foldCount: 1
    }
    expect(gateAction(retry, SNAPSHOT, gated, ledger(approval))).toEqual({ verdict: 'allow' })
  })

  it('escalates an approvalRequired action on an "on" capability into the gated approval path', () => {
    const escalated = { ...ACTION, approvalRequired: true }
    const on = { ...ENROLLMENT, capabilities: { publish: 'on' as const } }
    expect(gateAction(escalated, SNAPSHOT, on, ledger())).toMatchObject({
      verdict: 'hold',
      reason: 'awaiting-approval'
    })
    const approval: LedgerEntry = {
      ...OWNER_FACT,
      kind: 'approval',
      eventId: 'approval-escalated-1',
      atMs: 1,
      scope: approvalScopeForAction(escalated),
      decision: 'approved',
      foldCount: 1
    }
    expect(gateAction(escalated, SNAPSHOT, on, ledger(approval))).toEqual({ verdict: 'allow' })
  })

  it('does not escalate approvalRequired past a capability that is off, and ignores it on gated', () => {
    const escalated = { ...ACTION, approvalRequired: true }
    const off = { ...ENROLLMENT, capabilities: { publish: 'off' as const } }
    expect(gateAction(escalated, SNAPSHOT, off, ledger())).toEqual({
      verdict: 'hold',
      reason: 'capability-off'
    })
    const gated = { ...ENROLLMENT, capabilities: { publish: 'gated' as const } }
    const first = gateAction(escalated, SNAPSHOT, gated, ledger())
    expect(first).toMatchObject({ verdict: 'hold', reason: 'awaiting-approval' })
  })

  it('holds a retry on the same awaiting-approval escalation as its unapproved original', () => {
    const retry = { ...ACTION, evidenceKey: 'failure-2', retryOf: ACTION.evidenceKey }
    const gated = { ...ENROLLMENT, capabilities: { publish: 'gated' as const } }
    const first = gateAction(ACTION, SNAPSHOT, gated, ledger())
    if (first.verdict !== 'hold' || !first.escalation) {
      throw new Error('Expected an approval escalation')
    }
    const second = gateAction(retry, SNAPSHOT, gated, ledger())
    expect(second).toMatchObject({ verdict: 'hold', reason: 'awaiting-approval' })
    if (second.verdict !== 'hold' || !second.escalation) {
      throw new Error('Expected an approval escalation')
    }
    expect(second.escalation.escalationId).toBe(first.escalation.escalationId)
  })
})
