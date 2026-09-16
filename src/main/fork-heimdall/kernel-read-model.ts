import { homedir } from 'node:os'
import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import {
  WatcherTargetSchema,
  type HeimdallFleetSnapshot,
  type WatcherDetail,
  type WatcherTarget,
  type WatcherWorker
} from '../../shared/fork-heimdall/fleet-types'
import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'
import type { Store } from '../persistence'
import {
  buildHeimdallDebugReport,
  collapseWatcherHomeDirectory,
  describeDebugSnapshot,
  dormantWatcherStatus,
  type DebugPointer,
  type HeimdallDebugReport
} from './debug-report'
import { isMalformedKindPayloadEnrollment, type EnrollmentRecord } from './enrollment-store'
import { enrollmentForPresentation } from './kernel-enrollment'
import { localFleetEntry, sortLocalFleetByAttention } from './local-fleet-projection'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import type { LeaseLocationDescription } from './lease-store'
import type { RegisteredWatcherKind } from './registry'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

type KernelReadModelDependencies = {
  ledger: RunnerLedgerStore
  orchestration: HeimdallOrchestrationAdapter
  entry(record: EnrollmentRecord): WatcherListEntry
  runner(watcherId: string): WatcherRunner | null
  kind(record: EnrollmentRecord): RegisteredWatcherKind | null
  isMalformedPayload(record: EnrollmentRecord): boolean
  owns(record: EnrollmentRecord): boolean
  store: Store
  databasePath(): string
  currentBudgetInterval(watcherId: string): { intervalId: string } | null
  hasPendingControlOperation(watcherId: string): boolean
  leaseLocation(record: EnrollmentRecord): LeaseLocationDescription | null
  now(): number
  appVersion(): string
}

function readFleetWorkspaceLabel(store: Store, record: EnrollmentRecord): string | null {
  return record.worktreeId === null
    ? (store.getRepo(record.repoId)?.displayName ?? null)
    : (store.getWorktreeMetaForHost(record.worktreeId, record.executionHostId)?.displayName ?? null)
}

export class KernelReadModel {
  constructor(private readonly dependencies: KernelReadModelDependencies) {}
  private lastGeneratedAtMs = -1

  fleet(records: EnrollmentRecord[]): HeimdallFleetSnapshot {
    const generatedAtMs = Math.max(this.dependencies.now(), this.lastGeneratedAtMs + 1)
    this.lastGeneratedAtMs = generatedAtMs
    const entries = records.map((record) => {
      const runner = this.dependencies.runner(record.watcherId)
      return localFleetEntry(
        this.dependencies.entry(record),
        generatedAtMs,
        this.dependencies.owns(record),
        {
          ledger: this.dependencies.ledger.read(record.watcherId),
          traces: runner?.traces ?? this.dependencies.ledger.readTickTraces(record.watcherId),
          workspaceLabel: readFleetWorkspaceLabel(this.dependencies.store, record)
        }
      )
    })
    return { entries: sortLocalFleetByAttention(entries), generatedAtMs }
  }

  async detail(untrustedTarget: WatcherTarget, record: EnrollmentRecord): Promise<WatcherDetail> {
    const target = WatcherTargetSchema.parse(untrustedTarget)
    if (target.connectionId !== null || target.pairingRevision !== null) {
      throw new Error('The local Heimdall owner cannot read a remote watcher target')
    }
    const owned = this.dependencies.owns(record)
    const workers = (await this.readWorkers(record)).workers
    const ledger = this.dependencies.ledger.read(record.watcherId)
    const traces = this.dependencies.ledger.readTickTraces(record.watcherId)
    return {
      watcher: localFleetEntry(this.dependencies.entry(record), this.dependencies.now(), owned, {
        ledger,
        traces,
        workspaceLabel: readFleetWorkspaceLabel(this.dependencies.store, record)
      }),
      ledger,
      traces,
      workers
    }
  }

