import { randomUUID } from 'node:crypto'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import { OWNER_INTERVENTION_CAPABILITY } from '../../../shared/fork-heimdall/owner/owner-capability'
import { decodeOwnerDeviation, findOldestOpenOwnerDeviation } from './deviation-ledger'
import type { WatcherParkReason } from '../../../shared/fork-heimdall/watcher-types'
import type { WatcherRunnerActions } from '../runner-actions'
import type { WatcherRunner, WatcherRunnerDependencies } from '../runner-state'
import { driveOwnerDeviation } from './deviation-routing'
import { deviationIsDispatchScoped } from './deviation-scope'

type OwnedDependencies = Pick<
  WatcherRunnerDependencies,
  'owner' | 'budgetClock' | 'ledgerStore' | 'orchestration' | 'now' | 'createId'
>

/** Assembles `driveOwnerDeviation`'s dependencies from the runner loop's own and runs one step. */
export async function runOwnerDeviationTick(args: {
  dependencies: OwnedDependencies
  actions: Pick<WatcherRunnerActions, 'execute' | 'recordGateRejection'>
  statusLifecycle: { park(runner: WatcherRunner, reason: WatcherParkReason): void }
  runner: WatcherRunner
  snapshot: Snapshot<unknown>
}): Promise<boolean> {
  const deps = args.dependencies
  if (!deps.owner) {
    return false
  }
  const now = () => deps.now?.() ?? Date.now()
  const existingEventIds = new Set(
    deps.ledgerStore.read(args.runner.enrollment.watcherId).entries.map((entry) => entry.eventId)
  )
  const outcome = await driveOwnerDeviation(
    {
      owner: deps.owner,
      actions: args.actions,
      budgetClock: deps.budgetClock,
      ledgerRecord: {
        ledgerStore: deps.ledgerStore,
        now,
        createId: () => deps.createId?.() ?? randomUUID()
      },
      answerWorkerQuestion: (messageId, answer) =>
        deps.orchestration.answerQuestion(args.runner.enrollment, messageId, answer),
      stopWorker: (dispatchId) => deps.orchestration.stopWorker(args.runner.enrollment, dispatchId),
      park: (reason) => args.statusLifecycle.park(args.runner, reason)
    },
    args.runner,
    args.snapshot
  )
  if (outcome !== 'handled') {
    return false
  }
  const currentLedger = deps.ledgerStore.read(args.runner.enrollment.watcherId)
  const ownerActed = currentLedger.entries.some(
    (entry) =>
      !existingEventIds.has(entry.eventId) &&
      entry.kind === 'attempt' &&
      entry.action.capability === OWNER_INTERVENTION_CAPABILITY
  )
  if (ownerActed) {
    return true
  }
  const pending = findOldestOpenOwnerDeviation(currentLedger)
  const deviation = pending ? decodeOwnerDeviation(pending) : null
  return deviation !== null && !deviationIsDispatchScoped(deviation, args.runner, currentLedger)
}
