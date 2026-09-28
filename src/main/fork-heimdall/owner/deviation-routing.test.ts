import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { z } from 'zod'
import { approvalScopeForAction } from '../../../shared/fork-heimdall/gate'
import { getLatestEscalations } from '../../../shared/fork-heimdall/ledger-queries'
import type { OwnerAdapter } from '../../../shared/fork-heimdall/kind-contract'
import type {
  ApprovalScope,
  AttemptEntry,
  KernelAction,
  LedgerEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { RegisteredWatcherKind } from '../registry'
import { WatcherRunnerActions } from '../runner-actions'
import type { WatcherRunner } from '../runner-state'
import {
  escalateDeviationToHuman,
  findOldestOpenOwnerDeviation,
  ownerInterventionSubmissionSubject,
  recordDeviation,
  type OwnerDeviationEscalation
} from './deviation-ledger'
import {
  driveOwnerDeviation,
  rememberOwnerSubmissionRejection,
  type DeviationRoutingDependencies
} from './deviation-routing'
import { deviationIsDispatchScoped } from './deviation-scope'
import type { OwnerReportReadResult } from './owner-report-io'
import { OWNER_STALL_THRESHOLD_MS } from './stall-detector'

const { ensureOwnerSession, sendOwnerTurn, readOwnerReport, issueOwnerReportPath } = vi.hoisted(
  () => ({
    ensureOwnerSession: vi.fn(async () => ({
      watcherId: 'watcher-1',
      sessionId: 'session-1',
      handle: 'handle-1',
      host: {}
    })),
    sendOwnerTurn: vi.fn(async (_input: { session: unknown; turnText: string }) => {}),
    readOwnerReport: vi.fn(async (): Promise<OwnerReportReadResult<unknown>> => ({
      ok: false,
      reason: 'missing'
    })),
    issueOwnerReportPath: vi.fn(async () => '/report/path.json')
  })
)

vi.mock('./owner-session', () => ({
  ensureOwnerSession,
  sendOwnerTurn,
  releaseOwnerSession: vi.fn()
}))
vi.mock('./owner-report-io', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readOwnerReport,
  issueOwnerReportPath,
  ownerReportPathForWake: () => '/report/path.json'
}))

type World = { revision: string }

type MemoryLedgerStore = {
  read(watcherId: string): WatcherLedger
  append(watcherId: string, entry: LedgerEntry): void
}

function memoryLedgerStore(): MemoryLedgerStore {
  const byWatcher = new Map<string, LedgerEntry[]>()
  return {
    read: (watcherId) => ({ watcherId, entries: byWatcher.get(watcherId) ?? [] }),
    append: (watcherId, entry) => {
      const list = byWatcher.get(watcherId) ?? []
      list.push(entry)
      byWatcher.set(watcherId, list)
    }
  }
}

function fakeOwner(
  rejection: {
    gate: 'write-territory' | 'landing-bar' | 'sitter-overrides'
    reason: string
  } | null,
  capability = 'write'
): OwnerAdapter<World, KernelAction> {
  return {
    describeState: () => ({ text: 'state', truncated: false }),
    describeInterventions: () => 'accept-report',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the ZodType class; only safeParse is called by the code under test.
    interventionSchema: {
      safeParse: (input: unknown) => ({ success: true, data: input })
    } as never,
    rejectIntervention: () => rejection,
    actionForIntervention: (_intervention, currentSnapshot) => ({
      kind: 'apply-fix',
      capability,
      visibility: 'local',
      contentIdentity: currentSnapshot.contentIdentity,
      evidenceKey: `apply-fix:${currentSnapshot.contentIdentity}`
    })
  }
}

function kindWithOwner(owner: OwnerAdapter<World, KernelAction>): RegisteredWatcherKind {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the WatcherKind contract (KindIdentity & SnapshotSource & Decision & ActionExecutor); these tests only ever read runner.kind.owner.
  return { owner } as unknown as RegisteredWatcherKind
}

