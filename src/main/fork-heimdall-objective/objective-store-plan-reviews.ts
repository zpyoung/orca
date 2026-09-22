import {
  PlanReviewReportSchema,
  type PlanReviewReport
} from '../../shared/fork-heimdall-objective/plan-review-schema'
import type Database from '../sqlite/sync-database'
import type { ObjectiveDatabase } from './objective-database'
import { runObjectiveMutation } from './objective-database-transaction'
import { naturalId, parseJson } from './objective-store-data'

export type PlanReviewTargetKind = 'revision' | 'patch'

export type RecordPlanReviewArgs = {
  watcherId: string
  targetKind: PlanReviewTargetKind
  targetId: string
  round: 1 | 2
  dispatchId: string
  report: PlanReviewReport
  reportDigest: string
  createdAtMs: number
}

export type ObjectivePlanReviewRecord = {
  id: string
  watcherId: string
  targetKind: PlanReviewTargetKind
  targetId: string
  round: 1 | 2
  dispatchId: string
  report: PlanReviewReport
  reportDigest: string
  createdAtMs: number
}

type PlanReviewRow = {
  id: string
  watcher_id: string
  target_kind: PlanReviewTargetKind
  target_id: string
  round: 1 | 2
  dispatch_id: string
  verdict: PlanReviewReport['verdict']
  report_json: string
  report_digest: string
  created_at_ms: number
}

const PLAN_REVIEW_COLUMNS = `id, watcher_id, target_kind, target_id, round, dispatch_id, verdict,
  report_json, report_digest, created_at_ms`

function planReviewRecord(row: PlanReviewRow): ObjectivePlanReviewRecord {
  return {
    id: row.id,
    watcherId: row.watcher_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    round: row.round,
    dispatchId: row.dispatch_id,
    report: parseJson(PlanReviewReportSchema, row.report_json, 'plan review payload'),
    reportDigest: row.report_digest,
    createdAtMs: row.created_at_ms
  }
}

function readPlanReviewRowByDispatch(
  db: Database.Database,
  dispatchId: string
): PlanReviewRow | undefined {
  return db
    .prepare(`SELECT ${PLAN_REVIEW_COLUMNS} FROM plan_review WHERE dispatch_id = ?`)
    .get(dispatchId) as PlanReviewRow | undefined
}

/**
 * Records a plan-critic verdict on a revision or a patch, natural-keyed on `dispatchId` so a
 * replayed dispatch returns the original row unchanged. A second dispatch naming the same
 * (targetKind, targetId, round) is a distinct review attempt at a slot the schema allows only one
 * verdict for, so it throws rather than silently losing the first one.
 */
export function recordPlanReview(
  database: ObjectiveDatabase,
  args: RecordPlanReviewArgs
): ObjectivePlanReviewRecord {
  const report = PlanReviewReportSchema.parse(args.report)
  const reportJson = JSON.stringify(report)
  return runObjectiveMutation(database, (db) => {
    const byDispatch = readPlanReviewRowByDispatch(db, args.dispatchId)
    if (byDispatch) {
      if (
        byDispatch.watcher_id !== args.watcherId ||
        byDispatch.target_kind !== args.targetKind ||
        byDispatch.target_id !== args.targetId ||
        byDispatch.round !== args.round ||
        byDispatch.report_json !== reportJson ||
        byDispatch.report_digest !== args.reportDigest
      ) {
        throw new Error('Plan review natural key was replayed with different content')
      }
      return planReviewRecord(byDispatch)
    }
    const bySlot = db
      .prepare(
        'SELECT dispatch_id FROM plan_review WHERE target_kind = ? AND target_id = ? AND round = ?'
      )
      .get(args.targetKind, args.targetId, args.round) as { dispatch_id: string } | undefined
    if (bySlot) {
      throw new Error(
        `Plan review round ${args.round} for ${args.targetKind} ${args.targetId} was already recorded by a different dispatch`
      )
    }
    db.prepare(
      `INSERT INTO plan_review (
        id, watcher_id, target_kind, target_id, round, dispatch_id, verdict, report_json,
        report_digest, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      naturalId('objective_plan_review', args.watcherId, args.dispatchId),
      args.watcherId,
      args.targetKind,
      args.targetId,
      args.round,
      args.dispatchId,
      report.verdict,
      reportJson,
      args.reportDigest,
      args.createdAtMs
    )
    return planReviewRecord(readPlanReviewRowByDispatch(db, args.dispatchId)!)
  })
}

export function listPlanReviews(
  database: ObjectiveDatabase,
  watcherId: string
): ObjectivePlanReviewRecord[] {
  const rows = database
    .connection()
    .prepare(
      `SELECT ${PLAN_REVIEW_COLUMNS} FROM plan_review WHERE watcher_id = ? ORDER BY created_at_ms DESC, id DESC`
    )
    .all(watcherId) as unknown as PlanReviewRow[]
  return rows.map(planReviewRecord)
}

export function getPlanReviewReport(
  database: ObjectiveDatabase,
  id: string
): PlanReviewReport | null {
  const row = database
    .connection()
    .prepare(`SELECT ${PLAN_REVIEW_COLUMNS} FROM plan_review WHERE id = ?`)
    .get(id) as PlanReviewRow | undefined
  return row ? planReviewRecord(row).report : null
}

/** Read model rows for `ObjectiveProjectionSchema.planReviews`, newest first. */
export function projectPlanReviews(
  db: Database.Database,
  watcherId: string
): {
  id: string
  targetKind: PlanReviewTargetKind
  targetId: string
  round: 1 | 2
  dispatchId: string
  verdict: PlanReviewReport['verdict']
  reportDigest: string
  createdAtMs: number
}[] {
  const rows = db
    .prepare(
      `SELECT ${PLAN_REVIEW_COLUMNS} FROM plan_review WHERE watcher_id = ? ORDER BY created_at_ms DESC, id DESC`
    )
    .all(watcherId) as unknown as PlanReviewRow[]
  return rows.map((row) => ({
    id: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    round: row.round,
    dispatchId: row.dispatch_id,
    verdict: row.verdict,
    reportDigest: row.report_digest,
    createdAtMs: row.created_at_ms
  }))
}
