import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../shared/orchestration-worker-start-prompt-budget'
import type {
  ObjectiveBudgetBucket,
  ObjectiveNodeState,
  ObjectiveReviewRole
} from '../../shared/fork-heimdall-objective/detail-types'
import type {
  ObjectiveEnrollmentPayload,
  ObjectiveRole
} from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveFailureClass } from '../../shared/fork-heimdall/effect-certainty'
import type {
  ObjectivePlan,
  ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { Store } from '../persistence'

export type ObjectiveFailureContext = {
  taskKey: string
  failureClass?: ObjectiveFailureClass
  narrative: string
  failingCriteria: readonly string[]
}

export type ObjectiveRolePromptInput = {
  role: ObjectiveRole
  contract: ObjectiveEnrollmentPayload
  reportPath: string
  budgetBucket: ObjectiveBudgetBucket
  node?: ObjectivePlanTask
  plan?: ObjectivePlan
  reason?: 'initial' | 'replan-after-block' | 'replan-after-failure'
  failureContext?: ObjectiveFailureContext
  planProgress?: readonly { taskKey: string; state: ObjectiveNodeState }[]
}

function reportContract(role: ObjectiveRole): string {
  switch (role) {
    case 'planner':
      return [
        'Write one strict JSON object: {"plan":[task,...]}.',
        'Each task is {taskKey,title,spec,deps,criteria,declaresDependencyChange,declaredPaths?}.',
        'Each criterion is {body,shellCheckable,checkCommand}; checkCommand is non-null exactly when shellCheckable is true.',
        'Task keys are unique, dependencies name other tasks, and the graph is acyclic.',
        'When known, declaredPaths contains only concrete workspace-relative file paths inside write territory.',
        'Never use globs or copy write-territory patterns into declaredPaths; omit declaredPaths when exact files are unknown.'
      ].join('\n')
    case 'implementer':
      return [
        'Write one strict JSON object: {taskKey,summary,filesModified,criteriaSelfAssessment}.',
        'Assess every criterion exactly once with {criterionIndex,result:"pass"|"fail"|"unknown",note}.',
        'pass: the criterion is met and you verified it. fail: the criterion is genuinely not met. unknown: you could not determine it, typically because something environmental blocked verification.',
        'Never report unknown for a criterion you know has failed, and never report pass for one you could not verify; an environment-dependent criterion you cannot verify is unknown, with a note on what blocked it.',
        'Every modified path must be workspace-relative and inside write territory.'
      ].join('\n')
    case 'reviewer':
      return [
        'Write one strict JSON object: {verdict:"approve"|"block",criteriaResults,summary}.',
        'Cover every plan criterion exactly once with {taskKey,criterionIndex,result:"pass"|"block",note}.',
        'The verdict must be block exactly when at least one criterion blocks.'
      ].join('\n')
    case 'integrator':
      return [
        'Write one strict JSON object: {verdict:"approve"|"block",criteriaResults,summary,checksRun}.',
        'Cover every plan criterion exactly once. checksRun entries are {command,exitCode}.',
        'The verdict must be block exactly when at least one criterion blocks.'
      ].join('\n')
  }
}

function roleInstruction(input: ObjectiveRolePromptInput): string {
  switch (input.role) {
    case 'planner':
      return `Produce the next implementable plan. Planning reason: ${input.reason ?? 'initial'}. Do not edit files. Do not assert environment facts you only observed in your own shell as guaranteed for the implementer; write environment-dependent steps so the implementer verifies them itself.`
    case 'implementer':
      if (!input.node) {
        throw new Error('An implementer prompt requires exactly one plan node')
      }
      return 'Implement only the assigned node. You may inspect context, but modify only declared write territory. Run focused checks when useful.'
    case 'reviewer':
      return 'Review the files on disk against every active-plan criterion. Do not modify files.'
    case 'integrator':
      return 'Integrate and repair the files on disk as needed, then evaluate every active-plan criterion.'
  }
}

function planReviewView(plan: ObjectivePlan): unknown {
  return plan.map((task) => ({
    taskKey: task.taskKey,
    title: task.title,
    deps: task.deps,
    criteria: task.criteria
  }))
}

function existingPlanContext(input: ObjectiveRolePromptInput): string[] {
  const existingPlan = input.contract.existingPlan
  if (input.role !== 'planner' || !existingPlan) {
    return []
  }

  const normalizationInstruction =
    (input.reason ?? 'initial') === 'initial'
      ? [
          'Normalize the source plan into the strict planner report contract.',
          'Preserve its scope, tasks, dependencies, and acceptance criteria; only fill in details needed to make it executable under this objective contract.',
          'Do not replace it with a newly designed plan.'
        ].join('\n')
      : [
          'Use the source plan as context for this replan, adapting it as needed for the stated replanning reason while preserving the objective.',
          'Account for work already completed; do not force completed tasks to run again.'
        ].join('\n')

  return [
    `USER-SUPPLIED EXISTING PLAN SOURCE - BEGIN\n${existingPlan}\nUSER-SUPPLIED EXISTING PLAN SOURCE - END`,
    [
      normalizationInstruction,
      'The source is not direct-execution authorization: objective capability modes and approval gates remain unchanged.'
    ].join('\n')
  ]
}

function failureContextSection(input: ObjectiveRolePromptInput): string[] {
  if (input.role !== 'planner' || !input.failureContext) {
    return []
  }
  const { taskKey, failureClass, narrative, failingCriteria } = input.failureContext
  const lines = [
    `FAILED TASK: ${taskKey}${failureClass === undefined ? '' : ` (${failureClass})`}`,
    `WORKER NARRATIVE:\n${narrative}`
  ]
  if (failingCriteria.length > 0) {
    lines.push(
      `FAILING CRITERIA:\n${failingCriteria.map((criterion) => `- ${criterion}`).join('\n')}`
    )
  }
  return [lines.join('\n')]
}

function planProgressSection(input: ObjectiveRolePromptInput): string[] {
  if (input.role !== 'planner' || !input.planProgress || input.planProgress.length === 0) {
    return []
  }
  return [
    `PLAN PROGRESS:\n${input.planProgress.map((node) => `- ${node.taskKey}: ${node.state}`).join('\n')}`
  ]
}

function roleContext(input: ObjectiveRolePromptInput): string[] {
  if (input.role === 'planner') {
    return [
      ...existingPlanContext(input),
      ...failureContextSection(input),
      ...planProgressSection(input)
    ]
  }
  if (input.role === 'implementer') {
    return [`ASSIGNED NODE JSON:\n${JSON.stringify(input.node)}`]
  }
  if (input.role === 'reviewer' || input.role === 'integrator') {
    if (!input.plan) {
      throw new Error(`${input.role} prompt requires the active plan`)
    }
    return [`ACTIVE PLAN REVIEW VIEW JSON:\n${JSON.stringify(planReviewView(input.plan))}`]
  }
  return []
}

function finishInstructions(reportPath: string): string {
  return [
    `Write the JSON report atomically to this exact absolute path: ${JSON.stringify(reportPath)}`,
    'Then finish using the worker identifiers Orca supplied in your preamble:',
    `orca orchestration send --from <workerHandle> --type worker_done --outcome succeeded --task-id <taskId> --dispatch-id <dispatchId> --report-path ${JSON.stringify(reportPath)} [--files-modified a,b,c] --subject "<one line>" --body "<summary>"`,
    'If the work itself failed, still write the most complete valid report possible and send worker_done with --outcome failed.'
  ].join('\n')
}

export function buildObjectiveRolePrompt(input: ObjectiveRolePromptInput): string {
  const sections = [
    `ROLE: Objective ${input.role}`,
    `OBJECTIVE:\n${input.contract.objectiveText}`,
    `TIER: ${input.contract.tier}`,
    `LANDING BAR: ${input.contract.landingBar}`,
    `BUDGET: ${input.budgetBucket}`,
    'CONCURRENCY: 1',
    `WRITE TERRITORY:\n${input.contract.writeTerritory.map((path) => `- ${path}`).join('\n')}`,
    roleInstruction(input),
    ...roleContext(input),
    `REPORT CONTRACT:\n${reportContract(input.role)}`,
    finishInstructions(input.reportPath)
  ]
  const prompt = sections.join('\n\n')
  const bytes = Buffer.byteLength(prompt, 'utf8')
  if (bytes > ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES) {
    throw new Error(
      `Objective ${input.role} prompt is ${bytes} bytes; maximum is ${ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES}`
    )
  }
  return prompt
}

export function resolveObjectiveRoleAgent(
  store: Pick<Store, 'getSettings'>,
  contract: ObjectiveEnrollmentPayload,
  role: ObjectiveRole | ObjectiveReviewRole,
  judgmentRecommendation?: string
): string {
  const settings = store.getSettings()
  const configuredAlternatives = Object.values(contract.roleAgents)
  if (
    judgmentRecommendation !== undefined &&
    configuredAlternatives.includes(judgmentRecommendation) &&
    isTuiAgent(judgmentRecommendation) &&
    isTuiAgentEnabled(judgmentRecommendation, settings.disabledTuiAgents)
  ) {
    return judgmentRecommendation
  }
  const selected = contract.roleAgents[role] ?? settings.defaultTuiAgent
  if (!isTuiAgent(selected) || !isTuiAgentEnabled(selected, settings.disabledTuiAgents)) {
    throw new Error(`No enabled TUI agent is configured for the objective ${role} role`)
  }
  return selected
}
