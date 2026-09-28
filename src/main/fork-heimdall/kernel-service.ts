import { randomUUID } from 'node:crypto'
import { HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND } from '../../shared/fork-heimdall/budget'
import { hasPendingAttemptOutcome } from '../../shared/fork-heimdall/ledger-queries'
import type {
  KernelAction,
  SubmissionPreflightResult,
  WatcherKind
} from '../../shared/fork-heimdall/kind-contract'
import {
  WatcherTargetSchema,
  type HeimdallFleetSnapshot,
  type WatcherCommandRequest,
  type WatcherCommandResult,
  type WatcherDetail,
  type WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  EnrollInput,
  EnrollResult,
  WatcherEnrollment,
  WatcherListEntry
} from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallDatabase } from './database'
import type { WatcherControlPlane } from './control-plane'
import { durableWatcherBudget, type HeimdallDebugReport } from './debug-report'
import {
  isMalformedKindPayloadEnrollment,
  type EnrollmentRecord,
  type EnrollmentStore
} from './enrollment-store'
import { enrollmentForPresentation } from './kernel-enrollment'
import { enrollWatcher } from './kernel-enrollment-lifecycle'
import type { HeimdallKernelHost } from './kernel-host'
import { watcherListEntry } from './kernel-list-entry'
import type {
  HeimdallKernelService,
  HeimdallOrchestrationSubmission
} from './kernel-service-contract'
import { preflightKernelSubmission } from './kernel-submission-preflight'
import {
  runnerLedgerStore,
  type HeimdallKernelServiceDependencies
} from './kernel-service-dependencies'
import { hasKernelStorage, wakeHeimdallMailboxRunners } from './kernel-runtime-lifecycle'
import { bootHeimdallKernelService } from './kernel-service-boot'
import { shutdownHeimdallKernel } from './kernel-shutdown'
import { setHeimdallMailboxWake } from './mailbox-wake-registry'
import type { KernelTerminalTransition } from './kernel-terminal-transition'
import type { KernelReadModel } from './kernel-read-model'
import type { HeimdallLedgerStore } from './ledger-store'
import type { JudgmentPersistencePort } from './judgment/store'
import type { LeaseStore } from './lease-store'
import type { MalformedEnrollmentLifecycle } from './malformed-enrollment'
import { drainPendingKindPurges } from './pending-kind-purge'
import { WatcherKindRegistry, type RegisteredWatcherKind } from './registry'
import type { WatcherRunnerLoop } from './runner-loop'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

export type { HeimdallKernelService } from './kernel-service-contract'

