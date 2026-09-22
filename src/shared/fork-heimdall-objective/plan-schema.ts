import { z } from 'zod'
import {
  OBJECTIVE_CHECK_COMMAND_MAX_LENGTH,
  OBJECTIVE_CRITERION_BODY_MAX_LENGTH,
  OBJECTIVE_CRITERION_NOTE_MAX_LENGTH,
  OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH,
  OBJECTIVE_TASK_KEY_MAX_LENGTH,
  OBJECTIVE_TASK_SPEC_MAX_LENGTH,
  OBJECTIVE_TASK_TITLE_MAX_LENGTH,
  OBJECTIVE_TERRITORY_MAX_ENTRIES,
  ObjectiveTerritoryGlobSchema,
  ObjectiveWorkspacePathSchema,
  isObjectiveConcreteWorkspacePath,
  type ObjectiveEnrollmentPayload
} from './contract-types'

export const OBJECTIVE_PLAN_MAX_TASKS = 128
export const OBJECTIVE_TASK_MAX_CRITERIA = 64
export const OBJECTIVE_REPORT_MAX_FILES = 256
export const OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES = 64
export const OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH = 2_000

export const TaskKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(OBJECTIVE_TASK_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
const TitleSchema = z.string().trim().min(1).max(OBJECTIVE_TASK_TITLE_MAX_LENGTH)
const NoteSchema = z.string().trim().min(1).max(OBJECTIVE_CRITERION_NOTE_MAX_LENGTH)

export const ObjectiveCriterionSchema = z
  .object({
    body: z.string().trim().min(1).max(OBJECTIVE_CRITERION_BODY_MAX_LENGTH),
    shellCheckable: z.boolean(),
    checkCommand: z.string().trim().min(1).max(OBJECTIVE_CHECK_COMMAND_MAX_LENGTH).nullable()
  })
  .strict()
  .refine(
    (criterion) => criterion.shellCheckable === (criterion.checkCommand !== null),
    'shellCheckable must agree with checkCommand'
  )
export type ObjectiveCriterion = z.infer<typeof ObjectiveCriterionSchema>

export const ObjectivePlanTaskSchema = z
  .object({
    taskKey: TaskKeySchema,
    title: TitleSchema,
    spec: z.string().trim().min(1).max(OBJECTIVE_TASK_SPEC_MAX_LENGTH),
    deps: z.array(TaskKeySchema).max(OBJECTIVE_PLAN_MAX_TASKS),
    criteria: z.array(ObjectiveCriterionSchema).min(1).max(OBJECTIVE_TASK_MAX_CRITERIA),
    declaresDependencyChange: z.boolean(),
    declaredPaths: z.array(ObjectiveWorkspacePathSchema).max(OBJECTIVE_REPORT_MAX_FILES).optional(),
    territory: z
      .array(ObjectiveTerritoryGlobSchema)
      .min(1)
      .max(OBJECTIVE_TERRITORY_MAX_ENTRIES)
      .optional()
  })
  .strict()
  .refine(
    (task) => new Set(task.deps).size === task.deps.length,
    'Task dependencies must be unique'
  )
  .refine(
    (task) =>
      task.declaredPaths === undefined ||
      new Set(task.declaredPaths).size === task.declaredPaths.length,
    'Declared paths must be unique'
  )
  .refine(
    (task) =>
      task.territory === undefined || new Set(task.territory).size === task.territory.length,
    'Territory globs must be unique'
  )
export type ObjectivePlanTask = z.infer<typeof ObjectivePlanTaskSchema>

/**
 * A planner's claim about the objective's state, with the tasks whose validity depends on it — an
 * empty list means the claim is informational and never blocks a plan review's approval.
 */
export const ObjectivePlanAssumptionSchema = z
  .object({
    claim: z.string().trim().min(1).max(OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH),
    dependentTaskKeys: z.array(TaskKeySchema).max(OBJECTIVE_PLAN_MAX_TASKS)
  })
  .strict()
  .refine(
    (assumption) =>
      new Set(assumption.dependentTaskKeys).size === assumption.dependentTaskKeys.length,
    'Assumption dependent task keys must be unique'
  )
export type ObjectivePlanAssumption = z.infer<typeof ObjectivePlanAssumptionSchema>

function addPlanGraphIssues(tasks: readonly ObjectivePlanTask[], context: z.RefinementCtx): void {
  const byKey = new Map<string, ObjectivePlanTask>()
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]
    if (byKey.has(task.taskKey)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate taskKey ${task.taskKey}`,
        path: [index, 'taskKey']
      })
    }
    byKey.set(task.taskKey, task)
  }
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]
    for (const dependency of task.deps) {
      if (!byKey.has(dependency)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown dependency ${dependency}`,
          path: [index, 'deps']
        })
      } else if (dependency === task.taskKey) {
        context.addIssue({
          code: 'custom',
          message: 'A task cannot depend on itself',
          path: [index, 'deps']
        })
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (taskKey: string): void => {
    if (visited.has(taskKey) || !byKey.has(taskKey)) {
      return
    }
    if (visiting.has(taskKey)) {
      context.addIssue({ code: 'custom', message: `Plan dependency cycle includes ${taskKey}` })
      return
    }
    visiting.add(taskKey)
    for (const dependency of byKey.get(taskKey)?.deps ?? []) {
      visit(dependency)
    }
    visiting.delete(taskKey)
    visited.add(taskKey)
  }
  for (const task of tasks) {
    visit(task.taskKey)
  }
}

