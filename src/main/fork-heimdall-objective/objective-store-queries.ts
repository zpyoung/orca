import {
  ObjectiveWorkspacePathSchema,
  type ObjectiveLandingBar
} from '../../shared/fork-heimdall-objective/contract-types'
import {
  ObjectiveDispatchRecordSchema,
  type ObjectiveDispatchRecord
} from '../../shared/fork-heimdall-objective/parallel-types'
import {
  ImplementerReportSchema,
  ObjectiveCriterionSchema,
  PlannerReportSchema,
  ObjectivePlanTaskSchema,
  type ObjectivePlan,
  type ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveDatabase } from './objective-database'
import {
  DependenciesSchema,
  parseJson,
  parseLandingPayloadJson,
  type CheckRow,
  type CriterionRow,
  type DispatchRow,
  type LandingRow,
  type ObjectiveCheckAttempt,
  type ObjectiveLandingPayload,
  type ObjectiveStoredCriterion
} from './objective-store-data'

const DISPATCH_COLUMNS = `attempt_fingerprint, watcher_id, execution_host_id, revision_id, task_key, plan_task_digest,
  dispatch_id, workspace_id, workspace_path, base_commit, lane_task_keys_json, session_node_count,
  state, commit_sha, applied_commit_sha, report_digest, conflict_paths_json,
  conflicting_task_keys_json, conflicting_dispatch_ids_json, created_at_ms, completed_at_ms,
  terminal_handle, setup_state, report_path, report_json, task_json`

function dispatchRecord(row: DispatchRow): ObjectiveDispatchRecord {
  return ObjectiveDispatchRecordSchema.parse({
    attemptFingerprint: row.attempt_fingerprint,
    watcherId: row.watcher_id,
    executionHostId: row.execution_host_id,
    revisionId: row.revision_id,
    taskKey: row.task_key,
    planTaskDigest: row.plan_task_digest,
    dispatchId: row.dispatch_id,
    workspaceId: row.workspace_id,
    workspacePath: row.workspace_path,
    baseCommit: row.base_commit,
    laneTaskKeys: parseJson(DependenciesSchema, row.lane_task_keys_json, 'dispatch lane task keys'),
    sessionNodeCount: row.session_node_count,
    state: row.state,
    commitSha: row.commit_sha,
    appliedCommitSha: row.applied_commit_sha,
    reportDigest: row.report_digest,
    conflictPaths: parseJson(
      ObjectiveWorkspacePathSchema.array().max(256),
      row.conflict_paths_json,
      'dispatch conflict paths'
    ),
    conflictingTaskKeys: parseJson(
      DependenciesSchema,
      row.conflicting_task_keys_json,
      'dispatch conflicting task keys'
    ),
    conflictingDispatchIds: parseJson(
      DependenciesSchema,
      row.conflicting_dispatch_ids_json,
      'conflicting dispatch ids'
    ),
    createdAtMs: row.created_at_ms,
    completedAtMs: row.completed_at_ms,
    terminalHandle: row.terminal_handle,
    setupState: row.setup_state,
    reportPath: row.report_path,
    report:
      row.report_json === null
        ? null
        : parseJson(ImplementerReportSchema, row.report_json, 'dispatch report'),
    task: parseJson(ObjectivePlanTaskSchema, row.task_json, 'dispatch task')
  })
}

export function readObjectiveCheckAttempt(
  database: ObjectiveDatabase,
  criterionId: string,
  contentIdentity: string
): ObjectiveCheckAttempt | null {
  const row = database
    .connection()
    .prepare(`SELECT id, watcher_id, criterion_id, content_identity,
    execution_host_id, command, exit_code, timed_out, stdout_tail, stderr_tail, epoch, started_at_ms, completed_at_ms,
    owner_skip
    FROM check_attempt WHERE criterion_id = ? AND content_identity = ?`)
    .get(criterionId, contentIdentity) as CheckRow | undefined
  return row
    ? {
        id: row.id,
        watcherId: row.watcher_id,
        criterionId: row.criterion_id,
        contentIdentity: row.content_identity,
        executionHostId: row.execution_host_id,
        command: row.command,
        epoch: row.epoch,
        startedAtMs: row.started_at_ms,
        exitCode: row.exit_code,
        timedOut: row.timed_out === 1,
        stdoutTail: row.stdout_tail,
        stderrTail: row.stderr_tail,
        completedAtMs: row.completed_at_ms,
        ownerSkip: row.owner_skip === 1
      }
    : null
}