function eraseWatcherKind<TWorld, TAction extends KernelAction, TResult>(
  kind: WatcherKind<TWorld, TAction, TResult>
): RegisteredWatcherKind {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: type-erases a specific WatcherKind<TWorld, TAction, TResult> for storage in the heterogeneous kind registry; every reader narrows it back through KernelAction.
  return kind as RegisteredWatcherKind
}

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
  private readonly drainedShutdownListeners = new Set<() => void>()
  private unsubscribeLedger: (() => void) | null = null
  private loaded = false
  private stopped = false
  private shutdownPromise: Promise<void> | null = null
  private readonly onSuspend = (): void => this.suspend()
  private readonly onResume = (): void => this.resume()

  constructor(private readonly dependencies: HeimdallKernelServiceDependencies) {}

  registerKind<TWorld, TAction extends KernelAction, TResult>(
    kind: WatcherKind<TWorld, TAction, TResult>
  ): void {
    this.registry.register(eraseWatcherKind(kind))
    if (!this.loaded) {
      return
    }
    if (this.database?.isReadOnly() !== true) {
      void drainPendingKindPurges(this.requireEnrollments(), this.registry, kind.id)
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
      this.restoreRunner(record, eraseWatcherKind(kind), this.database?.isReadOnly() !== true)
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
      appendBudgetGeneration: (watcherId) => {
        this.requireRunnerLedger().append(watcherId, {
          eventId: this.createId(),
          watcherId,
          atMs: this.now(),
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND,
          payload: { reason: 're-enrollment-after-explicit-disarm' }
        })
      },
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

  async preflightSubmission(
    submission: HeimdallOrchestrationSubmission
  ): Promise<SubmissionPreflightResult> {
    this.ensureLoaded()
    return await preflightKernelSubmission(submission, {
      enrollments: this.requireEnrollments(),
      runners: this.runners,
      ledgerStore: this.requireRunnerLedger(),
      host: this.requireHost(),
      ownsEnrollment: (enrollment) => this.ownsEnrollment(enrollment)
    })
  }

  judgmentPersistence(): JudgmentPersistencePort {
    return {
      databasePath: () => {
        this.ensureLoaded()
        if (!this.database) {
          throw new Error('Heimdall database is unavailable')
        }
        return this.database.databasePath()
      },
      read: (watcherId) => this.ledger(watcherId),
      append: (entry, options) => {
        this.ensureLoaded()
        this.requireEnrollmentRecord(entry.watcherId)
        return this.requireLedgerStore().append(entry, options)
      }
    }
  }
  async debugReport(watcherId: string): Promise<HeimdallDebugReport> {
    this.ensureLoaded()
    return await this.requireReadModel().debugReport(this.requireEnrollmentRecord(watcherId))
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
    if (!hasKernelStorage(this.dependencies)) {
      return
    }
    this.ensureLoaded()
    setHeimdallMailboxWake((address) => this.wakeRunnersForMailbox(address))
  }

  private wakeRunnersForMailbox(address: string): void {
    wakeHeimdallMailboxRunners({
      address,
      runners: this.runners.values(),
      ledgerStore: this.requireRunnerLedger(),
      runnerLoop: this.requireRunnerLoop()
    })
  }

  onShutdown(listener: () => void, phase: 'start' | 'drained' = 'start'): () => void {
    const listeners = phase === 'drained' ? this.drainedShutdownListeners : this.shutdownListeners
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  stopForShutdown(): Promise<void> {
    if (this.shutdownPromise || this.stopped) {
      return this.shutdownPromise ?? Promise.resolve()
    }
    this.stopped = true
    setHeimdallMailboxWake(null)
    this.shutdownPromise = shutdownHeimdallKernel({
      loaded: this.loaded,
      listeners: this.shutdownListeners,
      drainedListeners: this.drainedShutdownListeners,
      subscribers: this.subscribers,
      runners: this.runners.values(),
      runnerLoop: this.runnerLoop,
      leaseStore: this.leaseStore,
      host: this.host,
      unsubscribeLedger: this.unsubscribeLedger,
      database: this.database
    }).finally(() => {
      this.unsubscribeLedger = null
    })
    return this.shutdownPromise
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
    const boot = bootHeimdallKernelService(this.dependencies, {
      registry: this.registry,
      runners: this.runners,
      now: () => this.now(),
      createId: () => this.createId(),
      storageAuthority: () => this.storageAuthority(),
      publishChanged: () => this.publishChanged(),
      onSuspend: this.onSuspend,
      onResume: this.onResume,
      activateHandoff: (sitter, kind) => this.activateHandoff(sitter, kind),
      listEntry: (record) => this.listEntry(record),
      judgmentPersistence: () => this.judgmentPersistence()
    })
    this.database = boot.database
    this.enrollments = boot.enrollments
    this.ledgerStore = boot.ledgerStore
    this.leaseStore = boot.leaseStore
    this.host = boot.host
    this.terminalTransition = boot.terminalTransition
    this.malformedEnrollments = boot.malformedEnrollments
    this.runnerLoop = boot.runnerLoop
    this.controlPlane = boot.controlPlane
    this.readModel = boot.readModel
    this.loaded = true
    this.unsubscribeLedger = boot.ledgerStore.subscribe(() => this.publishChanged())
    const writable = !boot.database.isReadOnly()
    if (writable) {
      void drainPendingKindPurges(boot.enrollments, this.registry)
    }
    boot.host.attachPowerMonitor()
    for (const record of boot.enrollments.list()) {
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
    const hasPendingOutcome = hasPendingAttemptOutcome(
      this.requireRunnerLedger().read(enrollment.watcherId)
    )
    if (
      schedule &&
      enrollment.terminalAtMs === null &&
      ((!enrollment.paused && enrollment.enabled) || hasPendingOutcome)
    ) {
      this.requireRunnerLoop().schedule(runner, 0)
    }
    return runner
  }

  private activateHandoff(sitter: WatcherEnrollment, kind: RegisteredWatcherKind): void {
    this.restoreRunner(sitter, kind)
    this.publishChanged()
  }

  private listEntry(record: EnrollmentRecord): WatcherListEntry {
    const malformed = isMalformedKindPayloadEnrollment(record)
    const enrollment = enrollmentForPresentation(record)
    const runnerLedger = this.requireRunnerLedger()
    const ledger = runnerLedger.read(enrollment.watcherId)
    const terminalSummary = runnerLedger.readTerminalSummary(enrollment.watcherId)
    const runner = this.runners.get(enrollment.watcherId)
    return watcherListEntry({
      enrollment,
      kind: this.registry.get(enrollment.kind),
      ledger,
      terminalSummary,
      ...(runner
        ? {
            status: {
              ...runner.status,
              budget: durableWatcherBudget(enrollment, ledger, terminalSummary)
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

  private requireLedgerStore(): HeimdallLedgerStore {
    if (!this.ledgerStore) {
      throw new Error('Heimdall ledger store is unavailable')
    }
    return this.ledgerStore
  }

  private requireRunnerLedger(): RunnerLedgerStore {
    return runnerLedgerStore(this.requireLedgerStore())
  }

  private requireRunnerLoop(): WatcherRunnerLoop {
    if (!this.runnerLoop) {
      throw new Error('Heimdall runner is unavailable')
    }
    return this.runnerLoop
  }

  private requireHost(): HeimdallKernelHost {
    if (!this.host) {
      throw new Error('Heimdall kernel host is unavailable')
    }
    return this.host
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

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.dependencies.createId?.() ?? randomUUID()
  }
}
