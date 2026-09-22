import { ObjectiveLandingBarSchema } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveRevisionStatus } from '../../shared/fork-heimdall-objective/detail-types'
import {
  IntegratorReportSchema,
  PlannerReportSchema,
  ReviewerReportSchema
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveDatabase } from './objective-database'
import { runObjectiveMutation } from './objective-database-transaction'
import { amendObjectiveRevision } from './objective-store-amend-revision'
import {
  parseLandingPayload,
  naturalId,
  type ActivatePlanArgs,
  type ActivatePlanResult,
  type AmendRevisionArgs,
  type CompleteCheckAttemptArgs,
  type IngestPlanArgs,
  type IngestPlanResult,
  type ObjectiveCheckAttempt,
  type RecordLandingArgs,
  type RecordLandingResult,
  type RecordNodeDispatchArgs,
  type RecordOwnerCheckSkipArgs,
  type RecordVerdictArgs,
  type RevisionAmendmentResult,
  type StartCheckAttemptArgs,
  type VerdictRow
} from './objective-store-data'
import { readObjectiveCheckAttempt } from './objective-store-queries'

export class ObjectiveStoreMutations {
  constructor(private readonly database: ObjectiveDatabase) {}

  ingestPlan(args: IngestPlanArgs): IngestPlanResult {
    const report = PlannerReportSchema.parse(args.report)
    const payloadJson = JSON.stringify(report)
    const revisionId = naturalId('objective_revision', args.watcherId, args.revisionNumber)
    return this.mutate(() => {
      const db = this.database.connection()
      const replay = db
        .prepare(`SELECT id, revision_number, payload_json, digest, created_at_ms
        FROM plan_revision WHERE watcher_id = ? AND created_by_dispatch_id = ?
        ORDER BY revision_number DESC LIMIT 1`)
        .get(args.watcherId, args.dispatchId) as
        | {
            id: string
            revision_number: number
            payload_json: string
            digest: string
            created_at_ms: number
          }
        | undefined
      if (replay) {
        if (
          replay.revision_number !== args.revisionNumber ||
          replay.payload_json !== payloadJson ||
          replay.digest !== args.digest ||
          replay.created_at_ms !== args.createdAtMs
        ) {
          throw new Error('Planner dispatch natural key was replayed with different content')
        }
        return {
          revisionId: replay.id,
          revisionNumber: replay.revision_number,
          digest: replay.digest
        }
      }
      db.prepare(`INSERT INTO plan_revision (
        id, watcher_id, revision_number, status, payload_json, digest, created_by_dispatch_id, created_at_ms, approved_at_ms
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, NULL)
      ON CONFLICT (watcher_id, revision_number) DO NOTHING`).run(
        revisionId,
        args.watcherId,
        args.revisionNumber,
        payloadJson,
        args.digest,
        args.dispatchId,
        args.createdAtMs
      )
      const stored = db
        .prepare(`SELECT id, payload_json, digest, created_by_dispatch_id, created_at_ms
        FROM plan_revision WHERE watcher_id = ? AND revision_number = ?`)
        .get(args.watcherId, args.revisionNumber) as {
        id: string
        payload_json: string
        digest: string
        created_by_dispatch_id: string | null
        created_at_ms: number
      }
      if (
        stored.payload_json !== payloadJson ||
        stored.digest !== args.digest ||
        stored.created_by_dispatch_id !== args.dispatchId ||
        stored.created_at_ms !== args.createdAtMs
      ) {
        throw new Error('Plan revision natural key was replayed with different content')
      }
      report.plan.forEach((task, ordinal) => {
        db.prepare(`INSERT INTO plan_node (
          id, watcher_id, revision_id, task_key, title, spec, deps_json, orchestration_task_id, dispatch_id,
          dispatched_at_ms, ordinal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
        ON CONFLICT (revision_id, task_key) DO UPDATE SET
          title = excluded.title, spec = excluded.spec, deps_json = excluded.deps_json,
          ordinal = excluded.ordinal`).run(
          naturalId('objective_node', stored.id, task.taskKey),
          args.watcherId,
          stored.id,
          task.taskKey,
          task.title,
          task.spec,
          JSON.stringify(task.deps),
          ordinal
        )
        task.criteria.forEach((criterion, ordinal) => {
          db.prepare(`INSERT INTO acceptance_criterion (
            id, watcher_id, revision_id, task_key, ordinal, body, shell_checkable, check_command
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (revision_id, task_key, ordinal) DO UPDATE SET
            body = excluded.body, shell_checkable = excluded.shell_checkable, check_command = excluded.check_command`).run(
            naturalId('objective_criterion', stored.id, task.taskKey, ordinal),
            args.watcherId,
            stored.id,
            task.taskKey,
            ordinal,
            criterion.body,
            criterion.shellCheckable ? 1 : 0,
            criterion.checkCommand
          )
        })
      })
      return { revisionId: stored.id, revisionNumber: args.revisionNumber, digest: args.digest }
    })
  }