function buildRunner(args: {
  paused: boolean
  owner?: { agent: 'claude' }
  enabled?: boolean
  capabilities?: Record<string, 'off' | 'gated' | 'on'>
}): WatcherRunner {
  const enrollment: WatcherEnrollment = {
    watcherId: 'watcher-1',
    kind: 'objective',
    workspaceKey: 'local::/workspace',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/workspace',
    schedulerOwner: 'local_host_service',
    enabled: args.enabled ?? true,
    paused: args.paused,
    commandRevision: 0,
    capabilities: args.capabilities ?? {
      plan: 'on',
      write: 'on',
      'owner-intervention': 'on'
    },
    budget: { wallClockActiveMs: 100_000, turns: 10 },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
    orchestrationRunId: 'run-1',
    createdAtMs: 0,
    terminalAtMs: null,
    ...(args.owner ? { owner: args.owner } : {})
  }
  return {
    enrollment,
    kind: kindWithOwner(fakeOwner(null)),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherStatus is never read by driveOwnerDeviation or these tests; only its presence on WatcherRunner matters.
    status: {} as WatcherRunner['status'],
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
    leaseGuard: null,
    leaseRenewal: null,
    ownerBudgetInterval: null
  }
}

const snapshot: Snapshot<World> = {
  freshness: 'live',
  contentIdentity: 'revision-1',
  observedAtMs: 1,
  world: { revision: 'revision-1' }
}

type TestRoutingDependencies = DeviationRoutingDependencies & {
  notifyApproval: Mock<(enrollment: WatcherEnrollment, action: KernelAction) => void>
}

function baseDeps(ledgerStore: MemoryLedgerStore): TestRoutingDependencies {
  let clock = 0
  let ids = 0
  let openInterval: { watcherId: string; intervalId: string } | null = null
  const notifyApproval = vi.fn<(enrollment: WatcherEnrollment, action: KernelAction) => void>()
  const actions = new WatcherRunnerActions({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: MemoryLedgerStore only implements read/append; actions.execute is mocked below so RunnerLedgerStore's other members are never called.
    ledgerStore: ledgerStore as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RunnerBudgetClock is unused — actions.execute is mocked below, so the constructor never calls into it.
    budgetClock: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: HeimdallOrchestrationAdapter is unused — actions.execute is mocked below, so the constructor never calls into it.
    orchestration: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherLedgerLifecycle is unused — actions.execute is mocked below, so the constructor never calls into it.
    dispatchLifecycle: {} as never,
    notifyApproval,
    now: () => ++clock,
    createId: () => `action-event-${++ids}`
  })
  vi.spyOn(actions, 'execute').mockResolvedValue(true)
  return {
    owner: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService is a large class; ensureOwnerSession/sendOwnerTurn are mocked via vi.mock, so this runtime handle is never dereferenced.
      runtime: {} as never,
      resolveWorkspaceTarget: async () => ({
        kind: 'folder',
        executionHostId: 'local',
        workspacePath: '/workspace',
        watcherId: 'watcher-1',
        fileProvider: null
      }),
      ensureRun: async () => ({ runId: 'run-1' })
    },
    actions,
    budgetClock: {
      open: (watcherId, cause) => {
        openInterval = { watcherId, intervalId: `interval-${cause}` }
        return openInterval
      },
      close: () => {
        openInterval = null
      },
      current: () => openInterval
    },
    ledgerRecord: { ledgerStore, now: () => ++clock, createId: () => `event-${++ids}` },
    answerWorkerQuestion: vi.fn(async () => {}),
    stopWorker: vi.fn(async () => ({ status: 'applied' as const, appliedAtMs: ++clock })),
    park: vi.fn(),
    notifyApproval
  }
}

function appendApproval(ledgerStore: MemoryLedgerStore, scope: ApprovalScope): void {
  ledgerStore.append('watcher-1', {
    eventId: `approval-${ledgerStore.read('watcher-1').entries.length}`,
    watcherId: 'watcher-1',
    atMs: 10_000,
    origin: 'owner',
    class: 'fact',
    kind: 'approval',
    scope,
    decision: 'approved',
    foldCount: 1
  })
}
function appendAcceptedOwnerReady(
  ledgerStore: MemoryLedgerStore,
  pending: OwnerDeviationEscalation
): void {
  const sequence = ledgerStore.read('watcher-1').entries.length
  ledgerStore.append('watcher-1', {
    eventId: `owner-ready-${sequence}`,
    watcherId: 'watcher-1',
    atMs: 10_000 + sequence,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    source: {
      kind: 'orchestration',
      sequence,
      messageId: `owner-ready-${sequence}`
    },
    payload: {
      type: 'status',
      subject: ownerInterventionSubmissionSubject('watcher-1', pending),
      body: 'ready',
      payload: {}
    }
  })
}
function requireOpenOwnerDeviation(ledgerStore: MemoryLedgerStore): OwnerDeviationEscalation {
  const pending = findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))
  if (!pending) {
    throw new Error('Expected an open owner deviation')
  }
  return pending
}

