import { describe, expect, it, vi } from 'vitest'
import type { EscalationEntry, LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { WatcherControlPlane } from './control-plane'
import type {
  EnrollmentControlChange,
  EnrollmentControlCommit,
  EnrollmentStore
} from './enrollment-store'
import { fakeLedger } from './ledger-test-fixture'
import type { WatcherRunner } from './runner-state'

function enrollment(overrides: Partial<WatcherEnrollment> = {}): WatcherEnrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'hosted-review',
    workspaceKey: 'local::/repo',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/repo',
    schedulerOwner: 'local_host_service',
    enabled: false,
    paused: false,
    commandRevision: 3,
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null,
    ...overrides
  }
}

const OWNER_FENCE = {
  executionHostId: 'local' as const,
  schedulerOwner: 'local_host_service' as const,
  workspaceKey: 'local::/repo' as const,
  revision: 3
}

function fakeEnrollments(initial: WatcherEnrollment) {
  let record = initial
  const store: EnrollmentStore = {
    get: (watcherId: string) => (watcherId === record.watcherId ? record : null),
    list: () => [record],
    findLiveByWorkspace: () => null,
    insert: (next: WatcherEnrollment) => {
      record = next
      return next
    },
    commitControl: (
      watcherId: string,
      _expectedOwner: unknown,
      change: EnrollmentControlChange,
      appendWithinTransaction?: () => void
    ): EnrollmentControlCommit => {
      if (watcherId !== record.watcherId) {
        return { status: 'refused', reason: 'watcher-not-found', detail: 'not found' }
      }
      appendWithinTransaction?.()
      record = {
        ...record,
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
        ...(change.paused === undefined ? {} : { paused: change.paused }),
        commandRevision: record.commandRevision + 1
      }
      return { status: 'committed', enrollment: record }
    },
    deleteWatcher: () => {
      throw new Error('not used in this test')
    },
    rollbackInserted: () => {
      throw new Error('not used in this test')
    },
    pendingKindPurges: () => [],
    completeKindPurge: () => {},
    setEnabled: (_watcherId: string, enabled: boolean) => {
      record = { ...record, enabled }
      return record
    },
    rearm: () => {
      throw new Error('not used in this test')
    },
    setOrchestrationRunId: () => {
      throw new Error('not used in this test')
    },
    markTerminal: () => {
      throw new Error('not used in this test')
    }
  }
  return { store, current: () => record }
}

function ownerDeviationEntry(overrides: Partial<EscalationEntry> = {}): EscalationEntry {
  return {
    eventId: 'deviation-1',
    watcherId: 'watcher-1',
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: 'owner-deviation:watcher-1:worker-question:message-1',
    escalationKind: 'owner-deviation',
    status: 'escalated',
    foldCount: 2,
    reason: JSON.stringify({
      summary: 'worker-question',
      note: 'escalated: no reply',
      deviation: {
        kind: 'worker-question',
        messageId: 'message-1',
        dispatchId: 'dispatch-1',
        question: 'Which branch?'
      }
    }),
    ...overrides
  }
}

function latestWithEscalationId(
  entries: LedgerEntry[],
  escalationId: string
): EscalationEntry | undefined {
  return entries
    .filter((entry): entry is EscalationEntry => entry.kind === 'escalation')
    .findLast((entry) => entry.escalationId === escalationId)
}

function parkEntry(
  escalationId: string,
  overrides: Partial<EscalationEntry> = {}
): EscalationEntry {
  return {
    eventId: 'park-1',
    watcherId: 'watcher-1',
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: `park:watcher-1:owner-escalation:${encodeURIComponent(escalationId)}`,
    escalationKind: 'park-owner-escalation',
    status: 'open',
    foldCount: 1,
    reason: 'needs a person',
    ...overrides
  }
}

function harness(entries: LedgerEntry[]) {
  const { store: ledger, entries: ledgerEntries } = fakeLedger(entries)
  const { store: enrollments } = fakeEnrollments(enrollment())
  const schedule = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test double only needs the enrollment/status fields the control plane reads; WatcherRunner has 20 fields the exercised paths never touch.
  const runner = {
    enrollment: enrollment(),
    status: {
      watcherId: 'watcher-1',
      enabled: false,
      state: 'parked',
      phase: 'parked',
      reason: 'needs a person',
      parkReason: { kind: 'owner-escalation', escalationId: '', reason: 'needs a person' },
      budget: { activeMs: 0, turns: 0, exhausted: null },
      startedAtMs: 0,
      lastSuccessfulTickAtMs: null,
      nextPulseAtMs: null
    }
  } as unknown as WatcherRunner
  let id = 0
  const controlPlane = new WatcherControlPlane({
    enrollments,
    ledger,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lease is never read by the answer-escalation paths this fixture exercises.
    lease: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: orchestration is never read by the answer-escalation paths this fixture exercises.
    orchestration: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherRunnerLoop is a class with private fields, so a structural test double can never satisfy it without this cast; only `.schedule` is exercised by the code under test.
    runnerLoop: { schedule, controlLifecycle: {} as never } as never,
    runner: () => runner,
    removeRunner: vi.fn(),
    purgeKindData: async () => {},
    owns: () => true,
    now: () => 99,
    createId: () => `event-${++id}`,
    changed: vi.fn()
  })
  return { controlPlane, ledgerEntries, schedule, runner }
}

describe('WatcherControlPlane answer-escalation command', () => {
  it('refuses when the watcher is not parked on that escalation', async () => {
    const { controlPlane, schedule } = harness([])

    const result = await controlPlane.command({
      target: { watcherId: 'watcher-1', connectionId: null, pairingRevision: null },
      expectedOwner: OWNER_FENCE,
      command: { kind: 'answer-escalation', escalationId: 'unknown', body: 'Use main.' }
    })

    expect(result).toMatchObject({ status: 'refused', reason: 'invalid-state' })
    expect(schedule).not.toHaveBeenCalled()
  })

  it('reopens the deviation, records the reply, unparks and reschedules the runner', async () => {
    const deviation = ownerDeviationEntry()
    const park = parkEntry(deviation.escalationId)
    const { controlPlane, ledgerEntries, schedule, runner } = harness([deviation, park])

    const result = await controlPlane.command({
      target: { watcherId: 'watcher-1', connectionId: null, pairingRevision: null },
      expectedOwner: OWNER_FENCE,
      command: {
        kind: 'answer-escalation',
        escalationId: deviation.escalationId,
        body: 'Use main.'
      }
    })

    expect(result).toMatchObject({ status: 'applied' })
    const latestDeviation = latestWithEscalationId(ledgerEntries, deviation.escalationId)
    const latestPark = latestWithEscalationId(ledgerEntries, park.escalationId)
    expect(latestDeviation).toMatchObject({
      status: 'open',
      foldCount: 1,
      humanReply: { body: 'Use main.', atMs: 99 }
    })
    expect(latestPark).toMatchObject({ status: 'acknowledged', foldCount: 2 })
    expect(runner.enrollment.enabled).toBe(true)
    expect(runner.status.parkReason).toBeNull()
    expect(runner.status.enabled).toBe(true)
    expect(schedule).toHaveBeenCalledWith(runner, 0)
  })
})
