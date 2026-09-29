import { HEIMDALL_CHANNELS, type EnrollSuccess } from '../../shared/fork-heimdall/api'
import {
  HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
  HeimdallEnrollmentRefusalError,
  HeimdallEnrollmentRefusalErrorDataSchema
} from '../../shared/fork-heimdall/enrollment-refusal-error'
import {
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import type {
  WatcherCommandRequest,
  WatcherCommandResult,
  WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import {
  EnrollSuccessReaderSchema,
  WatcherCommandResultReaderSchema
} from '../../shared/fork-heimdall/remote-reader-schemas'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  HeimdallCommandCapabilityError,
  HeimdallEnvironmentUnavailableError,
  remoteCommandWasSent,
  type FleetEnvironmentIdentity,
  type FleetEnvironmentTransport
} from './fleet-environment-transport'

export const OWNER_UNREACHABLE =
  'The owning runtime cannot be reached. The watcher may still be running.'
const COMMAND_INDETERMINATE =
  'The connection failed after the command was sent. It may or may not have taken effect; refresh the owner state before trying again.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function enrollmentForParallelCompatibility(
  input: EnrollInput,
  parallelExecutionSupported: boolean
): EnrollInput {
  if (parallelExecutionSupported || input.kind !== 'objective' || !isRecord(input.kindPayload)) {
    return input
  }
  const { lanesEnabled: _lanesEnabled, gates: _gates, ...legacyKindPayload } = input.kindPayload
  return {
    ...input,
    kindPayload: { ...legacyKindPayload, maxConcurrency: 1 }
  }
}

export async function enrollRemoteWatcher(
  environments: FleetEnvironmentTransport,
  identity: FleetEnvironmentIdentity,
  input: EnrollInput
): Promise<EnrollSuccess> {
  let response: RuntimeRpcResponse<unknown>
  try {
    response = await environments.mutate(identity, HEIMDALL_CHANNELS.enroll, {
      input,
      owner: null
    })
  } catch (error) {
    if (
      error instanceof HeimdallCommandCapabilityError ||
      error instanceof HeimdallEnvironmentUnavailableError
    ) {
      throw error
    }
    throw new Error(
      remoteCommandWasSent(error)
        ? `Heimdall enrollment outcome is indeterminate. ${COMMAND_INDETERMINATE}`
        : OWNER_UNREACHABLE
    )
  }
  if (response.ok !== true) {
    if (response.error.code === HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE) {
      const refusal = HeimdallEnrollmentRefusalErrorDataSchema.safeParse(response.error.data)
      if (!refusal.success) {
        throw new Error('The owning runtime returned an invalid Heimdall enrollment refusal.')
      }
      throw new HeimdallEnrollmentRefusalError(refusal.data, response.error.message)
    }
    if (response.error.message.startsWith('Heimdall enrollment refused:')) {
      throw new Error(response.error.message)
    }
    if (response.error.code === 'method_not_found') {
      throw new HeimdallCommandCapabilityError()
    }
    throw new Error(`Heimdall enrollment outcome is indeterminate. ${COMMAND_INDETERMINATE}`)
  }
  const parsed = EnrollSuccessReaderSchema.safeParse(response.result)
  if (!parsed.success) {
    throw new Error('The owning runtime returned an invalid Heimdall enrollment result.')
  }
  return parsed.data
}

export async function sendRemoteWatcherCommand(
  environments: FleetEnvironmentTransport,
  identity: FleetEnvironmentIdentity,
  request: WatcherCommandRequest,
  onUnsupported: () => void
): Promise<WatcherCommandResult> {
  const localRequest: WatcherCommandRequest = {
    ...request,
    target: {
      watcherId: request.target.watcherId,
      connectionId: null,
      pairingRevision: null
    }
  }
  try {
    const response =
      request.command.kind === 'delete'
        ? await environments.mutate(
            identity,
            HEIMDALL_CHANNELS.command,
            localRequest,
            HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
          )
        : request.command.kind === 'set-concurrency'
          ? await environments.mutate(
              identity,
              HEIMDALL_CHANNELS.command,
              localRequest,
              HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
            )
          : await environments.mutate(identity, HEIMDALL_CHANNELS.command, localRequest)
    if (response.ok !== true) {
      return response.error.code === 'method_not_found'
        ? refused('unsupported-capability', 'The owning runtime does not expose Heimdall commands.')
        : indeterminate()
    }
    const parsed = WatcherCommandResultReaderSchema.safeParse(response.result)
    return parsed.success ? parsed.data : indeterminate()
  } catch (error) {
    if (error instanceof HeimdallCommandCapabilityError) {
      onUnsupported()
      return refused('unsupported-capability', error.message)
    }
    if (error instanceof HeimdallEnvironmentUnavailableError) {
      return error.availability === 'replaced'
        ? refused('owner-conflict', error.message)
        : refused('owner-unreachable', error.message)
    }
    return remoteCommandWasSent(error)
      ? indeterminate()
      : refused('owner-unreachable', OWNER_UNREACHABLE)
  }
}

export async function readRemoteDebugReport(
  environments: FleetEnvironmentTransport,
  identity: FleetEnvironmentIdentity,
  target: WatcherTarget
): Promise<unknown> {
  const response = await environments.read(identity, HEIMDALL_CHANNELS.debugReport, {
    watcherId: target.watcherId,
    connectionId: null,
    pairingRevision: null
  })
  if (response.ok !== true) {
    throw new Error('The owning runtime refused the Heimdall debug report read.')
  }
  return response.result
}

export function refused(
  reason: Extract<WatcherCommandResult, { status: 'refused' }>['reason'],
  detail: string
): WatcherCommandResult {
  return { status: 'refused', reason, detail }
}

function indeterminate(): WatcherCommandResult {
  return { status: 'indeterminate', detail: COMMAND_INDETERMINATE }
}
