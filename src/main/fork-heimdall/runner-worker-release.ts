import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'

import type { WatcherRunnerActionDependencies } from './runner-actions'
import type { WatcherRunner } from './runner-state'

type WorkerReleaseDependencies = Pick<
  WatcherRunnerActionDependencies,
  'orchestration' | 'ledgerStore' | 'now' | 'createId'
>

export async function releaseEligibleSettledWorkers(
  runner: WatcherRunner,
  dependencies: WorkerReleaseDependencies
): Promise<void> {
  const ledger = dependencies.ledgerStore.read(runner.enrollment.watcherId)
  for (const attempt of getLatestAttempts(ledger)) {
    if (
      attempt.state !== 'settled' ||
      !attempt.dispatchId ||
      runner.kind.concurrency?.retainWorker(attempt, ledger)
    ) {
      continue
    }
    await releaseSettledWorker(runner, attempt.dispatchId, dependencies)
  }
}

export async function releaseSettledWorker(
  runner: WatcherRunner,
  dispatchId: string,
  dependencies: WorkerReleaseDependencies
): Promise<boolean> {
  const ledger = dependencies.ledgerStore.read(runner.enrollment.watcherId)
  const attempt = getLatestAttempts(ledger).find((candidate) => candidate.dispatchId === dispatchId)
  if (attempt && runner.kind.concurrency?.retainWorker(attempt, ledger)) {
    return false
  }
  try {
    const recordedOutcome = workerReleaseOutcome(
      dependencies.ledgerStore.read(runner.enrollment.watcherId),
      dispatchId
    )
    if (recordedOutcome !== null) {
      return recordedOutcome
    }

    const receipt = await dependencies.orchestration.releaseWorker(runner.enrollment, dispatchId)
    appendReleaseEvidence(runner, dependencies, 'worker-terminal-released', {
      dispatchId: receipt.dispatchId,
      state: receipt.state,
      reason: receipt.reason,
      processAction: receipt.processAction
    })
    return receipt.state === 'released' || receipt.state === 'already_released'
  } catch (error) {
    appendReleaseEvidence(runner, dependencies, 'worker-terminal-release-error', {
      dispatchId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  return false
}

export function workerReleaseConfirmed(ledger: WatcherLedger, dispatchId: string): boolean {
  return workerReleaseOutcome(ledger, dispatchId) === true
}

function workerReleaseOutcome(ledger: WatcherLedger, dispatchId: string): boolean | null {
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (
      entry.kind !== 'evidence' ||
      (entry.evidenceKind !== 'worker-terminal-released' &&
        entry.evidenceKind !== 'worker-terminal-release-error')
    ) {
      continue
    }
    const payload = entry.payload
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('dispatchId' in payload) ||
      payload.dispatchId !== dispatchId
    ) {
      continue
    }
    return (
      entry.evidenceKind === 'worker-terminal-released' &&
      'state' in payload &&
      (payload.state === 'released' || payload.state === 'already_released')
    )
  }
  return null
}

function appendReleaseEvidence(
  runner: WatcherRunner,
  dependencies: WorkerReleaseDependencies,
  evidenceKind: 'worker-terminal-released' | 'worker-terminal-release-error',
  payload: unknown
): void {
  try {
    dependencies.ledgerStore.append(runner.enrollment.watcherId, {
      eventId: dependencies.createId(),
      watcherId: runner.enrollment.watcherId,
      atMs: dependencies.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind,
      payload
    })
  } catch {
    // Terminal cleanup is cosmetic; evidence persistence cannot fail reconciliation.
  }
}
