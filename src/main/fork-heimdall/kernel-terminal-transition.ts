import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import type { HandoffAdapter } from '../../shared/fork-heimdall/kind-contract'
import type {
  HandoffEvidencePayload,
  HandoffOriginPayload
} from '../../shared/fork-heimdall-objective/objective-handoff-policy'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { FiredStopPredicate } from '../../shared/fork-heimdall/stop-policy'
import type {
  AuthorizedEnrollment,
  CoordinatorIdentity,
  EnrollInput,
  WatcherEnrollment
} from '../../shared/fork-heimdall/watcher-types'
import {
  isMalformedKindPayloadEnrollment,
  type EnrollmentRecord,
  type EnrollmentStore
} from './enrollment-store'
import type { KindEnrollmentAuthorization } from './kernel-enrollment'
import { getErrorCode } from '../git/worktree-operation-options'
import type { HeimdallLedgerStore } from './ledger-store'
import type { RegisteredWatcherKind } from './registry'
import { WatcherDeletePendingError } from './runner-control-lifecycle'
import type { WatcherRunner } from './runner-state'

export type KernelTerminalTransitionDependencies = {
  enrollments: EnrollmentStore
  ledger: HeimdallLedgerStore
  now(): number
  createId(): string
  authorize(input: EnrollInput): Promise<KindEnrollmentAuthorization>
  mintCoordinatorIdentity(seed: string): CoordinatorIdentity
  readLedger(watcherId: string): WatcherLedger
}

export type PreparedHandoff =
  | { status: 'enroll'; enrollment: WatcherEnrollment; kind: RegisteredWatcherKind }
  | {
      status: 'refused'
      reason: 'invalid-payload' | 'owner-not-executable' | 'unknown-kind'
      detail: string
    }
  | { status: 'none' }

