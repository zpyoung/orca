import {
  AcceptReportActionSchema,
  IngestReportActionSchema
} from '../../shared/fork-heimdall-objective/objective-actions'
import { ObjectiveActionResultSchema } from '../../shared/fork-heimdall-objective/objective-action-results'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import { WatcherLedgerSchema, type WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveDatabase } from './objective-database'
import { findObjectiveWorkerEvidence } from './execution-context'
import type { ObjectiveReconcileResult } from './objective-store-data'
import type { ObjectiveStoreMutations } from './objective-store-mutations'
import type { ObjectiveStoreQueries } from './objective-store-queries'

type ImplementerReportAttemptFields = {
  revisionId: string
  taskKey: string
  dispatchId: string
  orchestrationTaskId: string | null
}

/**
 * `accept-report` lands the same `implementer-report` natural key as a successful `ingest-report`,
 * just without a validator-supplied `orchestrationTaskId` on the action itself — recovered from the
 * worker's own evidence instead, same as the dispatch-time fallback every other site here already uses.
 */
function implementerReportAttemptFields(
  action: unknown,
  ledger: WatcherLedger
): ImplementerReportAttemptFields | null {
  const ingested = IngestReportActionSchema.safeParse(action)
  if (ingested.success) {
    return {
      revisionId: ingested.data.revisionId,
      taskKey: ingested.data.taskKey,
      dispatchId: ingested.data.dispatchId,
      orchestrationTaskId: ingested.data.orchestrationTaskId
    }
  }
  const accepted = AcceptReportActionSchema.safeParse(action)
  if (accepted.success) {
    return {
      revisionId: accepted.data.revisionId,
      taskKey: accepted.data.taskKey,
      dispatchId: accepted.data.dispatchId,
      orchestrationTaskId:
        findObjectiveWorkerEvidence(ledger, accepted.data.dispatchId)?.orchestrationTaskId ?? null
    }
  }
  return null
}

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
    const action = implementerReportAttemptFields(attempt.action, parsed)
    const result = ObjectiveActionResultSchema.safeParse(attempt.result)
    if (
      action &&
      result.success &&
      (result.data.kind === 'report-ingested' || result.data.kind === 'report-accepted') &&
      action.orchestrationTaskId !== null &&
      result.data.naturalKey.kind === 'implementer-report' &&
      result.data.naturalKey.revisionId === action.revisionId &&
      result.data.naturalKey.taskKey === action.taskKey &&
      result.data.naturalKey.dispatchId === action.dispatchId
    ) {
      const evidenceAtMs = findObjectiveWorkerEvidence(parsed, action.dispatchId)?.atMs
      const originAtMs = attempts.find((entry) => entry.dispatchId === action.dispatchId)?.atMs
      const dispatchedAtMs = evidenceAtMs ?? originAtMs ?? null
      if (dispatchedAtMs === null) {
        skipped += 1
        continue
      }
      if (!queries.nodeForDispatch(parsed.watcherId, action.dispatchId)) {
        mutations.recordNodeDispatch({
          watcherId: parsed.watcherId,
          revisionId: action.revisionId,
          taskKey: action.taskKey,
          orchestrationTaskId: action.orchestrationTaskId,
          dispatchId: action.dispatchId,
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
        'record-landing',
        'accept-report'
      ].includes(attempt.action.kind)
    ) {
      skipped += 1
    }
  }
  return { reconciled, skipped }
}
