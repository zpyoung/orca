import { homedir } from 'node:os'
import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import {
  WatcherTargetSchema,
  type HeimdallFleetSnapshot,
  type WatcherDetail,
  type WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'
import {
  buildHeimdallDebugReport,
  dormantWatcherStatus,
  type HeimdallDebugReport
} from './debug-report'
import { isMalformedKindPayloadEnrollment, type EnrollmentRecord } from './enrollment-store'
import { enrollmentForPresentation } from './kernel-enrollment'
import { localFleetEntry, sortLocalFleetByAttention } from './local-fleet-projection'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

type KernelReadModelDependencies = {
  ledger: RunnerLedgerStore
  orchestration: HeimdallOrchestrationAdapter
  entry(record: EnrollmentRecord): WatcherListEntry
  runner(watcherId: string): WatcherRunner | null
  owns(record: EnrollmentRecord): boolean
  now(): number
  appVersion(): string
}

export class KernelReadModel {
  constructor(private readonly dependencies: KernelReadModelDependencies) {}
  private lastGeneratedAtMs = -1

  fleet(records: EnrollmentRecord[]): HeimdallFleetSnapshot {
    const generatedAtMs = Math.max(this.dependencies.now(), this.lastGeneratedAtMs + 1)
    this.lastGeneratedAtMs = generatedAtMs
    const entries = records.map((record) =>
      localFleetEntry(
        this.dependencies.entry(record),
        generatedAtMs,
        this.dependencies.owns(record)
      )
    )
    return { entries: sortLocalFleetByAttention(entries), generatedAtMs }
  }

  async detail(untrustedTarget: WatcherTarget, record: EnrollmentRecord): Promise<WatcherDetail> {
    const target = WatcherTargetSchema.parse(untrustedTarget)
    if (target.connectionId !== null || target.pairingRevision !== null) {
      throw new Error('The local Heimdall owner cannot read a remote watcher target')
    }
    const owned = this.dependencies.owns(record)
    const workers =
      owned && !isMalformedKindPayloadEnrollment(record)
        ? await this.dependencies.orchestration.listWorkers(record)
        : []
    return {
      watcher: localFleetEntry(this.dependencies.entry(record), this.dependencies.now(), owned),
      ledger: this.dependencies.ledger.read(record.watcherId),
      traces: this.dependencies.ledger.readTickTraces(record.watcherId),
      workers
    }
  }

  debugReport(record: EnrollmentRecord): HeimdallDebugReport {
    const enrollment = enrollmentForPresentation(record)
    const ledger = this.dependencies.ledger.read(enrollment.watcherId)
    const runner = this.dependencies.runner(enrollment.watcherId)
    return buildHeimdallDebugReport({
      enrollment,
      status: runner
        ? { ...runner.status, budget: deriveBudgetState(ledger, enrollment.budget) }
        : dormantWatcherStatus(enrollment, ledger),
      ledger,
      traces: runner?.traces ?? this.dependencies.ledger.readTickTraces(enrollment.watcherId),
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
      generatedAtMs: this.dependencies.now(),
      appVersion: this.dependencies.appVersion(),
      platform: process.platform,
      homeDirectory: homedir()
    })
  }
}
