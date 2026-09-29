import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { listEnvironments, resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import {
  RemoteRuntimeClientError,
  sendRemoteRuntimeRequestWithStatusPreflight,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import {
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environment-manual-disconnect'
import {
  callRuntimeEnvironment,
  getRuntimeEnvironmentStatus,
  subscribeRuntimeEnvironment
} from '../ipc/runtime-environment-transport-routing'

const REMOTE_FLEET_TIMEOUT_MS = 15_000

export type FleetEnvironmentIdentity = {
  id: string
  pairingRevision: number
}

export type FleetEnvironmentAvailability = 'available' | 'disconnected' | 'replaced'

export type FleetEnvironmentSubscriptionCallbacks = {
  onResponse(response: RuntimeRpcResponse<unknown>): void
  onError(error: { code: string; message: string }): void
  onClose(): void
}

export type FleetEnvironmentTransport = {
  list(): FleetEnvironmentIdentity[]
  availability(identity: FleetEnvironmentIdentity): FleetEnvironmentAvailability
  status(identity: FleetEnvironmentIdentity): Promise<RuntimeRpcResponse<RuntimeStatus>>
  read(
    identity: FleetEnvironmentIdentity,
    method: string,
    params: unknown
  ): Promise<RuntimeRpcResponse<unknown>>
  mutate(
    identity: FleetEnvironmentIdentity,
    method: string,
    params: unknown,
    requiredCapability?:
      | typeof HEIMDALL_COMMANDS_RUNTIME_CAPABILITY
      | typeof HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
      | typeof HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
  ): Promise<RuntimeRpcResponse<unknown>>
  subscribe(
    identity: FleetEnvironmentIdentity,
    method: string,
    params: unknown,
    callbacks: FleetEnvironmentSubscriptionCallbacks
  ): Promise<RemoteRuntimeSubscription>
}

export class HeimdallCommandCapabilityError extends Error {
  constructor(
    requiredCapability:
      | typeof HEIMDALL_COMMANDS_RUNTIME_CAPABILITY
      | typeof HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
      | typeof HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
      | typeof HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY = HEIMDALL_COMMANDS_RUNTIME_CAPABILITY
  ) {
    super(
      requiredCapability === HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
        ? 'The owning runtime does not support permanent watcher deletion. Update the host and try again.'
        : requiredCapability === HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
          ? 'The owning runtime does not support parallel objective execution. Update the host and try again.'
          : requiredCapability === HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY
            ? 'The owning runtime does not support enrolling on a new worktree. Update the host and try again.'
            : 'The owning runtime does not support Heimdall commands. Update the host and try again.'
    )
    this.name = 'HeimdallCommandCapabilityError'
  }
}

export class HeimdallEnrollOwnerCapabilityError extends Error {
  constructor() {
    super(
      'unsupported-capability: owner-not-supported: the owning runtime does not support ' +
        'enrolling a watcher with an owner. Update the host and try again.'
    )
    this.name = 'HeimdallEnrollOwnerCapabilityError'
  }
}

export class HeimdallEnvironmentUnavailableError extends Error {
  constructor(readonly availability: Exclude<FleetEnvironmentAvailability, 'available'>) {
    super(
      availability === 'replaced'
        ? 'The runtime environment pairing changed; refresh and try again.'
        : 'The owning runtime cannot be reached.'
    )
    this.name = 'HeimdallEnvironmentUnavailableError'
  }
}

export function createFleetEnvironmentTransport(
  resolveUserDataPath: () => string
): FleetEnvironmentTransport {
  const availability = (identity: FleetEnvironmentIdentity): FleetEnvironmentAvailability => {
    let environment
    try {
      environment = resolveEnvironment(resolveUserDataPath(), identity.id)
    } catch {
      return 'disconnected'
    }
    if ((environment.pairingRevision ?? environment.createdAt) !== identity.pairingRevision) {
      return 'replaced'
    }
    return isRuntimeEnvironmentManuallyDisconnected(environment.id) ? 'disconnected' : 'available'
  }
  const assertAvailable = (identity: FleetEnvironmentIdentity) => {
    const verdict = availability(identity)
    if (verdict !== 'available') {
      throw new HeimdallEnvironmentUnavailableError(verdict)
    }
    return resolveEnvironment(resolveUserDataPath(), identity.id)
  }

  return {
    list: () =>
      listEnvironments(resolveUserDataPath()).map((environment) => ({
        id: environment.id,
        pairingRevision: environment.pairingRevision ?? environment.createdAt
      })),
    availability,
    status: async (identity) => {
      assertAvailable(identity)
      const response = await getRuntimeEnvironmentStatus(
        resolveUserDataPath(),
        identity.id,
        undefined,
        {
          observeOnly: true
        }
      )
      assertAvailable(identity)
      return response
    },
    read: async (identity, method, params) => {
      assertAvailable(identity)
      const response = await callRuntimeEnvironment(
        resolveUserDataPath(),
        identity.id,
        method,
        params,
        REMOTE_FLEET_TIMEOUT_MS,
        identity.pairingRevision
      )
      assertAvailable(identity)
      return response
    },
    mutate: (
      identity,
      method,
      params,
      requiredCapability = HEIMDALL_COMMANDS_RUNTIME_CAPABILITY
    ) => {
      const environment = assertAvailable(identity)
      const pairing = getPreferredPairingOffer(environment)
      return sendRemoteRuntimeRequestWithStatusPreflight(
        pairing,
        method,
        params,
        REMOTE_FLEET_TIMEOUT_MS,
        (response) => {
          assertAvailable(identity)
          if (response.ok !== true || !response.result.capabilities?.includes(requiredCapability)) {
            throw new HeimdallCommandCapabilityError(requiredCapability)
          }
        },
        undefined,
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      )
    },
    subscribe: (identity, method, params, callbacks) => {
      assertAvailable(identity)
      return subscribeRuntimeEnvironment(
        resolveUserDataPath(),
        identity.id,
        method,
        params,
        REMOTE_FLEET_TIMEOUT_MS,
        {
          onEvent: (event) => {
            if (availability(identity) !== 'available') {
              return
            }
            if (event.type === 'response') {
              callbacks.onResponse(event.response)
            } else if (event.type === 'error') {
              callbacks.onError({ code: event.code, message: event.message })
            } else if (event.type === 'close') {
              callbacks.onClose()
            }
          },
          onClose: () => undefined
        },
        () => availability(identity) === 'available'
      )
    }
  }
}

export function remoteCommandWasSent(error: unknown): boolean {
  return error instanceof RemoteRuntimeClientError && error.pairingStage === 'runtime'
}