function latestAwaitingApprovalScope(
  ledgerStore: MemoryLedgerStore,
  contentIdentity = 'revision-1'
): ApprovalScope {
  const escalation = getLatestEscalations(ledgerStore.read('watcher-1')).find(
    (entry) =>
      entry.escalationKind === 'awaiting-approval' &&
      entry.approvalScope?.contentIdentity === contentIdentity
  )
  if (!escalation?.approvalScope) {
    throw new Error(`Expected an awaiting-approval escalation for ${contentIdentity}`)
  }
  return escalation.approvalScope
}

function sentOwnerTurnText(index: number): string {
  const input: unknown = vi.mocked(sendOwnerTurn).mock.calls[index]?.[0]
  if (
    input === null ||
    typeof input !== 'object' ||
    !('turnText' in input) ||
    typeof input.turnText !== 'string'
  ) {
    throw new Error(`Expected owner turn ${index} to contain text`)
  }
  return input.turnText
}

const deviation = {
  kind: 'worker-question' as const,
  messageId: 'message-1',
  dispatchId: 'dispatch-1',
  question: 'Which branch?'
}

beforeEach(() => {
  vi.clearAllMocks()
  ensureOwnerSession.mockResolvedValue({
    watcherId: 'watcher-1',
    sessionId: 'session-1',
    handle: 'handle-1',
    host: {}
  })
  readOwnerReport.mockResolvedValue({ ok: false, reason: 'missing' })
})

describe('driveOwnerDeviation: guards', () => {
  it('is idle and touches nothing when the watcher is paused', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: true, owner: { agent: 'claude' } })
    const outcome = await driveOwnerDeviation(baseDeps(ledgerStore), runner, snapshot)
    expect(outcome).toBe('idle')
    expect(ensureOwnerSession).not.toHaveBeenCalled()
    expect(sendOwnerTurn).not.toHaveBeenCalled()
  })

  it('is idle and touches nothing when no owner is configured', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: false })
    const outcome = await driveOwnerDeviation(baseDeps(ledgerStore), runner, snapshot)
    expect(outcome).toBe('idle')
    expect(ensureOwnerSession).not.toHaveBeenCalled()
  })
})

describe('driveOwnerDeviation: first wake', () => {
  it('sends the brief and marks the turn sent without spending a retry', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    const outcome = await driveOwnerDeviation(baseDeps(ledgerStore), runner, snapshot)
    expect(outcome).toBe('handled')
    expect(ensureOwnerSession).toHaveBeenCalledTimes(1)
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
    const pending = findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))
    expect(pending?.foldCount).toBe(1)
  })

  it('parks explicitly without issuing a path or sending when mandatory state cannot fit', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    runner.kind = kindWithOwner({
      ...fakeOwner(null),
      describeState: () => ({ text: 'x'.repeat(40_000), truncated: false })
    })
    const deps = baseDeps(ledgerStore)

    const outcome = await driveOwnerDeviation(deps, runner, snapshot)

    expect(outcome).toBe('handled')
    expect(issueOwnerReportPath).not.toHaveBeenCalled()
    expect(ensureOwnerSession).not.toHaveBeenCalled()
    expect(sendOwnerTurn).not.toHaveBeenCalled()
    expect(deps.park).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'owner-escalation',
        reason: expect.stringContaining('minimum complete state envelope')
      })
    )
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))).toBeNull()
  })

  it('is reachable even when the enrollment is already disabled', async () => {
    // a worker-question or worker-escalation deviation already disabled the watcher (via `park`)
    // before `driveOwnerDeviation` ever runs — it must not gate on `enabled`, or its own deviation
    // becomes unreachable the same way a park-disposition stop predicate's used to be
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' }, enabled: false })
    const outcome = await driveOwnerDeviation(baseDeps(ledgerStore), runner, snapshot)
    expect(outcome).toBe('handled')
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
  })
})

