import { writeFile } from 'node:fs/promises'
import type { z } from 'zod'
import type { ObjectiveGate } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  ObjectiveAction,
  PlanReviewTargetSchema
} from '../../shared/fork-heimdall-objective/objective-actions'
import { objectiveFrozenTaskKeys } from '../../shared/fork-heimdall-objective/objective-repair-state'
import { deriveObjectiveBudgetBucket } from '../../shared/fork-heimdall-objective/pacing'
import {
  lintObjectivePlan,
  type ObjectivePlanLint
} from '../../shared/fork-heimdall-objective/plan-lint'
import type { PlannerRepairReport } from '../../shared/fork-heimdall-objective/plan-repair-schema'
import type {
  ObjectivePlan,
  ObjectivePlanAssumption
} from '../../shared/fork-heimdall-objective/plan-schema'
import { applyRevisionAmendmentPatch } from '../../shared/fork-heimdall-objective/revision-amendment'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'
import { buildObjectiveRolePrompt } from './role-prompts'

export type PlanReviewTarget = z.infer<typeof PlanReviewTargetSchema>
export type PlanReviewFrozenTask = { taskKey: string; title: string }

export type PlanReviewInput = {
  target: PlanReviewTarget
  plan: ObjectivePlan
  patch?: PlannerRepairReport
  frozenTasks?: readonly PlanReviewFrozenTask[]
  assumptions: readonly ObjectivePlanAssumption[]
  lint: ObjectivePlanLint
  writeTerritory: readonly string[]
  gates: readonly ObjectiveGate[] | undefined
  effectiveMaxConcurrency: number
}

const PLAN_REVIEW_INPUT_MAX_BYTES = 1024 * 1024
const TRUNCATION_MARKER = '…[truncated]'
const TRUNCATED_SPEC_TARGET_CHARS = 200

type SpecLocation = { kind: 'plan' | 'patch'; index: number; spec: string }

/** The next spec to shrink: the longest one still above the truncated target, plan tasks then patch upserts. */
function longestUntruncatedSpec(input: PlanReviewInput): SpecLocation | null {
  let best: SpecLocation | null = null
  const consider = (kind: SpecLocation['kind'], index: number, spec: string): void => {
    if (spec.length > TRUNCATED_SPEC_TARGET_CHARS && (!best || spec.length > best.spec.length)) {
      best = { kind, index, spec }
    }
  }
  input.plan.forEach((task, index) => consider('plan', index, task.spec))
  input.patch?.repair.upsertTasks.forEach((task, index) => consider('patch', index, task.spec))
  return best
}

function withTruncatedSpec(input: PlanReviewInput, location: SpecLocation): PlanReviewInput {
  const nextSpec = `${location.spec.slice(0, TRUNCATED_SPEC_TARGET_CHARS)}${TRUNCATION_MARKER}`
  if (location.kind === 'plan') {
    const plan = input.plan.map((task, index) =>
      index === location.index ? { ...task, spec: nextSpec } : task
    )
    return { ...input, plan }
  }
  const patch = input.patch!
  const upsertTasks = patch.repair.upsertTasks.map((task, index) =>
    index === location.index ? { ...task, spec: nextSpec } : task
  )
  return { ...input, patch: { ...patch, repair: { ...patch.repair, upsertTasks } } }
}

function serializedByteLength(input: PlanReviewInput): number {
  return Buffer.byteLength(JSON.stringify(input), 'utf8')
}

/**
 * Assembles the reviewer's plan-review input: a pure function of already-resolved data (the caller
 * applies a repair patch to its base plan before calling this). Truncates the longest task spec
 * strings first, one at a time, until the serialized input fits the 1 MiB cap or nothing more can
 * be shrunk.
 */
export function buildPlanReviewInput(input: PlanReviewInput): PlanReviewInput {
  let working = input
  while (serializedByteLength(working) > PLAN_REVIEW_INPUT_MAX_BYTES) {
    const location = longestUntruncatedSpec(working)
    if (!location) {
      break
    }
    working = withTruncatedSpec(working, location)
  }
  return working
}

