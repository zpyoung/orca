import { randomUUID } from 'node:crypto'
import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import {
  WatcherTargetSchema,
  type HeimdallFleetSnapshot,
  type WatcherCommandRequest,
  type WatcherCommandResult,
  type WatcherDetail,
  type WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  EnrollInput,
  EnrollResult,
  WatcherEnrollment,
  WatcherListEntry
} from '../../shared/fork-heimdall/watcher-types'
import { HeimdallBudgetClock } from './budget-clock'
import { HeimdallDatabase } from './database'
import { WatcherControlPlane } from './control-plane'
import type { HeimdallDebugReport } from './debug-report'
import {
  HeimdallEnrollmentStore,
  isMalformedKindPayloadEnrollment,
  type EnrollmentRecord,
  type EnrollmentStore
} from './enrollment-store'
import { enrollmentForPresentation, runnableEnrollment } from './kernel-enrollment'
import { enrollWatcher } from './kernel-enrollment-lifecycle'
import { HeimdallKernelHost } from './kernel-host'
import { watcherListEntry } from './kernel-list-entry'
import type { HeimdallKernelService } from './kernel-service-contract'
import {
  runnerLedgerStore,
  type HeimdallKernelServiceDependencies
} from './kernel-service-dependencies'
import { shutdownHeimdallKernel } from './kernel-shutdown'
import { KernelTerminalTransition } from './kernel-terminal-transition'
import { KernelReadModel } from './kernel-read-model'
import { HeimdallLedgerStore } from './ledger-store'
import { HostRoutedLeaseStore, type LeaseStore } from './lease-store'
import { MalformedEnrollmentLifecycle } from './malformed-enrollment'
import { notifyWatcher } from './notification'
import { RuntimeHeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import { WatcherKindRegistry, type RegisteredWatcherKind } from './registry'
import { WatcherRunnerLoop } from './runner-loop'
import type { RunnerBudgetClock, RunnerLedgerStore, WatcherRunner } from './runner-state'

export type { HeimdallKernelService } from './kernel-service-contract'
export class HeimdallKernelServiceImpl implements HeimdallKernelService {
  private readonly registry = new WatcherKindRegistry()
  private readonly runners = new Map<string, WatcherRunner>()
  private malformedEnrollments: MalformedEnrollmentLifecycle | null = null
  private database: HeimdallDatabase | null = null
  private enrollments: EnrollmentStore | null = null
  private ledgerStore: HeimdallLedgerStore | null = null
  private leaseStore: LeaseStore | null = null
  private readModel: KernelReadModel | null = null
  private host: HeimdallKernelHost | null = null
  private runnerLoop: WatcherRunnerLoop | null = null
  private controlPlane: WatcherControlPlane | null = null
  private terminalTransition: KernelTerminalTransition | null = null
  private readonly subscribers = new Set<() => void>()
  private readonly shutdownListeners = new Set<() => void>()
  private unsubscribeLedger: (() => void) | null = null
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
      if (
        record.kind !== kind.id ||
        this.runners.has(record.watcherId) ||
        !this.ownsEnrollment(record)
      ) {
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
    this.publishChanged()
  }

  async enroll(untrustedInput: EnrollInput): Promise<EnrollResult> {
    this.ensureLoaded()
    return await enrollWatcher(untrustedInput, {
      registry: this.registry,
      storageAuthority: this.storageAuthority(),
      enrollments: this.requireEnrollments(),
      readLedger: (watcherId) => this.requireRunnerLedger().read(watcherId),
      owns: (enrollment) => this.ownsEnrollment(enrollment),
      restore: (enrollment, kind) => this.restoreRunner(enrollment, kind),
      runner: (watcherId) => this.runners.get(watcherId) ?? null,
      acknowledgePark: (watcherId) => this.requireRunnerLoop().acknowledgePark(watcherId),
      entry: (enrollment) => this.listEntry(enrollment),
      schedule: (runner) => this.requireRunnerLoop().schedule(runner, 0),
      publish: () => this.publishChanged(),
      now: () => this.now(),
      createId: () => this.createId()
    })
  }

  async list(): Promise<WatcherListEntry[]> {
    this.ensureLoaded()
    return this.requireEnrollments()
      .list()
      .map((record) => this.listEntry(record))
  }

  async fleet(): Promise<HeimdallFleetSnapshot> {
    this.ensureLoaded()
    return this.requireReadModel().fleet(this.requireEnrollments().list())
  }

  async detail(untrustedTarget: WatcherTarget): Promise<WatcherDetail> {
    this.ensureLoaded()
    const target = WatcherTargetSchema.parse(untrustedTarget)
    return await this.requireReadModel().detail(
      target,
      this.requireEnrollmentRecord(target.watcherId)
    )
  }

  command(request: WatcherCommandRequest): Promise<WatcherCommandResult> {
    this.ensureLoaded()
    if (!this.controlPlane) {
      throw new Error('Heimdall control plane is unavailable')
    }
    return this.controlPlane.command(request)
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  ledger(watcherId: string): WatcherLedger {
    this.ensureLoaded()
    this.requireEnrollmentRecord(watcherId)
    return this.requireRunnerLedger().read(watcherId)
  }
  debugReport(watcherId: string): HeimdallDebugReport {
    this.ensureLoaded()
    return this.requireReadModel().debugReport(this.requireEnrollmentRecord(watcherId))
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

  start(): void {
    if (!this.dependencies.database) {
      const store: unknown = this.dependencies.store
      if (
        typeof store !== 'object' ||
        store === null ||
        !('getProfileStorageDirectory' in store) ||
        typeof store.getProfileStorageDirectory !== 'function'
      ) {
        return
      }
      const directory = store.getProfileStorageDirectory()
      if (typeof directory !== 'string' || directory.length === 0) {
        return
      }
    }
    this.ensureLoaded()
  }

  onShutdown(listener: () => void): () => void {
    this.shutdownListeners.add(listener)
    return () => this.shutdownListeners.delete(listener)
  }

  stopForShutdown(): void {
    if (this.stopped) {
      return
    }
    this.stopped = true
    shutdownHeimdallKernel({
      loaded: this.loaded,
      listeners: this.shutdownListeners,
      subscribers: this.subscribers,
      runners: this.runners.values(),
      runnerLoop: this.runnerLoop,
      leaseStore: this.leaseStore,
      host: this.host,
      unsubscribeLedger: this.unsubscribeLedger,
      database: this.database
    })
    this.unsubscribeLedger = null
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
    this.terminalTransition = new KernelTerminalTransition({
      enrollments,
      ledger: ledgerStore,
      now: () => this.now(),
      createId: () => this.createId()
    })
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
      onStatus: () => this.publishChanged(),
      persistEnabled: (enrollment, enabled) => {
        const updated = this.requireEnrollments().setEnabled(enrollment.watcherId, enabled)
        if (isMalformedKindPayloadEnrollment(updated)) {
          throw new Error('A malformed enrollment cannot have an active runner')
        }
        return updated
      },
      persistTerminal: (runner, fired) =>
        this.requireTerminalTransition().commit(runner.enrollment, fired),
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
    this.controlPlane = new WatcherControlPlane({
      enrollments,
      ledger: ledgerStore,
      lease: leaseStore,
      orchestration,
      runnerLoop: this.requireRunnerLoop(),
      runner: (watcherId) => this.runners.get(watcherId) ?? null,
      owns: (enrollment) => this.ownsEnrollment(enrollment),
      now: () => this.now(),
      createId: () => this.createId(),
      changed: () => this.publishChanged()
    })
    this.readModel = new KernelReadModel({
      ledger: runnerLedger,
      orchestration,
      entry: (record) => this.listEntry(record),
      runner: (watcherId) => this.runners.get(watcherId) ?? null,
      owns: (record) => this.ownsEnrollment(record),
      now: () => this.now(),
      appVersion: () => this.dependencies.appVersion?.() ?? 'unknown'
    })
    this.unsubscribeLedger = ledgerStore.subscribe(() => this.publishChanged())
    const writable = !database.isReadOnly()
    host.attachPowerMonitor()
    for (const record of enrollments.list()) {
      if (!this.ownsEnrollment(record)) {
        continue
      }
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
    enrollment = this.requireTerminalTransition().recover(
      enrollment,
      this.database?.isReadOnly() !== true
    )
    const existing = this.runners.get(enrollment.watcherId)
    if (existing) {
      return existing
    }
    const runner = this.requireRunnerLoop().createRunner(enrollment, kind)
    this.runners.set(enrollment.watcherId, runner)
    const hasInFlight =
      getInFlightAttempts(this.requireRunnerLedger().read(enrollment.watcherId)).length > 0
    if (
      schedule &&
      enrollment.terminalAtMs === null &&
      ((!enrollment.paused && enrollment.enabled) || hasInFlight)
    ) {
      this.requireRunnerLoop().schedule(runner, 0)
    }
    return runner
  }
  private listEntry(record: EnrollmentRecord): WatcherListEntry {
    const malformed = isMalformedKindPayloadEnrollment(record)
    const enrollment = enrollmentForPresentation(record)
    const ledger = this.requireRunnerLedger().read(enrollment.watcherId)
    const runner = this.runners.get(enrollment.watcherId)
    return watcherListEntry({
      enrollment,
      kind: this.registry.get(enrollment.kind),
      ledger,
      ...(runner
        ? {
            status: {
              ...runner.status,
              budget: deriveBudgetState(ledger, enrollment.budget)
            }
          }
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
  private requireTerminalTransition(): KernelTerminalTransition {
    if (!this.terminalTransition) {
      throw new Error('Heimdall terminal transition is unavailable')
    }
    return this.terminalTransition
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

  private requireReadModel(): KernelReadModel {
    if (!this.readModel) {
      throw new Error('Heimdall read model is unavailable')
    }
    return this.readModel
  }

  private ownsEnrollment(enrollment: EnrollmentRecord): boolean {
    return this.storageAuthority() === 'runtime'
      ? enrollment.schedulerOwner === 'remote_host_service'
      : enrollment.schedulerOwner !== 'remote_host_service'
  }

  private storageAuthority(): 'desktop' | 'runtime' {
    return this.dependencies.storageAuthority ?? 'desktop'
  }

  private publishChanged(): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber()
      } catch (error) {
        console.warn('[heimdall] fleet subscriber failed:', error)
      }
    }
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
