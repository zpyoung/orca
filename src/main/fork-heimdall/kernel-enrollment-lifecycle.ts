import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  AuthorizedEnrollment,
  EnrollInput,
  EnrollResult,
  WatcherEnrollment,
  WatcherListEntry
} from '../../shared/fork-heimdall/watcher-types'
import {
  isMalformedKindPayloadEnrollment,
  type EnrollmentRecord,
  type EnrollmentStore
} from './enrollment-store'
import { authorizeKindEnrollment, extendBudgetForRearm } from './kernel-enrollment'
import { mintCoordinatorIdentity } from './orchestration/coordinator-identity'
import type { WatcherKindRegistry, RegisteredWatcherKind } from './registry'
import type { WatcherRunner } from './runner-state'

export type KernelEnrollmentLifecycleDependencies = {
  registry: WatcherKindRegistry
  storageAuthority: 'desktop' | 'runtime'
  enrollments: EnrollmentStore
  readLedger(watcherId: string): WatcherLedger
  appendBudgetGeneration(watcherId: string): void
  owns(enrollment: EnrollmentRecord): boolean
  restore(enrollment: WatcherEnrollment, kind: RegisteredWatcherKind): WatcherRunner
  runner(watcherId: string): WatcherRunner | null
  acknowledgePark(watcherId: string): void
  entry(enrollment: WatcherEnrollment): WatcherListEntry
  schedule(runner: WatcherRunner): void
  publish(): void
  now(): number
  createId(): string
}

type InsertedEnrollmentActivation = Pick<
  KernelEnrollmentLifecycleDependencies,
  'restore' | 'publish'
>

export function activateInsertedEnrollment(
  inserted: WatcherEnrollment,
  kind: RegisteredWatcherKind,
  dependencies: InsertedEnrollmentActivation
): void {
  dependencies.restore(inserted, kind)
  dependencies.publish()
}

function latestHaltWasExplicitDisarm(ledger: WatcherLedger): boolean {
  const halt = ledger.entries.findLast(
    (entry) =>
      entry.kind === 'escalation' &&
      (entry.escalationKind.startsWith('park-') || entry.escalationKind === 'control-disarm')
  )
  return halt?.kind === 'escalation' && halt.escalationKind === 'control-disarm'
}
function validateEnrollment(
  kind: RegisteredWatcherKind,
  candidate: AuthorizedEnrollment,
  existing: WatcherEnrollment | null
): { status: 'refused'; reason: 'invalid-payload'; detail: string } | null {
  try {
    kind.validateEnrollment?.(candidate, existing)
    return null
  } catch (error) {
    return {
      status: 'refused',
      reason: 'invalid-payload',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function enrollWatcher(
  untrustedInput: EnrollInput,
  dependencies: KernelEnrollmentLifecycleDependencies
): Promise<EnrollResult> {
  const authorization = await authorizeKindEnrollment(
    dependencies.registry,
    untrustedInput,
    dependencies.storageAuthority
  )
  if (authorization.status !== 'authorized') {
    return authorization
  }
  const { authorized, kind } = authorization

  const existing = dependencies.enrollments.findLiveByWorkspace(authorized.workspaceKey)
  if (existing) {
    if (isMalformedKindPayloadEnrollment(existing)) {
      return {
        status: 'refused',
        reason: 'invalid-payload',
        detail: 'Persisted kind payload is malformed and cannot be re-armed'
      }
    }
    if (!dependencies.owns(existing)) {
      return {
        status: 'refused',
        reason: 'owner-not-executable',
        schedulerOwner: existing.schedulerOwner
      }
    }
    if (
      existing.executionHostId !== authorized.executionHostId ||
      existing.schedulerOwner !== authorized.schedulerOwner ||
      existing.workspaceKey !== authorized.workspaceKey
    ) {
      return {
        status: 'refused',
        reason: 'duplicate-workspace',
        existingWatcherId: existing.watcherId
      }
    }
    if (existing.enabled) {
      return {
        status: 'refused',
        reason: 'duplicate-workspace',
        existingWatcherId: existing.watcherId
      }
    }
    if (existing.kind !== authorized.kind) {
      return {
        status: 'refused',
        reason: 'invalid-payload',
        detail: `Workspace is already enrolled as ${existing.kind}`
      }
    }
    const validationRefusal = validateEnrollment(kind, authorized, existing)
    if (validationRefusal) {
      return validationRefusal
    }
    const ledger = dependencies.readLedger(existing.watcherId)
    const startsNewBudgetGeneration = latestHaltWasExplicitDisarm(ledger)
    const budget = startsNewBudgetGeneration
      ? authorized.budget
      : extendBudgetForRearm(ledger, existing.budget, authorized.budget)
    const rearmed = dependencies.enrollments.rearm(
      existing.watcherId,
      {
        capabilities: authorized.capabilities,
        budget,
        kindPayload: authorized.kindPayload
      },
      startsNewBudgetGeneration
        ? () => dependencies.appendBudgetGeneration(existing.watcherId)
        : undefined
    )
    dependencies.acknowledgePark(rearmed.watcherId)
    let runner = dependencies.runner(rearmed.watcherId)
    if (!runner) {
      runner = dependencies.restore(rearmed, kind)
    } else {
      runner.enrollment = rearmed
      runner.status = {
        ...runner.status,
        enabled: true,
        state: 'watching',
        phase: 're-armed',
        reason: null,
        parkReason: null
      }
      runner.stopped = false
      dependencies.schedule(runner)
    }
    dependencies.publish()
    return { status: 're-armed', entry: dependencies.entry(rearmed) }
  }
  const validationRefusal = validateEnrollment(kind, authorized, null)
  if (validationRefusal) {
    return validationRefusal
  }

  const enrollment: WatcherEnrollment = {
    ...authorized,
    watcherId: dependencies.createId(),
    enabled: true,
    paused: false,
    commandRevision: 0,
    coordinatorIdentity: mintCoordinatorIdentity(dependencies.createId()),
    orchestrationRunId: null,
    createdAtMs: dependencies.now(),
    terminalAtMs: null
  }
  const inserted = dependencies.enrollments.insert(enrollment)
  activateInsertedEnrollment(inserted, kind, dependencies)
  return { status: 'enrolled', entry: dependencies.entry(inserted) }
}
