import type { AttemptEntry, WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  objectiveAttemptFailureClass,
  objectiveAttemptReportValidation,
  objectiveReportValidationDetail,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome
} from './decision-context'
import { decidePlannerAction } from './decide-planner'
import { objectiveNodeFailedDeviation, objectiveReportRejectedDeviation } from './deviation-context'
import type {
  ObjectiveNodeProjection,
  ObjectivePendingReport,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export type ObjectiveReportRejection = {
  rejectionReason: string
  reportedFiles: string[]
  observedFiles: string[]
  detail?: string
  status: 'rejected' | 'unverifiable'
}

export function rejectedObjectiveReportResult(
  attempt: AttemptEntry,
  ledger: WatcherLedger
): ObjectiveReportRejection {
  const provenance = objectiveAttemptReportValidation(attempt, ledger)
  if (provenance) {
    return {
      rejectionReason:
        provenance.sourceCode ?? attempt.reason ?? `${provenance.role}-report-${provenance.code}`,
      reportedFiles: provenance.reportedFiles,
      observedFiles: provenance.observedFiles,
      detail: objectiveReportValidationDetail(provenance),
      status: provenance.status
    }
  }
  const result = attempt.result
  const record = isPlainRecord(result) ? result : {}
  const files = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const detail =
    typeof record.detail === 'string' && record.detail.trim().length > 0 ? record.detail : undefined
  return {
    rejectionReason: attempt.reason ?? 'report-rejected',
    reportedFiles: files(record.reportedFiles),
    observedFiles: files(record.observedFiles),
    ...(detail === undefined ? {} : { detail }),
    status: 'rejected'
  }
}

export function projectedObjectiveReportRejection(
  report: ObjectivePendingReport
): ObjectiveReportRejection | null {
  const provenance = report.reportValidation
  if (!provenance) {
    return null
  }
  return {
    rejectionReason: provenance.sourceCode ?? `${provenance.role}-report-${provenance.code}`,
    reportedFiles: provenance.reportedFiles,
    observedFiles: provenance.observedFiles,
    detail: objectiveReportValidationDetail(provenance),
    status: provenance.status
  }
}

export function objectiveNodeFailureSummary(
  reports: readonly ObjectivePendingReport[],
  attempt: AttemptEntry | undefined,
  ledger: WatcherLedger
): string | null {
  if (attempt) {
    const provenance = objectiveAttemptReportValidation(attempt, ledger)
    if (provenance) {
      return objectiveReportValidationDetail(provenance)
    }
  }
  const report = attempt?.dispatchId
    ? reports.find((candidate) => candidate.dispatchId === attempt.dispatchId)
    : undefined
  return report?.body ?? attempt?.reason ?? null
}

type NodeFailureDecisionContext = {
  snapshot: Snapshot<ObjectiveWorld>
  ledger: WatcherLedger
  attempts: readonly ObjectiveAttempt[]
  reports: readonly ObjectivePendingReport[]
  revision: ObjectiveRevisionProjection
  ownerConfigured: boolean
}

export function decideObjectiveNodeFailure(
  args: NodeFailureDecisionContext & {
    node: ObjectiveNodeProjection
    dispatch: ObjectiveAttempt | null
    summary?: string | null
  }
): ObjectiveDecisionOutcome {
  if (args.ownerConfigured) {
    return {
      action: null,
      deviation: objectiveNodeFailedDeviation({
        taskKey: args.node.taskKey,
        dispatchId: args.node.dispatchId ?? args.dispatch?.attempt.dispatchId ?? null,
        failureClass: args.dispatch
          ? (objectiveAttemptFailureClass(args.dispatch.attempt, args.ledger) ?? null)
          : null,
        summary:
          args.summary ??
          objectiveNodeFailureSummary(args.reports, args.dispatch?.attempt, args.ledger)
      })
    }
  }
  return decidePlannerAction(
    args.snapshot,
    args.ledger,
    args.attempts,
    args.reports,
    'replan-after-failure',
    args.revision.number
  )
}

export function decideObjectiveReportRejection(
  args: NodeFailureDecisionContext & {
    node: ObjectiveNodeProjection
    dispatchId: string
    rejection: ObjectiveReportRejection
  }
): ObjectiveDecisionOutcome {
  if (!args.ownerConfigured) {
    return decidePlannerAction(
      args.snapshot,
      args.ledger,
      args.attempts,
      args.reports,
      'replan-after-failure',
      args.revision.number
    )
  }
  if (args.rejection.status === 'unverifiable') {
    return {
      action: null,
      deviation: objectiveNodeFailedDeviation({
        taskKey: args.node.taskKey,
        dispatchId: args.dispatchId,
        failureClass: null,
        summary: args.rejection.detail ?? args.rejection.rejectionReason
      })
    }
  }
  return {
    action: null,
    deviation: objectiveReportRejectedDeviation({
      dispatchId: args.dispatchId,
      taskKey: args.node.taskKey,
      rejectionReason: args.rejection.rejectionReason,
      reportedFiles: args.rejection.reportedFiles,
      observedFiles: args.rejection.observedFiles,
      ...(args.rejection.detail === undefined ? {} : { detail: args.rejection.detail })
    })
  }
}
