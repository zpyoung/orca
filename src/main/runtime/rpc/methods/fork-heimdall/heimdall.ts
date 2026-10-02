import { defineMethod, defineStreamingMethod, type RpcContext } from '../../core'
import {
  EmptyHeimdallRequestSchema,
  HEIMDALL_CHANNELS,
  HeimdallEnrollRequestSchema,
  HeimdallUnsubscribeRequestSchema,
  WatcherCommandRequestSchema,
  WatcherTargetSchema
} from '../../../../../shared/fork-heimdall/api'
import type {
  HeimdallFleetSnapshotReader,
  WatcherDetailReader
} from '../../../../../shared/fork-heimdall/remote-reader-schemas'
import { heimdallEnrollmentRefusalError } from '../../../../../shared/fork-heimdall/enrollment-refusal-error'
import { stampPipelineAnswerAttribution } from '../../../../fork-heimdall-pipeline/answer-attribution'
import { PIPELINE_RPC_METHODS } from '../../../../fork-heimdall-pipeline/pipeline-rpc-methods'
import { requireHeimdallKernel, requireHeimdallTransport } from './kernel-binding'
import { isLocalArtifactPasswordCaller } from '../fork-artifact-passwords/artifact-password-local-caller'
import { HEIMDALL_OBJECTIVE_METHODS } from '../fork-heimdall-objective/objective-detail-method'
import {
  LEGACY_HEIMDALL_METHODS,
  LegacyHeimdallEnrollRequestSchema,
  LegacyWatcherIdRequestSchema,
  projectLegacyDebugReport,
  projectLegacyEnrollResult
} from './legacy-wire'
import { projectHeimdalDetailForClient } from './dispatch-result-wire'
import {
  projectHeimdallDetailParkReasonForClient,
  projectHeimdallFleetSnapshotForClient,
  projectWatcherListEntryForClient
} from './park-reason-wire'

let fleetSubscriptionSequence = 0

function assertLocalTarget(target: {
  connectionId: string | null
  pairingRevision: number | null
}): void {
  if (target.connectionId !== null || target.pairingRevision !== null) {
    throw new Error('A remote runtime can only serve locally owned Heimdall watchers')
  }
}

/** Keep paired runtimes host-local; the trusted desktop renderer shares their `runtime` clientKind. */

function isPairedRuntimeForwarder(caller: Pick<RpcContext, 'clientKind' | 'clientId'>): boolean {
  return caller.clientKind === 'runtime' && !isLocalArtifactPasswordCaller(caller)
}

export const HEIMDALL_METHODS = [
  ...LEGACY_HEIMDALL_METHODS,
  ...HEIMDALL_OBJECTIVE_METHODS,
  ...PIPELINE_RPC_METHODS,
  defineMethod({
    name: HEIMDALL_CHANNELS.enroll,
    params: HeimdallEnrollRequestSchema.or(LegacyHeimdallEnrollRequestSchema),
    handler: async (request, context) => {
      const { runtime, clientKind } = context
      if (!('input' in request)) {
        const legacy = await requireHeimdallKernel(runtime).enroll(request)
        if (legacy.status === 'refused') {
          throw heimdallEnrollmentRefusalError(legacy)
        }
        return projectLegacyEnrollResult({
          ...legacy,
          entry: projectWatcherListEntryForClient(legacy.entry, context)
        })
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
        throw heimdallEnrollmentRefusalError(result)
      }
      return { ...result, entry: projectWatcherListEntryForClient(result.entry, context) }
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.fleet,
    params: EmptyHeimdallRequestSchema,
    handler: async (_params, context) => {
      const { runtime } = context
      const snapshot = isPairedRuntimeForwarder(context)
        ? await requireHeimdallKernel(runtime).fleet()
        : await requireHeimdallTransport(runtime).fleet()
      return projectHeimdallFleetSnapshotForClient(snapshot, context)
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.detail,
    params: WatcherTargetSchema,
    handler: async (target, context) => {
      const { runtime } = context
      let detail: WatcherDetailReader
      if (isPairedRuntimeForwarder(context)) {
        assertLocalTarget(target)
        detail = await requireHeimdallKernel(runtime).detail(target)
      } else {
        detail = await requireHeimdallTransport(runtime).detail(target)
      }
      return projectHeimdalDetailForClient(
        projectHeimdallDetailParkReasonForClient(detail, context),
        context
      )
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.command,
    params: WatcherCommandRequestSchema,
    handler: (request, context) => {
      const { runtime } = context
      const attributedRequest =
        request.command.kind === 'answer-pipeline-choice' &&
        request.command.attribution === undefined
          ? stampPipelineAnswerAttribution(request, context, Date.now())
          : request
      if (isPairedRuntimeForwarder(context)) {
        assertLocalTarget(attributedRequest.target)
        return requireHeimdallKernel(runtime).command(attributedRequest)
      }
      return requireHeimdallTransport(runtime).command(attributedRequest)
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.debugReport,
    params: WatcherTargetSchema.or(LegacyWatcherIdRequestSchema),
    handler: async (target, { runtime, clientKind }) => {
      if (!('connectionId' in target)) {
        return projectLegacyDebugReport(
          await requireHeimdallKernel(runtime).debugReport(target.watcherId)
        )
      }
      if (clientKind === 'runtime') {
        assertLocalTarget(target)
        return await requireHeimdallKernel(runtime).debugReport(target.watcherId)
      }
      return await requireHeimdallTransport(runtime).debugReport(target)
    }
  }),
  defineStreamingMethod({
    name: HEIMDALL_CHANNELS.subscribe,
    params: EmptyHeimdallRequestSchema,
    handler: async (_params, context, emit) => {
      const { runtime, connectionId, signal } = context

      const hostLocalRuntimeForwarder = isPairedRuntimeForwarder(context)
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
          supplied?: HeimdallFleetSnapshotReader
        ): void => {
          emission = emission
            .then(async () => {
              if (closed) {
                return
              }
              const snapshot = projectHeimdallFleetSnapshotForClient(
                supplied ??
                  (hostLocalRuntimeForwarder
                    ? await requireHeimdallKernel(runtime).fleet()
                    : await requireHeimdallTransport(runtime).fleet()),
                context
              )
              if (!closed) {
                emit(type === 'ready' ? { type, subscriptionId, snapshot } : { type, snapshot })
              }
            })
            .catch(() => cleanup())
        }
        unsubscribe = hostLocalRuntimeForwarder
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
