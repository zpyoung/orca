import type { Deviation } from '../fork-heimdall/owner/deviation'
import type { ObjectiveFailureClass } from '../fork-heimdall/effect-certainty'
import { OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH, type ObjectiveLandingBar } from './contract-types'
import type { ObjectiveReviewRole } from './detail-types'

const DEVIATION_CONTEXT_TEXT_MAX_LENGTH = 8_192
const FILE_LIST_MAX = 256
const FILE_PATH_MAX_LENGTH = 1_024
const ABBREVIATED_MARKER = '… [abbreviated]'

/** Owner-facing deviation context is bounded without mutating canonical reports or action records. */
function boundedContext(value: string, max = DEVIATION_CONTEXT_TEXT_MAX_LENGTH): string {
  return value.length > max
    ? `${value.slice(0, max - ABBREVIATED_MARKER.length)}${ABBREVIATED_MARKER}`
    : value
}

function boundedFiles(files: readonly string[]): {
  values: string[]
  omitted: number
  abbreviatedPaths: number
} {
  let abbreviatedPaths = 0
  const values = files.slice(0, FILE_LIST_MAX).map((file) => {
    if (file.length <= FILE_PATH_MAX_LENGTH) {
      return file
    }
    abbreviatedPaths += 1
    return boundedContext(file, FILE_PATH_MAX_LENGTH)
  })
  return { values, omitted: files.length - values.length, abbreviatedPaths }
}

export function objectiveNodeFailedDeviation(args: {
  taskKey: string
  dispatchId: string | null
  failureClass: ObjectiveFailureClass | null
  summary: string | null
  conflictPaths?: readonly string[]
  conflictingDispatchIds?: readonly string[]
}): Deviation {
  const conflicts =
    args.conflictPaths === undefined ? undefined : boundedFiles(args.conflictPaths).values
  const conflictingDispatchIds = args.conflictingDispatchIds?.slice(0, 128)
  const detail =
    conflicts === undefined && conflictingDispatchIds === undefined
      ? undefined
      : boundedContext(
          `Conflict resolution failed. Paths: ${conflicts?.join(', ') || 'none'}. Dispatches: ${conflictingDispatchIds?.join(', ') || 'none'}.`,
          4_096
        )
  return {
    kind: 'node-failed',
    dispatchId: args.dispatchId ?? `node:${args.taskKey}`,
    taskKey: args.taskKey,
    failureClass: args.failureClass,
    summary:
      args.summary === null
        ? null
        : boundedContext(args.summary, OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH),
    ...(detail === undefined ? {} : { detail }),
    ...(conflicts === undefined ? {} : { conflictPaths: conflicts }),
    ...(conflictingDispatchIds === undefined ? {} : { conflictingDispatchIds })
  }
}

export function objectiveRetryExhaustedDeviation(args: {
  taskKey: string
  retryCount: number
  lastFailureClass: ObjectiveFailureClass | null
  conflictPaths?: readonly string[]
  conflictingDispatchIds?: readonly string[]
}): Deviation {
  const conflicts =
    args.conflictPaths === undefined ? undefined : boundedFiles(args.conflictPaths).values
  const conflictingDispatchIds = args.conflictingDispatchIds?.slice(0, 128)
  const detail =
    conflicts === undefined && conflictingDispatchIds === undefined
      ? undefined
      : boundedContext(
          `Conflict resolution exhausted its retry cap. Paths: ${conflicts?.join(', ') || 'none'}. Dispatches: ${conflictingDispatchIds?.join(', ') || 'none'}.`,
          4_096
        )
  return {
    kind: 'retry-exhausted',
    taskKey: args.taskKey,
    retryCount: args.retryCount,
    lastFailureClass: args.lastFailureClass,
    ...(detail === undefined ? {} : { detail }),
    ...(conflicts === undefined ? {} : { conflictPaths: conflicts }),
    ...(conflictingDispatchIds === undefined ? {} : { conflictingDispatchIds })
  }
}

export function objectiveReportRejectedDeviation(args: {
  dispatchId: string
  taskKey: string
  rejectionReason: string
  reportedFiles: readonly string[]
  observedFiles: readonly string[]
  detail?: string
}): Deviation {
  const reported = boundedFiles(args.reportedFiles)
  const observed = boundedFiles(args.observedFiles)
  const abbreviation =
    reported.omitted > 0 ||
    observed.omitted > 0 ||
    reported.abbreviatedPaths > 0 ||
    observed.abbreviatedPaths > 0
      ? `Diagnostic file lists abbreviated: reported omitted=${reported.omitted}, observed omitted=${observed.omitted}, reported paths abbreviated=${reported.abbreviatedPaths}, observed paths abbreviated=${observed.abbreviatedPaths}.`
      : undefined
  const detail =
    args.detail === undefined
      ? abbreviation
      : abbreviation === undefined
        ? args.detail
        : `${args.detail}\n${abbreviation}`
  return {
    kind: 'report-rejected',
    dispatchId: args.dispatchId,
    taskKey: args.taskKey,
    rejectionReason: boundedContext(args.rejectionReason),
    reportedFiles: reported.values,
    observedFiles: observed.values,
    ...(detail === undefined ? {} : { detail: boundedContext(detail, 4_096) })
  }
}

export function objectiveCheckFailedDeviation(args: {
  criterionId: string
  command: string | null
  exitCode: number | null
  timedOut: boolean
  detail?: string
}): Deviation {
  return {
    kind: 'check-failed',
    criterionId: args.criterionId,
    command: args.command,
    exitCode: args.exitCode,
    timedOut: args.timedOut,
    ...(args.detail === undefined ? {} : { detail: boundedContext(args.detail, 4_096) })
  }
}

export function objectiveReviewBlockedDeviation(args: {
  role: ObjectiveReviewRole
  dispatchId: string
  summary: string | null
  detail?: string
}): Deviation {
  return {
    kind: 'review-blocked',
    role: args.role,
    dispatchId: args.dispatchId,
    summary:
      args.summary === null
        ? null
        : boundedContext(args.summary, OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH),
    ...(args.detail === undefined ? {} : { detail: boundedContext(args.detail, 4_096) })
  }
}

export function objectiveLandingFailedDeviation(args: {
  rung: ObjectiveLandingBar
  contentIdentity: string
  reason: string | null
}): Deviation {
  return {
    kind: 'landing-failed',
    rung: args.rung,
    contentIdentity: args.contentIdentity,
    reason: args.reason === null ? null : boundedContext(args.reason)
  }
}

export function objectivePlanFailedDeviation(args: {
  reason: 'no-usable-plan' | 'activation-not-landed'
  revisionId?: string
  revisionNumber?: number
  detail?: string
}): Deviation {
  return {
    kind: 'plan-failed',
    reason: args.reason,
    ...(args.revisionId === undefined ? {} : { revisionId: args.revisionId }),
    ...(args.revisionNumber === undefined ? {} : { revisionNumber: args.revisionNumber }),
    ...(args.detail === undefined ? {} : { detail: boundedContext(args.detail, 4_096) })
  }
}