describe('driveOwnerDeviation: accepted ready evidence', () => {
  it('leaves an invalid pre-ready report and a rejected ready attempt outside the turn budget', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    const deps = baseDeps(ledgerStore)

    await driveOwnerDeviation(deps, runner, snapshot)
    const pending = requireOpenOwnerDeviation(ledgerStore)
    const ownerInterval = deps.budgetClock.current?.('watcher-1')
    readOwnerReport.mockResolvedValue({
      ok: false,
      reason: 'malformed',
      detail: 'invalid report'
    })

    await driveOwnerDeviation(deps, runner, snapshot)
    expect(readOwnerReport).not.toHaveBeenCalled()
    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(1)
    expect(deps.budgetClock.current?.('watcher-1')).toEqual(ownerInterval)

    // A ready rejected by submission preflight adds no durable evidence, so the next tick is inert too.
    await driveOwnerDeviation(deps, runner, snapshot)
    expect(readOwnerReport).not.toHaveBeenCalled()
    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(1)
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)

    readOwnerReport.mockResolvedValue({
      ok: true,
      path: '/report/path.json',
      report: { kind: 'accept-report' }
    })
    appendAcceptedOwnerReady(ledgerStore, pending)
    await driveOwnerDeviation(deps, runner, snapshot)

    expect(readOwnerReport).toHaveBeenCalledTimes(1)
    expect(deps.actions.execute).toHaveBeenCalledTimes(1)
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))).toBeNull()
    expect(deps.budgetClock.current?.('watcher-1')).toBeNull()
  })

  it('does not let a prior wake ready authorize the re-raised turn report', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    runner.kind = kindWithOwner(fakeOwner({ gate: 'write-territory', reason: 'outside territory' }))
    const deps = baseDeps(ledgerStore)

    await driveOwnerDeviation(deps, runner, snapshot)
    appendAcceptedOwnerReady(ledgerStore, requireOpenOwnerDeviation(ledgerStore))
    readOwnerReport.mockResolvedValue({
      ok: true,
      path: '/report/path.json',
      report: { kind: 'accept-report' }
    })
    await driveOwnerDeviation(deps, runner, snapshot)
    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(2)

    runner.kind = kindWithOwner(fakeOwner(null))
    readOwnerReport.mockClear()
    await driveOwnerDeviation(deps, runner, snapshot)
    expect(readOwnerReport).not.toHaveBeenCalled()
    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(2)
    expect(deps.actions.execute).not.toHaveBeenCalled()

    appendAcceptedOwnerReady(ledgerStore, requireOpenOwnerDeviation(ledgerStore))
    await driveOwnerDeviation(deps, runner, snapshot)
    expect(readOwnerReport).toHaveBeenCalledTimes(1)
    expect(deps.actions.execute).toHaveBeenCalledTimes(1)
  })
  it('does not replay a resolved occurrence ready against the same deviation recurring later', async () => {
    const ledgerStore = memoryLedgerStore()
    const firstRecorded = recordDeviation(
      { ledgerStore, now: () => 1, createId: () => 'first-occurrence' },
      'watcher-1',
      deviation
    )
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    const deps = baseDeps(ledgerStore)

    await driveOwnerDeviation(deps, runner, snapshot)
    const firstSent = requireOpenOwnerDeviation(ledgerStore)
    const firstSubject = ownerInterventionSubmissionSubject('watcher-1', firstSent)
    appendAcceptedOwnerReady(ledgerStore, firstSent)
    readOwnerReport.mockResolvedValue({
      ok: true,
      path: '/report/path.json',
      report: { kind: 'accept-report' }
    })
    await driveOwnerDeviation(deps, runner, snapshot)
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))).toBeNull()

    const recurrence = recordDeviation(deps.ledgerRecord, 'watcher-1', deviation)
    expect(ownerInterventionSubmissionSubject('watcher-1', recurrence)).not.toBe(firstSubject)
    expect(recurrence.foldCount).toBe(firstRecorded.foldCount)
    await driveOwnerDeviation(deps, runner, snapshot)

    readOwnerReport.mockClear()
    await driveOwnerDeviation(deps, runner, snapshot)

    expect(readOwnerReport).not.toHaveBeenCalled()
    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(1)
    expect(sendOwnerTurn).toHaveBeenCalledTimes(2)
  })
})

