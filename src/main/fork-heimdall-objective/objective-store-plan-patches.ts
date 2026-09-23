import {
  PlannerRepairReportSchema,
  type PlannerRepairReport
} from '../../shared/fork-heimdall-objective/plan-repair-schema'
import {
  PlannerReportSchema,
  type ObjectivePlanAssumption
} from '../../shared/fork-heimdall-objective/plan-schema'
import type Database from '../sqlite/sync-database'
import type { ObjectiveDatabase } from './objective-database'
import { runObjectiveMutation } from './objective-database-transaction'
import { objectiveResultDigest } from './execution-context'
import { amendObjectiveRevisionInTransaction } from './objective-store-amend-revision'
import { naturalId, parseJson, type RevisionAmendmentResult } from './objective-store-data'

export type IngestPlanPatchArgs = {
  watcherId: string
  revisionId: string
  dispatchId: string
  repairOrdinal: number
  report: PlannerRepairReport
  createdAtMs: number
  rejection?: string
}

export type RejectPlanPatchArgs = {
  patchId: string
  rejection: string
  resolvedAtMs: number
}

export type ApplyPlanPatchArgs = {
  watcherId: string
  patchId: string
  amendedAtMs: number
  frozenTaskKeys: readonly string[]
}

export type ObjectivePlanPatchStatus = 'pending' | 'applied' | 'rejected'

export type ObjectivePlanPatchRecord = {
  id: string
  watcherId: string
  revisionId: string
  createdByDispatchId: string
  repairOrdinal: number
  report: PlannerRepairReport
  digest: string
  status: ObjectivePlanPatchStatus
  rejection: string | null
  createdAtMs: number
  resolvedAtMs: number | null
}

type PlanPatchRow = {
  id: string
  watcher_id: string
  revision_id: string
  created_by_dispatch_id: string
  repair_ordinal: number
  payload_json: string
  digest: string
  status: ObjectivePlanPatchStatus
  rejection: string | null
  created_at_ms: number
  resolved_at_ms: number | null
}

const PLAN_PATCH_COLUMNS = `id, watcher_id, revision_id, created_by_dispatch_id, repair_ordinal,
  payload_json, digest, status, rejection, created_at_ms, resolved_at_ms`

function planPatchRecord(row: PlanPatchRow): ObjectivePlanPatchRecord {
  return {
    id: row.id,
    watcherId: row.watcher_id,
    revisionId: row.revision_id,
    createdByDispatchId: row.created_by_dispatch_id,
    repairOrdinal: row.repair_ordinal,
    report: parseJson(PlannerRepairReportSchema, row.payload_json, 'plan patch payload'),
    digest: row.digest,
    status: row.status,
    rejection: row.rejection,
    createdAtMs: row.created_at_ms,
    resolvedAtMs: row.resolved_at_ms
  }
}

function readPlanPatchRowById(db: Database.Database, patchId: string): PlanPatchRow | undefined {
  return db.prepare(`SELECT ${PLAN_PATCH_COLUMNS} FROM plan_patch WHERE id = ?`).get(patchId) as
    | PlanPatchRow
    | undefined
}

function readPlanPatchRowByDispatch(
  db: Database.Database,
  watcherId: string,
  dispatchId: string
): PlanPatchRow | undefined {
  return db
    .prepare(
      `SELECT ${PLAN_PATCH_COLUMNS} FROM plan_patch WHERE watcher_id = ? AND created_by_dispatch_id = ?`
    )
    .get(watcherId, dispatchId) as PlanPatchRow | undefined
}

/**
 * Records a planner repair proposal against a revision, natural-keyed on (watcherId, dispatchId) so
 * a replayed dispatch returns the original patch unchanged instead of duplicating it. A caller that
 * already knows the patch is unusable (e.g. it names a frozen task) passes `rejection` so the row
 * lands `rejected` without a review ever being dispatched for it.
 */
