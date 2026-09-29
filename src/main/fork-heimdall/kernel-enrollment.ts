import type { AutomationSchedulerOwner } from '../../shared/automations-types'
import { deriveBudgetState, type BudgetPolicy } from '../../shared/fork-heimdall/budget'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { EnrollmentAuthorizationScope } from '../../shared/fork-heimdall/kind-contract'
import { OWNER_INTERVENTION_CAPABILITY } from '../../shared/fork-heimdall/owner/owner-capability'
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

// mirrors the runtime-side check in owner/owner-session.ts: only claude has a resumable,
// non-PTY structured session, so every other agent is refused before it ever wakes.
const SUPPORTED_OWNER_AGENTS: ReadonlySet<string> = new Set(['claude'])

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
  storageAuthority: HeimdallStorageAuthority = 'desktop',
  scope?: EnrollmentAuthorizationScope
): Promise<KindEnrollmentAuthorization> {
  const inputResult = EnrollInputSchema.safeParse(untrustedInput)
  if (!inputResult.success) {
    return { status: 'refused', reason: 'invalid-payload', detail: inputResult.error.message }
  }
  const input = inputResult.data
  if (input.owner && !SUPPORTED_OWNER_AGENTS.has(input.owner.agent)) {
    return {
      status: 'refused',
      reason: 'invalid-payload',
      detail: `Heimdall owner agent "${input.owner.agent}" has no structured session; only "claude" is supported in this slice.`
    }
  }
  const kind = registry.get(input.kind)
  if (!kind) {
    return { status: 'refused', reason: 'unknown-kind', detail: input.kind }
  }

  const payloadInputSchema = kind.enrollmentInputSchema ?? kind.enrollmentPayloadSchema
  const payloadResult = payloadInputSchema.safeParse(input.kindPayload)
  if (!payloadResult.success) {
    return { status: 'refused', reason: 'invalid-payload', detail: payloadResult.error.message }
  }

  let authorizedUnknown: unknown
  try {
    authorizedUnknown = await kind.authorizeEnrollment(input, scope)
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
  // The kind's own capability schema is strict and knows nothing about owner-intervention, so the
  // key is added here rather than passed through `input.capabilities`, and only when a caller
  // actually asks for it — an absent key already means 'off' to gate 5 (gate.ts), so every
  // enrollment that doesn't touch this stays byte-for-byte on the kind's own capability set.
  const authorizedWithOwner: AuthorizedEnrollment = {
    ...authorized,
    owner: input.owner,
    ...(input.ownerInterventionCapability === undefined
      ? {}
      : {
          capabilities: {
            ...authorized.capabilities,
            [OWNER_INTERVENTION_CAPABILITY]: input.ownerInterventionCapability
          }
        })
  }
  return { status: 'authorized', authorized: authorizedWithOwner, kind }
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
