import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { KindConcurrencyPolicy, KernelAction } from '../../shared/fork-heimdall/kind-contract'
import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import { objectiveParallelSlotState } from '../../shared/fork-heimdall-objective/parallel-scheduling'
import { objectiveHasPendingDrain } from '../../shared/fork-heimdall-objective/stop-policy'
import { requireObjectiveSnapshotBinding, type ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'

type Policy = KindConcurrencyPolicy<ObjectiveWorld, ObjectiveAction>

function fingerprint(action: KernelAction): string {
  return makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey)
}

/** The gate name of a `run-gate` action, or null for every other kind (including malformed input). */
function runGateName(action: KernelAction): string | null {
  if (action.kind !== 'run-gate') {
    return null
  }
  const parsed = ObjectiveActionSchema.safeParse(action)
  return parsed.success && parsed.data.kind === 'run-gate' ? parsed.data.gateName : null
}

export function createObjectiveConcurrencyPolicy(args: {
  objectiveStore: Pick<ObjectiveStore, 'getDispatch' | 'listDispatches'>
  snapshotBindings: WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>
  retainWorker: Policy['retainWorker']
  reconcile: NonNullable<Policy['reconcile']>
}): Policy {
  function isolatedAction(action: KernelAction, binding: ObjectiveSnapshotBinding): boolean {
    const record = args.objectiveStore.getDispatch(fingerprint(action))
    return (
      action.kind === 'dispatch-node' &&
      record !== null &&
      record.watcherId === binding.enrollment.watcherId &&
      record.workspacePath !== binding.target.workspacePath
    )
  }

  return {
    canRunAlongside(action, activeActions, snapshot, ledger: WatcherLedger) {
      const binding = requireObjectiveSnapshotBinding(args.snapshotBindings, snapshot)
      if (
        action.kind === 'run-gate' &&
        activeActions.every((active) => {
          const activeGateName = runGateName(active)
          return activeGateName !== null && activeGateName !== action.gateName
        })
      ) {
        return true
      }
      if (activeActions.some((active) => !isolatedAction(active, binding))) {
        return false
      }
      if (
        action.kind === 'ingest-report' ||
        action.kind === 'apply-node' ||
        action.kind === 'amend-plan' ||
        action.kind === 'accept-report'
      ) {
        return true
      }
      if (action.kind !== 'dispatch-node') {
        return activeActions.length === 0
      }
      const slots = objectiveParallelSlotState(snapshot.world, ledger, action.revisionId)
      const records = args.objectiveStore.listDispatches(binding.enrollment.watcherId)
      const conflict = records.find(
        (record) =>
          record.revisionId === action.revisionId &&
          record.taskKey === action.taskKey &&
          record.state === 'resolving-conflict'
      )
      if (conflict) {
        return !activeActions.some((active) => {
          const record = args.objectiveStore.getDispatch(fingerprint(active))
          return record?.workspaceId === conflict.workspaceId
        })
      }
      const ownFingerprint = fingerprint(action)
      const ownAttemptPending = getInFlightAttempts(ledger).some(
        (attempt) => attempt.fingerprint === ownFingerprint
      )
      const occupiedBeforeAction = slots.runningCount - Number(ownAttemptPending)
      if (slots.effectiveMaxConcurrency === 1 && occupiedBeforeAction > 0) {
        return false
      }
      return occupiedBeforeAction < slots.effectiveMaxConcurrency
    },
    shouldDrainBudget: objectiveHasPendingDrain,
    canRunWhenBudgetExhausted(action, snapshot) {
      if (
        action.kind === 'ingest-report' ||
        action.kind === 'apply-node' ||
        action.kind === 'ingest-plan' ||
        action.kind === 'ingest-verdict'
      ) {
        return true
      }
      return (
        action.kind === 'dispatch-node' &&
        (snapshot.world.parallel?.dispatches.some(
          (record) =>
            record.state === 'resolving-conflict' &&
            record.revisionId === action.revisionId &&
            record.taskKey === action.taskKey
        ) ??
          false)
      )
    },
    isIsolatedAttempt(attempt) {
      const record = args.objectiveStore.getDispatch(attempt.fingerprint)
      return attempt.action.kind === 'dispatch-node' && record?.watcherId === attempt.watcherId
    },
    preserveAttemptOnContentChange(attempt, snapshot) {
      const binding = requireObjectiveSnapshotBinding(args.snapshotBindings, snapshot)
      return isolatedAction(attempt.action, binding)
    },
    retainWorker: args.retainWorker,
    reconcile: args.reconcile
  }
}