export function ingestPlanPatch(
  database: ObjectiveDatabase,
  args: IngestPlanPatchArgs
): ObjectivePlanPatchRecord {
  const report = PlannerRepairReportSchema.parse(args.report)
  const payloadJson = JSON.stringify(report)
  const digest = objectiveResultDigest(report)
  const id = naturalId('objective_plan_patch', args.watcherId, args.dispatchId)
  const status: ObjectivePlanPatchStatus = args.rejection === undefined ? 'pending' : 'rejected'
  const resolvedAtMs = args.rejection === undefined ? null : args.createdAtMs
  return runObjectiveMutation(database, (db) => {
    db.prepare(
      `INSERT INTO plan_patch (
        id, watcher_id, revision_id, created_by_dispatch_id, repair_ordinal, payload_json, digest,
        status, rejection, created_at_ms, resolved_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (watcher_id, created_by_dispatch_id) DO NOTHING`
    ).run(
      id,
      args.watcherId,
      args.revisionId,
      args.dispatchId,
      args.repairOrdinal,
      payloadJson,
      digest,
      status,
      args.rejection ?? null,
      args.createdAtMs,
      resolvedAtMs
    )
    const stored = readPlanPatchRowByDispatch(db, args.watcherId, args.dispatchId)
    if (
      !stored ||
      stored.revision_id !== args.revisionId ||
      stored.repair_ordinal !== args.repairOrdinal ||
      stored.payload_json !== payloadJson ||
      stored.digest !== digest ||
      stored.created_at_ms !== args.createdAtMs
    ) {
      throw new Error('Plan patch natural key was replayed with different content')
    }
    return planPatchRecord(stored)
  })
}

/** Rejects a pending patch outright, e.g. after a `revise`/`escalate` plan review verdict. */
export function rejectPlanPatch(
  database: ObjectiveDatabase,
  args: RejectPlanPatchArgs
): ObjectivePlanPatchRecord {
  return runObjectiveMutation(database, (db) => {
    const row = readPlanPatchRowById(db, args.patchId)
    if (!row) {
      throw new Error('Plan patch was not found')
    }
    if (row.status === 'applied') {
      throw new Error('Plan patch cannot be rejected from applied')
    }
    if (row.status === 'rejected') {
      if (row.rejection !== args.rejection) {
        throw new Error('Plan patch rejection was replayed with a different reason')
      }
      return planPatchRecord(row)
    }
    db.prepare(
      `UPDATE plan_patch SET status = 'rejected', rejection = ?, resolved_at_ms = ? WHERE id = ?`
    ).run(args.rejection, args.resolvedAtMs, args.patchId)
    return planPatchRecord(readPlanPatchRowById(db, args.patchId)!)
  })
}

function mergeAssumptionsOntoRevision(
  db: Database.Database,
  revisionId: string,
  previousAssumptions: readonly ObjectivePlanAssumption[],
  patchAssumptions: readonly ObjectivePlanAssumption[]
): void {
  const revision = db
    .prepare('SELECT payload_json FROM plan_revision WHERE id = ?')
    .get(revisionId) as { payload_json: string }
  const plan = parseJson(PlannerReportSchema, revision.payload_json, 'plan payload').plan
  const taskKeys = new Set(plan.map((task) => task.taskKey))
  const assumptions = [...previousAssumptions, ...patchAssumptions].map((assumption) => ({
    ...assumption,
    dependentTaskKeys: assumption.dependentTaskKeys.filter((taskKey) => taskKeys.has(taskKey))
  }))
  db.prepare('UPDATE plan_revision SET payload_json = ? WHERE id = ?').run(
    JSON.stringify({ plan, assumptions }),
    revisionId
  )
}

/**
 * Applies a pending patch to its revision inside one transaction: the amendment and the patch's own
 * `applied`/`rejected` transition either both land or neither does. Replaying an already-applied
 * patch re-runs `amendObjectiveRevisionInTransaction`, which recognizes its own digest and reports
 * `replayed: true` without writing anything again.
 */
