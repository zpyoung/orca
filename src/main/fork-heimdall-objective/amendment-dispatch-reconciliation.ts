import type { WatcherCommandResult } from '../../shared/fork-heimdall/fleet-types'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { objectiveLaneForTask } from '../../shared/fork-heimdall-objective/parallel-scheduling'
import { ObjectivePlanTaskSchema } from '../../shared/fork-heimdall-objective/plan-schema'
import { objectiveResultDigest } from './execution-context'
import type { ObjectiveStore } from './objective-store'

/**
 * Stops and discards amendment-invalidated isolated work without guessing across an unverifiable
 * worker stop. An `applying` record is deliberately left to apply recovery: after a crash its
 * commit may already be on the enrolled branch, so it is no longer known to be unapplied work.
 */
export async function reconcileAmendedObjectiveDispatches(args: {
  ledger: WatcherLedger
  objectiveStore: ObjectiveStore
  lease: LeaseGuard
  stopWorker(dispatchId: string): Promise<WatcherCommandResult>
}): Promise<void> {
  const settledDispatchIds = new Set<string>()
  for (const attempt of getLatestAttempts(args.ledger)) {
    if (attempt.state === 'settled' && attempt.dispatchId) {
      settledDispatchIds.add(attempt.dispatchId)
    }
  }
  for (const record of args.objectiveStore.listDispatches(args.ledger.watcherId)) {
    if (record.state === 'applied') {
      const appliedTask = args.objectiveStore.getTask(record.revisionId, record.taskKey)
      const taskUnchanged =
        appliedTask !== null &&
        objectiveResultDigest(ObjectivePlanTaskSchema.parse(appliedTask)) === record.planTaskDigest
      const currentPlan = args.objectiveStore.getPlan(record.revisionId)
      const currentLane = currentPlan
        ? objectiveLaneForTask(
            currentPlan.map((task) => ({
              taskKey: task.taskKey,
              deps: task.deps,
              state: 'pending' as const
            })),
            record.taskKey
          )
        : null
      if (!taskUnchanged || currentLane?.taskKeys.join('\0') !== record.laneTaskKeys.join('\0')) {
        const taskIndex = record.laneTaskKeys.indexOf(record.taskKey)
        await args.lease.assertHeld()
        args.objectiveStore.saveDispatch({
          ...record,
          laneTaskKeys:
            taskIndex === -1 ? [record.taskKey] : record.laneTaskKeys.slice(0, taskIndex + 1)
        })
      }
      continue
    }
    if (record.state === 'failed' || record.state === 'discarded' || record.state === 'applying') {
      continue
    }
    const currentTask = args.objectiveStore.getTask(record.revisionId, record.taskKey)
    if (
      currentTask &&
      objectiveResultDigest(ObjectivePlanTaskSchema.parse(currentTask)) === record.planTaskDigest
    ) {
      continue
    }
    if (
      record.dispatchId &&
      !settledDispatchIds.has(record.dispatchId) &&
      (record.state === 'running' || record.state === 'resolving-conflict')
    ) {
      await args.lease.assertHeld()
      const stopped = await args.stopWorker(record.dispatchId)
      await args.lease.assertHeld()
      if (stopped.status !== 'applied') {
        continue
      }
    }
    await args.lease.assertHeld()
    args.objectiveStore.saveDispatch({
      ...record,
      state: 'discarded',
      setupState: 'retained',
      completedAtMs: record.completedAtMs ?? Date.now()
    })
  }
}