export const ObjectivePlanSchema = z
  .array(ObjectivePlanTaskSchema)
  .min(1)
  .max(OBJECTIVE_PLAN_MAX_TASKS)
  .superRefine(addPlanGraphIssues)
export type ObjectivePlan = z.infer<typeof ObjectivePlanSchema>

export const PlannerReportSchema = z
  .object({
    plan: ObjectivePlanSchema,
    assumptions: z
      .array(ObjectivePlanAssumptionSchema)
      .max(OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES)
      .optional()
  })
  .strict()
export type PlannerReport = z.infer<typeof PlannerReportSchema>

export const CriterionSelfAssessmentSchema = z
  .object({
    criterionIndex: z
      .number()
      .int()
      .nonnegative()
      .max(OBJECTIVE_TASK_MAX_CRITERIA - 1),
    result: z.enum(['pass', 'fail', 'unknown']),
    note: NoteSchema
  })
  .strict()
export type CriterionSelfAssessment = z.infer<typeof CriterionSelfAssessmentSchema>

export const ImplementerReportSchema = z
  .object({
    taskKey: TaskKeySchema,
    summary: z.string().trim().min(1).max(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH),
    filesModified: z.array(ObjectiveWorkspacePathSchema).max(OBJECTIVE_REPORT_MAX_FILES),
    criteriaSelfAssessment: z.array(CriterionSelfAssessmentSchema).max(OBJECTIVE_TASK_MAX_CRITERIA)
  })
  .strict()
  .refine(
    (report) => new Set(report.filesModified).size === report.filesModified.length,
    'Modified paths must be unique'
  )
  .refine(
    (report) =>
      new Set(report.criteriaSelfAssessment.map((assessment) => assessment.criterionIndex)).size ===
      report.criteriaSelfAssessment.length,
    'Criterion self-assessments must be unique'
  )
export type ImplementerReport = z.infer<typeof ImplementerReportSchema>

export const ReviewCriterionResultSchema = z
  .object({
    taskKey: TaskKeySchema,
    criterionIndex: z
      .number()
      .int()
      .nonnegative()
      .max(OBJECTIVE_TASK_MAX_CRITERIA - 1),
    result: z.enum(['pass', 'block']),
    note: NoteSchema
  })
  .strict()
