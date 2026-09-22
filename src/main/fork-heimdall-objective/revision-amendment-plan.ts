import {
  ObjectivePlanSchema,
  type ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { RevisionAmendmentPatch } from '../../shared/fork-heimdall-objective/revision-amendment'

export type AmendedPlanOutcome =
  | { ok: true; plan: ObjectivePlanTask[] }
  | { ok: false; reason: 'invalid-dependency-graph'; detail: string }

/**
 * Applies an amendment's upserts and drops onto a plan, preserving every untouched task's original
 * position and appending genuinely new tasks at the end, then re-validates the result with the same
 * acyclic/unique-key check a freshly ingested plan gets.
 */
export function applyRevisionAmendmentPatch(
  currentPlan: readonly ObjectivePlanTask[],
  patch: RevisionAmendmentPatch
): AmendedPlanOutcome {
  const dropSet = new Set(patch.dropTaskKeys)
  const upsertByKey = new Map(patch.upsertTasks.map((task) => [task.taskKey, task]))
  const currentKeys = new Set(currentPlan.map((task) => task.taskKey))

  const amendedPlan: ObjectivePlanTask[] = []
  for (const task of currentPlan) {
    if (dropSet.has(task.taskKey)) {
      continue
    }
    amendedPlan.push(upsertByKey.get(task.taskKey) ?? task)
  }
  for (const task of patch.upsertTasks) {
    if (!currentKeys.has(task.taskKey)) {
      amendedPlan.push(task)
    }
  }

  const validated = ObjectivePlanSchema.safeParse(amendedPlan)
  if (!validated.success) {
    return { ok: false, reason: 'invalid-dependency-graph', detail: validated.error.message }
  }
  return { ok: true, plan: validated.data }
}

export function unknownAmendmentDropTaskKeys(
  currentPlan: readonly ObjectivePlanTask[],
  patch: RevisionAmendmentPatch
): string[] {
  const currentKeys = new Set(currentPlan.map((task) => task.taskKey))
  return patch.dropTaskKeys.filter((taskKey) => !currentKeys.has(taskKey))
}

export function revisionAmendmentTouchedTaskKeys(patch: RevisionAmendmentPatch): string[] {
  return [...new Set([...patch.upsertTasks.map((task) => task.taskKey), ...patch.dropTaskKeys])]
}
