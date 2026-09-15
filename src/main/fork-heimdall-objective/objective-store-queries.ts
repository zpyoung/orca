import type { ObjectiveLandingBar } from '../../shared/fork-heimdall-objective/contract-types'
import {
  ObjectiveCriterionSchema,
  PlannerReportSchema,
  type ObjectivePlan,
  type ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveDatabase } from './objective-database'
import {
  parseJson,
  type CheckRow,
  type CriterionRow,
  type ObjectiveCheckAttempt,
  type ObjectiveStoredCriterion
} from './objective-store-data'

export function readObjectiveCheckAttempt(
  database: ObjectiveDatabase,
  criterionId: string,
  contentIdentity: string
): ObjectiveCheckAttempt | null {
  const row = database
    .connection()
    .prepare(`SELECT id, watcher_id, criterion_id, content_identity,
    execution_host_id, command, exit_code, timed_out, stdout_tail, stderr_tail, epoch, started_at_ms, completed_at_ms
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
        completedAtMs: row.completed_at_ms
      }
    : null
}

export class ObjectiveStoreQueries {
  constructor(private readonly database: ObjectiveDatabase) {}

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
}