export type TerminalCommitResult = {
  enrollment: WatcherEnrollment
  handoff:
    | { status: 'enrolled'; enrollment: WatcherEnrollment }
    | { status: 'refused'; detail: string }
    | { status: 'none' }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function payloadString(payload: unknown, field: string): string {
  if (!isRecord(payload)) {
    throw new Error(`Authorized handoff payload is missing ${field}`)
  }
  const value = payload[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Authorized handoff payload is missing ${field}`)
  }
  return value
}

function hasSourceWorkspaceAuthority(
  source: WatcherEnrollment,
  authorized: AuthorizedEnrollment
): boolean {
  return (
    authorized.workspaceKey === source.workspaceKey &&
    authorized.executionHostId === source.executionHostId &&
    authorized.schedulerOwner === source.schedulerOwner &&
    authorized.workspacePath === source.workspacePath &&
    authorized.repoId === source.repoId &&
    authorized.worktreeId === source.worktreeId
  )
}

function isDuplicateWorkspace(error: unknown): boolean {
  return (
    getErrorCode(error) === 'SQLITE_CONSTRAINT_UNIQUE' &&
    errorDetail(error).includes('heimdall_enrollment.workspace_key')
  )
}

/** Atomically joins the kernel terminal fact to the enrollment's terminal marker and handoff. */
export class KernelTerminalTransition {
  constructor(private readonly dependencies: KernelTerminalTransitionDependencies) {}

  async prepareHandoff(
    enrollment: WatcherEnrollment,
    fired: FiredStopPredicate,
    handoff?: HandoffAdapter<unknown>
  ): Promise<PreparedHandoff> {
    if (!handoff) {
      return { status: 'none' }
    }
    const derivation = await handoff.derive(
      enrollment,
      fired,
      this.dependencies.readLedger(enrollment.watcherId)
    )
    if (derivation.kind === 'none') {
      return { status: 'none' }
    }

    let authorization: KindEnrollmentAuthorization
    try {
      authorization = await this.dependencies.authorize(derivation.input)
    } catch (error) {
      return { status: 'refused', reason: 'invalid-payload', detail: errorDetail(error) }
    }
    if (authorization.status !== 'authorized') {
      if (authorization.reason === 'owner-not-executable') {
        return {
          status: 'refused',
          reason: authorization.reason,
          detail: authorization.schedulerOwner
        }
      }
      return {
        status: 'refused',
        reason: authorization.reason,
        detail: authorization.detail
      }
    }
    if (!hasSourceWorkspaceAuthority(enrollment, authorization.authorized)) {
      return {
        status: 'refused',
        reason: 'invalid-payload',
        detail: 'Authorized handoff workspace does not match the terminating watcher'
      }
    }

    const watcherId = this.dependencies.createId()
    return {
      status: 'enroll',
      kind: authorization.kind,
      enrollment: {
        ...authorization.authorized,
        watcherId,
        enabled: true,
        paused: false,
        commandRevision: 0,
        coordinatorIdentity: this.dependencies.mintCoordinatorIdentity(
          this.dependencies.createId()
        ),
        orchestrationRunId: null,
        createdAtMs: 0,
        terminalAtMs: null
      }
    }
  }

  commit(
    enrollment: WatcherEnrollment,
    fired: FiredStopPredicate,
    prepared: PreparedHandoff = { status: 'none' }
  ): TerminalCommitResult {
    return this.commitAt(enrollment, fired, prepared, this.dependencies.now(), true)
  }

  async terminate(
    runner: WatcherRunner,
    fired: FiredStopPredicate,
    activate: (sitter: WatcherEnrollment, kind: RegisteredWatcherKind) => void
  ): Promise<WatcherEnrollment> {
    const prepared = await this.prepareHandoff(runner.enrollment, fired, runner.kind.handoff)
    if (!runner.leaseGuard) {
      throw new Error('Watcher terminal transition reached persistence without a lease')
    }
    await runner.leaseGuard.assertHeld()
    if (runner.stopped || runner.controlPending === 'delete') {
      throw new WatcherDeletePendingError()
    }
    const result = this.commit(runner.enrollment, fired, prepared)
    if (result.handoff.status === 'enrolled' && prepared.status === 'enroll') {
      activate(result.handoff.enrollment, prepared.kind)
    }
    return result.enrollment
  }

  recover(enrollment: WatcherEnrollment, writable = true): WatcherEnrollment {
    if (enrollment.terminalAtMs !== null) {
      if (writable) {
        this.compactTerminal(enrollment)
      }
      return enrollment
    }
    const terminal = this.dependencies.ledger
      .read(enrollment.watcherId)
      .entries.find((entry) => entry.kind === 'terminal')
    if (!terminal || terminal.kind !== 'terminal') {
      return enrollment
    }
    if (!writable) {
      return {
        ...enrollment,
        enabled: false,
        paused: false,
        terminalAtMs: terminal.atMs
      }
    }
    return this.requireValid(
      this.dependencies.enrollments.markTerminal(
        enrollment.watcherId,
        terminal.atMs,
        undefined,
        () => this.compactTerminal(enrollment)
      )
    )
  }

  private commitAt(
    enrollment: WatcherEnrollment,
    fired: FiredStopPredicate,
    prepared: PreparedHandoff,
    atMs: number,
    retryDuplicate: boolean
  ): TerminalCommitResult {
    const transaction: {
      transitioned: boolean
      terminalEventId: string | null
      sitter: WatcherEnrollment | null
    } = { transitioned: false, terminalEventId: null, sitter: null }
    try {
      const updated = this.dependencies.enrollments.markTerminal(
        enrollment.watcherId,
        atMs,
        () => {
          transaction.transitioned = true
          if (prepared.status === 'enroll') {
            const payload: HandoffEvidencePayload = {
              sitterWatcherId: prepared.enrollment.watcherId,
              reviewUrl: payloadString(prepared.enrollment.kindPayload, 'reviewUrl'),
              reachedRung: 'hosted-review',
              contentIdentity: fired.detail ?? fired.predicateId
            }
            this.dependencies.ledger.append({
              eventId: this.dependencies.createId(),
              watcherId: enrollment.watcherId,
              atMs,
              origin: 'owner',
              class: 'fact',
              kind: 'evidence',
              evidenceKind: 'handoff',
              payload
            })
          } else if (prepared.status === 'refused') {
            this.dependencies.ledger.append({
              eventId: this.dependencies.createId(),
              watcherId: enrollment.watcherId,
              atMs,
              origin: 'owner',
              class: 'fact',
              kind: 'escalation',
              escalationId: `handoff:${enrollment.watcherId}`,
              escalationKind: 'handoff-refused',
              status: 'open',
              foldCount: 1,
              reason: prepared.detail
            })
          }
          transaction.terminalEventId = this.dependencies.createId()
          this.dependencies.ledger.append({
            eventId: transaction.terminalEventId,
            watcherId: enrollment.watcherId,
            atMs,
            origin: 'owner',
            class: 'fact',
            kind: 'terminal',
            state: fired.predicateId,
            reason: fired.reason
          })
        },
        () => {
          if (prepared.status === 'enroll' && transaction.terminalEventId !== null) {
            transaction.sitter = this.dependencies.enrollments.insert({
              ...prepared.enrollment,
              createdAtMs: atMs
            })
            const payload: HandoffOriginPayload = {
              objectiveWatcherId: enrollment.watcherId,
              objectiveTerminalEventId: transaction.terminalEventId,
              contentIdentity: fired.detail ?? fired.predicateId,
              reachedRung: 'hosted-review',
              inheritedBudget: prepared.enrollment.budget,
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: enrollment.capabilities is a generic capabilities Record; the sitter kind's contract guarantees it carries exactly HandoffOriginPayload['derivedCapabilities']'s keys by convention, which the generic Record type cannot express.
              derivedCapabilities: prepared.enrollment
                .capabilities as HandoffOriginPayload['derivedCapabilities']
            }
            this.dependencies.ledger.append({
              eventId: this.dependencies.createId(),
              watcherId: transaction.sitter.watcherId,
              atMs,
              origin: 'owner',
              class: 'fact',
              kind: 'evidence',
              evidenceKind: 'handoff-origin',
              payload
            })
          }
          this.compactTerminal(enrollment)
        }
      )
      const valid = this.requireValid(updated)
      if (!transaction.transitioned) {
        return { enrollment: valid, handoff: { status: 'none' } }
      }
      if (prepared.status === 'enroll' && transaction.sitter) {
        return {
          enrollment: valid,
          handoff: { status: 'enrolled', enrollment: transaction.sitter }
        }
      }
      if (prepared.status === 'refused') {
        return { enrollment: valid, handoff: { status: 'refused', detail: prepared.detail } }
      }
      return { enrollment: valid, handoff: { status: 'none' } }
    } catch (error) {
      if (prepared.status === 'enroll' && retryDuplicate && isDuplicateWorkspace(error)) {
        return this.commitAt(
          enrollment,
          fired,
          { status: 'refused', reason: 'invalid-payload', detail: 'duplicate-workspace' },
          atMs,
          false
        )
      }
      throw error
    }
  }

  private compactTerminal(enrollment: WatcherEnrollment): void {
    const ledger = this.dependencies.ledger.read(enrollment.watcherId)
    this.dependencies.ledger.compactTerminal(
      enrollment.watcherId,
      enrollment.kind,
      deriveBudgetState(ledger, enrollment.budget)
    )
  }

  private requireValid(record: EnrollmentRecord): WatcherEnrollment {
    if (isMalformedKindPayloadEnrollment(record)) {
      throw new Error(`Heimdall watcher ${record.watcherId} kind payload is malformed`)
    }
    return record
  }
}
