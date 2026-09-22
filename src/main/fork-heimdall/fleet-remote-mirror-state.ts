import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import {
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import {
  HeimdallFleetSnapshotSchema,
  type HeimdallFleetSnapshot,
  type WatcherDetail,
  type WatcherFleetEntry,
  type WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import type { RuntimeCapability } from '../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type {
  FleetEnvironmentAvailability,
  FleetEnvironmentIdentity,
  FleetEnvironmentTransport
} from './fleet-environment-transport'
import { routeRemoteFleetEntry, type HeimdallCommandSupport } from './fleet-projection'

/** Reads one advertised-capability check off a `status()` outcome; unsettled or refused reads as unknown. */
function statusCapabilitySupport(
  status: PromiseSettledResult<RuntimeRpcResponse<RuntimeStatus>>,
  capability: RuntimeCapability
): HeimdallCommandSupport {
  if (status.status !== 'fulfilled' || status.value.ok !== true) {
    return 'unknown'
  }
  return status.value.result.capabilities?.includes(capability) ? 'supported' : 'unsupported'
}

export class RemoteFleetMirrorState {
  incarnation = 1
  reachable = false
  commandSupport: HeimdallCommandSupport = 'unknown'
  deleteSupport: HeimdallCommandSupport = 'unknown'
  enrollOwnerSupport: HeimdallCommandSupport = 'unknown'
  parallelExecutionSupport: HeimdallCommandSupport = 'unknown'
  ownerGeneratedAtMs = -1
  entries: WatcherFleetEntry[] = []
  readonly details = new Map<string, WatcherDetail>()
  readonly notificationDetails = new Map<string, WatcherDetail>()
  subscription: { close(): void } | null = null
  subscriptionStarting = false
  subscriptionUnsupported = false
  retryTimer: NodeJS.Timeout | null = null
  eventProcessing = Promise.resolve()
  refreshSequence = 0
  subscriptionGeneration = 0
  observationEpoch = 0
  hasSubscriptionBaseline = false

  constructor(
    public identity: FleetEnvironmentIdentity,
    private readonly onChanged: () => void
  ) {}

  replaceIdentity(identity: FleetEnvironmentIdentity): void {
    this.retireTransport()
    this.identity = identity
    this.incarnation += 1
    this.reachable = false
    this.commandSupport = 'unknown'
    this.deleteSupport = 'unknown'
    this.enrollOwnerSupport = 'unknown'
    this.parallelExecutionSupport = 'unknown'
    this.ownerGeneratedAtMs = -1
    this.subscriptionUnsupported = false
    this.eventProcessing = Promise.resolve()
    this.hasSubscriptionBaseline = false
    this.refreshSequence += 1
    this.subscriptionGeneration += 1
    this.observationEpoch += 1
    this.onChanged()
  }

  async refresh(environments: FleetEnvironmentTransport, isDisposed: () => boolean): Promise<void> {
    const incarnation = this.incarnation
    const refreshSequence = ++this.refreshSequence
    const observationEpoch = this.observationEpoch
    const [status, fleet] = await Promise.allSettled([
      environments.status(this.identity),
      environments.read(this.identity, HEIMDALL_CHANNELS.fleet, {})
    ])
    if (
      !this.isCurrent(incarnation, isDisposed()) ||
      refreshSequence !== this.refreshSequence ||
      observationEpoch !== this.observationEpoch
    ) {
      return
    }
    const previousSupport = this.commandSupport
    const previousDeleteSupport = this.deleteSupport
    const previousEnrollOwnerSupport = this.enrollOwnerSupport
    const previousParallelExecutionSupport = this.parallelExecutionSupport
    this.commandSupport = statusCapabilitySupport(status, HEIMDALL_COMMANDS_RUNTIME_CAPABILITY)
    this.deleteSupport = statusCapabilitySupport(status, HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY)
    this.enrollOwnerSupport = statusCapabilitySupport(
      status,
      HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY
    )
    this.parallelExecutionSupport = statusCapabilitySupport(
      status,
      HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
    )
    const supportChanged = (): boolean =>
      previousSupport !== this.commandSupport ||
      previousDeleteSupport !== this.deleteSupport ||
      previousEnrollOwnerSupport !== this.enrollOwnerSupport ||
      previousParallelExecutionSupport !== this.parallelExecutionSupport
    if (fleet.status === 'fulfilled' && fleet.value.ok === true) {
      const parsed = HeimdallFleetSnapshotSchema.safeParse(fleet.value.result)
      if (parsed.success) {
        if (parsed.data.generatedAtMs <= this.ownerGeneratedAtMs) {
          const contactChanged = !this.reachable
          this.reachable = true
          if (contactChanged || supportChanged()) {
            this.onChanged()
          }
          return
        }
        if (this.applySnapshot(parsed.data)) {
          return
        }
      }
    }
    this.markUnreachable()
    if (supportChanged()) {
      this.onChanged()
    }
  }

  applySnapshot(snapshot: HeimdallFleetSnapshot): boolean {
    if (snapshot.generatedAtMs <= this.ownerGeneratedAtMs) {
      return false
    }
    let entries: WatcherFleetEntry[]
    try {
      entries = snapshot.entries.map((entry) => routeRemoteFleetEntry(entry, this.identity))
    } catch {
      return false
    }
    this.entries = entries
    this.ownerGeneratedAtMs = snapshot.generatedAtMs
    this.reachable = true
    const retained = new Set(entries.map((entry) => remoteDetailKey(entry.target)))
    for (const key of this.details.keys()) {
      if (!retained.has(key)) {
        this.details.delete(key)
      }
    }
    for (const key of this.notificationDetails.keys()) {
      if (!retained.has(key)) {
        this.notificationDetails.delete(key)
      }
    }
    this.onChanged()
    return true
  }

  markUnreachable(): void {
    if (this.reachable) {
      this.reachable = false
      this.onChanged()
    }
  }

  isReadable(
    identity: FleetEnvironmentIdentity,
    availability: FleetEnvironmentAvailability
  ): boolean {
    return (
      this.reachable &&
      this.identity.pairingRevision === identity.pairingRevision &&
      availability === 'available'
    )
  }

  isCurrent(incarnation: number, disposed: boolean): boolean {
    return !disposed && this.incarnation === incarnation
  }

  isCurrentSubscription(
    incarnation: number,
    subscriptionGeneration: number,
    disposed: boolean
  ): boolean {
    return (
      this.isCurrent(incarnation, disposed) &&
      this.subscriptionGeneration === subscriptionGeneration
    )
  }

  retireTransport(): void {
    this.subscription?.close()
    this.subscription = null
    this.subscriptionStarting = false
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  retire(): void {
    this.incarnation += 1
    this.retireTransport()
  }
}

export function remoteDetailKey(target: WatcherTarget): string {
  return `${target.connectionId ?? 'local'}\0${target.pairingRevision ?? 'local'}\0${target.watcherId}`
}