export class ObjectiveStoreQueries {
  constructor(private readonly database: ObjectiveDatabase) {}

  getDispatch(attemptFingerprint: string): ObjectiveDispatchRecord | null {
    const row = this.database
      .connection()
      .prepare(`SELECT ${DISPATCH_COLUMNS} FROM objective_dispatch WHERE attempt_fingerprint = ?`)
      .get(attemptFingerprint) as DispatchRow | undefined
    return row ? dispatchRecord(row) : null
  }

  listDispatches(watcherId: string): ObjectiveDispatchRecord[] {
    const rows = this.database
      .connection()
      .prepare(`SELECT ${DISPATCH_COLUMNS} FROM objective_dispatch
        WHERE watcher_id = ?
        ORDER BY COALESCE(completed_at_ms, 9223372036854775807), created_at_ms, attempt_fingerprint`)
      .all(watcherId) as unknown as DispatchRow[]
    return rows.map(dispatchRecord)
  }

  dispatchForId(watcherId: string, dispatchId: string): ObjectiveDispatchRecord | null {
    const row = this.database
      .connection()
      .prepare(`SELECT ${DISPATCH_COLUMNS} FROM objective_dispatch
        WHERE watcher_id = ? AND dispatch_id = ?`)
      .get(watcherId, dispatchId) as DispatchRow | undefined
    return row ? dispatchRecord(row) : null
  }

  parallelNote(watcherId: string): string | null {
    const row = this.database
      .connection()
      .prepare('SELECT note FROM objective_parallel_state WHERE watcher_id = ?')
      .get(watcherId) as { note: string | null } | undefined
    return row?.note ?? null
  }

  nodeForDispatch(
    watcherId: string,
    dispatchId: string
  ): { revisionId: string; taskKey: string } | null {
    const row = this.database
      .connection()
      .prepare(
        'SELECT revision_id, task_key FROM plan_node WHERE watcher_id = ? AND dispatch_id = ?'
      )
      .get(watcherId, dispatchId) as { revision_id: string; task_key: string } | undefined
    return row ? { revisionId: row.revision_id, taskKey: row.task_key } : null
  }

  getPlan(revisionId: string): ObjectivePlan | null {
    const row = this.database
      .connection()
      .prepare('SELECT payload_json FROM plan_revision WHERE id = ?')
      .get(revisionId) as { payload_json: string } | undefined
    return row ? parseJson(PlannerReportSchema, row.payload_json, 'plan payload').plan : null
  }

  getTask(revisionId: string, taskKey: string): ObjectivePlanTask | null {
    return this.getPlan(revisionId)?.find((task) => task.taskKey === taskKey) ?? null
  }

  getCriterion(criterionId: string): ObjectiveStoredCriterion | null {
    const row = this.database
      .connection()
      .prepare(`SELECT id, revision_id, task_key, ordinal, body, shell_checkable, check_command
      FROM acceptance_criterion WHERE id = ?`)
      .get(criterionId) as CriterionRow | undefined
    if (!row || row.body === undefined) {
      return null
    }
    const criterion = ObjectiveCriterionSchema.parse({
      body: row.body,
      shellCheckable: row.shell_checkable === 1,
      checkCommand: row.check_command
    })
    return {
      ...criterion,
      id: row.id,
      revisionId: row.revision_id,
      taskKey: row.task_key,
      ordinal: row.ordinal
    }
  }