  activatePlan(args: ActivatePlanArgs): ActivatePlanResult {
    return this.mutate(() => {
      const db = this.database.connection()
      const revision = db
        .prepare(
          'SELECT revision_number, status, digest, approved_at_ms FROM plan_revision WHERE id = ? AND watcher_id = ?'
        )
        .get(args.revisionId, args.watcherId) as
        | {
            revision_number: number
            status: ObjectiveRevisionStatus
            digest: string
            approved_at_ms: number | null
          }
        | undefined
      if (!revision || revision.digest !== args.digest) {
        throw new Error('Plan revision does not match its activation digest')
      }
      if (revision.status !== 'draft' && revision.status !== 'approved') {
        throw new Error(`Plan revision cannot be activated from ${revision.status}`)
      }
      db.prepare(`UPDATE plan_revision SET status = 'superseded'
        WHERE watcher_id = ? AND status = 'approved' AND id <> ?`).run(
        args.watcherId,
        args.revisionId
      )
      db.prepare(`UPDATE plan_revision SET status = 'approved', approved_at_ms = COALESCE(approved_at_ms, ?)
        WHERE id = ? AND watcher_id = ?`).run(args.approvedAtMs, args.revisionId, args.watcherId)
      return {
        revisionId: args.revisionId,
        revisionNumber: revision.revision_number,
        digest: revision.digest,
        approvedAtMs: revision.approved_at_ms ?? args.approvedAtMs
      }
    })
  }

  recordNodeDispatch(args: RecordNodeDispatchArgs): RecordNodeDispatchArgs {
    return this.mutate(() => {
      const db = this.database.connection()
      const row = db
        .prepare(`SELECT orchestration_task_id, dispatch_id, dispatched_at_ms FROM plan_node
        WHERE watcher_id = ? AND revision_id = ? AND task_key = ?`)
        .get(args.watcherId, args.revisionId, args.taskKey) as
        | {
            orchestration_task_id: string | null
            dispatch_id: string | null
            dispatched_at_ms: number | null
          }
        | undefined
      if (!row) {
        throw new Error('Plan node was not found for dispatch')
      }
      if (
        (row.orchestration_task_id !== null &&
          row.orchestration_task_id !== args.orchestrationTaskId) ||
        (row.dispatch_id !== null && row.dispatch_id !== args.dispatchId) ||
        (row.dispatched_at_ms !== null && row.dispatched_at_ms !== args.dispatchedAtMs)
      ) {
        throw new Error('Plan node natural key was replayed with a different dispatch')
      }
      db.prepare(`UPDATE plan_node SET orchestration_task_id = ?, dispatch_id = ?, dispatched_at_ms = ?
        WHERE watcher_id = ? AND revision_id = ? AND task_key = ?`).run(
        args.orchestrationTaskId,
        args.dispatchId,
        args.dispatchedAtMs,
        args.watcherId,
        args.revisionId,
        args.taskKey
      )
      return args
    })
  }

