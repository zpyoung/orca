import { randomUUID } from 'node:crypto'
import type { WatcherEnrollment, WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'
import { HeimdallBudgetClock } from './budget-clock'
import { HeimdallDatabase } from './database'
import { WatcherControlPlane } from './control-plane'
import {
  HeimdallEnrollmentStore,
  isMalformedKindPayloadEnrollment,
  type EnrollmentRecord,
  type EnrollmentStore
} from './enrollment-store'
import { authorizeKindEnrollment, runnableEnrollment } from './kernel-enrollment'
import { HeimdallKernelHost } from './kernel-host'
import { KernelReadModel } from './kernel-read-model'
import type { HeimdallKernelServiceDependencies } from './kernel-service-dependencies'
import { runnerLedgerStore } from './kernel-service-dependencies'
import { KernelTerminalTransition } from './kernel-terminal-transition'
import { HeimdallLedgerStore } from './ledger-store'
import { HostRoutedLeaseStore, type LeaseStore } from './lease-store'
import { MalformedEnrollmentLifecycle } from './malformed-enrollment'
import { notifyWatcher } from './notification'
import { mintCoordinatorIdentity } from './orchestration/coordinator-identity'
import { RuntimeHeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import type { RegisteredWatcherKind, WatcherKindRegistry } from './registry'
import { WatcherRunnerLoop } from './runner-loop'
import { createStallCauseJudge } from './judgment/stall-cause-judge'
import type { JudgmentPersistencePort } from './judgment/store'
import type { RunnerBudgetClock, WatcherRunner } from './runner-state'

export type HeimdallKernelServiceBootContext = {
  registry: WatcherKindRegistry
  runners: Map<string, WatcherRunner>
  now: () => number
  createId: () => string
  storageAuthority: () => 'desktop' | 'runtime'
  publishChanged: () => void
  onSuspend: () => void
  onResume: () => void
  activateHandoff: (sitter: WatcherEnrollment, kind: RegisteredWatcherKind) => void
  listEntry: (record: EnrollmentRecord) => WatcherListEntry
  judgmentPersistence: () => JudgmentPersistencePort
}

export type HeimdallKernelServiceBoot = {
  database: HeimdallDatabase
  enrollments: EnrollmentStore
  ledgerStore: HeimdallLedgerStore
  leaseStore: LeaseStore
  host: HeimdallKernelHost
  terminalTransition: KernelTerminalTransition
  malformedEnrollments: MalformedEnrollmentLifecycle
  runnerLoop: WatcherRunnerLoop
  controlPlane: WatcherControlPlane
  readModel: KernelReadModel
}

function ownsEnrollment(
  storageAuthority: 'desktop' | 'runtime',
  enrollment: EnrollmentRecord
): boolean {
  return storageAuthority === 'runtime'
    ? enrollment.schedulerOwner === 'remote_host_service'
    : enrollment.schedulerOwner !== 'remote_host_service'
}

function requireLiveEnrollment(enrollments: EnrollmentStore, watcherId: string): WatcherEnrollment {
  const record = enrollments.get(watcherId)
  if (!record) {
    throw new Error(`Unknown Heimdall watcher: ${watcherId}`)
  }
  if (isMalformedKindPayloadEnrollment(record)) {
    throw new Error(`Heimdall watcher has an invalid persisted kind payload: ${watcherId}`)
  }
  return record
}

/** Builds the kernel service's dependency graph; extracted so kernel-service.ts stays under the line budget. */
export function bootHeimdallKernelService(
  dependencies: HeimdallKernelServiceDependencies,
  context: HeimdallKernelServiceBootContext
): HeimdallKernelServiceBoot {
  const database =
    dependencies.database ??
    new HeimdallDatabase(() => dependencies.store.getProfileStorageDirectory())
  const enrollments = dependencies.enrollmentStore ?? new HeimdallEnrollmentStore(database)
  const ledgerStore = dependencies.ledgerStore ?? new HeimdallLedgerStore(database)
  const budgetClock = dependencies.budgetClock ?? new HeimdallBudgetClock(ledgerStore)
  const host = new HeimdallKernelHost(
    dependencies.runtime,
    (key) => runnableEnrollment(enrollments.findLiveByWorkspace(key)),
    context.onSuspend,
    context.onResume
  )
  const leaseStore =
    dependencies.leaseStore ??
    new HostRoutedLeaseStore({ resolveTarget: (key) => host.resolveLeaseTarget(key) })

  const runnerLedger = runnerLedgerStore(ledgerStore)
  const terminalTransition = new KernelTerminalTransition({
    enrollments,
    ledger: ledgerStore,
    now: context.now,
    createId: context.createId,
    authorize: (input) =>
      authorizeKindEnrollment(context.registry, input, context.storageAuthority()),
    mintCoordinatorIdentity,
    readLedger: (watcherId) => runnerLedger.read(watcherId)
  })
  const malformedEnrollments = new MalformedEnrollmentLifecycle({
    enrollments,
    readLedger: (watcherId) => runnerLedger.read(watcherId),
    appendLedger: (watcherId, entry) => runnerLedger.append(watcherId, entry),
    now: context.now,
    createId: context.createId
  })
  const orchestration =
    dependencies.orchestration ??
    new RuntimeHeimdallOrchestrationAdapter(dependencies.runtime, {
      persistOrchestrationRunId: async (watcherId, runId) => {
        const previous = requireLiveEnrollment(enrollments, watcherId)
        const updated = enrollments.setOrchestrationRunId(watcherId, runId)
        const runner = context.runners.get(watcherId)
        if (runner) {
          runner.enrollment = updated
        }
        if (previous.orchestrationRunId !== runId) {
          ledgerStore.append({
            eventId: context.createId(),
            watcherId,
            atMs: context.now(),
            origin: 'owner',
            class: 'fact',
            kind: 'evidence',
            evidenceKind: 'orchestration-run-boundary',
            payload: { runId }
          })
        }
      }
    })
  const runnerLoop = new WatcherRunnerLoop({
    ledgerStore: runnerLedger,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: BudgetClock and RunnerBudgetClock are deliberately separate module-boundary interfaces with equivalent handle/method shapes (IntervalHandle vs DispatchIntervalHandle); bridging them is this wiring's job.
    budgetClock: budgetClock as RunnerBudgetClock,
    leaseStore,
    orchestration,
    owner: {
      runtime: dependencies.runtime,
      resolveWorkspaceTarget: (key) => host.resolveLeaseTarget(key),
      ensureRun: (enrollment) => orchestration.ensureRun(enrollment)
    },
    stallCause: createStallCauseJudge(context.judgmentPersistence(), context.storageAuthority),
    onStatus: () => context.publishChanged(),
    persistEnabled: (enrollment, enabled) => {
      const updated = enrollments.setEnabled(enrollment.watcherId, enabled)
      if (isMalformedKindPayloadEnrollment(updated)) {
        throw new Error('A malformed enrollment cannot have an active runner')
      }
      return updated
    },
    persistTerminal: (runner, fired) =>
      terminalTransition.terminate(runner, fired, (sitter, kind) =>
        context.activateHandoff(sitter, kind)
      ),
    readEnrollment: (watcherId) => {
      const record = enrollments.get(watcherId)
      if (!record || isMalformedKindPayloadEnrollment(record)) {
        return null
      }
      return record
    },
    notifyApproval: (enrollment, action) =>
      notifyWatcher(
        dependencies.store,
        enrollment,
        'Watcher approval requested',
        `${action.kind} is waiting for approval`,
        `approval:${enrollment.watcherId}:${action.kind}`
      ),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.createId ? { createId: dependencies.createId } : {}),
    ...(dependencies.setTimer ? { setTimer: dependencies.setTimer } : {}),
    ...(dependencies.clearTimer ? { clearTimer: dependencies.clearTimer } : {}),
    holderId: dependencies.holderId ?? `process-${process.pid}-${randomUUID()}`
  })
  const controlPlane = new WatcherControlPlane({
    enrollments,
    ledger: ledgerStore,
    lease: leaseStore,
    orchestration,
    runnerLoop,
    runner: (watcherId) => context.runners.get(watcherId) ?? null,
    removeRunner: (watcherId) => {
      context.runners.delete(watcherId)
    },
    purgeKindData: async (enrollment) => {
      const kind = context.registry.get(enrollment.kind)
      if (!kind) {
        throw new Error(`Unknown Heimdall watcher kind: ${enrollment.kind}`)
      }
      await kind.purge?.(enrollment.watcherId)
    },
    owns: (enrollment) => ownsEnrollment(context.storageAuthority(), enrollment),
    now: context.now,
    createId: context.createId,
    changed: () => context.publishChanged()
  })
  const readModel = new KernelReadModel({
    ledger: runnerLedger,
    orchestration,
    entry: context.listEntry,
    runner: (watcherId) => context.runners.get(watcherId) ?? null,
    kind: (record) => context.registry.get(record.kind),
    isMalformedPayload: (record) =>
      isMalformedKindPayloadEnrollment(record) || malformedEnrollments.has(record.watcherId),
    owns: (record) => ownsEnrollment(context.storageAuthority(), record),
    store: dependencies.store,
    databasePath: () => database.databasePath(),
    currentBudgetInterval: (watcherId) => budgetClock.current(watcherId),
    hasPendingControlOperation: (watcherId) => controlPlane.hasPendingOperation(watcherId),
    leaseLocation: (record) => leaseStore.describeLocation?.(record.workspaceKey) ?? null,
    now: context.now,
    appVersion: () => dependencies.appVersion?.() ?? 'unknown'
  })

  return {
    database,
    enrollments,
    ledgerStore,
    leaseStore,
    host,
    terminalTransition,
    malformedEnrollments,
    runnerLoop,
    controlPlane,
    readModel
  }
}
