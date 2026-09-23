import { z } from 'zod'
import type { ObjectiveGate } from './contract-types'
import {
  TaskKeySchema,
  type ObjectivePlan,
  type ObjectivePlanAssumption,
  type ObjectivePlanTask
} from './plan-schema'
import { objectiveTerritoriesOverlap, objectiveTerritoryWithin } from './plan-territory'

export const PLAN_LINT_FINDINGS_MAX = 256
const PLAN_LINT_DETAIL_MAX_LENGTH = 1_000

export const PlanLintCodeSchema = z.enum([
  'missing-territory',
  'territory-outside-objective',
  'test-only-node',
  'full-suite-check',
  'unscoped-check',
  'non-relative-check',
  'conflict-pair',
  'duplicates-gate',
  'no-gate-declared',
  'missing-assumptions'
])
export type PlanLintCode = z.infer<typeof PlanLintCodeSchema>

export const PlanLintFindingSchema = z
  .object({
    code: PlanLintCodeSchema,
    taskKey: TaskKeySchema.nullable(),
    detail: z.string().min(1).max(PLAN_LINT_DETAIL_MAX_LENGTH)
  })
  .strict()
export type PlanLintFinding = z.infer<typeof PlanLintFindingSchema>

export const ObjectivePlanLintSchema = z
  .object({
    findings: z.array(PlanLintFindingSchema).max(PLAN_LINT_FINDINGS_MAX),
    truncated: z.boolean(),
    conflictPairs: z.array(z.tuple([TaskKeySchema, TaskKeySchema])),
    criticalPathLength: z.number().int().nonnegative(),
    // approximates the largest antichain as the widest single depth level, not a true max-antichain
    maxWidth: z.number().int().nonnegative()
  })
  .strict()
export type ObjectivePlanLint = z.infer<typeof ObjectivePlanLintSchema>

type PlanLintGate = Pick<ObjectiveGate, 'name' | 'command'>

export type LintObjectivePlanInput = {
  plan: ObjectivePlan
  assumptions: readonly ObjectivePlanAssumption[] | undefined
  writeTerritory: readonly string[]
  gates: readonly PlanLintGate[] | undefined
  // repair: tasks that could not run concurrently with open ones are still compared against them
  frozenTaskKeys?: ReadonlySet<string>
}

// matches a literal (a.test.ts) or wildcard (*.spec.tsx) final segment, not just a bare `*.test.ts` glob
const TEST_ONLY_LAST_SEGMENT_REGEX = /\.(test|spec)\.[^/]+$/u

function isTestOnlyGlob(glob: string): boolean {
  const segments = glob.split('/')
  const lastSegment = segments.at(-1) ?? ''
  if (TEST_ONLY_LAST_SEGMENT_REGEX.test(lastSegment)) {
    return true
  }
  return segments.includes('__tests__') || segments[0] === 'tests'
}

const FULL_SUITE_TEST_REGEX = /\bpnpm (run )?test(:sandbox)?\b(?![^\n]*\S+\.(test|spec)\.)/u
const FULL_SUITE_VITEST_REGEX = /\bvitest( run)?\s*$/u
const FULL_SUITE_CHECK_LINT_REGEX = /\bpnpm (run )?(typecheck|lint)\b(?!:)/u

function matchesFullSuite(text: string): boolean {
  return (
    FULL_SUITE_TEST_REGEX.test(text) ||
    FULL_SUITE_VITEST_REGEX.test(text) ||
    FULL_SUITE_CHECK_LINT_REGEX.test(text)
  )
}

const UNSCOPED_INVOCATION_REGEX = /\bvitest\b|\bpnpm (run )?test(:\S+)?\b|\btsc\b/u
const PATH_ARGUMENT_REGEX = /(^|\s)(?!-)\S*\/\S*/u
const SHELL_SEPARATOR_REGEX = /&&|\|\||\||;/u

// a shell chain can scope one segment and leave another bare (`echo src/foo && vitest run`),
// so each segment is judged independently rather than the command as a whole
function matchesUnscoped(command: string): boolean {
  return command
    .split(SHELL_SEPARATOR_REGEX)
    .some(
      (segment) => UNSCOPED_INVOCATION_REGEX.test(segment) && !PATH_ARGUMENT_REGEX.test(segment)
    )
}

const NON_RELATIVE_PATH_REGEX = /(^|\s)\/[A-Za-z]|[A-Za-z]:\\/u

function matchesNonRelative(command: string): boolean {
  return NON_RELATIVE_PATH_REGEX.test(command)
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/gu, ' ')
}

