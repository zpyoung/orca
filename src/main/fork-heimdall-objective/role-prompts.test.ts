import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../shared/orchestration-worker-start-prompt-budget'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../../shared/fork-heimdall/owner/intervention'
import {
  OBJECTIVE_TASK_SPEC_MAX_LENGTH,
  OBJECTIVE_TEXT_MAX_LENGTH,
  type ObjectiveEnrollmentPayload,
  type ObjectiveGate
} from '../../shared/fork-heimdall-objective/contract-types'
import {
  OBJECTIVE_PLAN_MAX_TASKS,
  type ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import { buildObjectiveRolePrompt, type ObjectiveRolePromptInput } from './role-prompts'
import type { RepairPlanContext } from './repair-plan-context'

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

/** Every prompt now needs the live concurrency cap and lane setting; keep test calls terse. */
const parallel = { effectiveMaxConcurrency: 1, lanesEnabled: true }

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
      budgetBucket: 'plenty',
      ...parallel
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
      budgetBucket: 'plenty' as const,
      ...parallel
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
      budgetBucket: 'tight',
      ...parallel
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
      budgetBucket: 'nearly-spent',
      ...parallel
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
        budgetBucket: 'plenty',
        ...parallel
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
      ...parallel,
      failureContext
    })
    const withoutContext = buildObjectiveRolePrompt({
      role: 'planner',
      contract,
      reason: 'replan-after-failure',
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty',
      ...parallel
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
      ...parallel,
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
      ...parallel,
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
      budgetBucket: 'plenty',
      ...parallel
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
      ...parallel,
      requestedSkipStage: 'hosted-review',
      ownerGuidance: rationale
    })

    expect(prompt).toContain('OWNER REQUESTED SKIP STAGE:\nhosted-review')
    expect(prompt).toContain(`OWNER GUIDANCE:\n${rationale}`)
  })

  it('prints the effective concurrency cap for every role', () => {
    const assigned = node('assigned', 'Implement the assigned behavior')
    const common = {
      contract,
      reportPath: '/tmp/objective/report.json',
      budgetBucket: 'plenty' as const,
      effectiveMaxConcurrency: 7,
      lanesEnabled: true
    }
    const planner = buildObjectiveRolePrompt({ ...common, role: 'planner' })
    const implementer = buildObjectiveRolePrompt({
      ...common,
      role: 'implementer',
      node: assigned
    })
    const reviewer = buildObjectiveRolePrompt({ ...common, role: 'reviewer', plan: [assigned] })
    const integrator = buildObjectiveRolePrompt({
      ...common,
      role: 'integrator',
      plan: [assigned]
    })

    for (const prompt of [planner, implementer, reviewer, integrator]) {
      expect(prompt).toContain('CONCURRENCY: 7')
    }
  })

  describe('plan shaping policy', () => {
    it('states the shaping rules for the planner, in C11 order, with the header line exact', () => {
      const prompt = buildObjectiveRolePrompt({
        role: 'planner',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        effectiveMaxConcurrency: 3,
        lanesEnabled: true
      })

      expect(prompt).toContain('PLAN SHAPING POLICY:')
      const order = [
        'Size each node',
        'Tests ship together with the code',
        'Up to 3 nodes run at once.',
        'A node starts only once every dependency is applied',
        'One-to-one dependency chains share one warm session.',
        'A fresh session spends about 30% of a node orienting.',
        'Node checks must be scoped',
        'OBJECTIVE GATES: none declared',
        'Objective gates run the full suite',
        'Every task must declare territory',
        'Declare assumptions naming the task keys'
      ]
      let cursor = -1
      for (const fragment of order) {
        const index = prompt.indexOf(fragment)
        expect(index).toBeGreaterThan(cursor)
        cursor = index
      }
    })

    it('omits the shared-lane line when lanesEnabled is false', () => {
      const prompt = buildObjectiveRolePrompt({
        role: 'planner',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        effectiveMaxConcurrency: 1,
        lanesEnabled: false
      })

      expect(prompt).not.toContain('one warm session')
    })

    it('lists declared objective gates by name, or "none declared"', () => {
      const gates: ObjectiveGate[] = [
        { name: 'lint', command: 'oxlint .', timeoutSeconds: 60 },
        { name: 'typecheck', command: 'tsc --noEmit', timeoutSeconds: 300 }
      ]
      const withGates = buildObjectiveRolePrompt({
        role: 'planner',
        contract: { ...contract, gates },
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel
      })
      const withoutGates = buildObjectiveRolePrompt({
        role: 'planner',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel
      })

      expect(withGates).toContain('OBJECTIVE GATES: lint, typecheck')
      expect(withoutGates).toContain('OBJECTIVE GATES: none declared')
    })

    it('does not render the plan shaping policy for non-planner roles', () => {
      const assigned = node('assigned', 'Implement the assigned behavior')
      const prompt = buildObjectiveRolePrompt({
        role: 'implementer',
        contract,
        node: assigned,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel
      })

      expect(prompt).not.toContain('PLAN SHAPING POLICY')
    })
  })

  describe('planner report contract', () => {
    it('requires territory per task and a top-level assumptions array in the full-plan contract', () => {
      const prompt = buildObjectiveRolePrompt({
        role: 'planner',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel
      })

      expect(prompt).toContain('territory')
      expect(prompt).toContain('assumptions')
      expect(prompt).toContain('"plan":[task,...],"assumptions":[assumption,...]')
    })

    it('replaces the full-plan contract with the repair contract when shape is repair', () => {
      const prompt = buildObjectiveRolePrompt({
        role: 'planner',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel,
        shape: 'repair'
      })

      expect(prompt).toContain('upsertTasks')
      expect(prompt).toContain('dropTaskKeys')
      expect(prompt).toContain('Frozen tasks cannot be changed or dropped')
      expect(prompt).toContain('new tasks may depend on frozen tasks')
      expect(prompt).not.toContain('"plan":[task,...]')
    })
  })

  describe('repair planner context', () => {
    const openTask = node('open-one', 'Finish the remaining slice')
    const repairContext: RepairPlanContext = {
      openTasks: [openTask],
      frozenTasks: [
        {
          taskKey: 'frozen-one',
          title: 'Frozen One',
          state: 'succeeded',
          summary: 'Landed cleanly.',
          filesModified: ['src/a.ts']
        }
      ]
    }

    it('renders the open tasks and frozen tasks sections for a repair planner prompt', () => {
      const prompt = buildObjectiveRolePrompt({
        role: 'planner',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel,
        shape: 'repair',
        repairContext
      })

      expect(prompt).toContain('OPEN TASKS JSON:')
      expect(prompt).toContain('"taskKey":"open-one"')
      expect(prompt).toContain('FROZEN TASKS:')
      expect(prompt).toContain('frozen-one | Frozen One | succeeded | Landed cleanly. | src/a.ts')
    })

    it('renders plan review findings for either report shape', () => {
      const fullShape = buildObjectiveRolePrompt({
        role: 'planner',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel,
        planReviewFindings: 'The prior plan left task ordering ambiguous.'
      })
      const repairShape = buildObjectiveRolePrompt({
        role: 'planner',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel,
        shape: 'repair',
        repairContext,
        planReviewFindings: 'The prior plan left task ordering ambiguous.'
      })

      expect(fullShape).toContain(
        'PLAN REVIEW FINDINGS:\nThe prior plan left task ordering ambiguous.'
      )
      expect(repairShape).toContain(
        'PLAN REVIEW FINDINGS:\nThe prior plan left task ordering ambiguous.'
      )
    })

    it('trims the repair context and appends an OMITTED line when the prompt would otherwise overflow', () => {
      // well past ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES (~1.2MB) before trimming, while
      // staying within OBJECTIVE_PLAN_MAX_TASKS total tasks like a real plan would
      const frozenCount = OBJECTIVE_PLAN_MAX_TASKS - 1
      const hugeRepairContext: RepairPlanContext = {
        openTasks: [node('open-one', 'x'.repeat(OBJECTIVE_TASK_SPEC_MAX_LENGTH))],
        frozenTasks: Array.from({ length: frozenCount }, (_, index) => ({
          taskKey: `frozen-${index}`,
          title: `Frozen ${index}`,
          state: 'succeeded' as const,
          summary: 'y'.repeat(10_000),
          filesModified: [`src/frozen-${index}.ts`],
          completedAtMs: index
        }))
      }
      const input: ObjectiveRolePromptInput = {
        role: 'planner',
        contract,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel,
        shape: 'repair',
        repairContext: hugeRepairContext
      }

      const prompt = buildObjectiveRolePrompt(input)

      expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(
        ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES
      )
      expect(prompt).toContain('OMITTED:')
      // the oldest completedAtMs entries are trimmed before the newest
      expect(prompt).toContain('frozen-0 summary/filesModified')
    })
  })

  describe('implementer scoped checks', () => {
    it('tells the implementer to run only checks scoped to its task, never whole-tree checks', () => {
      const assigned = node('assigned', 'Implement the assigned behavior')
      const prompt = buildObjectiveRolePrompt({
        role: 'implementer',
        contract,
        node: assigned,
        reportPath: '/tmp/objective/report.json',
        budgetBucket: 'plenty',
        ...parallel
      })

      expect(prompt).toContain('Run only the checks scoped to your task')
      expect(prompt).toContain(
        'never the full test suite, a whole-tree typecheck, or whole-tree lint'
      )
    })
  })
})