describe('driveOwnerDeviation: rejected reply is re-raised once then escalated', () => {
  it('re-raises on the first rejection and escalates on the second', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    runner.kind = kindWithOwner(fakeOwner({ gate: 'write-territory', reason: 'outside territory' }))
    const deps = baseDeps(ledgerStore)

    // wake 1: sends the brief
    await driveOwnerDeviation(deps, runner, snapshot)
    appendAcceptedOwnerReady(ledgerStore, requireOpenOwnerDeviation(ledgerStore))
    // reply 1: rejected by gate 1, re-raised (spends the one retry) and a fresh brief goes out
    readOwnerReport.mockResolvedValueOnce({
      ok: true,
      path: '/report/path.json',
      report: { kind: 'accept-report' }
    })
    await driveOwnerDeviation(deps, runner, snapshot)
    expect(deps.park).not.toHaveBeenCalled()
    expect(sendOwnerTurn).toHaveBeenCalledTimes(2)
    expect(sentOwnerTurnText(1)).toContain('write-territory: outside territory')
    const afterFirstRejection = requireOpenOwnerDeviation(ledgerStore)
    expect(afterFirstRejection.foldCount).toBe(2)

    // reply 2: rejected again — the retry is spent, so this escalates instead of re-raising
    appendAcceptedOwnerReady(ledgerStore, afterFirstRejection)
    readOwnerReport.mockResolvedValueOnce({
      ok: true,
      path: '/report/path.json',
      report: { kind: 'accept-report' }
    })
    const outcome = await driveOwnerDeviation(deps, runner, snapshot)
    expect(outcome).toBe('handled')
    expect(deps.park).toHaveBeenCalledTimes(1)
    expect(sendOwnerTurn).toHaveBeenCalledTimes(2)
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))).toBeNull()
  })

  it('shows a rejected preflight cause on re-wake without the rejection spending a retry', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    const deps = baseDeps(ledgerStore)

    await driveOwnerDeviation(deps, runner, snapshot)
    const pending = requireOpenOwnerDeviation(ledgerStore)
    const reason = 'Heimdall rejected the owner intervention: rationale exceeds its bound.'
    rememberOwnerSubmissionRejection(runner, pending, reason)

    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(1)
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)

    deps.ledgerRecord.now = () => 1_000_000_000
    await driveOwnerDeviation(deps, runner, snapshot)

    expect(sendOwnerTurn).toHaveBeenCalledTimes(2)
    expect(sentOwnerTurnText(1)).toContain(reason)
    expect(requireOpenOwnerDeviation(ledgerStore).foldCount).toBe(2)
  })
})

async function submitOwnerReport(capabilities: Record<string, 'off' | 'gated' | 'on'>) {
  const ledgerStore = memoryLedgerStore()
  recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
  const runner = buildRunner({
    paused: false,
    owner: { agent: 'claude' },
    capabilities
  })
  runner.kind = kindWithOwner(fakeOwner(null, 'plan'))
  const deps = baseDeps(ledgerStore)
  await driveOwnerDeviation(deps, runner, snapshot)
  appendAcceptedOwnerReady(ledgerStore, requireOpenOwnerDeviation(ledgerStore))
  readOwnerReport.mockResolvedValue({
    ok: true,
    path: '/report/path.json',
    report: { kind: 'dispatch-planner', guidance: 'Use the existing source plan.' }
  })
  await driveOwnerDeviation(deps, runner, snapshot)
  return { ledgerStore, runner, deps }
}