function matchesGateCommand(command: string, gates: readonly PlanLintGate[]): boolean {
  const normalized = normalizeCommand(command)
  return gates.some((gate) => normalizeCommand(gate.command) === normalized)
}

function matchesGateName(title: string, gates: readonly PlanLintGate[]): boolean {
  const normalizedTitle = title.trim().toLowerCase()
  return gates.some((gate) => gate.name.toLowerCase() === normalizedTitle)
}

/** Transitive dependency (prerequisite) closure for every task, keyed by taskKey. */
function buildDescendantSets(plan: ObjectivePlan): Map<string, ReadonlySet<string>> {
  const byKey = new Map(plan.map((task) => [task.taskKey, task]))
  const memo = new Map<string, Set<string>>()
  const resolve = (taskKey: string): ReadonlySet<string> => {
    const cached = memo.get(taskKey)
    if (cached !== undefined) {
      return cached
    }
    const result = new Set<string>()
    // the plan schema forbids cycles; seeding memo before recursing keeps this safe if one slips through
    memo.set(taskKey, result)
    for (const dependency of byKey.get(taskKey)?.deps ?? []) {
      result.add(dependency)
      for (const transitive of resolve(dependency)) {
        result.add(transitive)
      }
    }
    return result
  }
  for (const task of plan) {
    resolve(task.taskKey)
  }
  return memo
}

function hasDependencyPath(
  descendants: Map<string, ReadonlySet<string>>,
  a: string,
  b: string
): boolean {
  return (descendants.get(a)?.has(b) ?? false) || (descendants.get(b)?.has(a) ?? false)
}

function computeConflictPairs(
  plan: ObjectivePlan,
  frozenTaskKeys: ReadonlySet<string> | undefined
): [string, string][] {
  const descendants = buildDescendantSets(plan)
  const pairs: [string, string][] = []
  for (let earlier = 0; earlier < plan.length; earlier += 1) {
    const a = plan[earlier]
    if (a.territory === undefined) {
      continue
    }
    for (let later = earlier + 1; later < plan.length; later += 1) {
      const b = plan[later]
      if (b.territory === undefined) {
        continue
      }
      if (frozenTaskKeys?.has(a.taskKey) === true && frozenTaskKeys?.has(b.taskKey) === true) {
        continue
      }
      if (hasDependencyPath(descendants, a.taskKey, b.taskKey)) {
        continue
      }
      if (objectiveTerritoriesOverlap(a.territory, b.territory)) {
        pairs.push([a.taskKey, b.taskKey])
      }
    }
  }
  return pairs
}

/**
 * `criticalPathLength` is the longest dependency chain by node count; `maxWidth` approximates the
 * plan's maximum antichain as the widest single depth level (depth = longest chain from a root),
 * which can undercount a true antichain that spans multiple depths.
 */
function computeChainMetrics(plan: ObjectivePlan): {
  criticalPathLength: number
  maxWidth: number
} {
  const byKey = new Map(plan.map((task) => [task.taskKey, task]))
  const lengthMemo = new Map<string, number>()
  const depthMemo = new Map<string, number>()
  const chainLength = (taskKey: string): number => {
    const cached = lengthMemo.get(taskKey)
    if (cached !== undefined) {
      return cached
    }
    lengthMemo.set(taskKey, 1)
    const deps = byKey.get(taskKey)?.deps ?? []
    const value = deps.length === 0 ? 1 : 1 + Math.max(...deps.map(chainLength))
    lengthMemo.set(taskKey, value)
    return value
  }
  const depth = (taskKey: string): number => {
    const cached = depthMemo.get(taskKey)
    if (cached !== undefined) {
      return cached
    }
    depthMemo.set(taskKey, 0)
    const deps = byKey.get(taskKey)?.deps ?? []
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depth))
    depthMemo.set(taskKey, value)
    return value
  }

  let criticalPathLength = 0
  const widthByDepth = new Map<number, number>()
  for (const task of plan) {
    criticalPathLength = Math.max(criticalPathLength, chainLength(task.taskKey))
    const taskDepth = depth(task.taskKey)
    widthByDepth.set(taskDepth, (widthByDepth.get(taskDepth) ?? 0) + 1)
  }
  const maxWidth = widthByDepth.size === 0 ? 0 : Math.max(...widthByDepth.values())
  return { criticalPathLength, maxWidth }
}

