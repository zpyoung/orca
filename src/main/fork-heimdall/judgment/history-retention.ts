import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
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
  subjectIds: readonly string[]
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
  if (
    ledger.latestEscalation === null ||
    typeof ledger.latestEscalation !== 'object' ||
    Array.isArray(ledger.latestEscalation)
  ) {
    return {}
  }
  const escalation = ledger.latestEscalation as Record<string, unknown>
  const messageId = stringField(escalation, 'subjectId')
  const payload = escalation.payload
  const dispatchId =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? stringField(payload as Record<string, unknown>, 'dispatchId')
      : undefined
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
  const activeNumber = world.plan.revisions.reduce(
    (highest, revision) =>
      revision.status === 'approved' ? Math.max(highest, revision.number) : highest,
    0
  )
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
  ledger: LedgerProjection
): OmissionUnit[] {
  const units: OmissionUnit[] = []
  let ordinal = 0
  if (
    world.contract.existingPlan !== undefined &&
    world.plan.revisions.some((revision) => revision.status === 'approved')
  ) {
    units.push({ ...emptyUnit(ordinal++), existingPlan: true })
  }

  const claimedAttempts = new Set<string>()
  const claimedReports = new Set<string>()
  const claimedJudgmentReports = new Set<number>()
  const escalation = activeEscalationIds(ledger)
  const protectedRevisionSubjects = new Set<string>()
  const superseded = [...world.plan.revisions]
    .filter((revision) => revision.status === 'superseded')
    .sort((left, right) => left.number - right.number)

  for (const revision of superseded) {
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
        .map((record) => record.atMs)
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
      subjectIds: [candidate.subjectId]
    })
  }

  const openApprovalScopes = new Set(
    ledger.escalations.flatMap((item) => {
      if (item.status !== 'open' && item.status !== 'escalated') {
        return []
      }
      const scope = (item.value as Record<string, unknown>).approvalScope
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
