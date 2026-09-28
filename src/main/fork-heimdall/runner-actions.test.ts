import { describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { WatcherRunnerActions, type WatcherRunnerActionDependencies } from './runner-actions'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

function action(contentIdentity: string): KernelAction {
  return {
    kind: 'apply-review-fix',
    capability: 'write',
    visibility: 'external',
    contentIdentity,
    evidenceKey: `review:${contentIdentity}`
  }
}

function holdVerdict(
  overrides: Partial<Extract<GateVerdict, { verdict: 'hold' }>> = {}
): Extract<GateVerdict, { verdict: 'hold' }> {
  return { verdict: 'hold', reason: 'gate held', ...overrides }
}

function escalationFor(contentIdentity: string, foldCount: number) {
  return {
    escalationId: `escalation-${contentIdentity}`,
    escalationKind: 'awaiting-approval' as const,
    foldCount,
    approvalScope: {
      actionKind: 'apply-review-fix',
      contentIdentity,
      evidenceKey: `review:${contentIdentity}`
    }
  }
}

function harness(): {
  actions: WatcherRunnerActions
  runner: WatcherRunner
  entries: LedgerEntry[]
  notifyApproval: ReturnType<typeof vi.fn>
} {
  const entries: LedgerEntry[] = []
  let nextId = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only read/append are exercised by WatcherRunnerActions in these tests; the tick-trace and terminal-summary members are unused.
  const ledgerStore = {
    read: (): WatcherLedger => ({ watcherId: 'watcher-1', entries }),
    append: (_watcherId: string, entry: LedgerEntry): void => {
      entries.push(entry)
    }
  } as unknown as RunnerLedgerStore
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only enrollment is read off WatcherRunner by the code under test here.
  const runner = {
    enrollment: { watcherId: 'watcher-1' }
  } as unknown as WatcherRunner
  const notifyApproval = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: budgetClock/orchestration/dispatchLifecycle are never invoked by recordGateRejection/abandonFingerprint under test.
  const dependencies = {
    ledgerStore,
    budgetClock: {},
    orchestration: {},
    dispatchLifecycle: {},
    notifyApproval,
    now: () => 100,
    createId: () => `event-${(nextId += 1)}`
  } as unknown as WatcherRunnerActionDependencies
  return { actions: new WatcherRunnerActions(dependencies), runner, entries, notifyApproval }
}

function abandonedEntries(entries: readonly LedgerEntry[]) {
  return entries.filter(
    (entry): entry is Extract<LedgerEntry, { kind: 'attempt-abandoned' }> =>
      entry.kind === 'attempt-abandoned'
  )
}

describe('WatcherRunnerActions.recordGateRejection gate-hold dedup', () => {
  it('appends exactly one attempt-abandoned observation for repeated gate-holds on the same fingerprint', () => {
    const { actions, runner, entries } = harness()
    const gateAction = action('revision-1')

    actions.recordGateRejection(runner, gateAction, holdVerdict())
    actions.recordGateRejection(runner, gateAction, holdVerdict())
    actions.recordGateRejection(runner, gateAction, holdVerdict())

    const abandoned = abandonedEntries(entries)
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.reason).toBe('gate-hold')
  })

  it('appends again once a different abandon reason has been recorded for the same fingerprint', () => {
    const { actions, runner, entries } = harness()
    const gateAction = action('revision-1')
    const fingerprint = makeAttemptFingerprint(
      gateAction.contentIdentity,
      gateAction.kind,
      gateAction.evidenceKey
    )

    actions.abandonFingerprint(runner, fingerprint, 'lease-refused')
    actions.recordGateRejection(runner, gateAction, holdVerdict())

    const abandoned = abandonedEntries(entries)
    expect(abandoned.map((entry) => entry.reason)).toEqual(['lease-refused', 'gate-hold'])
  })

  it('still appends an escalation and notifies on every call, gated by foldCount', () => {
    const { actions, runner, entries, notifyApproval } = harness()
    const gateAction = action('revision-1')

    actions.recordGateRejection(
      runner,
      gateAction,
      holdVerdict({ escalation: escalationFor('revision-1', 1) })
    )
    actions.recordGateRejection(
      runner,
      gateAction,
      holdVerdict({ escalation: escalationFor('revision-1', 2) })
    )

    const escalations = entries.filter((entry) => entry.kind === 'escalation')
    expect(escalations).toHaveLength(2)
    expect(abandonedEntries(entries)).toHaveLength(1)
    expect(notifyApproval).toHaveBeenCalledTimes(1)
    expect(notifyApproval).toHaveBeenCalledWith(runner.enrollment, gateAction)
  })

  it('does not suppress a different fingerprint held in the same window', () => {
    const { actions, runner, entries } = harness()

    actions.recordGateRejection(runner, action('revision-1'), holdVerdict())
    actions.recordGateRejection(runner, action('revision-2'), holdVerdict())

    expect(abandonedEntries(entries)).toHaveLength(2)
  })

  it('appends when no attempt-abandoned observation for the fingerprint is present, including after retention eviction', () => {
    const { actions, runner, entries } = harness()
    const gateAction = action('revision-1')
    entries.push({
      eventId: 'stale',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner',
      class: 'observation',
      kind: 'attempt-abandoned',
      fingerprint: 'unrelated-fingerprint',
      reason: 'gate-hold'
    })

    actions.recordGateRejection(runner, gateAction, holdVerdict())

    const abandoned = abandonedEntries(entries)
    expect(abandoned).toHaveLength(2)
    expect(abandoned[1]?.fingerprint).toBe(
      makeAttemptFingerprint(gateAction.contentIdentity, gateAction.kind, gateAction.evidenceKey)
    )
  })
})