function lintTask(
  task: ObjectivePlanTask,
  writeTerritory: readonly string[],
  gates: readonly PlanLintGate[] | undefined,
  conflictsWithLaterTasks: readonly string[]
): PlanLintFinding[] {
  const findings: PlanLintFinding[] = []
  const { taskKey } = task

  if (task.territory === undefined) {
    findings.push({
      code: 'missing-territory',
      taskKey,
      detail: `Task ${taskKey} does not declare a write territory.`
    })
  } else {
    if (!objectiveTerritoryWithin(task.territory, writeTerritory)) {
      findings.push({
        code: 'territory-outside-objective',
        taskKey,
        detail: `Task ${taskKey} territory reaches outside the objective's write territory.`
      })
    }
    if (task.territory.length > 0 && task.territory.every(isTestOnlyGlob)) {
      findings.push({
        code: 'test-only-node',
        taskKey,
        detail: `Task ${taskKey} territory covers only test files; a pre-existing upstream test may still need changes outside it.`
      })
    }
  }

  if (matchesFullSuite(task.spec)) {
    findings.push({
      code: 'full-suite-check',
      taskKey,
      detail: `Task ${taskKey} spec references a full-suite command.`
    })
  }
  task.criteria.forEach((criterion, index) => {
    if (criterion.checkCommand !== null && matchesFullSuite(criterion.checkCommand)) {
      findings.push({
        code: 'full-suite-check',
        taskKey,
        detail: `Task ${taskKey} criterion ${index} runs a full-suite command instead of a scoped one.`
      })
    }
  })
  task.criteria.forEach((criterion, index) => {
    if (criterion.checkCommand !== null && matchesUnscoped(criterion.checkCommand)) {
      findings.push({
        code: 'unscoped-check',
        taskKey,
        detail: `Task ${taskKey} criterion ${index} runs without a path argument.`
      })
    }
  })
  task.criteria.forEach((criterion, index) => {
    if (criterion.checkCommand !== null && matchesNonRelative(criterion.checkCommand)) {
      findings.push({
        code: 'non-relative-check',
        taskKey,
        detail: `Task ${taskKey} criterion ${index} references an absolute or non-worktree path.`
      })
    }
  })
  if (gates !== undefined && gates.length > 0) {
    task.criteria.forEach((criterion, index) => {
      if (criterion.checkCommand !== null && matchesGateCommand(criterion.checkCommand, gates)) {
        findings.push({
          code: 'duplicates-gate',
          taskKey,
          detail: `Task ${taskKey} criterion ${index} duplicates a declared gate command.`
        })
      }
    })
    if (matchesGateName(task.title, gates)) {
      findings.push({
        code: 'duplicates-gate',
        taskKey,
        detail: `Task ${taskKey} title duplicates a declared gate name.`
      })
    }
  }
  for (const other of conflictsWithLaterTasks) {
    findings.push({
      code: 'conflict-pair',
      taskKey,
      detail: `Task ${taskKey} territory overlaps task ${other} with no dependency path between them.`
    })
  }

  return findings
}

/**
 * Flags a planner report's likely mistakes for display and for a plan-review agent — never rejects.
 * Pure and deterministic: plan-level findings first, then per task in plan order, and within a task
 * in a fixed code order (see `PlanLintCode`'s declaration order).
 */
export function lintObjectivePlan(input: LintObjectivePlanInput): ObjectivePlanLint {
  const { plan, assumptions, writeTerritory, gates, frozenTaskKeys } = input
  const findings: PlanLintFinding[] = []

  if (gates === undefined || gates.length === 0) {
    findings.push({
      code: 'no-gate-declared',
      taskKey: null,
      detail: 'The objective declares no gates.'
    })
  }
  if (assumptions === undefined) {
    findings.push({
      code: 'missing-assumptions',
      taskKey: null,
      detail: 'The planner report omits assumptions.'
    })
  }

  const conflictPairs = computeConflictPairs(plan, frozenTaskKeys)
  const laterConflictsByEarlierTask = new Map<string, string[]>()
  for (const [earlier, later] of conflictPairs) {
    const laterTasks = laterConflictsByEarlierTask.get(earlier) ?? []
    laterTasks.push(later)
    laterConflictsByEarlierTask.set(earlier, laterTasks)
  }

  for (const task of plan) {
    findings.push(
      ...lintTask(task, writeTerritory, gates, laterConflictsByEarlierTask.get(task.taskKey) ?? [])
    )
  }

  const truncated = findings.length > PLAN_LINT_FINDINGS_MAX
  const boundedFindings = truncated ? findings.slice(0, PLAN_LINT_FINDINGS_MAX) : findings
  const { criticalPathLength, maxWidth } = computeChainMetrics(plan)

  return {
    findings: boundedFindings,
    truncated,
    conflictPairs,
    criticalPathLength,
    maxWidth
  }
}
