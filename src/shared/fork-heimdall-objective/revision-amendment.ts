import { z } from 'zod'
import {
  OWNER_INTERVENTION_ID_MAX_LENGTH,
  OWNER_INTERVENTION_TEXT_MAX_LENGTH
} from '../fork-heimdall/owner/intervention'
import { OBJECTIVE_PLAN_MAX_TASKS, ObjectivePlanTaskSchema } from './plan-schema'

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
