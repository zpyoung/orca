import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../../core'
import {
  EmptyHeimdallRequestSchema,
  HEIMDALL_CHANNELS,
  HeimdallEnrollRequestSchema,
  HeimdallUnsubscribeRequestSchema,
  WatcherCommandRequestSchema,
  WatcherTargetSchema,
  type HeimdallFleetSnapshot
} from '../../../../../shared/fork-heimdall/api'
import { requireHeimdallKernel, requireHeimdallTransport } from './kernel-binding'
import { HEIMDALL_OBJECTIVE_METHODS } from '../fork-heimdall-objective/objective-detail-method'
import {
  LEGACY_HEIMDALL_METHODS,
  LegacyHeimdallEnrollRequestSchema,
  LegacyWatcherIdRequestSchema,
  projectLegacyDebugReport,
  projectLegacyEnrollResult
} from './legacy-wire'

let fleetSubscriptionSequence = 0

function assertLocalTarget(target: {
  connectionId: string | null
  pairingRevision: number | null
}): void {
  if (target.connectionId !== null || target.pairingRevision !== null) {
    throw new Error('A remote runtime can only serve locally owned Heimdall watchers')
  }
}

export const HEIMDALL_METHODS: readonly RpcAnyMethod[] = [
  ...LEGACY_HEIMDALL_METHODS,
  ...HEIMDALL_OBJECTIVE_METHODS,
  defineMethod({
    name: HEIMDALL_CHANNELS.enroll,
    params: HeimdallEnrollRequestSchema.or(LegacyHeimdallEnrollRequestSchema),
    handler: async (request, { runtime, clientKind }) => {
      if (!('input' in request)) {
        const legacy = await requireHeimdallKernel(runtime).enroll(request)
        if (legacy.status === 'refused') {
          throw new Error(`Heimdall enrollment refused: ${legacy.reason}`)
        }
        return projectLegacyEnrollResult(legacy)
      }
      const { input, owner } = request
      if (clientKind === 'runtime' && owner !== null) {
        throw new Error('A remote runtime cannot route transitive Heimdall enrollment')
      }
      const result =
        clientKind === 'runtime'
          ? await requireHeimdallKernel(runtime).enroll(input)
          : await requireHeimdallTransport(runtime).enroll(input, owner ?? undefined)
      if (result.status === 'refused') {
        throw new Error(`Heimdall enrollment refused: ${result.reason}`)
      }
      return result
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.fleet,
    params: EmptyHeimdallRequestSchema,
    handler: (_params, { runtime, clientKind }) =>
      clientKind === 'runtime'
        ? requireHeimdallKernel(runtime).fleet()
        : requireHeimdallTransport(runtime).fleet()
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.detail,
    params: WatcherTargetSchema,
    handler: (target, { runtime, clientKind }) => {
      if (clientKind === 'runtime') {
        assertLocalTarget(target)
        return requireHeimdallKernel(runtime).detail(target)
      }
      return requireHeimdallTransport(runtime).detail(target)
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.command,
    params: WatcherCommandRequestSchema,
    handler: (request, { runtime, clientKind }) => {
      if (clientKind === 'runtime') {
        assertLocalTarget(request.target)
        return requireHeimdallKernel(runtime).command(request)
      }
      return requireHeimdallTransport(runtime).command(request)
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.debugReport,
    params: WatcherTargetSchema.or(LegacyWatcherIdRequestSchema),
    handler: (target, { runtime, clientKind }) => {
      if (!('connectionId' in target)) {
        return projectLegacyDebugReport(
          requireHeimdallKernel(runtime).debugReport(target.watcherId)
        )
      }
      if (clientKind === 'runtime') {
        assertLocalTarget(target)
        return requireHeimdallKernel(runtime).debugReport(target.watcherId)
      }
      return requireHeimdallTransport(runtime).debugReport(target)
    }
  }),
  defineStreamingMethod({
    name: HEIMDALL_CHANNELS.subscribe,
    params: EmptyHeimdallRequestSchema,
    handler: async (_params, { runtime, clientKind, connectionId, signal }, emit) => {
      await new Promise<void>((resolve) => {
        let closed = false
        let emission = Promise.resolve()
        let unsubscribe = (): void => undefined
        const subscriptionId = `heimdall-${connectionId ?? 'inproc'}-${++fleetSubscriptionSequence}`
        const cleanup = (): void => {
          if (closed) {
            return
          }
          closed = true
          unsubscribe()
          signal?.removeEventListener('abort', cleanup)
          const finish = (): void => {
            emit({ type: 'end' })
            resolve()
          }
          void emission.then(finish, finish)
        }
        const emitSnapshot = (
          type: 'ready' | 'snapshot',
          supplied?: HeimdallFleetSnapshot
        ): void => {
          emission = emission
            .then(async () => {
              if (closed) {
                return
              }
              const snapshot =
                supplied ??
                (clientKind === 'runtime'
                  ? await requireHeimdallKernel(runtime).fleet()
                  : await requireHeimdallTransport(runtime).fleet())
              if (!closed) {
                emit(type === 'ready' ? { type, subscriptionId, snapshot } : { type, snapshot })
              }
            })
            .catch(() => cleanup())
        }
        unsubscribe =
          clientKind === 'runtime'
            ? requireHeimdallKernel(runtime).subscribe(() => emitSnapshot('snapshot'))
            : requireHeimdallTransport(runtime).subscribe((snapshot) =>
                emitSnapshot('snapshot', snapshot)
              )
        runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
        signal?.addEventListener('abort', cleanup, { once: true })
        if (signal?.aborted) {
          cleanup()
          return
        }
        emitSnapshot('ready')
      })
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.unsubscribe,
    params: HeimdallUnsubscribeRequestSchema,
    handler: ({ subscriptionId }, { runtime }) => {
      runtime.cleanupSubscription(subscriptionId)
      return { unsubscribed: true }
    }
  })
]
