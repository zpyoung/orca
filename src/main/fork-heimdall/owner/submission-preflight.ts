import type {
  KernelAction,
  OwnerAdapter,
  SubmissionPreflightResult
} from '../../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import { InterventionSchema } from '../../../shared/fork-heimdall/owner/intervention'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { LeaseWorkspaceTarget } from '../lease-store'
import { ownerDeviationWakeToken, type OwnerDeviationEscalation } from './deviation-ledger'
import { evaluateOwnerIntervention } from './owner-intervention'
import { readOwnerReport, ownerReportPathForWake, MAX_OWNER_REPORT_BYTES } from './owner-report-io'
import { resolveOwnerReportLocation } from './owner-report-location'

export async function preflightOwnerInterventionSubmission(args: {
  target: LeaseWorkspaceTarget
  pending: OwnerDeviationEscalation
  owner: OwnerAdapter<unknown, KernelAction>
  snapshot: Snapshot<unknown>
  ledger: WatcherLedger
  enrollment: WatcherEnrollment
}): Promise<SubmissionPreflightResult> {
  const location = await resolveOwnerReportLocation(args.target)
  const reportPath = ownerReportPathForWake(location, ownerDeviationWakeToken(args.pending))
  const read = await readOwnerReport(location, reportPath, undefined, InterventionSchema)
  const outcome = evaluateOwnerIntervention({
    read,
    owner: args.owner,
    snapshot: args.snapshot,
    ledger: args.ledger,
    enrollment: args.enrollment
  })
  if (outcome.status !== 'malformed' && outcome.status !== 'rejected') {
    return { status: 'accepted' }
  }
  const detail =
    outcome.status === 'rejected' ? `${outcome.gate}: ${outcome.reason}` : outcome.reason
  const boundedDetail =
    read.ok || read.reason !== 'oversize'
      ? detail
      : `reportPath exceeds the ${MAX_OWNER_REPORT_BYTES}-byte limit.`
  return {
    status: 'rejected',
    code: 'heimdall_owner_intervention_invalid',
    reason:
      `Heimdall rejected the owner intervention: ${boundedDetail} ` +
      'Correct the issued report file and resend the same ready status; the current owner turn and retry budget remain available.'
  }
}
