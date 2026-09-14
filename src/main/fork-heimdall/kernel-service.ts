import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { ApprovalScopeSchema, type ApprovalScope } from '../../shared/fork-heimdall/gate'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import { getLatestApproval, getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  EnrollInput,
  EnrollResult,
  WatcherEnrollment,
  WatcherListEntry
} from '../../shared/fork-heimdall/watcher-types'
import { HeimdallBudgetClock } from './budget-clock'
import { HeimdallDatabase } from './database'
import {
  buildHeimdallDebugReport,
  dormantWatcherStatus,
  type HeimdallDebugReport
} from './debug-report'
import {
  HeimdallEnrollmentStore,
  isMalformedKindPayloadEnrollment,
  type EnrollmentRecord,
  type EnrollmentStore
} from './enrollment-store'
import {
  authorizeKindEnrollment,
  enrollmentForPresentation,
  extendBudgetForRearm,
  runnableEnrollment
} from './kernel-enrollment'
import { HeimdallKernelHost } from './kernel-host'
import { watcherListEntry } from './kernel-list-entry'
import type { HeimdallKernelService } from './kernel-service-contract'
import {
  requireLeaseStore,
  runnerLedgerStore,
  type HeimdallKernelServiceDependencies
} from './kernel-service-dependencies'
import { HeimdallLedgerStore } from './ledger-store'
import { HostRoutedLeaseStore, type LeaseStore } from './lease-store'
import { MalformedEnrollmentLifecycle } from './malformed-enrollment'
import { notifyWatcher } from './notification'
import { mintCoordinatorIdentity } from './orchestration/coordinator-identity'
import { RuntimeHeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import { WatcherKindRegistry, type RegisteredWatcherKind } from './registry'
import { WatcherRunnerLoop } from './runner-loop'
import type { RunnerBudgetClock, RunnerLedgerStore, WatcherRunner } from './runner-state'

export type { HeimdallKernelService } from './kernel-service-contract'
export class HeimdallKernelServiceImpl implements HeimdallKernelService {
  private readonly registry = new WatcherKindRegistry()
  private malformedEnrollments: MalformedEnrollmentLifecycle | null = null
  private database: HeimdallDatabase | null = null
  private readonly runners = new Map<string, WatcherRunner>()
  private enrollments: EnrollmentStore | null = null
  private ledgerStore: HeimdallLedgerStore | null = null
  private leaseStore: LeaseStore | null = null
  private host: HeimdallKernelHost | null = null
  private runnerLoop: WatcherRunnerLoop | null = null
  private loaded = false
  private stopped = false
  private readonly onSuspend = (): void => this.suspend()
  private readonly onResume = (): void => this.resume()

  constructor(private readonly dependencies: HeimdallKernelServiceDependencies) {}

  registerKind<TWorld, TAction extends KernelAction, TResult>(
    kind: WatcherKind<TWorld, TAction, TResult>
  ): void {
    this.registry.register(kind as RegisteredWatcherKind)
    if (!this.loaded) {
      return
    }
    for (const record of this.requireEnrollments().list()) {
      if (record.kind !== kind.id || this.runners.has(record.watcherId)) {
        continue
      }
      if (isMalformedKindPayloadEnrollment(record)) {
        this.malformedEnrollments!.record(record, this.database?.isReadOnly() !== true)
        continue
      }
      if (!kind.enrollmentPayloadSchema.safeParse(record.kindPayload).success) {
        this.malformedEnrollments!.record(record, this.database?.isReadOnly() !== true)
        continue
      }
      this.restoreRunner(
        record,
        kind as RegisteredWatcherKind,
        this.database?.isReadOnly() !== true
      )
    }
  }

  async enroll(untrustedInput: EnrollInput): Promise<EnrollResult> {
    this.ensureLoaded()
    const authorization = await authorizeKindEnrollment(this.registry, untrustedInput)
    if (authorization.status !== 'authorized') {
      return authorization
    }
    const { authorized, kind } = authorization

    const existing = this.requireEnrollments().findLiveByWorkspace(authorized.workspaceKey)
    if (existing) {
      if (isMalformedKindPayloadEnrollment(existing)) {
        return {
          status: 'refused',
          reason: 'invalid-payload',
          detail: 'Persisted kind payload is malformed and cannot be re-armed'
        }
      }
      if (existing.enabled) {
        return {
          status: 'refused',
          reason: 'duplicate-workspace',
          existingWatcherId: existing.watcherId
        }
      }
      if (existing.kind !== authorized.kind) {
        return {
          status: 'refused',
          reason: 'invalid-payload',
          detail: `Workspace is already enrolled as ${existing.kind}`
        }
      }
      const extendedBudget = extendBudgetForRearm(
        this.requireRunnerLedger().read(existing.watcherId),
        existing.budget,
        authorized.budget
      )
      const rearmed = this.requireEnrollments().rearm(existing.watcherId, {
        capabilities: authorized.capabilities,
        budget: extendedBudget,
        kindPayload: authorized.kindPayload
      })
      this.requireRunnerLoop().acknowledgePark(rearmed.watcherId)
      let runner = this.runners.get(rearmed.watcherId)
      if (!runner) {
        runner = this.restoreRunner(rearmed, kind)
      } else {
        runner.enrollment = rearmed
        runner.status = {
          ...runner.status,
          enabled: true,
          state: 'watching',
          phase: 're-armed',
          reason: null,
          parkReason: null
        }
        runner.stopped = false
        this.requireRunnerLoop().schedule(runner, 0)
      }
      return { status: 're-armed', entry: this.listEntry(rearmed) }
    }

    const enrollment: WatcherEnrollment = {
      ...authorized,
      watcherId: this.createId(),
      enabled: true,
      coordinatorIdentity: mintCoordinatorIdentity(this.createId()),
      orchestrationRunId: null,
      createdAtMs: this.now(),
      terminalAtMs: null
    }
    const inserted = this.requireEnrollments().insert(enrollment)
    this.restoreRunner(inserted, kind)
    return { status: 'enrolled', entry: this.listEntry(inserted) }
  }

  async list(): Promise<WatcherListEntry[]> {
    this.ensureLoaded()
    return this.requireEnrollments()
      .list()
      .map((record) => this.listEntry(record))
  }

  async disarm(watcherId: string): Promise<void> {
    this.ensureLoaded()
    const enrollment = this.requireEnrollments().setEnabled(watcherId, false)
    const runner = this.runners.get(watcherId)
    if (runner) {
      if (isMalformedKindPayloadEnrollment(enrollment)) {
        const guard = runner.leaseGuard
        this.requireRunnerLoop().disarm(runner)
        if (guard) {
          await requireLeaseStore(this.leaseStore).release(enrollment.workspaceKey, guard.epoch)
        }
        return
      }
      runner.enrollment = enrollment
      runner.status = {
        ...runner.status,
        enabled: false,
        state: 'disabled',
        phase: 'disarmed',
        reason: null,
        parkReason: null,
        nextPulseAtMs: null
      }
      if (getInFlightAttempts(this.requireRunnerLedger().read(watcherId)).length === 0) {
        const guard = runner.leaseGuard
        this.requireRunnerLoop().disarm(runner)
        if (guard) {
          await requireLeaseStore(this.leaseStore).release(enrollment.workspaceKey, guard.epoch)
        }
      }
    }
  }

  async disarmAll(): Promise<void> {
    this.ensureLoaded()
    for (const enrollment of this.requireEnrollments().list()) {
      if (enrollment.terminalAtMs === null && enrollment.enabled) {
        await this.disarm(enrollment.watcherId)
      }
    }
  }

  async approve(watcherId: string, untrustedScope: ApprovalScope): Promise<void> {
    this.ensureLoaded()
    const scope = ApprovalScopeSchema.parse(untrustedScope)
    const enrollment = this.requireEnrollment(watcherId)
    const ledger = this.requireRunnerLedger().read(watcherId)
    const previous = getLatestApproval(ledger, scope)
    this.append(watcherId, {
      eventId: this.createId(),
      watcherId,
      atMs: this.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'approval',
      scope,
      decision: 'approved',
      foldCount: (previous?.foldCount ?? 0) + 1
    })
    const runner =
      this.runners.get(watcherId) ?? this.restoreRunner(enrollment, this.requireKind(enrollment))
    this.requireRunnerLoop().schedule(runner, 0)
  }

  ledger(watcherId: string): WatcherLedger {
    this.ensureLoaded()
    this.requireEnrollmentRecord(watcherId)
    return this.requireRunnerLedger().read(watcherId)
  }

  debugReport(watcherId: string): HeimdallDebugReport {
    this.ensureLoaded()
    const enrollment = enrollmentForPresentation(this.requireEnrollmentRecord(watcherId))
    const ledger = this.requireRunnerLedger().read(watcherId)
    const runner = this.runners.get(watcherId) ?? null
    return buildHeimdallDebugReport({
      enrollment,
      status: runner?.status ?? dormantWatcherStatus(enrollment, ledger),
      ledger,
      traces: runner?.traces ?? this.requireRunnerLedger().readTickTraces(watcherId),
      runner: runner
        ? {
            consecutiveErrors: runner.consecutiveErrors,
            lastFullResyncAtMs: runner.lastFullResyncAtMs,
            tickQueued: runner.tickQueued,
            reconcileAgain: runner.reconcileAgain,
            timerArmed: runner.timer !== null,
            actionInFlight: getInFlightAttempts(ledger).length > 0,
            leaseEpoch: runner.leaseGuard?.epoch ?? null
          }
        : null,
      generatedAtMs: this.now(),
      appVersion: this.dependencies.appVersion?.() ?? 'unknown',
      platform: process.platform,
      homeDirectory: homedir()
    })
  }

  suspend(): void {
    if (!this.loaded) {
      return
    }
    for (const runner of this.runners.values()) {
      this.requireRunnerLoop().suspend(runner)
    }
  }

  resume(): void {
    if (!this.loaded || this.stopped) {
      return
    }
    for (const runner of this.runners.values()) {
      this.requireRunnerLoop().resume(runner)
    }
  }

  stopForShutdown(): void {
    if (this.stopped) {
      return
    }
    this.stopped = true
    if (!this.loaded) {
      return
    }
    // The caller is Electron's synchronous will-quit teardown, so a throw here would skip every
    // later member of that barrier and orphan plugin hosts and browser daemons.
    try {
      for (const runner of this.runners.values()) {
        const guard = runner.leaseGuard
        this.requireRunnerLoop().stop(runner)
        if (guard) {
          void requireLeaseStore(this.leaseStore)
            .release(runner.enrollment.workspaceKey, guard.epoch)
            .catch(() => {})
        }
      }
      this.host?.detachPowerMonitor()
      this.database?.close()
    } catch (error) {
      console.warn('[heimdall] shutdown teardown failed:', error)
    }
  }

  /** Narrow test seam: real scheduling always calls the same serialized pulse. */
  async reconcileForTesting(watcherId: string): Promise<void> {
    this.ensureLoaded()
    const runner = this.runners.get(watcherId)
    if (!runner) {
      throw new Error(`Unknown Heimdall runner: ${watcherId}`)
    }
    await this.requireRunnerLoop().pulse(runner)
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return
    }
    if (this.stopped) {
      throw new Error('Heimdall kernel has stopped')
    }
    const database =
      this.dependencies.database ??
      new HeimdallDatabase(() => this.dependencies.store.getProfileStorageDirectory())
    const enrollments = this.dependencies.enrollmentStore ?? new HeimdallEnrollmentStore(database)
    const ledgerStore = this.dependencies.ledgerStore ?? new HeimdallLedgerStore(database)
    const budgetClock = this.dependencies.budgetClock ?? new HeimdallBudgetClock(ledgerStore)
    const host = new HeimdallKernelHost(
      this.dependencies.runtime,
      (key) => runnableEnrollment(enrollments.findLiveByWorkspace(key)),
      this.onSuspend,
      this.onResume
    )
    const leaseStore =
      this.dependencies.leaseStore ??
      new HostRoutedLeaseStore({ resolveTarget: (key) => host.resolveLeaseTarget(key) })

    this.database = database
    this.enrollments = enrollments
    this.ledgerStore = ledgerStore
    this.leaseStore = leaseStore
    this.host = host
    const runnerLedger = runnerLedgerStore(ledgerStore)
    this.malformedEnrollments = new MalformedEnrollmentLifecycle({
      enrollments,
      readLedger: (watcherId) => runnerLedger.read(watcherId),
      appendLedger: (watcherId, entry) => runnerLedger.append(watcherId, entry),
      now: () => this.now(),
      createId: () => this.createId()
    })
    const orchestration =
      this.dependencies.orchestration ??
      new RuntimeHeimdallOrchestrationAdapter(this.dependencies.runtime, {
        persistOrchestrationRunId: async (watcherId, runId) => {
          const previous = this.requireEnrollment(watcherId)
          const updated = this.requireEnrollments().setOrchestrationRunId(watcherId, runId)
          const runner = this.runners.get(watcherId)
          if (runner) {
            runner.enrollment = updated
          }
          if (previous.orchestrationRunId !== runId) {
            this.append(watcherId, {
              eventId: this.createId(),
              watcherId,
              atMs: this.now(),
              origin: 'owner',
              class: 'fact',
              kind: 'evidence',
              evidenceKind: 'orchestration-run-boundary',
              payload: { runId }
            })
          }
        }
      })
    this.runnerLoop = new WatcherRunnerLoop({
      ledgerStore: runnerLedger,
      budgetClock: budgetClock as RunnerBudgetClock,
      leaseStore,
      orchestration,
      persistEnabled: (enrollment, enabled) => {
        const updated = this.requireEnrollments().setEnabled(enrollment.watcherId, enabled)
        if (isMalformedKindPayloadEnrollment(updated)) {
          throw new Error('A malformed enrollment cannot have an active runner')
        }
        return updated
      },
      notifyApproval: (enrollment, action) =>
        notifyWatcher(
          this.dependencies.store,
          enrollment,
          'Watcher approval requested',
          `${action.kind} is waiting for approval`,
          `approval:${enrollment.watcherId}:${action.kind}`
        ),
      ...(this.dependencies.now ? { now: this.dependencies.now } : {}),
      ...(this.dependencies.createId ? { createId: this.dependencies.createId } : {}),
      ...(this.dependencies.setTimer ? { setTimer: this.dependencies.setTimer } : {}),
      ...(this.dependencies.clearTimer ? { clearTimer: this.dependencies.clearTimer } : {}),
      holderId: this.dependencies.holderId ?? `process-${process.pid}-${randomUUID()}`
    })
    this.loaded = true
    const writable = !database.isReadOnly()
    host.attachPowerMonitor()
    for (const record of enrollments.list()) {
      if (isMalformedKindPayloadEnrollment(record)) {
        this.malformedEnrollments!.record(record, writable)
        continue
      }
      const kind = this.registry.get(record.kind)
      if (!kind) {
        continue
      }
      if (!kind.enrollmentPayloadSchema.safeParse(record.kindPayload).success) {
        this.malformedEnrollments!.record(record, writable)
        continue
      }
      this.restoreRunner(record, kind, writable)
    }
  }

  private restoreRunner(
    enrollment: WatcherEnrollment,
    kind: RegisteredWatcherKind,
    schedule: boolean = true
  ): WatcherRunner {
    const existing = this.runners.get(enrollment.watcherId)
    if (existing) {
      return existing
    }
    const runner = this.requireRunnerLoop().createRunner(enrollment, kind)
    this.runners.set(enrollment.watcherId, runner)
    const hasInFlight =
      getInFlightAttempts(this.requireRunnerLedger().read(enrollment.watcherId)).length > 0
    if (schedule && (enrollment.enabled || hasInFlight)) {
      this.requireRunnerLoop().schedule(runner, 0)
    }
    return runner
  }
  private listEntry(record: EnrollmentRecord): WatcherListEntry {
    const malformed = isMalformedKindPayloadEnrollment(record)
    const enrollment = enrollmentForPresentation(record)
    return watcherListEntry({
      enrollment,
      kind: this.registry.get(enrollment.kind),
      ledger: this.requireRunnerLedger().read(enrollment.watcherId),
      ...(this.runners.get(enrollment.watcherId)
        ? { status: this.runners.get(enrollment.watcherId)!.status }
        : {}),
      malformedPayload: malformed || this.malformedEnrollments!.has(enrollment.watcherId)
    })
  }

  private requireEnrollments(): EnrollmentStore {
    if (!this.enrollments) {
      throw new Error('Heimdall enrollment store is unavailable')
    }
    return this.enrollments
  }

  private requireRunnerLedger(): RunnerLedgerStore {
    if (!this.ledgerStore) {
      throw new Error('Heimdall ledger store is unavailable')
    }
    return runnerLedgerStore(this.ledgerStore)
  }

  private requireRunnerLoop(): WatcherRunnerLoop {
    if (!this.runnerLoop) {
      throw new Error('Heimdall runner is unavailable')
    }
    return this.runnerLoop
  }

  private requireEnrollmentRecord(watcherId: string): EnrollmentRecord {
    const enrollment = this.requireEnrollments().get(watcherId)
    if (!enrollment) {
      throw new Error(`Unknown Heimdall watcher: ${watcherId}`)
    }
    return enrollment
  }

  private requireEnrollment(watcherId: string): WatcherEnrollment {
    const enrollment = this.requireEnrollmentRecord(watcherId)
    if (isMalformedKindPayloadEnrollment(enrollment)) {
      throw new Error(`Heimdall watcher has an invalid persisted kind payload: ${watcherId}`)
    }
    return enrollment
  }

  private requireKind(enrollment: WatcherEnrollment): RegisteredWatcherKind {
    const kind = this.registry.get(enrollment.kind)
    if (!kind) {
      throw new Error(`Unknown Heimdall watcher kind: ${enrollment.kind}`)
    }
    return kind
  }

  private append(watcherId: string, entry: LedgerEntry): void {
    if (entry.watcherId !== watcherId) {
      throw new Error('Ledger watcher envelope mismatch')
    }
    if (!this.ledgerStore) {
      throw new Error('Heimdall ledger store is unavailable')
    }
    this.ledgerStore.append(entry)
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.dependencies.createId?.() ?? randomUUID()
  }
}
