import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import { activeEscalationIds, buildOmissionUnits, type OmissionUnit } from './history-retention'
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
export const JUDGMENT_TRUNCATION_VERSION = 1 as const

export type JudgmentTruncationCounts = {
  existingPlan: number
  revisions: number
  nodes: number
  verdicts: number
  landing: number
  judgmentReports: number
  attempts: number
  approvals: number
  escalations: number
  reports: number
  questionSubjects: number
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

function truncationNotice(truncation: JudgmentTruncation): string {
  const labels: Record<keyof JudgmentTruncationCounts, string> = {
    existingPlan: 'existing plan seed',
    revisions: 'revision(s)',
    nodes: 'node(s)',
    verdicts: 'verdict(s)',
    landing: 'landing record(s)',
    judgmentReports: 'judgment report(s)',
    attempts: 'attempt(s)',
    approvals: 'approval(s)',
    escalations: 'closed escalation(s)',
    reports: 'ledger report(s)',
    questionSubjects: 'historical question subject(s)'
  }
  const summary = (Object.entries(truncation.omitted) as [keyof JudgmentTruncationCounts, number][])
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${labels[key]}`)
    .join(', ')
  return `Judgment state bounded by ${truncation.policy} v${truncation.version}; omitted ${summary}.`
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
    projected = {
      state: JSON.parse(serializedState) as JudgmentState,
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

  const plan = sanitized(world.plan) as {
    revisions: unknown[]
    nodes: unknown[]
    verdicts: unknown[]
    landing: unknown[]
  }
  const reports = sanitized(world.reports)
  const allJudgmentReports = sanitized(world.judgmentReports ?? []) as unknown[]
  const units = buildOmissionUnits(world, ledger)
  const project = (prefix: number): JudgmentStateBudgetResult => {
    const drop = selectionForPrefix(units, prefix)
    const revisions = world.plan.revisions.flatMap((item, index) =>
      drop.revisionIds.has(item.id) ? [] : [plan.revisions[index]]
    )
    const nodes = world.plan.nodes.flatMap((item, index) =>
      drop.revisionIds.has(item.revisionId) ? [] : [plan.nodes[index]]
    )
    const verdicts = world.plan.verdicts.flatMap((item, index) =>
      drop.revisionIds.has(item.revisionId) ? [] : [plan.verdicts[index]]
    )
    const landing = world.plan.landing.flatMap((item, index) =>
      drop.revisionIds.has(item.revisionId) ? [] : [plan.landing[index]]
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
      ? (Object.fromEntries(
          Object.entries(world.contract).filter(([key]) => key !== 'existingPlan')
        ) as ObjectiveWorld['contract'])
      : world.contract
    const truncation: JudgmentTruncation = {
      policy: JUDGMENT_TRUNCATION_POLICY,
      version: JUDGMENT_TRUNCATION_VERSION,
      omitted: {
        existingPlan: drop.existingPlan ? 1 : 0,
        revisions: world.plan.revisions.length - revisions.length,
        nodes: world.plan.nodes.length - nodes.length,
        verdicts: world.plan.verdicts.length - verdicts.length,
        landing: world.plan.landing.length - landing.length,
        judgmentReports: (world.judgmentReports ?? []).length - judgmentReports.length,
        attempts: ledger.attempts.filter((item) => drop.attemptKeys.has(item.key)).length,
        approvals: ledger.approvals.filter((item) => drop.approvalKeys.has(item.key)).length,
        escalations: ledger.escalations.filter((item) => drop.escalationKeys.has(item.key)).length,
        reports: ledger.reports.filter((item) => drop.reportKeys.has(item.key)).length,
        questionSubjects: omittedQuestionSubjectIds.length
      }
    }
    const state: JudgmentState = {
      contentIdentity,
      objective: {
        contract,
        workspaceKind: world.workspaceKind,
        capabilities: world.capabilities,
        judgmentReports,
        plan: { revisions, nodes, verdicts, landing },
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

  if (units.length === 0) {
    return base
  }
  const maximum = project(units.length)
  if (!maximum.fitsStateBudget) {
    return maximum
  }
  // The codec assigns IDs from every sorted value before selecting profitable definitions.
  // Dropping history cannot widen retained refs, and ref-to-inline cutovers remove their table cost,
  // so normalization preserves the monotone prefix-size invariant required by this search.
  let low = 1
  let high = units.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (project(middle).fitsStateBudget) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  return low === units.length ? maximum : project(low)
}