  getCheckAttempt(criterionId: string, contentIdentity: string): ObjectiveCheckAttempt | null {
    return readObjectiveCheckAttempt(this.database, criterionId, contentIdentity)
  }

  hasCheckAttempt(criterionId: string, contentIdentity: string, completed = false): boolean {
    const attempt = readObjectiveCheckAttempt(this.database, criterionId, contentIdentity)
    return Boolean(attempt && (!completed || attempt.completedAtMs !== null))
  }

  hasPlanRevision(watcherId: string, revisionId: string, digest?: string): boolean {
    const row = this.database
      .connection()
      .prepare('SELECT digest FROM plan_revision WHERE watcher_id = ? AND id = ?')
      .get(watcherId, revisionId) as { digest: string } | undefined
    return Boolean(row && (digest === undefined || row.digest === digest))
  }
  hasUsablePlan(watcherId: string): boolean {
    return Boolean(
      this.database
        .connection()
        .prepare(
          `SELECT 1 FROM plan_revision approved
           WHERE approved.watcher_id = ?
             AND approved.status = 'approved'
             AND approved.approved_at_ms IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM plan_revision draft
               WHERE draft.watcher_id = ? AND draft.status = 'draft'
             )
           LIMIT 1`
        )
        .get(watcherId, watcherId)
    )
  }

  planForDispatch(
    watcherId: string,
    dispatchId: string
  ): { revisionId: string; revisionNumber: number; digest: string } | null {
    const row = this.database
      .connection()
      .prepare(`SELECT id, revision_number, digest FROM plan_revision WHERE watcher_id = ?
      AND created_by_dispatch_id = ? ORDER BY revision_number DESC LIMIT 1`)
      .get(watcherId, dispatchId) as
      | { id: string; revision_number: number; digest: string }
      | undefined
    return row
      ? { revisionId: row.id, revisionNumber: row.revision_number, digest: row.digest }
      : null
  }

  isPlanActivated(watcherId: string, revisionId: string, digest: string): boolean {
    return Boolean(
      this.database
        .connection()
        .prepare(`SELECT 1 FROM plan_revision WHERE watcher_id = ? AND id = ?
      AND digest = ? AND approved_at_ms IS NOT NULL AND status IN ('approved', 'superseded')`)
        .get(watcherId, revisionId, digest)
    )
  }

  hasVerdict(dispatchId: string, reportDigest?: string): boolean {
    const row = this.database
      .connection()
      .prepare('SELECT report_digest FROM review_verdict WHERE dispatch_id = ?')
      .get(dispatchId) as { report_digest: string } | undefined
    return Boolean(row && (reportDigest === undefined || row.report_digest === reportDigest))
  }

  hasLanding(watcherId: string, rung: ObjectiveLandingBar, contentIdentity: string): boolean {
    return Boolean(
      this.database
        .connection()
        .prepare(
          'SELECT 1 FROM landing_evidence WHERE watcher_id = ? AND rung = ? AND content_identity = ?'
        )
        .get(watcherId, rung, contentIdentity)
    )
  }

  hasAmendment(revisionId: string, digest: string): boolean {
    return Boolean(
      this.database
        .connection()
        .prepare('SELECT 1 FROM revision_amendment WHERE revision_id = ? AND digest = ?')
        .get(revisionId, digest)
    )
  }

  landingRow(
    watcherId: string,
    rung: ObjectiveLandingBar,
    contentIdentity: string
  ): ObjectiveLandingPayload | null {
    const row = this.database
      .connection()
      .prepare(
        `SELECT rung, content_identity, payload_json, created_at_ms
         FROM landing_evidence WHERE watcher_id = ? AND rung = ? AND content_identity = ?`
      )
      .get(watcherId, rung, contentIdentity) as LandingRow | undefined
    return row ? parseLandingPayloadJson(row.rung, row.payload_json, 'landing payload') : null
  }
}