/**
 * Writes the plan-review input JSON beside the issued report path, at
 * `<report directory>/<attemptFingerprint>.plan-review-input.json` — derived from `reportPath`
 * itself rather than a separately-passed fingerprint, since `reportPath`'s basename already is one.
 */
export async function writePlanReviewInputFile(
  target: ObjectiveWorkspaceTarget,
  reportPath: string,
  input: PlanReviewInput
): Promise<string> {
  const pathFlavor = resolveLeasePathFlavor(target.executionHostId, reportPath)
  const directory = pathFlavor.dirname(reportPath)
  const fingerprintName = pathFlavor.basename(reportPath, '.json')
  const inputPath = pathFlavor.join(directory, `${fingerprintName}.plan-review-input.json`)
  const serialized = JSON.stringify(input)
  if (target.fileProvider) {
    await target.fileProvider.writeFile(inputPath, serialized)
    return inputPath
  }
  if (target.executionHostId !== 'local') {
    throw new Error('Remote objective target has no filesystem provider')
  }
  await writeFile(inputPath, serialized, { encoding: 'utf8', mode: 0o600 })
  return inputPath
}

function requireDispatchPlan(objectiveStore: ObjectiveStore, revisionId: string): ObjectivePlan {
  const plan = objectiveStore.getPlan(revisionId)
  if (!plan) {
    throw new Error(`Objective plan revision ${revisionId} is unavailable`)
  }
  return plan
}

/** Per task: key, title, deps, territory, and any lint codes raised against it — for the dispatch prompt. */
function planReviewCompactSummary(plan: ObjectivePlan, lint: ObjectivePlanLint): string {
  const codesByTask = new Map<string, string[]>()
  for (const finding of lint.findings) {
    if (finding.taskKey !== null) {
      codesByTask.set(finding.taskKey, [...(codesByTask.get(finding.taskKey) ?? []), finding.code])
    }
  }
  return plan
    .map((task) => {
      const codes = codesByTask.get(task.taskKey)
      const deps = task.deps.length > 0 ? task.deps.join(', ') : 'none'
      const territory =
        task.territory && task.territory.length > 0 ? task.territory.join(', ') : 'none'
      return `${task.taskKey} | ${task.title} | deps: ${deps} | territory: ${territory}${codes ? ` | lint: ${codes.join(',')}` : ''}`
    })
    .join('\n')
}

/**
 * Resolves a dispatched plan-review target from the live store into its written input file and a
 * compact dispatch-prompt summary. A patch target's `plan` is the current approved plan with the
 * patch applied via `applyRevisionAmendmentPatch`; its declared assumptions are the patch's own,
 * not the revision's already-reviewed ones.
 */
