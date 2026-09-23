import { z } from 'zod'
import type { ObjectiveEnrollmentPayload } from './contract-types'
import {
  OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES,
  OBJECTIVE_PLAN_MAX_TASKS,
  ObjectivePlanAssumptionSchema,
  ObjectivePlanTaskSchema,
  TaskKeySchema,
  assertPlannerAssumptionsDeclared,
  assertPlannerAssumptionsNameKnownTasks,
  assertPlannerTaskTerritoryDeclared,
  assertPlannerTaskWithinDispatchSnapshotCap,
  objectivePathMatchesTerritory,
  type ObjectivePlanTask
} from './plan-schema'
import {
  applyRevisionAmendmentPatch,
  unknownAmendmentDropTaskKeys,
  type RevisionAmendmentPatch
} from './revision-amendment'

export const PlannerRepairReportSchema = z
  .object({
    repair: z
      .object({
        upsertTasks: z.array(ObjectivePlanTaskSchema).max(OBJECTIVE_PLAN_MAX_TASKS),
        dropTaskKeys: z.array(TaskKeySchema).max(OBJECTIVE_PLAN_MAX_TASKS)
      })
      .strict(),
    assumptions: z
      .array(ObjectivePlanAssumptionSchema)
      .max(OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES)
      .optional()
  })
  .strict()
export type PlannerRepairReport = z.infer<typeof PlannerRepairReportSchema>

/**
 * Parses and write-validates a planner's replan patch: every upsert must declare territory inside the
 * objective's write territory, drops must name tasks the current plan actually has, the patched plan
 * (via `applyRevisionAmendmentPatch`) must stay acyclic, and assumptions are required and must name
 * only tasks present in the resulting plan.
 */
export function parseAndValidatePlannerRepairReport(
  raw: unknown,
  contract: Pick<ObjectiveEnrollmentPayload, 'writeTerritory'>,
  current: readonly ObjectivePlanTask[]
): PlannerRepairReport {
  const report = PlannerRepairReportSchema.parse(raw)
  const { upsertTasks, dropTaskKeys } = report.repair
  if (upsertTasks.length === 0 && dropTaskKeys.length === 0) {
    throw new Error('Repair patch is empty')
  }
  const dropSet = new Set(dropTaskKeys)
  for (const task of upsertTasks) {
    if (dropSet.has(task.taskKey)) {
      throw new Error(`Repair patch both upserts and drops ${task.taskKey}`)
    }
  }
  const patch: RevisionAmendmentPatch = {
    digest: 'repair-patch',
    attestation: 'repair-patch',
    upsertTasks,
    dropTaskKeys
  }
  const unknownDrops = unknownAmendmentDropTaskKeys(current, patch)
  if (unknownDrops.length > 0) {
    throw new Error(`Repair patch drops unknown task ${unknownDrops[0]}`)
  }
  for (const task of upsertTasks) {
    assertPlannerTaskTerritoryDeclared(task)
    assertPlannerTaskWithinDispatchSnapshotCap(task)
    for (const path of task.declaredPaths ?? []) {
      if (!objectivePathMatchesTerritory(path, contract.writeTerritory)) {
        throw new Error(`Task ${task.taskKey} declares path outside write territory: ${path}`)
      }
    }
  }
  const outcome = applyRevisionAmendmentPatch(current, patch)
  if (!outcome.ok) {
    throw new Error(`Repair patch produces an invalid plan: ${outcome.detail}`)
  }
  const resultingTaskKeys = new Set(outcome.plan.map((task) => task.taskKey))
  assertPlannerAssumptionsDeclared(report.assumptions)
  assertPlannerAssumptionsNameKnownTasks(report.assumptions, resultingTaskKeys)
  return report
}