describe('driveOwnerDeviation: capability approval holds', () => {
  it('persists one owner approval request across ticks, then executes the same report once approved', async () => {
    const { ledgerStore, runner, deps } = await submitOwnerReport({
      plan: 'on',
      'owner-intervention': 'gated'
    })
    expect(latestAwaitingApprovalScope(ledgerStore)).toEqual(
      approvalScopeForAction({
        kind: 'apply-fix',
        capability: 'owner-intervention',
        visibility: 'local',
        contentIdentity: 'revision-1',
        evidenceKey: 'apply-fix:revision-1'
      })
    )
    expect(deps.notifyApproval).toHaveBeenCalledTimes(1)
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))?.foldCount).toBe(1)
    expect(deps.budgetClock.current?.('watcher-1')).toBeNull()
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
    expect(deps.actions.execute).not.toHaveBeenCalled()

    await driveOwnerDeviation(deps, runner, snapshot)
    expect(deps.notifyApproval).toHaveBeenCalledTimes(1)
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))?.foldCount).toBe(1)
    expect(deps.budgetClock.current?.('watcher-1')).toBeNull()
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
    expect(ensureOwnerSession).toHaveBeenCalledTimes(1)
    expect(deps.park).not.toHaveBeenCalled()

    appendApproval(ledgerStore, latestAwaitingApprovalScope(ledgerStore))
    await driveOwnerDeviation(deps, runner, snapshot)
    expect(deps.actions.execute).toHaveBeenCalledTimes(1)
    expect(deps.actions.execute).toHaveBeenCalledWith(
      runner,
      snapshot,
      expect.objectContaining({
        capability: 'owner-intervention',
        contentIdentity: 'revision-1',
        evidenceKey: 'apply-fix:revision-1'
      })
    )
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))).toBeNull()
    expect(await driveOwnerDeviation(deps, runner, snapshot)).toBe('idle')
    expect(deps.actions.execute).toHaveBeenCalledTimes(1)
  })

  it('holds a native gated capability without consuming the owner retry', async () => {
    const { ledgerStore, deps } = await submitOwnerReport({
      plan: 'gated',
      'owner-intervention': 'on'
    })
    expect(latestAwaitingApprovalScope(ledgerStore)).toBeDefined()
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))?.foldCount).toBe(1)
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
    expect(deps.actions.execute).not.toHaveBeenCalled()
    expect(deps.park).not.toHaveBeenCalled()
  })

  it('does not execute when approval belongs to another scope', async () => {
    const { ledgerStore, runner, deps } = await submitOwnerReport({
      plan: 'on',
      'owner-intervention': 'gated'
    })
    const heldScope = latestAwaitingApprovalScope(ledgerStore)
    appendApproval(ledgerStore, { ...heldScope, evidenceKey: 'unrelated-action' })
    await driveOwnerDeviation(deps, runner, snapshot)

    expect(deps.actions.execute).not.toHaveBeenCalled()
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))?.foldCount).toBe(1)
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
    expect(deps.park).not.toHaveBeenCalled()
  })

  it('does not apply a prior scope after the same report is replayed against newer content', async () => {
    const { ledgerStore, runner, deps } = await submitOwnerReport({
      plan: 'on',
      'owner-intervention': 'gated'
    })
    appendApproval(ledgerStore, latestAwaitingApprovalScope(ledgerStore))
    const newerSnapshot: Snapshot<World> = {
      ...snapshot,
      contentIdentity: 'revision-2',
      world: { revision: 'revision-2' }
    }
    await driveOwnerDeviation(deps, runner, newerSnapshot)

    expect(deps.actions.execute).not.toHaveBeenCalled()
    expect(latestAwaitingApprovalScope(ledgerStore, 'revision-2')).toMatchObject({
      contentIdentity: 'revision-2',
      evidenceKey: 'apply-fix:revision-2'
    })
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))?.foldCount).toBe(1)
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
    expect(deps.park).not.toHaveBeenCalled()
  })

  it('does not let owner-intervention:on bypass plan:off', async () => {
    const { ledgerStore, deps } = await submitOwnerReport({
      plan: 'off',
      'owner-intervention': 'on'
    })
    expect(deps.actions.execute).not.toHaveBeenCalled()
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))?.foldCount).toBe(2)
    expect(sendOwnerTurn).toHaveBeenCalledTimes(2)
    expect(deps.park).not.toHaveBeenCalled()
  })
})

