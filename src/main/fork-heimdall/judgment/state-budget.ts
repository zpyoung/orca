import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import { activeEscalationIds, buildOmissionUnits, type OmissionUnit } from './history-retention'
import { searchMinimalOmissionPrefix } from './omission-budget-search'
import {
  normalizeJudgmentState,
  type JudgmentNormalizationResult,
  type JudgmentNormalizationStats,
  type JudgmentWireState
} from './state-normalization'
import {
  compareCodeUnits,
  projectLedgerState,
  projectRelevantLedger,
  sanitized,
  stableJson,
  type JudgmentLedgerState
} from './state-projection'

export const JUDGMENT_TRUNCATION_POLICY = 'oldest-history-first' as const
export const JUDGMENT_TRUNCATION_VERSION = 2 as const

export type JudgmentTruncationCounts = {
  existingPlan: number
  revisions: number
  patches: number
  planReviews: number
  nodes: number
  verdicts: number
  landing: number
  judgmentReports: number
  attempts: number
  approvals: number
  escalations: number
  reports: number
  questionSubjects: number
  clippedCriterionStrings: number
  clippedCodeUnits: number
}

export type JudgmentTruncation = {
  policy: typeof JUDGMENT_TRUNCATION_POLICY
  version: typeof JUDGMENT_TRUNCATION_VERSION
  omitted: JudgmentTruncationCounts
}

export type JudgmentState = {
  contentIdentity: string
  objective: {
    contract: ObjectiveWorld['contract']
    workspaceKind: ObjectiveWorld['workspaceKind']
    capabilities: ObjectiveWorld['capabilities']
    plan: unknown
    reports: unknown
    landingContext: ObjectiveWorld['landingContext']
    judgmentReports: unknown
  }
  ledger: JudgmentLedgerState
  truncation?: JudgmentTruncation
}

export type JudgmentStateBudgetResult = {
  state: JudgmentWireState<JudgmentState>
  serializedState: string
  serializedBytes: number
  fitsStateBudget: boolean
  omittedQuestionSubjectIds: readonly string[]
  truncation: JudgmentTruncation | null
  truncationNotice: string | null
  normalization: JudgmentNormalizationStats | null
  normalizationNotice: string | null
}

type DropSelection = {
  existingPlan: boolean
  revisionIds: Set<string>
  attemptKeys: Set<string>
  approvalKeys: Set<string>
  escalationKeys: Set<string>
  reportKeys: Set<string>
  judgmentReportIndexes: Set<number>
  subjectIds: Set<string>
}

function selectionForPrefix(units: readonly OmissionUnit[], count: number): DropSelection {
  const selected: DropSelection = {
    existingPlan: false,
    revisionIds: new Set(),
    attemptKeys: new Set(),
    approvalKeys: new Set(),
    escalationKeys: new Set(),
    reportKeys: new Set(),
    judgmentReportIndexes: new Set(),
    subjectIds: new Set()
  }
  for (const unit of units.slice(0, count)) {
    selected.existingPlan ||= unit.existingPlan === true
    if (unit.revisionId) {
      selected.revisionIds.add(unit.revisionId)
    }
    for (const key of unit.attemptKeys) {
      selected.attemptKeys.add(key)
    }
    for (const key of unit.approvalKeys) {
      selected.approvalKeys.add(key)
    }
    for (const key of unit.escalationKeys) {
      selected.escalationKeys.add(key)
    }
    for (const key of unit.reportKeys) {
      selected.reportKeys.add(key)
    }
    for (const index of unit.judgmentReportIndexes) {
      selected.judgmentReportIndexes.add(index)
    }
    for (const id of unit.subjectIds) {
      selected.subjectIds.add(id)
    }
  }
  return selected
}

function typedEntries<T extends Record<string, unknown>>(value: T): [keyof T, T[keyof T]][] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.entries widens key/value types even for a statically known object shape; this generic helper restores them once instead of at each call site.
  return Object.entries(value) as [keyof T, T[keyof T]][]
}

function truncationNotice(truncation: JudgmentTruncation): string {
  const labels: Record<keyof JudgmentTruncationCounts, string> = {
    existingPlan: 'existing plan seed',
    revisions: 'revision(s)',
    patches: 'patch(es)',
    planReviews: 'plan review(s)',
    nodes: 'node(s)',
    verdicts: 'verdict(s)',
    landing: 'landing record(s)',
    judgmentReports: 'judgment report(s)',
    attempts: 'attempt(s)',
    approvals: 'approval(s)',
    escalations: 'closed escalation(s)',
    reports: 'ledger report(s)',
    questionSubjects: 'historical question subject(s)',
    clippedCriterionStrings: 'criterion string(s)',
    clippedCodeUnits: 'code units'
  }
  const summary = typedEntries(truncation.omitted)
    .filter(
      ([key, count]) => key !== 'clippedCriterionStrings' && key !== 'clippedCodeUnits' && count > 0
    )
    .map(([key, count]) => `${count} ${labels[key]}`)
    .join(', ')
  const clipped = truncation.omitted.clippedCriterionStrings
  const clippingNotice =
    clipped > 0
      ? `; clipped ${clipped} criterion string(s) to ${truncation.omitted.clippedCodeUnits} code units`
      : ''
  return `Judgment state bounded by ${truncation.policy} v${truncation.version}; omitted ${summary || 'nothing'}${clippingNotice}.`
}

