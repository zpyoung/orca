import { parkEscalationId } from '../../shared/fork-heimdall/park-escalation-id'
import type { EnrollmentStore, EnrollmentRecord } from '../fork-heimdall/enrollment-store'
import { isMalformedKindPayloadEnrollment } from '../fork-heimdall/enrollment-store'
import type { RunnerLedgerStore } from '../fork-heimdall/runner-state'
import type { PipelineAwareEnrollmentStore } from './pipeline-aware-enrollment-store'
/** Parks each live pipeline enrollment whose workspace is claimed by a live built-in watcher. */
export function parkClaimedPipelineRows(
  store: Pick<PipelineAwareEnrollmentStore, 'pipelineRowsClaimedByBuiltin'>,
  parkForConfigurationError: (watcherId: string, reason: string) => void
): void {
  for (const row of store.pipelineRowsClaimedByBuiltin()) {
    parkForConfigurationError(row.pipelineWatcherId, `workspace-claimed:${row.builtinWatcherId}`)
  }
}

export type PipelineBootConflictParkerDependencies = Readonly<{
  enrollments: EnrollmentStore
  ledger: RunnerLedgerStore
  now(): number
  createId(): string
}>

/** Creates an idempotent configuration-error transition for a conflicting pipeline row. */
export function createPipelineBootConflictParker(
  dependencies: PipelineBootConflictParkerDependencies
): (watcherId: string, reason: string) => void {
  return (watcherId, reason) => {
    const record: EnrollmentRecord | null = dependencies.enrollments.get(watcherId)
    if (!record || isMalformedKindPayloadEnrollment(record)) {
      return
    }
    const parkReason = { kind: 'configuration-error', reason } as const
    const escalationId = parkEscalationId(watcherId, parkReason)
    const previous = dependencies.ledger
      .read(watcherId)
      .entries.findLast(
        (entry) => entry.kind === 'escalation' && entry.escalationId === escalationId
      )
    if (
      previous?.kind === 'escalation' &&
      previous.status === 'open' &&
      previous.reason === reason
    ) {
      return
    }
    if (record.enabled) {
      dependencies.enrollments.setEnabled(watcherId, false)
    }
    dependencies.ledger.append(watcherId, {
      eventId: dependencies.createId(),
      watcherId,
      atMs: dependencies.now(),
      origin: 'owner',
      class: 'fact',
      kind: 'escalation',
      escalationId,
      escalationKind: 'park-configuration-error',
      status: 'open',
      foldCount: previous?.kind === 'escalation' ? previous.foldCount + 1 : 1,
      reason
    })
  }
}
