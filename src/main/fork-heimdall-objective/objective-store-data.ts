import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ObjectiveLandingBar } from '../../shared/fork-heimdall-objective/contract-types'
import type {
  ObjectiveRevisionStatus,
  ObjectiveReviewRole
} from '../../shared/fork-heimdall-objective/detail-types'
import {
  ReviewCriterionResultSchema,
  type IntegratorReport,
  type ObjectiveCriterion,
  type PlannerReport,
  type ReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'

const IdSchema = z.string().trim().min(1).max(1_024)

const FilesOnDiskLandingPayloadSchema = z.object({ revisionId: IdSchema }).strict()
const CommittedLocalBranchLandingPayloadSchema = z
  .object({
    revisionId: IdSchema,
    fromContentIdentity: IdSchema,
    commitSha: IdSchema,
    treeOid: IdSchema,
    branch: IdSchema
  })
  .strict()
const PushedRefLandingPayloadSchema = z
  .object({
    revisionId: IdSchema,
    fromContentIdentity: IdSchema,
    remote: IdSchema,
    branch: IdSchema,
    commitSha: IdSchema,
    remoteSha: IdSchema
  })
  .strict()
export const HostedReviewLandingPayloadSchema = z
  .object({
    revisionId: IdSchema,
    fromContentIdentity: IdSchema,
    provider: z.enum(['github', 'gitlab']),
    reviewNumber: z.number().int().positive().safe(),
    reviewUrl: z.string().trim().url(),
    branch: IdSchema,
    headSha: IdSchema,
    base: IdSchema
  })
  .strict()
const MergedLandingPayloadSchema = z
  .object({
    revisionId: IdSchema,
    fromContentIdentity: IdSchema,
    mergeSha: IdSchema
  })
  .strict()

export const LandingPayloadSchema = z.union([
  FilesOnDiskLandingPayloadSchema,
  CommittedLocalBranchLandingPayloadSchema,
  PushedRefLandingPayloadSchema,
  HostedReviewLandingPayloadSchema,
  MergedLandingPayloadSchema
])
export const CriteriaResultsSchema = z.array(ReviewCriterionResultSchema)
export const DependenciesSchema = z.array(IdSchema).max(128)

export type ObjectiveLandingPayload = z.infer<typeof LandingPayloadSchema>
export type HostedReviewLandingPayload = z.infer<typeof HostedReviewLandingPayloadSchema>

export function parseLandingPayload(
  rung: ObjectiveLandingBar,
  value: unknown
): ObjectiveLandingPayload {
  const schema = {
    'files-on-disk': FilesOnDiskLandingPayloadSchema,
    'committed-local-branch': CommittedLocalBranchLandingPayloadSchema,
    'pushed-ref': PushedRefLandingPayloadSchema,
    'hosted-review': HostedReviewLandingPayloadSchema,
    merged: MergedLandingPayloadSchema
  }[rung]
  return schema.parse(value)
}

export function parseLandingPayloadJson(
  rung: ObjectiveLandingBar,
  json: string,
  field: string
): ObjectiveLandingPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error(`Objective database contains malformed ${field} JSON`)
  }
  try {
    return parseLandingPayload(rung, parsed)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Objective database contains invalid ${field}: ${detail}`)
  }
}

export type IngestPlanArgs = {
  watcherId: string
  revisionNumber: number
  dispatchId: string
  report: PlannerReport
  digest: string
  createdAtMs: number
}

export type IngestPlanResult = {
  revisionId: string
  revisionNumber: number
  digest: string
}

export type ActivatePlanArgs = {
  watcherId: string
  revisionId: string
  digest: string
  approvedAtMs: number
}

export type ActivatePlanResult = IngestPlanResult & { approvedAtMs: number }

export type RecordNodeDispatchArgs = {
  watcherId: string
  revisionId: string
  taskKey: string
  orchestrationTaskId: string | null
  dispatchId: string
  dispatchedAtMs: number
}

export type StartCheckAttemptArgs = {
  watcherId: string
  criterionId: string
  contentIdentity: string
  executionHostId: string
  command: string
  epoch: number
  startedAtMs: number
}

export type CompleteCheckAttemptArgs = {
  criterionId: string
  contentIdentity: string
  exitCode: number | null
  timedOut: boolean
  stdoutTail: string
  stderrTail: string
  completedAtMs: number
}

export type ObjectiveCheckAttempt = StartCheckAttemptArgs & {
  id: string
  exitCode: number | null
  timedOut: boolean
  stdoutTail: string
  stderrTail: string
  completedAtMs: number | null
}

export type ObjectiveStoredCriterion = ObjectiveCriterion & {
  id: string
  revisionId: string
  taskKey: string
  ordinal: number
}

export type RecordVerdictArgs = {
  watcherId: string
  revisionId: string
  dispatchId: string
  role: ObjectiveReviewRole
  contentIdentity: string
  report: ReviewerReport | IntegratorReport
  reportDigest: string
  createdAtMs: number
}

export type RecordLandingArgs = {
  watcherId: string
  rung: ObjectiveLandingBar
  contentIdentity: string
  attemptFingerprint: string
  payload: ObjectiveLandingPayload
  epoch: number
  createdAtMs: number
}

export type RecordLandingResult = {
  rung: ObjectiveLandingBar
  contentIdentity: string
  attemptFingerprint: string
  revisionId: string
  epoch: number
  createdAtMs: number
}

export type ObjectiveReconcileResult = { reconciled: number; skipped: number }

export type RevisionRow = {
  id: string
  revision_number: number
  status: ObjectiveRevisionStatus
  digest: string
  created_by_dispatch_id: string | null
  created_at_ms: number
  approved_at_ms: number | null
}

export type NodeRow = {
  revision_id: string
  revision_status: ObjectiveRevisionStatus
  task_key: string
  title?: string
  deps_json: string
  orchestration_task_id: string | null
  dispatch_id: string | null
}

export type CriterionRow = {
  id: string
  revision_id: string
  task_key: string
  ordinal: number
  body: string
  shell_checkable: number
  check_command: string | null
}

export type CheckRow = {
  id: string
  watcher_id: string
  criterion_id: string
  content_identity: string
  execution_host_id: string
  command: string
  exit_code: number | null
  timed_out: number
  stdout_tail: string
  stderr_tail: string
  epoch: number
  started_at_ms: number
  completed_at_ms: number | null
}

export type ProjectionCheckRow = Pick<
  CheckRow,
  | 'criterion_id'
  | 'content_identity'
  | 'exit_code'
  | 'timed_out'
  | 'started_at_ms'
  | 'completed_at_ms'
>

export type VerdictRow = {
  revision_id: string
  dispatch_id: string
  role: ObjectiveReviewRole
  content_identity: string
  verdict: 'approve' | 'block'
  criteria_results_json: string
  report_digest: string
  created_at_ms: number
}

export type LandingRow = {
  rung: ObjectiveLandingBar
  content_identity: string
  payload_json: string
  created_at_ms: number
}

export function naturalId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

export function parseJson<T>(schema: z.ZodType<T>, json: string, field: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error(`Objective database contains malformed ${field} JSON`)
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`Objective database contains invalid ${field}: ${result.error.message}`)
  }
  return result.data
}
