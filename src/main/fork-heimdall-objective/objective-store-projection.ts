import {
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import {
  ObjectiveDetailSchema,
  ObjectiveProjectionSchema,
  type ObjectiveDetail,
  type ObjectiveNodeState,
  type ObjectiveProjection
} from '../../shared/fork-heimdall-objective/detail-types'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import { WatcherLedgerSchema, type WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveDatabase } from './objective-database'
import {
  CriteriaResultsSchema,
  DependenciesSchema,
  parseLandingPayloadJson,
  parseJson,
  type CriterionRow,
  type LandingRow,
  type NodeRow,
  type ProjectionCheckRow,
  type RevisionRow,
  type VerdictRow
} from './objective-store-data'

export function projectObjective(
  database: ObjectiveDatabase,
  watcherId: string,
  ledger?: WatcherLedger,
  contentIdentity?: string
): ObjectiveProjection {
  const db = database.connection()
  const revisions = db
    .prepare(`SELECT id, revision_number, status, digest, created_by_dispatch_id, created_at_ms, approved_at_ms
    FROM plan_revision WHERE watcher_id = ? ORDER BY revision_number, id`)
    .all(watcherId) as unknown as RevisionRow[]
  const nodes = db
    .prepare(`SELECT n.revision_id, r.status AS revision_status, n.task_key, n.deps_json,
    n.orchestration_task_id, n.dispatch_id FROM plan_node n JOIN plan_revision r ON r.id = n.revision_id
    WHERE n.watcher_id = ? ORDER BY r.revision_number, n.task_key`)
    .all(watcherId) as unknown as NodeRow[]
  const criteria = db
    .prepare(`SELECT id, revision_id, task_key, ordinal, shell_checkable, check_command
    FROM acceptance_criterion WHERE watcher_id = ? ORDER BY revision_id, task_key, ordinal`)
    .all(watcherId) as unknown as CriterionRow[]
  const checks = (contentIdentity === undefined
    ? db
        .prepare(`SELECT criterion_id, content_identity, exit_code, timed_out, started_at_ms, completed_at_ms
          FROM check_attempt WHERE watcher_id = ? ORDER BY started_at_ms, id`)
        .all(watcherId)
    : db
        .prepare(`SELECT criterion_id, content_identity, exit_code, timed_out, started_at_ms, completed_at_ms
          FROM check_attempt WHERE watcher_id = ? AND content_identity = ? ORDER BY started_at_ms, id`)
        .all(watcherId, contentIdentity)) as unknown as ProjectionCheckRow[]
  const verdicts = db
    .prepare(`SELECT revision_id, dispatch_id, role, content_identity, verdict, criteria_results_json,
    report_digest, created_at_ms FROM review_verdict WHERE watcher_id = ? ORDER BY created_at_ms, dispatch_id`)
    .all(watcherId) as unknown as VerdictRow[]
  const landing = db
    .prepare(`SELECT rung, content_identity, payload_json, created_at_ms
    FROM landing_evidence WHERE watcher_id = ? ORDER BY created_at_ms, rung`)
    .all(watcherId) as unknown as LandingRow[]
  return ObjectiveProjectionSchema.parse(
    buildProjection(
      revisions,
      nodes,
      criteria,
      checks,
      verdicts,
      landing,
      ledger ? WatcherLedgerSchema.parse(ledger) : undefined
    )
  )
}

export function detailObjective(
  database: ObjectiveDatabase,
  now: () => number,
  watcherId: string,
  contract: ObjectiveEnrollmentPayload,
  ledger?: WatcherLedger
): ObjectiveDetail {
  const parsedContract = ObjectiveEnrollmentPayloadSchema.parse(contract)
  const projection = projectObjective(database, watcherId, ledger)
  const db = database.connection()
  const nodes = db
    .prepare(`SELECT n.revision_id, r.status AS revision_status, n.task_key, n.title, n.deps_json,
    n.orchestration_task_id, n.dispatch_id FROM plan_node n JOIN plan_revision r ON r.id = n.revision_id
    WHERE n.watcher_id = ? ORDER BY r.revision_number, n.task_key`)
    .all(watcherId) as unknown as NodeRow[]
  const criteria = db
    .prepare(`SELECT id, revision_id, task_key, ordinal, body, shell_checkable, check_command
    FROM acceptance_criterion WHERE watcher_id = ? ORDER BY revision_id, task_key, ordinal`)
    .all(watcherId) as unknown as CriterionRow[]
  const projectedNodes = new Map(
    projection.nodes.map((node) => [`${node.revisionId}\0${node.taskKey}`, node])
  )
  const criteriaByNode = new Map<string, CriterionRow[]>()
  for (const criterion of criteria) {
    const key = `${criterion.revision_id}\0${criterion.task_key}`
    criteriaByNode.set(key, [...(criteriaByNode.get(key) ?? []), criterion])
  }
  return ObjectiveDetailSchema.parse({
    contract: parsedContract,
    revisions: projection.revisions.map(
      ({ id, number, status, digest, createdAtMs, approvedAtMs }) => ({
        id,
        number,
        status,
        digest,
        createdAtMs,
        approvedAtMs,
        nodeCount: nodes.filter((node) => node.revision_id === id).length
      })
    ),
    nodes: nodes.map((node) => {
      const key = `${node.revision_id}\0${node.task_key}`
      const projected = projectedNodes.get(key)
      if (!projected || node.title === undefined) {
        throw new Error('Objective projection omitted a stored plan node')
      }
      const projectedCriteria = new Map(
        projected.criteria.map((criterion) => [criterion.id, criterion])
      )
      return {
        taskKey: node.task_key,
        title: node.title,
        revisionId: node.revision_id,
        orchestrationTaskId: node.orchestration_task_id,
        dispatchId: node.dispatch_id,
        state: projected.state,
        criteria: (criteriaByNode.get(key) ?? []).map((criterion) => {
          const value = projectedCriteria.get(criterion.id)
          if (!value || criterion.body === undefined) {
            throw new Error('Objective projection omitted a stored criterion')
          }
          return {
            id: value.id,
            body: criterion.body,
            shellCheckable: value.shellCheckable,
            lastCheck: value.lastCheck,
            lastReview: value.lastReview
          }
        })
      }
    }),
    verdicts: projection.verdicts.map(({ dispatchId, role, verdict, contentIdentity, atMs }) => ({
      dispatchId,
      role,
      verdict,
      contentIdentity,
      atMs
    })),
    landing: projection.landing.map(({ rung, contentIdentity, atMs }) => ({
      rung,
      contentIdentity,
      atMs
    })),
    asOfMs: now()
  })
}

function buildProjection(
  revisions: RevisionRow[],
  nodes: NodeRow[],
  criteria: CriterionRow[],
  checks: ProjectionCheckRow[],
  verdictRows: VerdictRow[],
  landingRows: LandingRow[],
  ledger?: WatcherLedger
): unknown {
  const checkByCriterion = new Map(checks.map((check) => [check.criterion_id, check]))
  const reviewByCriterion = new Map<string, 'pass' | 'block'>()
  for (const verdict of verdictRows) {
    for (const result of parseJson(
      CriteriaResultsSchema,
      verdict.criteria_results_json,
      'criteria results'
    )) {
      reviewByCriterion.set(
        `${verdict.revision_id}\0${result.taskKey}\0${result.criterionIndex}`,
        result.result
      )
    }
  }
  const states = nodeStates(nodes, ledger)
  return {
    revisions: revisions.map((row) => ({
      id: row.id,
      number: row.revision_number,
      status: row.status,
      digest: row.digest,
      createdByDispatchId: row.created_by_dispatch_id,
      createdAtMs: row.created_at_ms,
      approvedAtMs: row.approved_at_ms
    })),
    nodes: nodes.map((node) => ({
      revisionId: node.revision_id,
      taskKey: node.task_key,
      deps: parseJson(DependenciesSchema, node.deps_json, 'node dependencies'),
      orchestrationTaskId: node.orchestration_task_id,
      dispatchId: node.dispatch_id,
      state: states.get(`${node.revision_id}\0${node.task_key}`) ?? 'pending',
      criteria: criteria
        .filter(
          (criterion) =>
            criterion.revision_id === node.revision_id && criterion.task_key === node.task_key
        )
        .map((criterion) => {
          const check = checkByCriterion.get(criterion.id)
          return {
            id: criterion.id,
            ordinal: criterion.ordinal,
            shellCheckable: criterion.shell_checkable === 1,
            checkCommand: criterion.check_command,
            lastCheck: check
              ? {
                  contentIdentity: check.content_identity,
                  exitCode: check.exit_code,
                  timedOut: check.timed_out === 1,
                  atMs: check.completed_at_ms ?? check.started_at_ms
                }
              : null,
            lastReview:
              reviewByCriterion.get(
                `${criterion.revision_id}\0${criterion.task_key}\0${criterion.ordinal}`
              ) ?? null
          }
        })
    })),
    verdicts: verdictRows.map((row) => ({
      dispatchId: row.dispatch_id,
      revisionId: row.revision_id,
      role: row.role,
      verdict: row.verdict,
      contentIdentity: row.content_identity,
      reportDigest: row.report_digest,
      atMs: row.created_at_ms
    })),
    landing: landingRows.map((row) => {
      const payload = parseLandingPayloadJson(row.rung, row.payload_json, 'landing payload')
      const common = {
        rung: row.rung,
        revisionId: payload.revisionId,
        contentIdentity: row.content_identity,
        atMs: row.created_at_ms
      }
      if (row.rung === 'files-on-disk' || !('fromContentIdentity' in payload)) {
        return common
      }
      if (row.rung === 'committed-local-branch' && 'treeOid' in payload) {
        return {
          ...common,
          fromContentIdentity: payload.fromContentIdentity,
          branch: payload.branch,
          commitSha: payload.commitSha
        }
      }
      if (row.rung === 'pushed-ref' && 'remote' in payload) {
        return {
          ...common,
          fromContentIdentity: payload.fromContentIdentity,
          branch: payload.branch,
          commitSha: payload.commitSha,
          remote: payload.remote,
          remoteSha: payload.remoteSha
        }
      }
      if (row.rung === 'hosted-review' && 'provider' in payload) {
        return {
          ...common,
          fromContentIdentity: payload.fromContentIdentity,
          branch: payload.branch,
          provider: payload.provider,
          reviewNumber: payload.reviewNumber,
          reviewUrl: payload.reviewUrl,
          headSha: payload.headSha,
          base: payload.base
        }
      }
      return { ...common, fromContentIdentity: payload.fromContentIdentity }
    })
  }
}

function nodeStates(nodes: NodeRow[], ledger?: WatcherLedger): Map<string, ObjectiveNodeState> {
  const states = new Map<string, ObjectiveNodeState>()
  const outcomes = new Map<string, ObjectiveNodeState>()
  for (const node of nodes) {
    if (node.dispatch_id) {
      outcomes.set(`${node.revision_id}\0${node.task_key}`, 'succeeded')
    }
  }
  if (ledger) {
    for (const attempt of getLatestAttempts(ledger)) {
      const action = attempt.action as Record<string, unknown>
      if (typeof action.revisionId !== 'string' || typeof action.taskKey !== 'string') {
        continue
      }
      const key = `${action.revisionId}\0${action.taskKey}`
      if (action.kind === 'dispatch-node') {
        if (attempt.state === 'settled' && attempt.effect === 'not-landed') {
          outcomes.set(key, 'failed')
        } else if (!outcomes.has(key)) {
          outcomes.set(key, 'dispatched')
        }
      } else if (action.kind === 'ingest-report' && attempt.state === 'settled') {
        if (attempt.effect === 'landed') {
          outcomes.set(key, 'succeeded')
        } else if (attempt.effect === 'not-landed') {
          outcomes.set(key, 'failed')
        }
      }
    }
  }
  for (const node of nodes) {
    const key = `${node.revision_id}\0${node.task_key}`
    if (node.revision_status === 'rejected' || node.revision_status === 'superseded') {
      states.set(key, 'replanned')
    } else if (outcomes.has(key)) {
      states.set(key, outcomes.get(key) as ObjectiveNodeState)
    } else if (node.dispatch_id) {
      states.set(key, 'succeeded')
    } else if (ledger && awaitingApproval(ledger, node.revision_id, node.task_key)) {
      states.set(key, 'awaiting-approval')
    } else {
      const deps = parseJson(DependenciesSchema, node.deps_json, 'node dependencies')
      const allSucceeded = deps.every(
        (dependency) => outcomes.get(`${node.revision_id}\0${dependency}`) === 'succeeded'
      )
      states.set(key, deps.length > 0 && !allSucceeded ? 'blocked-by-deps' : 'pending')
    }
  }
  return states
}

function awaitingApproval(ledger: WatcherLedger, revisionId: string, taskKey: string): boolean {
  const evidenceKey = `${revisionId}:${taskKey}`
  let approvedAt = -1
  for (const entry of ledger.entries) {
    if (
      entry.kind === 'approval' &&
      entry.scope.actionKind === 'dispatch-node' &&
      entry.scope.evidenceKey === evidenceKey &&
      entry.decision === 'approved'
    ) {
      approvedAt = entry.atMs
    }
  }
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (
      entry.kind === 'escalation' &&
      (entry.status === 'open' || entry.status === 'escalated') &&
      entry.approvalScope?.actionKind === 'dispatch-node' &&
      entry.approvalScope.evidenceKey === evidenceKey
    ) {
      return entry.atMs > approvedAt
    }
  }
  return false
}
