import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../shared/orchestration-worker-start-prompt-budget'
import type { ObjectiveEnrollmentPayload } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectivePlanTask } from '../../shared/fork-heimdall-objective/plan-schema'
import { buildObjectiveRolePrompt } from './role-prompts'

const contract: ObjectiveEnrollmentPayload = {
  objectiveText: 'Ship the requested behavior without changing unrelated files.',
  tier: 'standard',
  landingBar: 'files-on-disk',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

function node(taskKey: string, spec: string): ObjectivePlanTask {
  return {
    taskKey,
    title: `Task ${taskKey}`,
    spec,
    deps: [],
    criteria: [{ body: `${taskKey} works`, shellCheckable: false, checkCommand: null }],
    declaresDependencyChange: false,
    declaredPaths: [`src/${taskKey}.ts`]
  }
}

describe('objective role prompts', () => {
  it('includes the supplied source plan in the planner prompt', () => {
    const existingPlan =
      '## Existing source\n\n- Implement task A after task B.\n- Accept only when EXACT-PLAN-TOKEN passes.'
    const prompt = buildObjectiveRolePrompt({
      role: 'planner',
      contract: { ...contract, existingPlan },
      reason: 'initial',
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty'
    })

    expect(prompt).toContain(existingPlan)
  })

  it('keeps an existing plan out of non-planner prompts', () => {
    const existingPlan = 'RAW-PLAN-MUST-REACH-ONLY-THE-PLANNER'
    const assigned = node('assigned', 'Implement the assigned behavior')
    const inputContract = { ...contract, existingPlan }
    const common = {
      contract: inputContract,
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty' as const
    }
    const prompts = [
      buildObjectiveRolePrompt({
        ...common,
        role: 'implementer',
        node: assigned,
        plan: [assigned]
      }),
      buildObjectiveRolePrompt({ ...common, role: 'reviewer', plan: [assigned] }),
      buildObjectiveRolePrompt({ ...common, role: 'integrator', plan: [assigned] })
    ]

    for (const prompt of prompts) {
      expect(prompt).not.toContain(existingPlan)
    }
  })

  it('gives an implementer exactly its assigned node rather than sibling plan bodies', () => {
    const assigned = node('assigned', 'Implement the assigned behavior')
    const siblingSecret = 'SIBLING-SPEC-MUST-NOT-LEAK'
    const prompt = buildObjectiveRolePrompt({
      role: 'implementer',
      contract,
      node: assigned,
      plan: [assigned, node('sibling', siblingSecret)],
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'tight'
    })

    expect(prompt).toContain('Implement the assigned behavior')
    expect(prompt).toContain('"taskKey":"assigned"')
    expect(prompt).not.toContain(siblingSecret)
    expect(prompt).toContain('BUDGET: tight')
  })

  it('keeps the largest legal implementer node inside the upstream worker-start byte budget', () => {
    const prompt = buildObjectiveRolePrompt({
      role: 'implementer',
      contract: { ...contract, objectiveText: 'o'.repeat(16_384) },
      node: node('largest', 's'.repeat(16_384)),
      reportPath: `/tmp/${'p'.repeat(900)}.json`,
      budgetBucket: 'nearly-spent'
    })

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(
      ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES
    )
  })

  it('requires the complete active plan for a reviewer', () => {
    expect(() =>
      buildObjectiveRolePrompt({
        role: 'reviewer',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty'
      })
    ).toThrow('active plan')
  })
})