export type ReviewCriterionResult = z.infer<typeof ReviewCriterionResultSchema>

const ReviewerReportObjectSchema = z
  .object({
    verdict: z.enum(['approve', 'block']),
    criteriaResults: z
      .array(ReviewCriterionResultSchema)
      .max(OBJECTIVE_PLAN_MAX_TASKS * OBJECTIVE_TASK_MAX_CRITERIA),
    summary: z.string().trim().min(1).max(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH)
  })
  .strict()

export const ReviewerReportSchema = ReviewerReportObjectSchema.superRefine((report, context) => {
  const keys = report.criteriaResults.map((result) => `${result.taskKey}\0${result.criterionIndex}`)
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: 'custom',
      message: 'Criterion review results must be unique',
      path: ['criteriaResults']
    })
  }
  const blocked = report.criteriaResults.some((result) => result.result === 'block')
  if (blocked !== (report.verdict === 'block')) {
    context.addIssue({
      code: 'custom',
      message: 'Verdict must agree with criterion results',
      path: ['verdict']
    })
  }
})
export type ReviewerReport = z.infer<typeof ReviewerReportSchema>

export const IntegratorCheckSchema = z
  .object({
    command: z.string().trim().min(1).max(OBJECTIVE_CHECK_COMMAND_MAX_LENGTH),
    exitCode: z.number().int()
  })
  .strict()
export type IntegratorCheck = z.infer<typeof IntegratorCheckSchema>

export const IntegratorReportSchema = ReviewerReportObjectSchema.extend({
  checksRun: z.array(IntegratorCheckSchema).max(OBJECTIVE_TASK_MAX_CRITERIA)
})
  .strict()
  .superRefine((report, context) => {
    const keys = report.criteriaResults.map(
      (result) => `${result.taskKey}\0${result.criterionIndex}`
    )
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: 'custom',
        message: 'Criterion review results must be unique',
        path: ['criteriaResults']
      })
    }
    const blocked = report.criteriaResults.some((result) => result.result === 'block')
    if (blocked !== (report.verdict === 'block')) {
      context.addIssue({
        code: 'custom',
        message: 'Verdict must agree with criterion results',
        path: ['verdict']
      })
    }
  })
export type IntegratorReport = z.infer<typeof IntegratorReportSchema>

