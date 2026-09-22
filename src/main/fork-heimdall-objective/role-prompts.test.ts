import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../shared/orchestration-worker-start-prompt-budget'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../../shared/fork-heimdall/owner/intervention'
import {
  OBJECTIVE_TASK_SPEC_MAX_LENGTH,
  OBJECTIVE_TEXT_MAX_LENGTH,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
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
      contract: { ...contract, objectiveText: '界'.repeat(OBJECTIVE_TEXT_MAX_LENGTH) },
      node: node('largest', '界'.repeat(OBJECTIVE_TASK_SPEC_MAX_LENGTH)),
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

  it('renders failure context for a planner replan when supplied, but not otherwise', () => {
    const failureContext = {
      taskKey: 'core',
      failureClass: 'criteria' as const,
      narrative: 'The worker could not make the health check pass.',
      failingCriteria: ['Health check returns 200']
    }
    const withContext = buildObjectiveRolePrompt({
      role: 'planner',
      contract,
      reason: 'replan-after-failure',
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty',
      failureContext
    })
    const withoutContext = buildObjectiveRolePrompt({
      role: 'planner',
      contract,
      reason: 'replan-after-failure',
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty'
    })

    expect(withContext).toContain('FAILED TASK: core (criteria)')
    expect(withContext).toContain('The worker could not make the health check pass.')
    expect(withContext).toContain('Health check returns 200')
    expect(withoutContext).not.toContain('FAILED TASK')
  })

  it('renders failure context without a parenthetical when the failure class is not yet known', () => {
    const prompt = buildObjectiveRolePrompt({
      role: 'planner',
      contract,
      reason: 'replan-after-failure',
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty',
      failureContext: {
        taskKey: 'core',
        narrative: 'The worker exited before self-assessing any criterion.',
        failingCriteria: []
      }
    })

    expect(prompt).toContain('FAILED TASK: core')
    expect(prompt).not.toContain('FAILED TASK: core (')
    expect(prompt).not.toContain('FAILING CRITERIA')
  })

  it('renders plan progress for a planner replan when supplied, but not otherwise', () => {
    const withProgress = buildObjectiveRolePrompt({
      role: 'planner',
      contract,
      reason: 'replan-after-block',
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty',
      planProgress: [
        { taskKey: 'core', state: 'succeeded' },
        { taskKey: 'follow-up', state: 'pending' }
      ]
    })
    const withoutProgress = buildObjectiveRolePrompt({
      role: 'planner',
      contract,
      reason: 'replan-after-block',
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty'
    })

    expect(withProgress).toContain('PLAN PROGRESS:')
    expect(withProgress).toContain('- core: succeeded')
    expect(withProgress).toContain('- follow-up: pending')
    expect(withoutProgress).not.toContain('PLAN PROGRESS')
  })
  it('keeps a requested skip stage structurally separate from the full owner rationale', () => {
    const rationale = 'r'.repeat(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
    const prompt = buildObjectiveRolePrompt({
      role: 'planner',
      contract,
      reason: 'owner-directed',
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty',
      requestedSkipStage: 'hosted-review',
      ownerGuidance: rationale
    })

    expect(prompt).toContain('OWNER REQUESTED SKIP STAGE:\nhosted-review')
    expect(prompt).toContain(`OWNER GUIDANCE:\n${rationale}`)
  })
})
