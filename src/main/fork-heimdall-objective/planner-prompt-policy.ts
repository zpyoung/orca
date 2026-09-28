import type { ObjectiveGate } from '../../shared/fork-heimdall-objective/contract-types'
import { OBJECTIVE_CHECK_TIMEOUT_SECONDS } from './check-runner'

export type PlannerPromptPolicyInput = {
  effectiveMaxConcurrency: number
  lanesEnabled: boolean
  gates: readonly ObjectiveGate[] | undefined
}

/**
 * States the shaping rules a planner must follow so its nodes fit the run's parallel dispatch
 * model: sizing, concurrency, the dependency-merge start rule, warm-session lanes, check scope, and
 * where objective gates and the PR sit outside the node graph.
 */
export function buildPlannerPromptPolicySection(input: PlannerPromptPolicyInput): string {
  const gateNames = (input.gates ?? []).map((gate) => gate.name)
  const lines = [
    'Size each node so one implementer session can finish it in a single sitting; split larger changes into dependent tasks instead of one large task.',
    'Tests ship together with the code that needs them; add a test-only node only to fix a pre-existing upstream test the change breaks.',
    `Up to ${input.effectiveMaxConcurrency} nodes run at once.`,
    'A node starts only once every dependency is applied (merged) to the enrolled branch — list only real dependencies.',
    ...(input.lanesEnabled ? ['One-to-one dependency chains share one warm session.'] : []),
    'A fresh session spends about 30% of a node orienting.',
    `Node checks must be scoped to the task, finish within ${OBJECTIVE_CHECK_TIMEOUT_SECONDS} seconds, and run from any worktree using workspace-relative paths.`,
    'Node checks judge file contents or run scoped tests, never commit ranges, because checks run after every node lands.',
    gateNames.length > 0
      ? `OBJECTIVE GATES: ${gateNames.join(', ')}`
      : 'OBJECTIVE GATES: none declared',
    'Objective gates run the full suite and whole-tree checks, and the PR opens at the open-hosted-review rung — "run gates" and "open PR" are never nodes.',
    'Every task must declare territory: globs inside write territory naming what it will modify.',
    'Declare assumptions naming the task keys that depend on each one, with evidence on the ones you verified yourself.'
  ]
  return `PLAN SHAPING POLICY:\n${lines.join('\n')}`
}