export function segmentMatches(pattern: string, value: string): boolean {
  let expression = '^'
  for (const character of pattern) {
    if (character === '*') {
      expression += '[^/]*'
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`${expression}$`, 'u').test(value)
}

export function objectivePathMatchesTerritory(path: string, territory: readonly string[]): boolean {
  if (!isObjectiveConcreteWorkspacePath(path)) {
    return false
  }
  const pathParts = path.split('/')
  return territory.some((glob) => {
    const globParts = glob.split('/')
    const memo = new Map<string, boolean>()
    const match = (globIndex: number, pathIndex: number): boolean => {
      const key = `${globIndex}:${pathIndex}`
      const known = memo.get(key)
      if (known !== undefined) {
        return known
      }
      if (globIndex === globParts.length) {
        return pathIndex === pathParts.length
      }
      const part = globParts[globIndex]
      const result =
        part === '**'
          ? match(globIndex + 1, pathIndex) ||
            (pathIndex < pathParts.length && match(globIndex, pathIndex + 1))
          : pathIndex < pathParts.length &&
            segmentMatches(part, pathParts[pathIndex]) &&
            match(globIndex + 1, pathIndex + 1)
      memo.set(key, result)
      return result
    }
    return match(0, 0)
  })
}

export type PlanRevisionValidation = {
  writeTerritory: readonly string[]
  dispatchedTaskKeys: readonly string[]
}

/** Write-path requiredness: every task must declare `territory`, matching the planner write contract. */
export function assertPlannerTaskTerritoryDeclared(task: ObjectivePlanTask): void {
  if (task.territory === undefined) {
    throw new Error(`Planner task ${task.taskKey} must declare territory`)
  }
}

/** Write-path requiredness: `assumptions` must be present, even when empty. */
export function assertPlannerAssumptionsDeclared(
  assumptions: readonly ObjectivePlanAssumption[] | undefined
): asserts assumptions is readonly ObjectivePlanAssumption[] {
  if (assumptions === undefined) {
    throw new Error('Planner report must declare assumptions (use [] when none)')
  }
}

export function assertPlannerAssumptionsNameKnownTasks(
  assumptions: readonly ObjectivePlanAssumption[],
  taskKeys: ReadonlySet<string>
): void {
  assumptions.forEach((assumption, index) => {
    for (const taskKey of assumption.dependentTaskKeys) {
      if (!taskKeys.has(taskKey)) {
        throw new Error(`Assumption ${index} names unknown task ${taskKey}`)
      }
    }
  })
}

export function parseAndValidatePlannerReport(
  input: unknown,
  validation: PlanRevisionValidation
): PlannerReport {
  const report = PlannerReportSchema.parse(input)
  const taskKeys = new Set(report.plan.map((task) => task.taskKey))
  for (const dispatchedTaskKey of validation.dispatchedTaskKeys) {
    if (!taskKeys.has(dispatchedTaskKey)) {
      throw new Error(`Dispatched task ${dispatchedTaskKey} cannot be removed from a plan`)
    }
  }
  for (const task of report.plan) {
    for (const path of task.declaredPaths ?? []) {
      if (!objectivePathMatchesTerritory(path, validation.writeTerritory)) {
        throw new Error(`Task ${task.taskKey} declares path outside write territory: ${path}`)
      }
    }
  }
  for (const task of report.plan) {
    assertPlannerTaskTerritoryDeclared(task)
  }
  assertPlannerAssumptionsDeclared(report.assumptions)
  assertPlannerAssumptionsNameKnownTasks(report.assumptions, taskKeys)
  return report
}

export function parseAndValidateImplementerReport(
  input: unknown,
  task: ObjectivePlanTask,
  writeTerritory: ObjectiveEnrollmentPayload['writeTerritory']
): ImplementerReport {
  const report = ImplementerReportSchema.parse(input)
  if (report.taskKey !== task.taskKey) {
    throw new Error(`Implementer report names ${report.taskKey}; expected ${task.taskKey}`)
  }
  for (const path of report.filesModified) {
    if (!objectivePathMatchesTerritory(path, writeTerritory)) {
      throw new Error(`Implementer modified path outside write territory: ${path}`)
    }
  }
  const covered = new Set(report.criteriaSelfAssessment.map((item) => item.criterionIndex))
  if (
    covered.size !== task.criteria.length ||
    task.criteria.some((_, index) => !covered.has(index))
  ) {
    throw new Error(`Implementer report must assess every criterion for ${task.taskKey}`)
  }
  return report
}

function assertCompleteReviewCoverage(report: ReviewerReport, plan: ObjectivePlan): void {
  const expected = new Set<string>()
  for (const task of plan) {
    for (let index = 0; index < task.criteria.length; index += 1) {
      expected.add(`${task.taskKey}\0${index}`)
    }
  }
  const received = new Set(
    report.criteriaResults.map((result) => `${result.taskKey}\0${result.criterionIndex}`)
  )
  if (expected.size !== received.size || [...expected].some((key) => !received.has(key))) {
    throw new Error('Review report must cover every plan criterion exactly once')
  }
}

export function parseAndValidateReviewerReport(
  input: unknown,
  plan: ObjectivePlan
): ReviewerReport {
  const report = ReviewerReportSchema.parse(input)
  assertCompleteReviewCoverage(report, plan)
  return report
}

export function parseAndValidateIntegratorReport(
  input: unknown,
  plan: ObjectivePlan
): IntegratorReport {
  const report = IntegratorReportSchema.parse(input)
  assertCompleteReviewCoverage(report, plan)
  return report
}
