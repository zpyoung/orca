import { activeObjectiveRevision } from '../../../shared/fork-heimdall-objective/decision-context'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import { lineageBaseIdentity } from '../../../shared/fork-heimdall-objective/landing-ladder'
import {
  numberField,
  stableJson,
  stringField,
  type AttemptItem,
  type LedgerProjection,
  type ReportItem
} from './state-projection'

export type OmissionUnit = {
  atMs: number
  sourceIndex: number
  ordinal: number
  existingPlan?: true
  revisionId?: string
  attemptKeys: readonly string[]
  approvalKeys: readonly string[]
  escalationKeys: readonly string[]
  reportKeys: readonly string[]
  judgmentReportIndexes: readonly number[]
  gateAttemptIndexes: readonly number[]
  subjectIds: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type SubjectGroup = {
  subjectId: string
  attempts: AttemptItem[]
  reports: ReportItem[]
  judgmentReportIndexes: number[]
}

function emptyUnit(ordinal: number): OmissionUnit {
  return {
    atMs: -1,
    sourceIndex: -1,
    ordinal,
    attemptKeys: [],
    approvalKeys: [],
    escalationKeys: [],
    reportKeys: [],
    judgmentReportIndexes: [],
    gateAttemptIndexes: [],
    subjectIds: []
  }
}

function revisionMatchesAttempt(
  revision: ObjectiveWorld['plan']['revisions'][number],
  attempt: AttemptItem
): boolean {
  return (
    stringField(attempt.action, 'revisionId') === revision.id ||
    numberField(attempt.action, 'revisionNumber') === revision.number ||
    attempt.subjectId === revision.createdByDispatchId
  )
}

export function activeEscalationIds(ledger: LedgerProjection): {
  messageId?: string
  dispatchId?: string
} {
  if (!isRecord(ledger.latestEscalation)) {
    return {}
  }
  const escalation = ledger.latestEscalation
  const messageId = stringField(escalation, 'subjectId')
  const payload = escalation.payload
  const dispatchId = isRecord(payload) ? stringField(payload, 'dispatchId') : undefined
  return {
    ...(messageId === undefined ? {} : { messageId }),
    ...(dispatchId === undefined ? {} : { dispatchId })
  }
}

function reportWasConsumed(candidate: SubjectGroup, world: ObjectiveWorld): boolean {
  const dispatch = candidate.attempts.find((attempt) =>
    stringField(attempt.action, 'kind')?.startsWith('dispatch-')
  )
  const kind = dispatch && stringField(dispatch.action, 'kind')
  if (kind === 'dispatch-planner') {
    return world.plan.revisions.some(
      (revision) => revision.createdByDispatchId === candidate.subjectId
    )
  }
  if (kind === 'dispatch-node') {
    return world.plan.nodes.some(
      (node) =>
        node.dispatchId === candidate.subjectId &&
        (node.state === 'succeeded' || node.state === 'failed' || node.state === 'replanned')
    )
  }
  if (kind === 'dispatch-reviewer' || kind === 'dispatch-integrator') {
    return world.plan.verdicts.some((verdict) => verdict.dispatchId === candidate.subjectId)
  }
  return false
}

function isObsoletePlannerHistory(candidate: SubjectGroup, world: ObjectiveWorld): boolean {
  const activeNumber = activeObjectiveRevision(world)?.number ?? 0
  if (
    activeNumber === 0 ||
    candidate.attempts.some(
      (attempt) => attempt.value.state !== 'settled' || attempt.value.effect === 'indeterminate'
    )
  ) {
    return false
  }
  const revisionNumbers = candidate.attempts.flatMap((attempt) => {
    const kind = stringField(attempt.action, 'kind')
    const number = numberField(attempt.action, 'revisionNumber')
    return (kind === 'dispatch-planner' || kind === 'ingest-plan') && number !== undefined
      ? [number]
      : []
  })
  return (
    revisionNumbers.length > 0 &&
    revisionNumbers.every((revisionNumber) => revisionNumber < activeNumber)
  )
}

export function buildOmissionUnits(
  world: ObjectiveWorld,
  ledger: LedgerProjection,
  contentIdentity: string
): OmissionUnit[] {
  const units: OmissionUnit[] = []
  let ordinal = 0
  if (world.contract.existingPlan !== undefined && world.plan.revisions.length > 0) {
    units.push({ ...emptyUnit(ordinal++), existingPlan: true })
  }

  const claimedAttempts = new Set<string>()
  const claimedReports = new Set<string>()
  const claimedJudgmentReports = new Set<number>()
  const escalation = activeEscalationIds(ledger)
  const protectedRevisionSubjects = new Set<string>()
  const historicalRevisions = [...world.plan.revisions]
    .filter((revision) => revision.status === 'superseded' || revision.status === 'rejected')
    .sort((left, right) => left.number - right.number)

  for (const revision of historicalRevisions) {
    const subjects = new Set<string>()
    if (revision.createdByDispatchId) {
      subjects.add(revision.createdByDispatchId)
    }
    for (const node of world.plan.nodes) {
      if (node.revisionId === revision.id && node.dispatchId) {
        subjects.add(node.dispatchId)
      }
    }
    for (const verdict of world.plan.verdicts) {
      if (verdict.revisionId === revision.id) {
        subjects.add(verdict.dispatchId)
      }
    }
    const patches = (world.plan.patches ?? []).filter((patch) => patch.revisionId === revision.id)
    const patchIds = new Set(patches.map((patch) => patch.id))
    const planReviews = (world.plan.planReviews ?? []).filter(
      (review) =>
        (review.targetKind === 'revision' && review.targetId === revision.id) ||
        (review.targetKind === 'patch' && patchIds.has(review.targetId))
    )
    for (const patch of patches) {
      subjects.add(patch.createdByDispatchId)
    }
    for (const review of planReviews) {
      subjects.add(review.dispatchId)
    }
    const attemptKeys = new Set<string>()
    for (const attempt of ledger.attempts) {
      if (revisionMatchesAttempt(revision, attempt)) {
        attemptKeys.add(attempt.key)
        subjects.add(attempt.subjectId)
      }
    }
    for (const attempt of ledger.attempts) {
      if (subjects.has(attempt.subjectId)) {
        attemptKeys.add(attempt.key)
      }
    }
    const reportKeys = ledger.reports
      .filter((report) => subjects.has(report.subjectId))
      .map((report) => report.key)
    const judgmentReportIndexes = (world.judgmentReports ?? []).flatMap((report, index) =>
      subjects.has(report.dispatchId) ? [index] : []
    )
    const hasUnresolvedAttempt = ledger.attempts.some(
      (attempt) =>
        attemptKeys.has(attempt.key) &&
        (attempt.value.state !== 'settled' || attempt.value.effect === 'indeterminate')
    )
    if (
      hasUnresolvedAttempt ||
      (escalation.dispatchId !== undefined && subjects.has(escalation.dispatchId))
    ) {
      for (const subjectId of subjects) {
        protectedRevisionSubjects.add(subjectId)
      }
      continue
    }
    for (const key of attemptKeys) {
      claimedAttempts.add(key)
    }
    for (const key of reportKeys) {
      claimedReports.add(key)
    }
    for (const index of judgmentReportIndexes) {
      claimedJudgmentReports.add(index)
    }
    const planAtMs = Math.max(
      revision.createdAtMs,
      revision.approvedAtMs ?? 0,
      ...world.plan.nodes
        .filter((node) => node.revisionId === revision.id)
        .flatMap((node) =>
          node.criteria.flatMap((criterion) =>
            criterion.lastCheck === null ? [] : [criterion.lastCheck.atMs]
          )
        ),
      ...world.plan.verdicts
        .filter((verdict) => verdict.revisionId === revision.id)
        .map((verdict) => verdict.atMs),
      ...world.plan.landing
        .filter((record) => record.revisionId === revision.id)
        .map((record) => record.atMs),
      ...patches.map((patch) => patch.resolvedAtMs ?? patch.createdAtMs),
      ...planReviews.map((review) => review.createdAtMs)
    )
    const newest = [
      { atMs: planAtMs, sourceIndex: revision.number },
      ...ledger.attempts.filter((attempt) => attemptKeys.has(attempt.key)),
      ...ledger.reports.filter((report) => reportKeys.includes(report.key))
    ].reduce((left, right) =>
      left.atMs > right.atMs || (left.atMs === right.atMs && left.sourceIndex >= right.sourceIndex)
        ? left
        : right
    )
    units.push({
      atMs: newest.atMs,
      sourceIndex: newest.sourceIndex,
      ordinal: ordinal++,
      revisionId: revision.id,
      attemptKeys: [...attemptKeys],
      approvalKeys: [],
      escalationKeys: [],
      reportKeys,
      judgmentReportIndexes,
      gateAttemptIndexes: [],
      subjectIds: [...subjects]
    })
  }

  const pinnedSubjects = new Set(protectedRevisionSubjects)
  if (escalation.messageId) {
    pinnedSubjects.add(escalation.messageId)
  }
  if (escalation.dispatchId) {
    pinnedSubjects.add(escalation.dispatchId)
  }
  const groups = new Map<string, SubjectGroup>()
  const group = (subjectId: string): SubjectGroup => {
    const existing = groups.get(subjectId)
    if (existing) {
      return existing
    }
    const created: SubjectGroup = {
      subjectId,
      attempts: [],
      reports: [],
      judgmentReportIndexes: []
    }
    groups.set(subjectId, created)
    return created
  }
  for (const attempt of ledger.attempts) {
    if (!claimedAttempts.has(attempt.key)) {
      group(attempt.subjectId).attempts.push(attempt)
    }
  }
  for (const report of ledger.reports) {
    if (!claimedReports.has(report.key)) {
      group(report.subjectId).reports.push(report)
    }
  }
  for (const [index, report] of (world.judgmentReports ?? []).entries()) {
    if (!claimedJudgmentReports.has(index)) {
      group(report.dispatchId).judgmentReportIndexes.push(index)
    }
  }

  const history: OmissionUnit[] = []
  for (const candidate of groups.values()) {
    if (candidate.attempts.length === 0 || pinnedSubjects.has(candidate.subjectId)) {
      continue
    }
    const hasReport = candidate.reports.length > 0 || candidate.judgmentReportIndexes.length > 0
    const consumedReport = hasReport && reportWasConsumed(candidate, world)
    const obsoletePlanner = isObsoletePlannerHistory(candidate, world)
    const completed = candidate.attempts.every((attempt) => attempt.completed)
    if (!completed && !consumedReport && !obsoletePlanner) {
      continue
    }
    if (hasReport && !consumedReport && !obsoletePlanner) {
      continue
    }
    const sources = [...candidate.attempts, ...candidate.reports]
    const newest = sources.reduce((left, right) =>
      left.atMs > right.atMs || (left.atMs === right.atMs && left.sourceIndex >= right.sourceIndex)
        ? left
        : right
    )
    history.push({
      atMs: newest.atMs,
      sourceIndex: newest.sourceIndex,
      ordinal: ordinal++,
      attemptKeys: candidate.attempts.map((attempt) => attempt.key),
      approvalKeys: [],
      escalationKeys: [],
      reportKeys: candidate.reports.map((report) => report.key),
      judgmentReportIndexes: candidate.judgmentReportIndexes,
      gateAttemptIndexes: [],
      subjectIds: [candidate.subjectId]
    })
  }

  // gates are evaluated against the lineage base identity, so only that and the raw identity are live
  const liveGateIdentities = new Set([
    contentIdentity,
    lineageBaseIdentity(world.plan.landing, contentIdentity)
  ])
  for (const [index, gateAttempt] of (world.plan.gateAttempts ?? []).entries()) {
    if (gateAttempt.completedAtMs === null || liveGateIdentities.has(gateAttempt.contentIdentity)) {
      continue
    }
    history.push({
      ...emptyUnit(ordinal++),
      atMs: gateAttempt.completedAtMs,
      sourceIndex: index,
      gateAttemptIndexes: [index]
    })
  }

  const openApprovalScopes = new Set(
    ledger.escalations.flatMap((item) => {
      if (item.status !== 'open' && item.status !== 'escalated') {
        return []
      }
      const scope = isRecord(item.value) ? item.value.approvalScope : undefined
      return scope === undefined ? [] : [stableJson(scope)]
    })
  )
  for (const approval of ledger.approvals) {
    if (openApprovalScopes.has(approval.key)) {
      continue
    }
    history.push({
      ...emptyUnit(ordinal++),
      atMs: approval.atMs,
      sourceIndex: approval.sourceIndex,
      approvalKeys: [approval.key]
    })
  }
  for (const item of ledger.escalations) {
    if (item.status === 'open' || item.status === 'escalated') {
      continue
    }
    history.push({
      ...emptyUnit(ordinal++),
      atMs: item.atMs,
      sourceIndex: item.sourceIndex,
      escalationKeys: [item.key]
    })
  }
  units.push(...history)
  units.sort(
    (left, right) =>
      left.atMs - right.atMs || left.sourceIndex - right.sourceIndex || left.ordinal - right.ordinal
  )
  return units
}
