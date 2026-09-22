import type { ObjectiveRevisionStatus } from '../../shared/fork-heimdall-objective/detail-types'
import {
  PlannerReportSchema,
  type ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import {
  RevisionAmendmentPatchSchema,
  applyRevisionAmendmentPatch,
  revisionAmendmentTouchedTaskKeys,
  unknownAmendmentDropTaskKeys
} from '../../shared/fork-heimdall-objective/revision-amendment'
import type Database from '../sqlite/sync-database'
import type { ObjectiveDatabase } from './objective-database'
import { runObjectiveMutation } from './objective-database-transaction'
import {
  naturalId,
  parseJson,
  type AmendRevisionArgs,
  type RevisionAmendmentResult
} from './objective-store-data'

/**
 * Corrects an approved plan revision in place: the revision keeps its id and `approved` status, so
 * nothing it dispatched projects as `replanned`, while nodes named in the patch are updated and
 * reset to `pending` for redispatch. A node the patch does not name is left untouched. A node that
 * succeeded or is still in flight cannot be dropped — only one whose dispatch already failed can.
 */
export function amendObjectiveRevision(
  database: ObjectiveDatabase,
  args: AmendRevisionArgs
): RevisionAmendmentResult {
  const patch = RevisionAmendmentPatchSchema.parse(args.patch)
  return runObjectiveMutation(database, (db): RevisionAmendmentResult => {
    const revision = db
      .prepare('SELECT status, payload_json FROM plan_revision WHERE id = ? AND watcher_id = ?')
      .get(args.revisionId, args.watcherId) as
      | { status: ObjectiveRevisionStatus; payload_json: string }
      | undefined
    if (!revision) {
      throw new Error('Plan revision was not found for amendment')
    }
    if (revision.status !== 'approved') {
      throw new Error(`Plan revision cannot be amended from ${revision.status}`)
    }

    const replay = db
      .prepare('SELECT ordinal FROM revision_amendment WHERE revision_id = ? AND digest = ?')
      .get(args.revisionId, patch.digest) as { ordinal: number } | undefined
    if (replay) {
      return {
        ok: true,
        revisionId: args.revisionId,
        digest: patch.digest,
        ordinal: replay.ordinal,
        replayed: true
      }
    }

    const currentPlan = parseJson(PlannerReportSchema, revision.payload_json, 'plan payload').plan
    const unknownDrops = unknownAmendmentDropTaskKeys(currentPlan, patch)
    if (unknownDrops.length > 0) {
      throw new Error(`Amendment cannot drop unknown task key ${unknownDrops[0]}`)
    }

    // a plan row only ever records a *successful* dispatch; an in-flight node has none either, so
    // the caller-supplied ledger read is the only signal that distinguishes it from a failed one
    const succeededTaskKeys = new Set(
      (
        db
          .prepare(
            'SELECT task_key FROM plan_node WHERE revision_id = ? AND dispatch_id IS NOT NULL'
          )
          .all(args.revisionId) as { task_key: string }[]
      ).map((row) => row.task_key)
    )
    const inFlightTaskKeys = new Set(args.inFlightTaskKeys ?? [])
    for (const taskKey of patch.dropTaskKeys) {
      if (succeededTaskKeys.has(taskKey)) {
        return { ok: false, reason: 'drops-succeeded-node', taskKey }
      }
      if (inFlightTaskKeys.has(taskKey)) {
        return { ok: false, reason: 'drops-in-flight-node', taskKey }
      }
    }

    const amended = applyRevisionAmendmentPatch(currentPlan, patch)
    if (!amended.ok) {
      return amended
    }

    db.prepare(
      'UPDATE plan_revision SET payload_json = ?, digest = ? WHERE id = ? AND watcher_id = ?'
    ).run(JSON.stringify({ plan: amended.plan }), patch.digest, args.revisionId, args.watcherId)
    db.prepare('DELETE FROM review_verdict WHERE revision_id = ?').run(args.revisionId)

    for (const taskKey of patch.dropTaskKeys) {
      dropAmendedNode(db, args.revisionId, taskKey)
    }
    const ordinalByTaskKey = new Map(
      amended.plan.map((task, ordinal) => [task.taskKey, ordinal] as const)
    )
    for (const [taskKey, ordinal] of ordinalByTaskKey) {
      db.prepare('UPDATE plan_node SET ordinal = ? WHERE revision_id = ? AND task_key = ?').run(
        ordinal,
        args.revisionId,
        taskKey
      )
    }
    for (const task of patch.upsertTasks) {
      upsertAmendedNode(db, args, task, ordinalByTaskKey.get(task.taskKey)!)
    }

    const ordinal = nextAmendmentOrdinal(db, args.revisionId)
    db.prepare(
      `INSERT INTO revision_amendment (
        id, watcher_id, revision_id, ordinal, digest, amended_at_ms, attestation, touched_task_keys_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      naturalId('objective_amendment', args.revisionId, patch.digest),
      args.watcherId,
      args.revisionId,
      ordinal,
      patch.digest,
      args.amendedAtMs,
      patch.attestation,
      JSON.stringify(revisionAmendmentTouchedTaskKeys(patch))
    )

    return { ok: true, revisionId: args.revisionId, digest: patch.digest, ordinal, replayed: false }
  })
}

function dropAmendedNode(db: Database.Database, revisionId: string, taskKey: string): void {
  db.prepare(
    `DELETE FROM check_attempt WHERE criterion_id IN
     (SELECT id FROM acceptance_criterion WHERE revision_id = ? AND task_key = ?)`
  ).run(revisionId, taskKey)
  db.prepare('DELETE FROM acceptance_criterion WHERE revision_id = ? AND task_key = ?').run(
    revisionId,
    taskKey
  )
  db.prepare('DELETE FROM plan_node WHERE revision_id = ? AND task_key = ?').run(
    revisionId,
    taskKey
  )
}

function upsertAmendedNode(
  db: Database.Database,
  args: AmendRevisionArgs,
  task: ObjectivePlanTask,
  planOrdinal: number
): void {
  // a shorter criteria list than before must drop the now-unnamed trailing ordinals and their checks
  db.prepare(
    `DELETE FROM check_attempt WHERE criterion_id IN
     (SELECT id FROM acceptance_criterion WHERE revision_id = ? AND task_key = ? AND ordinal >= ?)`
  ).run(args.revisionId, task.taskKey, task.criteria.length)
  db.prepare(
    'DELETE FROM acceptance_criterion WHERE revision_id = ? AND task_key = ? AND ordinal >= ?'
  ).run(args.revisionId, task.taskKey, task.criteria.length)

  db.prepare(
    `INSERT INTO plan_node (
      id, watcher_id, revision_id, task_key, title, spec, deps_json,
      orchestration_task_id, dispatch_id, dispatched_at_ms, amended_at_ms, ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    ON CONFLICT (revision_id, task_key) DO UPDATE SET
      title = excluded.title, spec = excluded.spec, deps_json = excluded.deps_json,
      orchestration_task_id = NULL, dispatch_id = NULL, dispatched_at_ms = NULL,
      amended_at_ms = excluded.amended_at_ms, ordinal = excluded.ordinal`
  ).run(
    naturalId('objective_node', args.revisionId, task.taskKey),
    args.watcherId,
    args.revisionId,
    task.taskKey,
    task.title,
    task.spec,
    JSON.stringify(task.deps),
    args.amendedAtMs,
    planOrdinal
  )

  task.criteria.forEach((criterion, ordinal) => {
    db.prepare(
      `DELETE FROM check_attempt WHERE criterion_id IN (
        SELECT id FROM acceptance_criterion
        WHERE revision_id = ? AND task_key = ? AND ordinal = ?
          AND NOT (body IS ? AND shell_checkable = ? AND check_command IS ?)
      )`
    ).run(
      args.revisionId,
      task.taskKey,
      ordinal,
      criterion.body,
      criterion.shellCheckable ? 1 : 0,
      criterion.checkCommand
    )
    db.prepare(
      `INSERT INTO acceptance_criterion (
        id, watcher_id, revision_id, task_key, ordinal, body, shell_checkable, check_command
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (revision_id, task_key, ordinal) DO UPDATE SET
        body = excluded.body, shell_checkable = excluded.shell_checkable, check_command = excluded.check_command`
    ).run(
      naturalId('objective_criterion', args.revisionId, task.taskKey, ordinal),
      args.watcherId,
      args.revisionId,
      task.taskKey,
      ordinal,
      criterion.body,
      criterion.shellCheckable ? 1 : 0,
      criterion.checkCommand
    )
  })
}

function nextAmendmentOrdinal(db: Database.Database, revisionId: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM revision_amendment WHERE revision_id = ?'
    )
    .get(revisionId) as { value: number }
  return row.value
}