function normalizationNotice(normalization: JudgmentNormalizationStats): string {
  return `Judgment state shared-string normalization encoded ${normalization.stringCount} repeated string(s) at ${normalization.referenceCount} location(s), saving ${normalization.savedBytes} bytes.`
}

function budgetResult(
  state: JudgmentState,
  maxStateBytes: number | undefined,
  omittedQuestionSubjectIds: readonly string[],
  truncation: JudgmentTruncation | null,
  notice: string | null,
  normalize: boolean
): JudgmentStateBudgetResult {
  let projected: JudgmentNormalizationResult<JudgmentState>
  if (normalize) {
    projected = normalizeJudgmentState(state)
  } else {
    const serializedState = stableJson(state)
    const parsedState: JudgmentState = JSON.parse(serializedState)
    projected = {
      state: parsedState,
      serializedState,
      serializedBytes: Buffer.byteLength(serializedState, 'utf8'),
      normalization: null
    }
  }
  return {
    ...projected,
    fitsStateBudget: projected.serializedBytes <= (maxStateBytes ?? Number.MAX_SAFE_INTEGER),
    omittedQuestionSubjectIds,
    truncation,
    truncationNotice: notice,
    normalizationNotice:
      projected.normalization === null ? null : normalizationNotice(projected.normalization)
  }
}

