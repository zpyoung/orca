import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { objectiveFrozenTaskKeys } from '../../shared/fork-heimdall-objective/objective-repair-state'
import {
  objectiveActionNaturalKey,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'

type ApplyPlanPatchAction = Extract<ObjectiveAction, { kind: 'apply-plan-patch' }>

function invalid(reason: string): ActionOutcome {
  return { effect: 'not-landed', reason }
}

function naturalKey(action: ApplyPlanPatchAction) {
  const key = objectiveActionNaturalKey(action)
  if (!key) {
    throw new Error('Objective apply-plan-patch action has no natural key')
  }
  return key
}

/**
 * Applies a stored plan patch via the amend path, re-checking the frozen-task guard at execution
 * time since running work may have started between decision and execution. A store refusal (e.g.
 * `changes-frozen-node`) is a recorded outcome, not an invalid action — the patch lands rejected
 * and the attempt itself still lands.
 */
export async function executeApplyPlanPatch(args: {
  action: ApplyPlanPatchAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
}): Promise<ActionOutcome> {
  const patch = args.objectiveStore.getPlanPatch(args.action.patchId)
  if (
    !patch ||
    patch.revisionId !== args.action.revisionId ||
    patch.digest !== args.action.digest
  ) {
    return invalid('apply-plan-patch-not-found')
  }
  await args.context.lease.assertHeld()
  const frozen = objectiveFrozenTaskKeys(
    args.context.snapshot.world,
    args.context.ledger,
    args.action.revisionId
  )
  const result = args.objectiveStore.applyPlanPatch({
    watcherId: args.binding.enrollment.watcherId,
    patchId: args.action.patchId,
    amendedAtMs: Date.now(),
    frozenTaskKeys: [...frozen]
  })
  return {
    effect: 'landed',
    result: result.ok
      ? {
          kind: 'plan-patch-applied',
          naturalKey: naturalKey(args.action),
          patchId: args.action.patchId,
          revisionId: result.revisionId,
          digest: result.digest,
          ordinal: result.ordinal,
          replayed: result.replayed
        }
      : {
          kind: 'plan-patch-rejected',
          naturalKey: naturalKey(args.action),
          patchId: args.action.patchId,
          reason: result.reason,
          ...('taskKey' in result ? { taskKey: result.taskKey } : {}),
          ...('detail' in result ? { detail: result.detail } : {})
        }
  }
}
