import type { AutomationSchedulerOwner } from '../../shared/automations-types'
import { deriveBudgetState, type BudgetPolicy } from '../../shared/fork-heimdall/budget'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  AuthorizedEnrollmentSchema,
  EnrollInputSchema,
  type AuthorizedEnrollment,
  type EnrollInput,
  type EnrollResult,
  type WatcherEnrollment
} from '../../shared/fork-heimdall/watcher-types'
import type { RegisteredWatcherKind, WatcherKindRegistry } from './registry'
import { isMalformedKindPayloadEnrollment, type EnrollmentRecord } from './enrollment-store'

export type EnrollmentAuthorizationRefusal = Exclude<
  Extract<EnrollResult, { status: 'refused' }>,
  { reason: 'duplicate-workspace' }
>

export type AuthorizedKindEnrollment = {
  status: 'authorized'
  authorized: AuthorizedEnrollment
  kind: RegisteredWatcherKind
}

export type KindEnrollmentAuthorization = AuthorizedKindEnrollment | EnrollmentAuthorizationRefusal

export type HeimdallStorageAuthority = 'desktop' | 'runtime'

function isOwnerRefusal(error: unknown): error is { schedulerOwner: AutomationSchedulerOwner } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'schedulerOwner' in error &&
    (error.schedulerOwner === 'local_host_service' ||
      error.schedulerOwner === 'ssh_bridge' ||
      error.schedulerOwner === 'remote_host_service')
  )
}

export async function authorizeKindEnrollment(
  registry: WatcherKindRegistry,
  untrustedInput: EnrollInput,
  storageAuthority: HeimdallStorageAuthority = 'desktop'
): Promise<KindEnrollmentAuthorization> {
  const inputResult = EnrollInputSchema.safeParse(untrustedInput)
  if (!inputResult.success) {
    return { status: 'refused', reason: 'invalid-payload', detail: inputResult.error.message }
  }
  const input = inputResult.data
  const kind = registry.get(input.kind)
  if (!kind) {
    return { status: 'refused', reason: 'unknown-kind', detail: input.kind }
  }

  const payloadResult = kind.enrollmentPayloadSchema.safeParse(input.kindPayload)
  if (!payloadResult.success) {
    return { status: 'refused', reason: 'invalid-payload', detail: payloadResult.error.message }
  }

  let authorizedUnknown: unknown
  try {
    authorizedUnknown = await kind.authorizeEnrollment(input)
  } catch (error) {
    if (isOwnerRefusal(error)) {
      return {
        status: 'refused',
        reason: 'owner-not-executable',
        schedulerOwner: error.schedulerOwner
      }
    }
    return {
      status: 'refused',
      reason: 'invalid-payload',
      detail: error instanceof Error ? error.message : String(error)
    }
  }

  const authorizedResult = AuthorizedEnrollmentSchema.safeParse(authorizedUnknown)
  if (!authorizedResult.success || authorizedResult.data.kind !== input.kind) {
    return {
      status: 'refused',
      reason: 'invalid-payload',
      detail: authorizedResult.success
        ? 'Authorized kind does not match requested kind'
        : authorizedResult.error.message
    }
  }
  const authorized = authorizedResult.data
  if (!kind.enrollmentPayloadSchema.safeParse(authorized.kindPayload).success) {
    return {
      status: 'refused',
      reason: 'invalid-payload',
      detail: 'Authorized kind payload is invalid'
    }
  }
  const executableOwner =
    storageAuthority === 'runtime'
      ? authorized.schedulerOwner === 'remote_host_service'
      : authorized.schedulerOwner !== 'remote_host_service'
  if (!executableOwner) {
    return {
      status: 'refused',
      reason: 'owner-not-executable',
      schedulerOwner: authorized.schedulerOwner
    }
  }
  return { status: 'authorized', authorized, kind }
}

export function extendBudgetForRearm(
  ledger: WatcherLedger,
  previous: BudgetPolicy,
  allowance: BudgetPolicy
): BudgetPolicy {
  const spent = deriveBudgetState(ledger, previous)
  return {
    wallClockActiveMs:
      allowance.wallClockActiveMs === null ? null : spent.activeMs + allowance.wallClockActiveMs,
    turns: allowance.turns === null ? null : spent.turns + allowance.turns
  }
}

export function enrollmentForPresentation(record: EnrollmentRecord): WatcherEnrollment {
  if (!isMalformedKindPayloadEnrollment(record)) {
    return record
  }
  const { malformedKindPayload, ...enrollment } = record
  return {
    ...enrollment,
    kindPayload: malformedKindPayload.rawJson
  }
}

export function runnableEnrollment(record: EnrollmentRecord | null): WatcherEnrollment | null {
  return record && !isMalformedKindPayloadEnrollment(record) ? record : null
}