  startCheckAttempt(args: StartCheckAttemptArgs): ObjectiveCheckAttempt {
    return this.mutate(() => {
      this.database
        .connection()
        .prepare(`INSERT INTO check_attempt (
        id, watcher_id, criterion_id, content_identity, execution_host_id, command,
        exit_code, timed_out, stdout_tail, stderr_tail, epoch, started_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, '', '', ?, ?, NULL)
      ON CONFLICT (criterion_id, content_identity) DO NOTHING`)
        .run(
          naturalId('objective_check', args.criterionId, args.contentIdentity),
          args.watcherId,
          args.criterionId,
          args.contentIdentity,
          args.executionHostId,
          args.command,
          args.epoch,
          args.startedAtMs
        )
      const stored = readObjectiveCheckAttempt(
        this.database,
        args.criterionId,
        args.contentIdentity
      )
      if (
        !stored ||
        stored.watcherId !== args.watcherId ||
        stored.executionHostId !== args.executionHostId ||
        stored.command !== args.command ||
        stored.epoch !== args.epoch ||
        stored.startedAtMs !== args.startedAtMs
      ) {
        throw new Error('Check attempt natural key was replayed with different inputs')
      }
      return stored
    })
  }

  completeCheckAttempt(args: CompleteCheckAttemptArgs): ObjectiveCheckAttempt {
    return this.mutate(() => {
      if (!readObjectiveCheckAttempt(this.database, args.criterionId, args.contentIdentity)) {
        throw new Error('Check attempt must be started before completion')
      }
      this.database
        .connection()
        .prepare(`UPDATE check_attempt
        SET exit_code = ?, timed_out = ?, stdout_tail = ?, stderr_tail = ?, completed_at_ms = ?
        WHERE criterion_id = ? AND content_identity = ? AND completed_at_ms IS NULL`)
        .run(
          args.exitCode,
          args.timedOut ? 1 : 0,
          args.stdoutTail,
          args.stderrTail,
          args.completedAtMs,
          args.criterionId,
          args.contentIdentity
        )
      const stored = readObjectiveCheckAttempt(
        this.database,
        args.criterionId,
        args.contentIdentity
      )
      if (
        !stored ||
        stored.exitCode !== args.exitCode ||
        stored.timedOut !== args.timedOut ||
        stored.stdoutTail !== args.stdoutTail ||
        stored.stderrTail !== args.stderrTail ||
        stored.completedAtMs !== args.completedAtMs
      ) {
        throw new Error('Check attempt natural key was replayed with a different result')
      }
      return stored
    })
  }

  /**
   * Records an owner's check waiver as the settled attempt for one criterion at one content
   * identity, replacing a `run-check` attempt already stored under that natural key. A check has
   * to have run to be known bad, so the waiver that answers it always arrives second; replaying a
   * waiver over a waiver leaves the first one standing.
   */
  recordOwnerCheckSkip(args: RecordOwnerCheckSkipArgs): ObjectiveCheckAttempt {
    return this.mutate(() => {
      this.database
        .connection()
        .prepare(`INSERT INTO check_attempt (
        id, watcher_id, criterion_id, content_identity, execution_host_id, command,
        exit_code, timed_out, stdout_tail, stderr_tail, epoch, started_at_ms, completed_at_ms,
        owner_skip
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, '', ?, ?, ?, ?, 1)
      ON CONFLICT (criterion_id, content_identity) DO UPDATE SET
        watcher_id = excluded.watcher_id,
        execution_host_id = excluded.execution_host_id,
        command = excluded.command,
        exit_code = excluded.exit_code,
        timed_out = excluded.timed_out,
        stdout_tail = excluded.stdout_tail,
        stderr_tail = excluded.stderr_tail,
        epoch = excluded.epoch,
        started_at_ms = excluded.started_at_ms,
        completed_at_ms = excluded.completed_at_ms,
        owner_skip = 1
      WHERE check_attempt.owner_skip = 0`)
        .run(
          naturalId('objective_check', args.criterionId, args.contentIdentity),
          args.watcherId,
          args.criterionId,
          args.contentIdentity,
          args.executionHostId,
          args.note,
          args.note,
          args.epoch,
          args.recordedAtMs,
          args.recordedAtMs
        )
      const stored = readObjectiveCheckAttempt(
        this.database,
        args.criterionId,
        args.contentIdentity
      )
      if (!stored || !stored.ownerSkip || stored.exitCode !== 0 || stored.completedAtMs === null) {
        throw new Error('Owner check waiver was not recorded')
      }
      return stored
    })
  }