export function applyPlanPatch(
  database: ObjectiveDatabase,
  args: ApplyPlanPatchArgs
): RevisionAmendmentResult {
  return runObjectiveMutation(database, (db) => {
    const row = readPlanPatchRowById(db, args.patchId)
    if (!row || row.watcher_id !== args.watcherId) {
      throw new Error('Plan patch was not found')
    }
    if (row.status === 'rejected') {
      throw new Error('Plan patch cannot be applied from rejected')
    }
    const report = parseJson(PlannerRepairReportSchema, row.payload_json, 'plan patch payload')
    const previousRevision = db
      .prepare('SELECT payload_json FROM plan_revision WHERE id = ?')
      .get(row.revision_id) as { payload_json: string } | undefined
    const previousAssumptions = previousRevision
      ? (parseJson(PlannerReportSchema, previousRevision.payload_json, 'plan payload')
          .assumptions ?? [])
      : []

    const result = amendObjectiveRevisionInTransaction(db, {
      watcherId: args.watcherId,
      revisionId: row.revision_id,
      amendedAtMs: args.amendedAtMs,
      frozenTaskKeys: args.frozenTaskKeys,
      patch: {
        digest: row.digest,
        attestation: `planner-repair:${args.patchId}`,
        upsertTasks: report.repair.upsertTasks,
        dropTaskKeys: report.repair.dropTaskKeys
      }
    })

    if (row.status !== 'pending') {
      return result
    }
    if (result.ok) {
      mergeAssumptionsOntoRevision(
        db,
        row.revision_id,
        previousAssumptions,
        report.assumptions ?? []
      )
      db.prepare(`UPDATE plan_patch SET status = 'applied', resolved_at_ms = ? WHERE id = ?`).run(
        args.amendedAtMs,
        args.patchId
      )
    } else {
      const offender = 'taskKey' in result ? result.taskKey : result.detail
      db.prepare(
        `UPDATE plan_patch SET status = 'rejected', rejection = ?, resolved_at_ms = ? WHERE id = ?`
      ).run(`${result.reason}:${offender}`, args.amendedAtMs, args.patchId)
    }
    return result
  })
}

export function getPlanPatch(
  database: ObjectiveDatabase,
  patchId: string
): ObjectivePlanPatchRecord | null {
  const row = readPlanPatchRowById(database.connection(), patchId)
  return row ? planPatchRecord(row) : null
}

export function listPlanPatches(
  database: ObjectiveDatabase,
  watcherId: string
): ObjectivePlanPatchRecord[] {
  const rows = database
    .connection()
    .prepare(
      `SELECT ${PLAN_PATCH_COLUMNS} FROM plan_patch WHERE watcher_id = ? ORDER BY created_at_ms DESC, id DESC`
    )
    .all(watcherId) as unknown as PlanPatchRow[]
  return rows.map(planPatchRecord)
}

/** Frees a watcher's one-draft slot so a new draft can be ingested without waiting on owner review. */
export function rejectDraftRevision(
  database: ObjectiveDatabase,
  args: { watcherId: string; revisionId: string }
): void {
  runObjectiveMutation(database, (db) => {
    const row = db
      .prepare('SELECT status FROM plan_revision WHERE id = ? AND watcher_id = ?')
      .get(args.revisionId, args.watcherId) as { status: string } | undefined
    if (!row) {
      throw new Error('Plan revision was not found for rejection')
    }
    if (row.status === 'rejected') {
      return
    }
    if (row.status !== 'draft') {
      throw new Error(`Plan revision cannot be rejected from ${row.status}`)
    }
    db.prepare("UPDATE plan_revision SET status = 'rejected' WHERE id = ? AND watcher_id = ?").run(
      args.revisionId,
      args.watcherId
    )
  })
}

function touchedTaskKeys(report: PlannerRepairReport): string[] {
  return [
    ...new Set([
      ...report.repair.upsertTasks.map((task) => task.taskKey),
      ...report.repair.dropTaskKeys
    ])
  ]
}

/** Read model rows for `ObjectiveProjectionSchema.patches`, newest first. */
export function projectPlanPatches(
  db: Database.Database,
  watcherId: string
): {
  id: string
  revisionId: string
  createdByDispatchId: string
  repairOrdinal: number
  digest: string
  status: ObjectivePlanPatchStatus
  rejection: string | null
  touchedTaskKeys: string[]
  createdAtMs: number
  resolvedAtMs: number | null
}[] {
  const rows = db
    .prepare(
      `SELECT ${PLAN_PATCH_COLUMNS} FROM plan_patch WHERE watcher_id = ?
       ORDER BY created_at_ms DESC, id DESC LIMIT 1024`
    )
    .all(watcherId) as unknown as PlanPatchRow[]
  return rows.map((row) => {
    const record = planPatchRecord(row)
    return {
      id: record.id,
      revisionId: record.revisionId,
      createdByDispatchId: record.createdByDispatchId,
      repairOrdinal: record.repairOrdinal,
      digest: record.digest,
      status: record.status,
      rejection: record.rejection,
      touchedTaskKeys: touchedTaskKeys(record.report),
      createdAtMs: record.createdAtMs,
      resolvedAtMs: record.resolvedAtMs
    }
  })
}