  async debugReport(record: EnrollmentRecord): Promise<HeimdallDebugReport> {
    const enrollment = enrollmentForPresentation(record)
    const ledger = this.dependencies.ledger.read(enrollment.watcherId)
    const runner = this.dependencies.runner(enrollment.watcherId)
    const traces = runner?.traces ?? this.dependencies.ledger.readTickTraces(enrollment.watcherId)
    let latestObservedLeaseEpoch: number | null = null
    let latestObservedLeaseSequence = -1
    for (const trace of traces) {
      if (
        trace.leaseEpoch !== null &&
        trace.leaseEpoch > 0 &&
        trace.seq > latestObservedLeaseSequence
      ) {
        latestObservedLeaseEpoch = trace.leaseEpoch
        latestObservedLeaseSequence = trace.seq
      }
    }
    const malformedPayload = this.dependencies.isMalformedPayload(record)
    const kind = malformedPayload ? null : (runner?.kind ?? this.dependencies.kind(record))
    const workerRead = await this.readWorkers(record)
    const homeDirectory = homedir()
    const pointers: DebugPointer[] = [
      {
        role: 'kernel-database',
        host: 'kernel',
        path: collapseWatcherHomeDirectory(this.dependencies.databasePath(), homeDirectory),
        status: 'resolved'
      },
      {
        role: 'workspace',
        host: enrollment.executionHostId,
        path:
          enrollment.executionHostId === 'local'
            ? collapseWatcherHomeDirectory(enrollment.workspacePath, homeDirectory)
            : enrollment.workspacePath,
        status: 'resolved'
      }
    ]
    if (kind?.debug?.pointers) {
      try {
        pointers.push(
          ...kind.debug.pointers(enrollment).map((pointer) => ({
            ...pointer,
            path:
              pointer.host === 'kernel' || pointer.host === 'local'
                ? collapseWatcherHomeDirectory(pointer.path, homeDirectory)
                : pointer.path
          }))
        )
      } catch (error) {
        pointers.push({
          role: 'kind-database',
          host: 'kernel',
          path: '',
          status: 'unresolved',
          detail: `Kind pointer lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        })
      }
    }
    const leaseLocation = this.dependencies.leaseLocation(record)
    const activeLeaseEpoch = runner?.leaseGuard?.epoch ?? null
    const leaseEpoch = activeLeaseEpoch ?? latestObservedLeaseEpoch
    const usingObservedLeaseEpoch = activeLeaseEpoch === null && leaseEpoch !== null
    if (leaseLocation && leaseEpoch !== null) {
      const separator = leaseLocation.pathSeparator
      const leaseDirectory = leaseLocation.leaseDirectory.endsWith(separator)
        ? leaseLocation.leaseDirectory.slice(0, -separator.length)
        : leaseLocation.leaseDirectory
      const holderPath = `${leaseDirectory}${separator}epoch-${leaseEpoch}${separator}holder.json`
      pointers.push({
        role: 'lease-holder',
        host: leaseLocation.executionHostId,
        path:
          leaseLocation.executionHostId === 'local'
            ? collapseWatcherHomeDirectory(holderPath, homeDirectory)
            : holderPath,
        status: 'resolved',
        ...(usingObservedLeaseEpoch
          ? { detail: 'Last observed lease epoch; current ownership not verified' }
          : {})
      })
    } else {
      const unresolvedHost = leaseLocation?.executionHostId ?? enrollment.executionHostId
      const unresolvedPath = leaseLocation?.leaseDirectory ?? enrollment.workspacePath
      pointers.push({
        role: 'lease-holder',
        host: unresolvedHost,
        path:
          unresolvedHost === 'local'
            ? collapseWatcherHomeDirectory(unresolvedPath, homeDirectory)
            : unresolvedPath,
        status: 'unresolved',
        detail: leaseLocation
          ? 'No active lease epoch is known'
          : 'Lease location is not cached; no host resolution was attempted'
      })
    }
    return buildHeimdallDebugReport({
      enrollment,
      status: runner
        ? { ...runner.status, budget: deriveBudgetState(ledger, enrollment.budget) }
        : malformedPayload
          ? this.dependencies.entry(record).status
          : dormantWatcherStatus(enrollment, ledger),
      ledger,
      traces,
      runner: runner
        ? {
            kindId: runner.kind.id,
            consecutiveErrors: runner.consecutiveErrors,
            lastFullResyncAtMs: runner.lastFullResyncAtMs,
            tickQueued: runner.tickQueued,
            reconcileAgain: runner.reconcileAgain,
            timerArmed: runner.timer !== null,
            actionInFlight: getInFlightAttempts(ledger).length > 0,
            leaseEpoch: activeLeaseEpoch,
            stopped: runner.stopped,
            suspended: runner.suspended,
            controlPending: runner.controlPending,
            recovered: runner.recovered,
            forceFresh: runner.forceFresh,
            traceSequence: runner.traceSequence,
            leaseRenewalArmed: runner.leaseRenewal !== null,
            snapshot: runner.lastSnapshot
              ? describeDebugSnapshot(runner.lastSnapshot, (snapshot) =>
                  runner.kind.describeSnapshot(snapshot)
                )
              : null
          }
        : null,
      generatedAtMs: this.dependencies.now(),
      appVersion: this.dependencies.appVersion(),
      platform: process.platform,
      homeDirectory,
      budgetClock: {
        openIntervalId:
          this.dependencies.currentBudgetInterval(enrollment.watcherId)?.intervalId ?? null
      },
      malformedPayload,
      pendingControlOperation: this.dependencies.hasPendingControlOperation(enrollment.watcherId),
      workers: workerRead.workers,
      workersError: workerRead.error,
      pointers
    })
  }

  private async readWorkers(
    record: EnrollmentRecord
  ): Promise<{ workers: WatcherWorker[]; error: string | null }> {
    if (
      !this.dependencies.owns(record) ||
      this.dependencies.isMalformedPayload(record) ||
      isMalformedKindPayloadEnrollment(record)
    ) {
      return { workers: [], error: null }
    }
    try {
      return { workers: await this.dependencies.orchestration.listWorkers(record), error: null }
    } catch (error) {
      return {
        workers: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