describe('driveOwnerDeviation: an over-cap reply parks with a readable reason', () => {
  it('names the field and UTF-16 limit and keeps a rejected diagnostic preview', async () => {
    const ledgerStore = memoryLedgerStore()
    recordDeviation({ ledgerStore, now: () => 1, createId: () => 'e1' }, 'watcher-1', deviation)
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    const cappedSchema = z
      .object({
        kind: z.literal('skip-node'),
        taskKey: z.string(),
        rationale: z.string().trim().min(1).max(10)
      })
      .strict()
    runner.kind = kindWithOwner({ ...fakeOwner(null), interventionSchema: cappedSchema })
    const deps = baseDeps(ledgerStore)
    const rationale = 'far too long for the field cap'
    const overCapReply = {
      ok: true as const,
      path: '/report/path.json',
      report: { kind: 'skip-node', taskKey: 'task-1', rationale }
    }

    // wake 1: sends the brief
    await driveOwnerDeviation(deps, runner, snapshot)
    appendAcceptedOwnerReady(ledgerStore, requireOpenOwnerDeviation(ledgerStore))
    // reply 1: over-cap, re-raised (spends the one retry) and a fresh brief goes out
    readOwnerReport.mockResolvedValueOnce(overCapReply)
    await driveOwnerDeviation(deps, runner, snapshot)
    expect(deps.park).not.toHaveBeenCalled()

    // reply 2: over-cap again — the retry is spent, so this escalates and parks
    appendAcceptedOwnerReady(ledgerStore, requireOpenOwnerDeviation(ledgerStore))
    readOwnerReport.mockResolvedValueOnce(overCapReply)
    await driveOwnerDeviation(deps, runner, snapshot)

    expect(deps.park).toHaveBeenCalledTimes(1)
    const parked = vi.mocked(deps.park).mock.calls[0][0]
    if (parked.kind !== 'owner-escalation') {
      throw new Error(`expected an owner-escalation park, got ${parked.kind}`)
    }
    expect(parked.reason).toContain('rationale')
    expect(parked.reason).toContain('10-code-unit limit')
    expect(parked.reason).toContain(rationale.slice(0, 10))
    expect(parked.reason).toContain('submission rejected, no correction applied')
    expect(parked.reason).not.toContain('too_big')
  })
})

describe('driveOwnerDeviation: a stalled dispatch wakes the owner with no other deviation source', () => {
  it('records a stall deviation and sends the brief when nothing else is pending', async () => {
    const ledgerStore = memoryLedgerStore()
    const thresholdMs = 15 * 60_000
    ledgerStore.append('watcher-1', {
      eventId: 'attempt-1',
      watcherId: 'watcher-1',
      atMs: 0,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-1',
      fingerprint: 'fp-1',
      action: {
        kind: 'dispatch-node',
        capability: 'write',
        visibility: 'local',
        contentIdentity: 'revision-1',
        evidenceKey: 'evidence-1'
      },
      state: 'running',
      dispatchId: 'dispatch-1'
    })
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    const deps = baseDeps(ledgerStore)
    deps.ledgerRecord.now = () => thresholdMs + 1

    const outcome = await driveOwnerDeviation(deps, runner, snapshot)
    expect(outcome).toBe('handled')
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
    const pending = findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))
    expect(pending?.escalationId).toContain('stall:')
  })

  it('backs off a stall after the owner continues and prompts again after two thresholds', async () => {
    const ledgerStore = memoryLedgerStore()
    const thresholdMs = OWNER_STALL_THRESHOLD_MS
    let nowMs = thresholdMs + 1
    ledgerStore.append('watcher-1', {
      eventId: 'attempt-stalled',
      watcherId: 'watcher-1',
      atMs: 0,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-stalled',
      fingerprint: 'fp-stalled',
      action: {
        kind: 'dispatch-node',
        capability: 'write',
        visibility: 'local',
        contentIdentity: 'revision-1',
        evidenceKey: 'evidence-stalled'
      },
      state: 'running',
      dispatchId: 'dispatch-stalled'
    })
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    const deps = baseDeps(ledgerStore)
    deps.ledgerRecord.now = () => nowMs

    await expect(driveOwnerDeviation(deps, runner, snapshot)).resolves.toBe('handled')
    const pending = requireOpenOwnerDeviation(ledgerStore)
    appendAcceptedOwnerReady(ledgerStore, pending)
    readOwnerReport.mockResolvedValue({
      ok: true,
      path: '/report/path.json',
      report: { kind: 'continue' }
    })
    await expect(driveOwnerDeviation(deps, runner, snapshot)).resolves.toBe('handled')
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))).toBeNull()

    const resolved = getLatestEscalations(ledgerStore.read('watcher-1')).find(
      (entry) => entry.escalationId === pending.escalationId
    )
    if (!resolved) {
      throw new Error('Expected resolved stall deviation')
    }

    nowMs = resolved.atMs + 1
    await expect(driveOwnerDeviation(deps, runner, snapshot)).resolves.toBe('idle')
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)

    nowMs = resolved.atMs + 2 * thresholdMs + 1
    await expect(driveOwnerDeviation(deps, runner, snapshot)).resolves.toBe('handled')
    expect(sendOwnerTurn).toHaveBeenCalledTimes(2)
  })

  it('does not send another owner turn after the stalled dispatch was escalated', async () => {
    const ledgerStore = memoryLedgerStore()
    const thresholdMs = 15 * 60_000
    ledgerStore.append('watcher-1', {
      eventId: 'attempt-stalled',
      watcherId: 'watcher-1',
      atMs: 0,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-stalled',
      fingerprint: 'fp-stalled',
      action: {
        kind: 'dispatch-node',
        capability: 'write',
        visibility: 'local',
        contentIdentity: 'revision-1',
        evidenceKey: 'evidence-stalled'
      },
      state: 'running',
      dispatchId: 'dispatch-stalled'
    })
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    const deps = baseDeps(ledgerStore)
    deps.ledgerRecord.now = () => thresholdMs + 1
    await driveOwnerDeviation(deps, runner, snapshot)
    const pending = findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))
    if (!pending) {
      throw new Error('Expected open stall deviation')
    }
    escalateDeviationToHuman(deps.ledgerRecord, 'watcher-1', pending, 'operator required')

    await expect(driveOwnerDeviation(deps, runner, snapshot)).resolves.toBe('idle')
    expect(sendOwnerTurn).toHaveBeenCalledTimes(1)
  })

  it('raises a second dispatch stall once the first has been escalated', async () => {
    const ledgerStore = memoryLedgerStore()
    const thresholdMs = 15 * 60_000
    ledgerStore.append('watcher-1', {
      eventId: 'attempt-a',
      watcherId: 'watcher-1',
      atMs: 0,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-a',
      fingerprint: 'fp-a',
      action: {
        kind: 'dispatch-node',
        capability: 'write',
        visibility: 'local',
        contentIdentity: 'revision-1',
        evidenceKey: 'evidence-a'
      },
      state: 'running',
      dispatchId: 'dispatch-a'
    })
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    const deps = baseDeps(ledgerStore)
    deps.ledgerRecord.now = () => thresholdMs + 1
    await driveOwnerDeviation(deps, runner, snapshot)
    const pendingA = requireOpenOwnerDeviation(ledgerStore)
    escalateDeviationToHuman(deps.ledgerRecord, 'watcher-1', pendingA, 'operator required')

    ledgerStore.append('watcher-1', {
      eventId: 'attempt-b',
      watcherId: 'watcher-1',
      atMs: 0,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-b',
      fingerprint: 'fp-b',
      action: {
        kind: 'dispatch-node',
        capability: 'write',
        visibility: 'local',
        contentIdentity: 'revision-2',
        evidenceKey: 'evidence-b'
      },
      state: 'running',
      dispatchId: 'dispatch-b'
    })

    const outcome = await driveOwnerDeviation(deps, runner, snapshot)
    expect(outcome).toBe('handled')
    const pendingB = requireOpenOwnerDeviation(ledgerStore)
    expect(pendingB.escalationId).toContain('dispatch-b')
    expect(sendOwnerTurn).toHaveBeenCalledTimes(2)
  })
})