export function projectBoundedJudgmentState(
  contentIdentity: string,
  world: ObjectiveWorld,
  sourceLedger: WatcherLedger,
  options: { maxStateBytes?: number; normalize?: boolean } = {}
): JudgmentStateBudgetResult {
  const { maxStateBytes, normalize = true } = options
  const ledger = projectRelevantLedger(sourceLedger)
  const baseState: JudgmentState = {
    contentIdentity,
    objective: {
      contract: world.contract,
      workspaceKind: world.workspaceKind,
      capabilities: world.capabilities,
      judgmentReports: sanitized(world.judgmentReports ?? []),
      plan: sanitized(world.plan),
      reports: sanitized(world.reports),
      landingContext: world.landingContext
    },
    ledger: projectLedgerState(ledger)
  }
  const base = budgetResult(baseState, maxStateBytes, [], null, null, normalize)
  if (maxStateBytes === undefined || base.fitsStateBudget) {
    return base
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sanitized() preserves the plan's array structure while removing volatile fields.
  const plan = sanitized(world.plan) as {
    revisions: unknown[]
    nodes: unknown[]
    verdicts: unknown[]
    landing: unknown[]
    patches?: unknown[]
    planReviews?: unknown[]
    gateAttempts?: unknown[]
  }
  const reports = sanitized(world.reports)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sanitized() is generically typed unknown -> unknown; world.judgmentReports is always an array.
  const allJudgmentReports = sanitized(world.judgmentReports ?? []) as unknown[]
  const units = buildOmissionUnits(world, ledger)
  const project = (prefix: number, criterionCap?: number): JudgmentStateBudgetResult => {
    const drop = selectionForPrefix(units, prefix)
    const revisions = world.plan.revisions.flatMap((item, index) =>
      drop.revisionIds.has(item.id) ? [] : [plan.revisions[index]]
    )
    let clippedCriterionStrings = 0
    const clip = (text: string): string => {
      if (criterionCap === undefined || text.length <= criterionCap) {
        return text
      }
      clippedCriterionStrings++
      return `${text.slice(0, criterionCap)}…`
    }
    const nodes = world.plan.nodes.flatMap((item, index) => {
      if (drop.revisionIds.has(item.revisionId)) {
        return []
      }
      if (criterionCap === undefined) {
        return [plan.nodes[index]]
      }
      let changed = false
      const criteria = item.criteria.map((criterion) => {
        const body = clip(criterion.body)
        const checkCommand = criterion.checkCommand === null ? null : clip(criterion.checkCommand)
        if (body === criterion.body && checkCommand === criterion.checkCommand) {
          return criterion
        }
        changed = true
        return { ...criterion, body, checkCommand }
      })
      return [changed ? sanitized({ ...item, criteria }) : plan.nodes[index]]
    })
    const verdicts = world.plan.verdicts.flatMap((item, index) =>
      drop.revisionIds.has(item.revisionId) ? [] : [plan.verdicts[index]]
    )
    const landing = world.plan.landing.flatMap((item, index) =>
      drop.revisionIds.has(item.revisionId) ? [] : [plan.landing[index]]
    )
    const droppedPatchIds = new Set<string>()
    const patches = world.plan.patches?.flatMap((item, index) => {
      if (drop.revisionIds.has(item.revisionId)) {
        droppedPatchIds.add(item.id)
        return []
      }
      return [plan.patches?.[index]]
    })
    const planReviews = world.plan.planReviews?.flatMap((item, index) =>
      (item.targetKind === 'revision' && drop.revisionIds.has(item.targetId)) ||
      (item.targetKind === 'patch' && droppedPatchIds.has(item.targetId))
        ? []
        : [plan.planReviews?.[index]]
    )
    const judgmentReports = allJudgmentReports.filter(
      (_, index) => !drop.judgmentReportIndexes.has(index)
    )
    const retainedSubjects = new Set<string>()
    for (const item of ledger.attempts) {
      if (!drop.attemptKeys.has(item.key)) {
        retainedSubjects.add(item.subjectId)
      }
    }
    for (const item of ledger.reports) {
      if (!drop.reportKeys.has(item.key)) {
        retainedSubjects.add(item.subjectId)
      }
    }
    for (const [index, item] of (world.judgmentReports ?? []).entries()) {
      if (!drop.judgmentReportIndexes.has(index)) {
        retainedSubjects.add(item.dispatchId)
      }
    }
    const escalation = activeEscalationIds(ledger)
    if (escalation.messageId) {
      retainedSubjects.add(escalation.messageId)
    }
    if (escalation.dispatchId) {
      retainedSubjects.add(escalation.dispatchId)
    }
    const omittedQuestionSubjectIds = [...drop.subjectIds]
      .filter((id) => !retainedSubjects.has(id))
      .sort(compareCodeUnits)
    const contract = drop.existingPlan
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.fromEntries widens back to a generic index type; this filter only ever removes the optional existingPlan key from a value already known to be ObjectiveWorld['contract'].
        (Object.fromEntries(
          Object.entries(world.contract).filter(([key]) => key !== 'existingPlan')
        ) as ObjectiveWorld['contract'])
      : world.contract
    const truncation: JudgmentTruncation = {
      policy: JUDGMENT_TRUNCATION_POLICY,
      version: JUDGMENT_TRUNCATION_VERSION,
      omitted: {
        existingPlan: drop.existingPlan ? 1 : 0,
        revisions: world.plan.revisions.length - revisions.length,
        patches: (world.plan.patches?.length ?? 0) - (patches?.length ?? 0),
        planReviews: (world.plan.planReviews?.length ?? 0) - (planReviews?.length ?? 0),
        nodes: world.plan.nodes.length - nodes.length,
        verdicts: world.plan.verdicts.length - verdicts.length,
        landing: world.plan.landing.length - landing.length,
        judgmentReports: (world.judgmentReports ?? []).length - judgmentReports.length,
        attempts: ledger.attempts.filter((item) => drop.attemptKeys.has(item.key)).length,
        approvals: ledger.approvals.filter((item) => drop.approvalKeys.has(item.key)).length,
        escalations: ledger.escalations.filter((item) => drop.escalationKeys.has(item.key)).length,
        reports: ledger.reports.filter((item) => drop.reportKeys.has(item.key)).length,
        questionSubjects: omittedQuestionSubjectIds.length,
        clippedCriterionStrings,
        clippedCodeUnits: clippedCriterionStrings > 0 ? (criterionCap ?? 0) : 0
      }
    }
    const state: JudgmentState = {
      contentIdentity,
      objective: {
        contract,
        workspaceKind: world.workspaceKind,
        capabilities: world.capabilities,
        judgmentReports,
        plan: {
          ...plan,
          revisions,
          nodes,
          verdicts,
          landing,
          ...(patches === undefined ? {} : { patches }),
          ...(planReviews === undefined ? {} : { planReviews })
        },
        reports,
        landingContext: world.landingContext
      },
      ledger: projectLedgerState(ledger, drop),
      truncation
    }
    return budgetResult(
      state,
      maxStateBytes,
      omittedQuestionSubjectIds,
      truncation,
      truncationNotice(truncation),
      normalize
    )
  }

  // The codec assigns IDs from every sorted value before selecting profitable definitions.
  // Dropping history cannot widen retained refs, and ref-to-inline cutovers remove their table cost,
  // so normalization preserves the monotone prefix-size invariant required by this search.
  const found = searchMinimalOmissionPrefix(units.length, project)
  if (found?.result.fitsStateBudget) {
    return found.result
  }
  const maximumPrefix = units.length
  const ceiling = project(maximumPrefix, 8_192)
  if (ceiling.fitsStateBudget) {
    return ceiling
  }
  const floor = project(maximumPrefix, 256)
  if (floor.truncation?.omitted.clippedCriterionStrings === 0) {
    return found?.result ?? base
  }
  if (!floor.fitsStateBudget) {
    return floor
  }
  let low = 256
  let high = 8_192
  let best = floor
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = project(maximumPrefix, middle)
    if (candidate.fitsStateBudget) {
      low = middle
      best = candidate
    } else {
      high = middle - 1
    }
  }
  return best
}
