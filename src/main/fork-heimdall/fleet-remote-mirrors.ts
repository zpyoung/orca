import {
  HEIMDALL_CHANNELS,
  type EnrollSuccess,
  type HeimdallRemoteOwner
} from '../../shared/fork-heimdall/api'
import { HeimdallSubscriptionEventReaderSchema } from '../../shared/fork-heimdall/remote-reader-schemas'
import type {
  WatcherCommandRequest,
  WatcherCommandResult,
  WatcherDetail,
  WatcherFleetEntry,
  WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { Store } from '../persistence'
import {
  HeimdallCommandCapabilityError,
  HeimdallEnrollOwnerCapabilityError,
  HeimdallEnvironmentUnavailableError,
  type FleetEnvironmentAvailability,
  type FleetEnvironmentIdentity,
  type FleetEnvironmentTransport
} from './fleet-environment-transport'
import {
  enrollmentForMergeCheckScopeCompatibility,
  enrollmentWithoutUnsupportedRoleLaunch
} from './fleet-remote-enrollment-capabilities'
import {
  captureRemoteDetailNotifications,
  HeimdallOwnerDetailReadError,
  projectRemoteDetail,
  readConfirmedRemoteDetail
} from './fleet-remote-detail'
import {
  enrollmentForParallelCompatibility,
  enrollRemoteWatcher,
  OWNER_UNREACHABLE,
  readRemoteDebugReport
} from './fleet-remote-operations'
import { commandRemoteWatcher } from './fleet-remote-command'
import { projectRemoteFleetEntry, routeRemoteFleetEntry } from './fleet-projection'
import { remoteDetailKey, RemoteFleetMirrorState } from './fleet-remote-mirror-state'
import type { WatcherNotificationPublication } from './notification'

type FleetSyncPlan = {
  key: string
  mirrors: RemoteFleetMirrorState[]
}

export class HeimdallRemoteFleetMirrors {
  private readonly mirrors = new Map<string, RemoteFleetMirrorState>()
  private disposed = false
  private activeSyncKey: string | null = null
  private pendingSync: FleetSyncPlan | null = null

  constructor(
    private readonly environments: FleetEnvironmentTransport,
    private readonly onChanged: () => void,
    private readonly store?: Pick<Store, 'getSettings'>
  ) {}

  sync(): void {
    if (this.disposed) {
      return
    }
    const plan = this.prepareSync()
    if (this.activeSyncKey !== null) {
      if (plan.key !== this.activeSyncKey && plan.key !== this.pendingSync?.key) {
        this.pendingSync = plan
      }
      return
    }
    this.activeSyncKey = plan.key
    void this.drainSync(plan).catch(() => undefined)
  }

  entries(): WatcherFleetEntry[] {
    return Array.from(this.mirrors.values()).flatMap((mirror) => {
      let ownerAvailable = false
      try {
        ownerAvailable = this.environments.availability(mirror.identity) === 'available'
      } catch {
        // Inventory failures cannot prove that the remote owner is still reachable.
      }
      return mirror.entries.map((entry) =>
        projectRemoteFleetEntry(entry, {
          identity: mirror.identity,
          reachable: mirror.reachable && ownerAvailable,
          commandSupport: mirror.commandSupport,
          parallelExecutionSupport: mirror.parallelExecutionSupport
        })
      )
    })
  }

  async enroll(input: EnrollInput, owner: HeimdallRemoteOwner): Promise<EnrollSuccess> {
    const identity = { id: owner.connectionId, pairingRevision: owner.pairingRevision }
    const mirror = await this.ensureOwner(identity)
    if (mirror.commandSupport === 'unsupported') {
      throw new HeimdallCommandCapabilityError()
    }
    if (
      (input.owner !== undefined || input.ownerInterventionCapability !== undefined) &&
      mirror.enrollOwnerSupport === 'unsupported'
    ) {
      throw new HeimdallEnrollOwnerCapabilityError()
    }
    const scopeCompatibleInput = enrollmentForMergeCheckScopeCompatibility(
      input,
      mirror.mergeCheckScopeSupport === 'supported'
    )
    return enrollRemoteWatcher(
      this.environments,
      identity,
      enrollmentWithoutUnsupportedRoleLaunch(
        enrollmentForParallelCompatibility(
          scopeCompatibleInput,
          mirror.parallelExecutionSupport === 'supported'
        ),
        mirror.roleLaunchSupport === 'supported'
      )
    )
  }

  async detail(target: WatcherTarget): Promise<WatcherDetail> {
    const identity = { id: target.connectionId!, pairingRevision: target.pairingRevision! }
    const mirror = this.mirrors.get(identity.id)
    const cached = mirror?.details.get(remoteDetailKey(target))
    if (!mirror || !mirror.isReadable(identity, this.environments.availability(identity))) {
      if (
        mirror?.identity.pairingRevision === identity.pairingRevision &&
        this.environments.availability(identity) !== 'available'
      ) {
        mirror.markUnreachable()
      }
      if (cached && mirror) {
        return projectRemoteDetail(mirror, cached)
      }
      throw new Error(OWNER_UNREACHABLE)
    }
    const incarnation = mirror.incarnation
    try {
      const confirmed = await readConfirmedRemoteDetail(
        this.environments,
        identity,
        target,
        (owner) => routeRemoteFleetEntry(owner, mirror.identity)
      )
      if (!mirror.isCurrent(incarnation, this.disposed)) {
        throw new Error('The runtime environment pairing changed during the detail read.')
      }
      mirror.details.set(remoteDetailKey(confirmed.watcher.target), confirmed)
      return projectRemoteDetail(mirror, confirmed)
    } catch (error) {
      if (error instanceof HeimdallOwnerDetailReadError) {
        throw error
      }
      if (!mirror.isCurrent(incarnation, this.disposed)) {
        throw new Error('The runtime environment pairing changed during the detail read.')
      }
      mirror.markUnreachable()
      if (cached) {
        return projectRemoteDetail(mirror, cached)
      }
      throw new Error(OWNER_UNREACHABLE)
    }
  }

  command(request: WatcherCommandRequest): Promise<WatcherCommandResult> {
    return commandRemoteWatcher(
      this.environments,
      this.mirrors.get(request.target.connectionId!),
      request,
      this.onChanged
    )
  }

  async debugReport(target: WatcherTarget): Promise<unknown> {
    const identity = { id: target.connectionId!, pairingRevision: target.pairingRevision! }
    const mirror = this.mirrors.get(identity.id)
    if (!mirror?.isReadable(identity, this.environments.availability(identity))) {
      throw new Error(OWNER_UNREACHABLE)
    }
    return readRemoteDebugReport(this.environments, identity, target)
  }

  dispose(): void {
    this.disposed = true
    this.pendingSync = null
    for (const mirror of this.mirrors.values()) {
      mirror.retire()
    }
    this.mirrors.clear()
  }

  private prepareSync(): FleetSyncPlan {
    let identities: FleetEnvironmentIdentity[]
    try {
      identities = this.environments.list()
    } catch {
      for (const mirror of this.mirrors.values()) {
        this.markUnavailable(mirror)
      }
      return { key: 'inventory-unavailable', mirrors: [] }
    }

    const retained = new Set(identities.map((identity) => identity.id))
    for (const [environmentId, mirror] of this.mirrors) {
      if (!retained.has(environmentId)) {
        mirror.retire()
        this.mirrors.delete(environmentId)
        this.onChanged()
      }
    }

    const mirrors: RemoteFleetMirrorState[] = []
    const keyParts: string[] = []
    for (const identity of identities) {
      const mirror = this.prepareMirror(identity)
      let availability: FleetEnvironmentAvailability
      try {
        availability = this.environments.availability(identity)
      } catch {
        availability = 'disconnected'
      }
      keyParts.push(`${identity.id}\0${identity.pairingRevision}\0${availability}`)
      if (availability === 'available') {
        mirrors.push(mirror)
      } else {
        this.markUnavailable(mirror)
      }
    }
    keyParts.sort()
    return { key: keyParts.join('\n'), mirrors }
  }

  private async drainSync(initial: FleetSyncPlan): Promise<void> {
    let plan: FleetSyncPlan | null = initial
    try {
      while (plan && !this.disposed) {
        this.activeSyncKey = plan.key
        await Promise.all(
          plan.mirrors.map(async (mirror) => {
            const incarnation = mirror.incarnation
            try {
              await mirror.refresh(this.environments, () => this.disposed)
            } catch {
              if (mirror.isCurrent(incarnation, this.disposed)) {
                this.markUnavailable(mirror)
              }
            }
            if (mirror.isCurrent(incarnation, this.disposed)) {
              void this.ensureSubscription(mirror)
            }
          })
        )
        plan = this.pendingSync
        this.pendingSync = null
      }
    } finally {
      this.activeSyncKey = null
      const pending = this.pendingSync
      this.pendingSync = null
      if (pending && !this.disposed) {
        this.activeSyncKey = pending.key
        void this.drainSync(pending).catch(() => undefined)
      }
    }
  }

  private markUnavailable(mirror: RemoteFleetMirrorState): void {
    mirror.refreshSequence += 1
    mirror.markUnreachable()
  }

  private prepareMirror(identity: FleetEnvironmentIdentity): RemoteFleetMirrorState {
    const existing = this.mirrors.get(identity.id)
    if (existing?.identity.pairingRevision === identity.pairingRevision) {
      return existing
    }
    if (existing) {
      existing.replaceIdentity(identity)
      return existing
    }
    const mirror = new RemoteFleetMirrorState(identity, this.onChanged)
    this.mirrors.set(identity.id, mirror)
    return mirror
  }

  private async ensureSubscription(mirror: RemoteFleetMirrorState): Promise<void> {
    if (
      this.disposed ||
      mirror.subscription ||
      mirror.subscriptionStarting ||
      mirror.subscriptionUnsupported
    ) {
      return
    }
    let availability: FleetEnvironmentAvailability
    try {
      availability = this.environments.availability(mirror.identity)
    } catch {
      this.markUnavailable(mirror)
      return
    }
    if (availability !== 'available') {
      this.markUnavailable(mirror)
      return
    }
    mirror.subscriptionStarting = true
    const incarnation = mirror.incarnation
    const subscriptionGeneration = ++mirror.subscriptionGeneration
    try {
      const subscription = await this.environments.subscribe(
        mirror.identity,
        HEIMDALL_CHANNELS.subscribe,
        {},
        {
          onResponse: (response) =>
            this.enqueueSubscriptionResponse(mirror, incarnation, subscriptionGeneration, response),
          onError: () => {
            const observationEpoch = mirror.observationEpoch
            this.queueSubscriptionWork(mirror, () => {
              if (
                mirror.isCurrentSubscription(incarnation, subscriptionGeneration, this.disposed) &&
                observationEpoch === mirror.observationEpoch
              ) {
                mirror.markUnreachable()
              }
            })
          },
          onClose: () => {
            const observationEpoch = mirror.observationEpoch
            this.queueSubscriptionWork(mirror, () =>
              this.onSubscriptionClosed(
                mirror,
                incarnation,
                subscriptionGeneration,
                observationEpoch
              )
            )
          }
        }
      )
      if (!mirror.isCurrentSubscription(incarnation, subscriptionGeneration, this.disposed)) {
        subscription.close()
        return
      }
      mirror.subscription = subscription
    } catch {
      if (mirror.isCurrentSubscription(incarnation, subscriptionGeneration, this.disposed)) {
        mirror.markUnreachable()
        this.scheduleRetry(mirror)
      }
    } finally {
      if (mirror.isCurrentSubscription(incarnation, subscriptionGeneration, this.disposed)) {
        mirror.subscriptionStarting = false
      }
    }
  }

  private queueSubscriptionWork(
    mirror: RemoteFleetMirrorState,
    work: () => void | Promise<void>
  ): void {
    mirror.eventProcessing = mirror.eventProcessing.then(work).catch(() => undefined)
  }

  private enqueueSubscriptionResponse(
    mirror: RemoteFleetMirrorState,
    incarnation: number,
    subscriptionGeneration: number,
    response: RuntimeRpcResponse<unknown>
  ): void {
    let observationEpoch = mirror.observationEpoch
    if (
      mirror.isCurrentSubscription(incarnation, subscriptionGeneration, this.disposed) &&
      response.ok === true
    ) {
      const event = HeimdallSubscriptionEventReaderSchema.safeParse(response.result)
      if (event.success && event.data.type === 'ready') {
        observationEpoch = ++mirror.observationEpoch
        mirror.ownerGeneratedAtMs = -1
      }
    }
    this.queueSubscriptionWork(mirror, () =>
      this.consumeSubscriptionResponse(
        mirror,
        incarnation,
        subscriptionGeneration,
        observationEpoch,
        response
      )
    )
  }

  private async consumeSubscriptionResponse(
    mirror: RemoteFleetMirrorState,
    incarnation: number,
    subscriptionGeneration: number,
    observationEpoch: number,
    response: RuntimeRpcResponse<unknown>
  ): Promise<void> {
    if (
      !mirror.isCurrentSubscription(incarnation, subscriptionGeneration, this.disposed) ||
      observationEpoch !== mirror.observationEpoch
    ) {
      return
    }
    if (response.ok !== true) {
      if (response.error.code === 'method_not_found') {
        mirror.subscriptionUnsupported = true
      }
      return
    }
    const event = HeimdallSubscriptionEventReaderSchema.safeParse(response.result)
    if (!event.success || event.data.type === 'end') {
      return
    }
    const previousEntries = new Map(mirror.entries.map((entry) => [entry.target.watcherId, entry]))
    const orderingBaseline = mirror.ownerGeneratedAtMs
    const applied = mirror.applySnapshot(event.data.snapshot)
    let publicationEntries = mirror.entries
    if (!applied) {
      try {
        publicationEntries = event.data.snapshot.entries.map((entry) =>
          routeRemoteFleetEntry(entry, mirror.identity)
        )
      } catch {
        return
      }
      const contactChanged = !mirror.reachable
      mirror.reachable = true
      if (contactChanged) {
        this.onChanged()
      }
      if (event.data.type === 'snapshot' && event.data.snapshot.generatedAtMs < orderingBaseline) {
        return
      }
    }
    const publication: WatcherNotificationPublication =
      event.data.type === 'snapshot' ? 'live' : mirror.hasSubscriptionBaseline ? 'replay' : 'seed'
    if (event.data.type === 'ready') {
      mirror.hasSubscriptionBaseline = true
    }
    await captureRemoteDetailNotifications({
      entries: publicationEntries,
      previousEntries,
      details: mirror.notificationDetails,
      publication,
      store: this.store,
      readDetail: (target) => this.detail(target),
      isCurrent: (target) =>
        mirror.isCurrentSubscription(incarnation, subscriptionGeneration, this.disposed) &&
        mirror.reachable &&
        mirror.identity.id === target.connectionId &&
        mirror.identity.pairingRevision === target.pairingRevision
    })
  }

  private onSubscriptionClosed(
    mirror: RemoteFleetMirrorState,
    incarnation: number,
    subscriptionGeneration: number,
    observationEpoch: number
  ): void {
    if (
      !mirror.isCurrentSubscription(incarnation, subscriptionGeneration, this.disposed) ||
      observationEpoch !== mirror.observationEpoch
    ) {
      return
    }
    mirror.subscription = null
    if (!mirror.subscriptionUnsupported) {
      mirror.markUnreachable()
      this.scheduleRetry(mirror)
    }
  }

  private scheduleRetry(mirror: RemoteFleetMirrorState): void {
    if (mirror.retryTimer || this.disposed) {
      return
    }
    const incarnation = mirror.incarnation
    mirror.retryTimer = setTimeout(() => {
      mirror.retryTimer = null
      if (mirror.isCurrent(incarnation, this.disposed)) {
        void this.ensureSubscription(mirror)
      }
    }, 1_000)
    mirror.retryTimer.unref?.()
  }

  private async ensureOwner(identity: FleetEnvironmentIdentity): Promise<RemoteFleetMirrorState> {
    const mirror = this.prepareMirror(identity)
    if (!mirror.reachable) {
      await mirror.refresh(this.environments, () => this.disposed)
      void this.ensureSubscription(mirror)
    }
    const availability = this.environments.availability(identity)
    if (!mirror.reachable || availability !== 'available') {
      throw new HeimdallEnvironmentUnavailableError(
        availability === 'replaced' ? 'replaced' : 'disconnected'
      )
    }
    return mirror
  }
}
