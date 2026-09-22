import type { SubmissionPreflightResult } from '../../shared/fork-heimdall/kind-contract'
import type { HeimdallOrchestrationSubmission } from './kernel-service-contract'
import type { EnrollmentRecord, EnrollmentStore } from './enrollment-store'
import { isMalformedKindPayloadEnrollment } from './enrollment-store'
import type { HeimdallKernelHost } from './kernel-host'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'
import {
  findOldestOpenOwnerDeviation,
  ownerInterventionSubmissionSubject,
  ownerTurnAwaitingSend
} from './owner/deviation-ledger'
import { preflightOwnerInterventionSubmission } from './owner/submission-preflight'
import { findOwnerSession } from './owner/owner-session'
import {
  clearOwnerSubmissionRejection,
  rememberOwnerSubmissionRejection
} from './owner/deviation-routing'

const ACCEPTED = { status: 'accepted' } as const

type SubmissionPreflightDependencies = {
  enrollments: EnrollmentStore
  runners: ReadonlyMap<string, WatcherRunner>
  ledgerStore: RunnerLedgerStore
  host: HeimdallKernelHost
  ownsEnrollment(enrollment: EnrollmentRecord): boolean
}

export async function preflightKernelSubmission(
  submission: HeimdallOrchestrationSubmission,
  deps: SubmissionPreflightDependencies
): Promise<SubmissionPreflightResult> {
  const enrollmentRecord = deps.enrollments
    .list()
    .find(
      (candidate) =>
        candidate.orchestrationRunId === submission.runId &&
        candidate.terminalAtMs === null &&
        deps.ownsEnrollment(candidate)
    )
  if (!enrollmentRecord || isMalformedKindPayloadEnrollment(enrollmentRecord)) {
    return ACCEPTED
  }
  const enrollment = enrollmentRecord
  const runner = deps.runners.get(enrollment.watcherId)
  if (!runner) {
    return ACCEPTED
  }
  const ledger = deps.ledgerStore.read(enrollment.watcherId)

  if (submission.type === 'worker_done' && runner.kind.submission) {
    if (!submission.payload) {
      return ACCEPTED
    }
    let payload: unknown
    try {
      payload = JSON.parse(submission.payload)
    } catch {
      return ACCEPTED
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return ACCEPTED
    }
    const report = payload as Record<string, unknown>
    const dispatchId =
      typeof report.dispatchId === 'string' ? report.dispatchId : submission.dispatchId
    if (!dispatchId) {
      return ACCEPTED
    }
    try {
      return await runner.kind.submission.preflightWorkerReport(
        { dispatchId, payload: report },
        { enrollment, snapshot: runner.lastSnapshot, ledger }
      )
    } catch {
      // Execution-host and report-reader failures are not deterministic input rejection.
      return ACCEPTED
    }
  }

  if (submission.type !== 'status' || !runner.kind.owner) {
    return ACCEPTED
  }
  const ownerSubjectPrefix = `heimdall-owner-intervention:${enrollment.watcherId}:`
  if (!submission.subject.startsWith(ownerSubjectPrefix)) {
    return ACCEPTED
  }
  const inactiveOwnerTurn = {
    status: 'rejected',
    code: 'heimdall_owner_turn_not_active',
    reason:
      'Heimdall rejected the reserved owner intervention ready status because no matching sent owner turn is active. Wait for the current owner prompt, then send its exact ready command from the owner worker that received it.'
  } as const
  const pending = findOldestOpenOwnerDeviation(ledger)
  if (
    !pending ||
    submission.subject !== ownerInterventionSubmissionSubject(enrollment.watcherId, pending)
  ) {
    return inactiveOwnerTurn
  }
  if (ownerTurnAwaitingSend(pending)) {
    return inactiveOwnerTurn
  }
  const ownerSession = findOwnerSession(enrollment.watcherId)
  if (!ownerSession || ownerSession.handle !== submission.from) {
    return {
      status: 'rejected',
      code: 'heimdall_owner_submission_unauthorized',
      reason:
        'Heimdall rejected the owner intervention ready status because it was not sent by the active structured owner session. Resend the same ready command from the owner worker that received the current intervention prompt.'
    }
  }
  try {
    const snapshot =
      runner.lastSnapshot ??
      (await runner.kind.read(enrollment, {
        fresh: true
      }))
    const target = await deps.host.resolveLeaseTarget(enrollment.workspaceKey)
    const result = await preflightOwnerInterventionSubmission({
      target,
      pending,
      owner: runner.kind.owner,
      snapshot,
      ledger,
      enrollment
    })
    if (result.status === 'rejected') {
      rememberOwnerSubmissionRejection(runner, pending, result.reason)
    } else {
      clearOwnerSubmissionRejection(runner, pending)
    }
    return result
  } catch {
    // A failed or unverifiable execution-host read must follow the normal lifecycle.
    clearOwnerSubmissionRejection(runner, pending)
    return ACCEPTED
  }
}