  recordVerdict(args: RecordVerdictArgs): { dispatchId: string; reportDigest: string } {
    const report =
      args.role === 'integrator'
        ? IntegratorReportSchema.parse(args.report)
        : ReviewerReportSchema.parse(args.report)
    const criteriaJson = JSON.stringify(report.criteriaResults)
    return this.mutate(() => {
      const db = this.database.connection()
      db.prepare(`INSERT INTO review_verdict (
        id, watcher_id, revision_id, dispatch_id, role, content_identity, verdict,
        criteria_results_json, report_digest, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (dispatch_id) DO NOTHING`).run(
        naturalId('objective_verdict', args.dispatchId),
        args.watcherId,
        args.revisionId,
        args.dispatchId,
        args.role,
        args.contentIdentity,
        report.verdict,
        criteriaJson,
        args.reportDigest,
        args.createdAtMs
      )
      const stored = db
        .prepare(`SELECT watcher_id, revision_id, role, content_identity, verdict,
        criteria_results_json, report_digest, created_at_ms FROM review_verdict WHERE dispatch_id = ?`)
        .get(args.dispatchId) as Omit<VerdictRow, 'dispatch_id'> & { watcher_id: string }
      if (
        stored.watcher_id !== args.watcherId ||
        stored.revision_id !== args.revisionId ||
        stored.role !== args.role ||
        stored.content_identity !== args.contentIdentity ||
        stored.verdict !== report.verdict ||
        stored.criteria_results_json !== criteriaJson ||
        stored.report_digest !== args.reportDigest
      ) {
        throw new Error('Review verdict natural key was replayed with different content')
      }
      return { dispatchId: args.dispatchId, reportDigest: args.reportDigest }
    })
  }

  recordLanding(args: RecordLandingArgs): RecordLandingResult {
    const rung = ObjectiveLandingBarSchema.parse(args.rung)
    const payload = parseLandingPayload(rung, args.payload)
    const payloadJson = JSON.stringify(payload)
    return this.mutate(() => {
      const db = this.database.connection()
      db.prepare(`INSERT INTO landing_evidence (
        id, watcher_id, rung, content_identity, attempt_fingerprint, payload_json, epoch, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (watcher_id, rung, content_identity) DO NOTHING`).run(
        naturalId('objective_landing', args.watcherId, rung, args.contentIdentity),
        args.watcherId,
        rung,
        args.contentIdentity,
        args.attemptFingerprint,
        payloadJson,
        args.epoch,
        args.createdAtMs
      )
      const stored = db
        .prepare(`SELECT attempt_fingerprint, payload_json, epoch, created_at_ms
        FROM landing_evidence WHERE watcher_id = ? AND rung = ? AND content_identity = ?`)
        .get(args.watcherId, rung, args.contentIdentity) as {
        attempt_fingerprint: string
        payload_json: string
        epoch: number
        created_at_ms: number
      }
      if (
        stored.attempt_fingerprint !== args.attemptFingerprint ||
        stored.payload_json !== payloadJson
      ) {
        throw new Error('Landing evidence natural key was replayed with different content')
      }
      return {
        rung,
        contentIdentity: args.contentIdentity,
        attemptFingerprint: stored.attempt_fingerprint,
        revisionId: payload.revisionId,
        epoch: stored.epoch,
        createdAtMs: stored.created_at_ms
      }
    })
  }

  purge(watcherId: string): void {
    this.mutate(() => {
      const db = this.database.connection()
      for (const table of [
        'objective_parallel_state',
        'objective_dispatch',
        'landing_evidence',
        'review_verdict',
        'check_attempt',
        'acceptance_criterion',
        'revision_amendment',
        'plan_node',
        'plan_revision'
      ]) {
        db.prepare(`DELETE FROM ${table} WHERE watcher_id = ?`).run(watcherId)
      }
    })
  }

  amendRevision(args: AmendRevisionArgs): RevisionAmendmentResult {
    return amendObjectiveRevision(this.database, args)
  }

  private mutate<T>(operation: () => T): T {
    return runObjectiveMutation(this.database, () => operation())
  }
}