describe('deviationIsDispatchScoped', () => {
  it('uses the latest matching dispatch attempt for retry exhaustion', () => {
    const attempt = (attemptId: string, dispatchId: string, atMs: number): AttemptEntry => ({
      eventId: `event-${attemptId}`,
      watcherId: 'watcher-1',
      atMs,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId,
      fingerprint: `fingerprint-${attemptId}`,
      action: {
        kind: 'dispatch-node',
        capability: 'write',
        visibility: 'local',
        contentIdentity: 'revision-1',
        evidenceKey: attemptId,
        taskKey: 'task-a'
      },
      state: 'running',
      dispatchId
    })
    const ledger = {
      watcherId: 'watcher-1',
      entries: [attempt('old', 'dispatch-serial', 1), attempt('new', 'dispatch-isolated', 2)]
    }
    const runner = buildRunner({ paused: false, owner: { agent: 'claude' } })
    runner.kind = {
      ...runner.kind,
      concurrency: {
        canRunAlongside: () => false,
        shouldDrainBudget: () => false,
        preserveAttemptOnContentChange: () => false,
        canRunWhenBudgetExhausted: () => false,
        isIsolatedAttempt: (candidate) => candidate.dispatchId === 'dispatch-isolated',
        retainWorker: () => false
      }
    }

    expect(
      deviationIsDispatchScoped(
        {
          kind: 'retry-exhausted',
          taskKey: 'task-a',
          retryCount: 3,
          lastFailureClass: 'infra'
        },
        runner,
        ledger
      )
    ).toBe(true)
  })
})
