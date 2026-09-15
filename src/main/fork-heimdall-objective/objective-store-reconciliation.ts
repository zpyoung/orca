import {
  IngestReportActionSchema,
  ObjectiveActionResultSchema
} from '../../shared/fork-heimdall-objective/objective-actions'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import { WatcherLedgerSchema, type WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveDatabase } from './objective-database'
import { findObjectiveWorkerEvidence } from './execution-context'
import type { ObjectiveReconcileResult } from './objective-store-data'
import type { ObjectiveStoreMutations } from './objective-store-mutations'
import type { ObjectiveStoreQueries } from './objective-store-queries'

export function reconcileObjectiveLedger(
  database: ObjectiveDatabase,
  queries: ObjectiveStoreQueries,
  mutations: ObjectiveStoreMutations,
  ledger: WatcherLedger
): ObjectiveReconcileResult {
  database.assertWritable()
  const parsed = WatcherLedgerSchema.parse(ledger)
  const attempts = getLatestAttempts(parsed)
  let reconciled = 0
  let skipped = 0
  for (const attempt of attempts) {
    if (attempt.state !== 'settled' || attempt.effect !== 'landed') {
      continue
    }
    const action = IngestReportActionSchema.safeParse(attempt.action)
    const result = ObjectiveActionResultSchema.safeParse(attempt.result)
    if (
      action.success &&
      result.success &&
      result.data.kind === 'report-ingested' &&
      action.data.orchestrationTaskId !== null &&
      result.data.naturalKey.kind === 'implementer-report' &&
      result.data.naturalKey.revisionId === action.data.revisionId &&
      result.data.naturalKey.taskKey === action.data.taskKey &&
      result.data.naturalKey.dispatchId === action.data.dispatchId
    ) {
      const evidenceAtMs = findObjectiveWorkerEvidence(parsed, action.data.dispatchId)?.atMs
      const originAtMs = attempts.find((entry) => entry.dispatchId === action.data.dispatchId)?.atMs
      const dispatchedAtMs = evidenceAtMs ?? originAtMs ?? null
      if (dispatchedAtMs === null) {
        skipped += 1
        continue
      }
      if (!queries.nodeForDispatch(parsed.watcherId, action.data.dispatchId)) {
        mutations.recordNodeDispatch({
          watcherId: parsed.watcherId,
          revisionId: action.data.revisionId,
          taskKey: action.data.taskKey,
          orchestrationTaskId: action.data.orchestrationTaskId,
          dispatchId: action.data.dispatchId,
          dispatchedAtMs
        })
        reconciled += 1
      }
      continue
    }
    if (
      [
        'ingest-plan',
        'activate-plan',
        'ingest-report',
        'run-check',
        'ingest-verdict',
        'record-landing'
      ].includes(attempt.action.kind)
    ) {
      skipped += 1
    }
  }
  return { reconciled, skipped }
}
