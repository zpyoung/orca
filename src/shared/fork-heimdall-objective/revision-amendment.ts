import { z } from 'zod'
import {
  OWNER_INTERVENTION_ID_MAX_LENGTH,
  OWNER_INTERVENTION_TEXT_MAX_LENGTH
} from '../fork-heimdall/owner/intervention'
import {
  OBJECTIVE_PLAN_MAX_TASKS,
  ObjectivePlanSchema,
  ObjectivePlanTaskSchema,
  type ObjectivePlanTask
} from './plan-schema'

const IdSchema = z.string().trim().min(1).max(OWNER_INTERVENTION_ID_MAX_LENGTH)

/**
 * An owning agent's in-place correction to an approved plan revision: replaces or adds the named
 * tasks and may drop tasks that were never dispatched, without discarding the revision's id or its
 * completed nodes the way a full replan would.
 */
export const RevisionAmendmentPatchSchema = z
  .object({
    digest: IdSchema,
    attestation: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH),
    upsertTasks: z.array(ObjectivePlanTaskSchema).max(OBJECTIVE_PLAN_MAX_TASKS),
    dropTaskKeys: z.array(IdSchema).max(OBJECTIVE_PLAN_MAX_TASKS)
  })
  .strict()
  .refine(
    (patch) =>
      new Set(patch.upsertTasks.map((task) => task.taskKey)).size === patch.upsertTasks.length,
    'Amendment upserts must name each task key once'
  )
  .refine(
    (patch) => new Set(patch.dropTaskKeys).size === patch.dropTaskKeys.length,
    'Amendment drops must name each task key once'
  )
  .refine(
    (patch) => patch.upsertTasks.every((task) => !patch.dropTaskKeys.includes(task.taskKey)),
    'A task cannot be both upserted and dropped in the same amendment'
  )
  .refine(
    (patch) => patch.upsertTasks.length > 0 || patch.dropTaskKeys.length > 0,
    'Amendment must upsert or drop at least one task'
  )
export type RevisionAmendmentPatch = z.infer<typeof RevisionAmendmentPatchSchema>

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