export async function resolveObjectivePlanReviewDispatch(args: {
  target: PlanReviewTarget
  objectiveStore: ObjectiveStore
  world: ObjectiveWorld
  ledger: WatcherLedger
  writeTerritory: readonly string[]
  gates: readonly ObjectiveGate[] | undefined
  effectiveMaxConcurrency: number
  workspaceTarget: ObjectiveWorkspaceTarget
  reportPath: string
}): Promise<{ inputPath: string; summary: string }> {
  const { target, objectiveStore } = args
  let plan: ObjectivePlan
  let assumptions: readonly ObjectivePlanAssumption[]
  let patch: PlannerRepairReport | undefined
  let frozenTasks: PlanReviewFrozenTask[] | undefined
  let frozenTaskKeys: ReadonlySet<string> | undefined
  if (target.kind === 'revision') {
    const report = objectiveStore.getPlanReport(target.revisionId)
    if (!report) {
      throw new Error(`Objective plan revision ${target.revisionId} is unavailable`)
    }
    plan = report.plan
    assumptions = report.assumptions ?? []
  } else {
    const patchRecord = objectiveStore.getPlanPatch(target.patchId)
    if (!patchRecord) {
      throw new Error(`Objective plan patch ${target.patchId} is unavailable`)
    }
    const currentPlan = requireDispatchPlan(objectiveStore, patchRecord.revisionId)
    const amended = applyRevisionAmendmentPatch(currentPlan, {
      digest: patchRecord.digest,
      attestation: 'plan-review-input',
      upsertTasks: patchRecord.report.repair.upsertTasks,
      dropTaskKeys: patchRecord.report.repair.dropTaskKeys
    })
    if (!amended.ok) {
      throw new Error(`Plan patch ${target.patchId} produces an invalid plan: ${amended.detail}`)
    }
    plan = amended.plan
    patch = patchRecord.report
    assumptions = patchRecord.report.assumptions ?? []
    frozenTaskKeys = objectiveFrozenTaskKeys(args.world, args.ledger, patchRecord.revisionId)
    frozenTasks = [...frozenTaskKeys].map((taskKey) => ({
      taskKey,
      title: currentPlan.find((task) => task.taskKey === taskKey)?.title ?? taskKey
    }))
  }
  const lint = lintObjectivePlan({
    plan,
    assumptions,
    writeTerritory: args.writeTerritory,
    gates: args.gates,
    frozenTaskKeys
  })
  const input = buildPlanReviewInput({
    target,
    plan,
    ...(patch === undefined ? {} : { patch }),
    ...(frozenTasks === undefined ? {} : { frozenTasks }),
    assumptions,
    lint,
    writeTerritory: args.writeTerritory,
    gates: args.gates,
    effectiveMaxConcurrency: args.effectiveMaxConcurrency
  })
  const inputPath = await writePlanReviewInputFile(args.workspaceTarget, args.reportPath, input)
  return { inputPath, summary: planReviewCompactSummary(plan, lint) }
}

function planReviewDispatchTaskKey(target: PlanReviewTarget, round: 1 | 2): string {
  return `objective-plan-review-${planReviewRoutingScope(target)}-${round}`
}

/** The dispatch's routing/agent-judgment scope: the revision or patch id it is reviewing. */
export function planReviewRoutingScope(target: PlanReviewTarget): string {
  return target.kind === 'revision' ? target.revisionId : target.patchId
}

/** Resolves the store data, writes the input file, and builds the reviewer's plan-review dispatch spec. */
export async function preparePlanReviewDispatchSpec(args: {
  action: Extract<ObjectiveAction, { kind: 'dispatch-plan-review' }>
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  world: ObjectiveWorld
  ledger: WatcherLedger
  workspaceTarget: ObjectiveWorkspaceTarget
  reportPath: string
}): Promise<{ role: 'reviewer'; taskKey: string; spec: string }> {
  const { action, binding } = args
  const effectiveMaxConcurrency = args.world.parallel?.effectiveMaxConcurrency ?? 1
  const { inputPath, summary } = await resolveObjectivePlanReviewDispatch({
    target: action.target,
    objectiveStore: args.objectiveStore,
    world: args.world,
    ledger: args.ledger,
    writeTerritory: binding.contract.writeTerritory,
    gates: binding.contract.gates,
    effectiveMaxConcurrency,
    workspaceTarget: args.workspaceTarget,
    reportPath: args.reportPath
  })
  return {
    role: 'reviewer',
    taskKey: planReviewDispatchTaskKey(action.target, action.round),
    spec: buildObjectiveRolePrompt({
      role: 'reviewer',
      contract: binding.contract,
      reportPath: args.reportPath,
      budgetBucket: deriveObjectiveBudgetBucket(args.ledger, binding.enrollment.budget),
      effectiveMaxConcurrency,
      lanesEnabled: binding.contract.lanesEnabled !== false,
      mode: 'plan-review',
      planReviewInputPath: inputPath,
      planReviewSummary: summary
    })
  }
}
