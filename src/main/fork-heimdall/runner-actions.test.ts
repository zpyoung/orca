import { describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { ExecuteContext, KernelAction } from '../../shared/fork-heimdall/kind-contract'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import {
  enrollmentInput,
  harness as kernelHarness,
  kind as kernelKind,
  type World
} from './kernel-service-test-harness'
import { WatcherLedgerLifecycle } from './ledger-lifecycle'
import { WatcherRunnerActions, type WatcherRunnerActionDependencies } from './runner-actions'
import type { RunnerBudgetClock, RunnerLedgerStore, WatcherRunner } from './runner-state'

vi.mock('electron', () => ({}))

async function approvalReasonFromHook(
  describeApproval?: () => string | null
): Promise<string | undefined> {
  const { service } = await kernelHarness()
  service.registerKind(
    kernelKind({
      decide: () => ({ action: action('revision-1') }),
      ...(describeApproval === undefined ? {} : { describeApproval })
    })
  )
  const enrolled = await service.enroll({
    ...enrollmentInput(),
    capabilities: { write: 'gated' }
  })
  if (enrolled.status !== 'enrolled') {
    throw new Error('expected enrollment')
  }
  await service.reconcileForTesting(enrolled.entry.enrollment.watcherId)
  return getLatestEscalations(service.ledger(enrolled.entry.enrollment.watcherId)).find(
    (entry) => entry.escalationKind === 'awaiting-approval'
  )?.reason
}

function action(contentIdentity: string): KernelAction {
  return {
    kind: 'apply-review-fix',
    capability: 'write',
    visibility: 'external',
    contentIdentity,
    evidenceKey: `review:${contentIdentity}`,
    expectedState: { target: 'review', before: contentIdentity }
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

describe('Watcher kind approval advisory', () => {
  it('appends a kind-specific description to the pending approval reason', async () => {
    await expect(approvalReasonFromHook(() => 'gh pr create\nTITLE=x')).resolves.toBe(
      'awaiting-approval\ngh pr create\nTITLE=x'
    )
  })

  it('preserves the existing reason when the hook is absent or returns null', async () => {
    await expect(approvalReasonFromHook()).resolves.toBe('awaiting-approval')
    await expect(approvalReasonFromHook(() => null)).resolves.toBe('awaiting-approval')
  })

  it('truncates kind descriptions to 4,096 characters', async () => {
    const description = 'x'.repeat(4_097)
    await expect(approvalReasonFromHook(() => description)).resolves.toBe(
      `awaiting-approval\n${description.slice(0, 4_096)}`
    )
  })
})
describe('WatcherRunnerActions.execute evidence append', () => {
  it('binds evidence to the current watcher and write-ahead attempt, overriding forged identity fields', async () => {
    const watcherId = 'watcher-evidence'
    const fixture = await kernelHarness()
    const ledgerEntries: LedgerEntry[] = []
    const ledgerStore: RunnerLedgerStore = {
      read: (): WatcherLedger => ({ watcherId, entries: ledgerEntries }),
      append: (targetWatcherId, entry) => {
        expect(targetWatcherId).toBe(watcherId)
        ledgerEntries.push(entry)
      },
      appendTickTrace: () => {},
      readTickTraces: () => [],
      releaseTickTracePin: () => {},
      readTerminalSummary: () => null
    }
    const budgetClock: RunnerBudgetClock = {
      open: () => ({ watcherId, intervalId: 'interval-evidence' }),
      current: () => null,
      close: vi.fn(),
      checkpoint: () => {},
      recoverOnStart: () => false,
      owned: () => null
    }
    let sequence = 0
    const attemptAction = action('revision-evidence')
    const snapshot: Snapshot<World> = {
      freshness: 'live',
      contentIdentity: 'revision-evidence',
      observedAtMs: 1,
      world: { revision: 'revision-evidence' }
    }
    const execute = vi.fn(async (_action: KernelAction, context: ExecuteContext<World>) => {
      await context.appendEvidence?.('pipeline-loop-round', {
        loopId: 'loop',
        epoch: 2,
        round: 3,
        extraRounds: 1,
        attemptId: 'forged-attempt',
        attemptFingerprint: 'forged-fingerprint'
      })
      return { effect: 'landed' as const }
    })
    const pipelineKind = kernelKind({ execute })
    const assertHeld = vi.fn(async () => {})
    const runner: WatcherRunner = {
      enrollment: {
        watcherId,
        kind: 'hosted-review',
        workspaceKey: 'local::/workspace/evidence',
        executionHostId: 'local',
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        workspacePath: '/workspace/evidence',
        schedulerOwner: 'local_host_service',
        enabled: true,
        paused: false,
        commandRevision: 0,
        capabilities: { write: 'on' },
        budget: { wallClockActiveMs: null, turns: null },
        kindPayload: { label: 'Evidence test' },
        coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
        orchestrationRunId: null,
        createdAtMs: 1,
        terminalAtMs: null
      },
      kind: pipelineKind,
      status: {
        watcherId,
        enabled: true,
        state: 'watching',
        phase: 'watching',
        reason: null,
        parkReason: null,
        budget: { activeMs: 0, turns: 0, exhausted: null },
        startedAtMs: 1,
        lastSuccessfulTickAtMs: null,
        nextPulseAtMs: null
      },
      timer: null,
      operationTail: Promise.resolve(),
      tickQueued: false,
      reconcileAgain: false,
      stopped: false,
      suspended: false,
      controlPending: null,
      recovered: false,
      forceFresh: false,
      consecutiveErrors: 0,
      consecutiveGateHolds: 0,
      lastFullResyncAtMs: null,
      lastSnapshot: null,
      traceSequence: 0,
      traces: [],
      leaseGuard: {
        epoch: 1,
        holder: 'test-holder',
        assertHeld,
        renewLoop: () => ({ dispose: () => {} })
      },
      leaseRenewal: null,
      ownerBudgetInterval: null
    }
    const dependencies: WatcherRunnerActionDependencies = {
      ledgerStore,
      budgetClock,
      orchestration: fixture.orchestration,
      dispatchLifecycle: new WatcherLedgerLifecycle({
        ledgerStore,
        budgetClock,
        adapter: fixture.orchestration
      }),
      now: () => 10,
      createId: () => `event-${++sequence}`
    }

    const actions = new WatcherRunnerActions(dependencies)

    await actions.execute(runner, snapshot, attemptAction)

    const evidence = ledgerEntries.find(
      (entry): entry is Extract<LedgerEntry, { kind: 'evidence' }> => entry.kind === 'evidence'
    )
    expect(evidence).toMatchObject({
      watcherId,
      evidenceKind: 'pipeline-loop-round',
      payload: {
        loopId: 'loop',
        epoch: 2,
        round: 3,
        extraRounds: 1,
        attemptId: expect.any(String),
        attemptFingerprint: makeAttemptFingerprint(
          attemptAction.contentIdentity,
          attemptAction.kind,
          attemptAction.evidenceKey
        )
      }
    })
    expect(evidence?.payload).not.toMatchObject({
      attemptId: 'forged-attempt',
      attemptFingerprint: 'forged-fingerprint'
    })
    expect(assertHeld).toHaveBeenCalled()
  })
})
