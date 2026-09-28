import type { EnrollInput, EnrollResult } from '../../shared/fork-heimdall/watcher-types'
import { formatHeimdallEnrollmentRefusal } from '../../shared/fork-heimdall/enrollment-refusal-text'
import type { EnrollSuccess, HeimdallRemoteOwner } from '../../shared/fork-heimdall/api'
import {
  HeimdallFleetSnapshotSchema,
  type HeimdallFleetSnapshot,
  type WatcherCommandRequest,
  type WatcherCommandResult,
  type WatcherDetail,
  type WatcherFleetEntry,
  type WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import type { Store } from '../persistence'
import type { HeimdallDebugReport } from './debug-report'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  createFleetEnvironmentTransport,
  type FleetEnvironmentIdentity,
  type FleetEnvironmentTransport
} from './fleet-environment-transport'
import { buildFleetSnapshot } from './fleet-projection'
import { HeimdallRemoteFleetMirrors } from './fleet-remote-mirrors'

export type HeimdallFleetKernel = {
  enroll(input: EnrollInput): Promise<EnrollResult>
  fleet(): Promise<HeimdallFleetSnapshot>
  detail(target: WatcherTarget): Promise<WatcherDetail>
  command(request: WatcherCommandRequest): Promise<WatcherCommandResult>
  debugReport(watcherId: string): Promise<HeimdallDebugReport>
  subscribe(listener: () => void): () => void
}

export type HeimdallFleetTransportOptions = {
  kernel: HeimdallFleetKernel
  userDataPath: () => string
  store?: Pick<Store, 'getSettings'>
  environments?: FleetEnvironmentTransport
  now?: () => number
}

export class HeimdallFleetTransport {
  private readonly kernel: HeimdallFleetKernel
  private readonly remote: HeimdallRemoteFleetMirrors
  private readonly environments: FleetEnvironmentTransport
  private readonly now: () => number
  private readonly listeners = new Set<(snapshot: HeimdallFleetSnapshot) => void>()
  private localEntries: WatcherFleetEntry[] = []
  private localReadSequence = 0
  private lastGeneratedAtMs = 0
  private publishRunning = false
  private publishPending = false
  private publishNeedsLocalRead = false
  private disposed = false
  private readonly unsubscribeKernel: () => void

  constructor(options: HeimdallFleetTransportOptions) {
    this.kernel = options.kernel
    this.now = options.now ?? Date.now
    this.environments =
      options.environments ?? createFleetEnvironmentTransport(options.userDataPath)
    this.remote = new HeimdallRemoteFleetMirrors(
      this.environments,
      () => this.schedulePublish(false),
      options.store
    )
    this.unsubscribeKernel = this.kernel.subscribe(() => this.schedulePublish(true))
  }

  subscribe(listener: (snapshot: HeimdallFleetSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async fleet(): Promise<HeimdallFleetSnapshot> {
    await this.refreshLocal()
    this.remote.sync()
    return this.snapshot()
  }

  async enroll(input: EnrollInput, owner?: HeimdallRemoteOwner): Promise<EnrollSuccess> {
    if (owner) {
      return this.remote.enroll(input, owner)
    }
    const result = await this.kernel.enroll(input)
    if (result.status === 'refused') {
      throw new Error(formatHeimdallEnrollmentRefusal(result))
    }
    this.schedulePublish(true)
    return result
  }

  detail(target: WatcherTarget): Promise<WatcherDetail> {
    assertWellFormedTarget(target)
    return target.connectionId === null ? this.kernel.detail(target) : this.remote.detail(target)
  }

  command(request: WatcherCommandRequest): Promise<WatcherCommandResult> {
    assertWellFormedTarget(request.target)
    return request.target.connectionId === null
      ? this.kernel.command(request)
      : this.remote.command(request)
  }

  async debugReport(target: WatcherTarget): Promise<unknown> {
    assertWellFormedTarget(target)
    return target.connectionId === null
      ? this.kernel.debugReport(target.watcherId)
      : this.remote.debugReport(target)
  }

  /** One read against an owning runtime, for callers the fleet mirrors do not cover. */
  readRemote(
    identity: FleetEnvironmentIdentity,
    method: string,
    params: unknown
  ): Promise<RuntimeRpcResponse<unknown>> {
    return this.environments.read(identity, method, params)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.unsubscribeKernel()
    this.remote.dispose()
    this.listeners.clear()
  }

  private async refreshLocal(): Promise<void> {
    const sequence = ++this.localReadSequence
    const snapshot = HeimdallFleetSnapshotSchema.parse(await this.kernel.fleet())
    if (sequence === this.localReadSequence && !this.disposed) {
      this.localEntries = snapshot.entries
    }
  }

  private schedulePublish(refreshLocal: boolean): void {
    if (this.disposed) {
      return
    }
    this.publishPending = true
    this.publishNeedsLocalRead ||= refreshLocal
    if (this.publishRunning) {
      return
    }
    this.publishRunning = true
    void this.drainPublishes()
  }

  private async drainPublishes(): Promise<void> {
    while (this.publishPending && !this.disposed) {
      this.publishPending = false
      const refreshLocal = this.publishNeedsLocalRead
      this.publishNeedsLocalRead = false
      if (refreshLocal) {
        try {
          await this.refreshLocal()
        } catch {
          // Preserve the last confirmed owner projection until a later read succeeds.
        }
      }
      const snapshot = this.snapshot()
      for (const listener of this.listeners) {
        try {
          listener(snapshot)
        } catch {
          // One renderer or remote subscriber must not strand its siblings.
        }
      }
    }
    this.publishRunning = false
  }

  private snapshot(): HeimdallFleetSnapshot {
    const generatedAtMs = Math.max(Math.trunc(this.now()), this.lastGeneratedAtMs + 1)
    this.lastGeneratedAtMs = generatedAtMs
    return buildFleetSnapshot(this.localEntries, this.remote.entries(), generatedAtMs)
  }
}

function assertWellFormedTarget(target: WatcherTarget): void {
  const valid =
    (target.connectionId === null && target.pairingRevision === null) ||
    (target.connectionId !== null && target.pairingRevision !== null)
  if (!valid) {
    throw new Error('Invalid Heimdall target: connection and pairing revision must agree.')
  }
}
