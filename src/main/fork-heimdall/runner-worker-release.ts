import type { WatcherRunnerActionDependencies } from './runner-actions'
import type { WatcherRunner } from './runner-state'

type WorkerReleaseDependencies = Pick<
  WatcherRunnerActionDependencies,
  'orchestration' | 'ledgerStore' | 'now' | 'createId'
>

export async function releaseSettledWorker(
  runner: WatcherRunner,
  dispatchId: string,
  dependencies: WorkerReleaseDependencies
): Promise<void> {
  try {
    const cleanupRecorded = dependencies.ledgerStore
      .read(runner.enrollment.watcherId)
      .entries.some((entry) => {
        if (
          entry.kind !== 'evidence' ||
          (entry.evidenceKind !== 'worker-terminal-released' &&
            entry.evidenceKind !== 'worker-terminal-release-error')
        ) {
          return false
        }
        const payload = entry.payload
        return (
          typeof payload === 'object' &&
          payload !== null &&
          'dispatchId' in payload &&
          payload.dispatchId === dispatchId
        )
      })
    if (cleanupRecorded) {
      return
    }

    const receipt = await dependencies.orchestration.releaseWorker(runner.enrollment, dispatchId)
    appendReleaseEvidence(runner, dependencies, 'worker-terminal-released', {
      dispatchId: receipt.dispatchId,
      state: receipt.state,
      reason: receipt.reason,
      processAction: receipt.processAction
    })
  } catch (error) {
    appendReleaseEvidence(runner, dependencies, 'worker-terminal-release-error', {
      dispatchId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
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
