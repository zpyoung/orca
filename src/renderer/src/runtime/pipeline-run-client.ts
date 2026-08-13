import {
  decodePipelineRunSnapshotWire,
  type PipelineRunSnapshotWire
} from '../../../shared/pipeline-run-snapshot'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeClientTarget } from './runtime-rpc-client'

export type PipelineRunSnapshotSubscription = { unsubscribe: () => void }

/** `unsupported`: this host doesn't recognize `pipeline.subscribe` (old host, version skew). `transient`: any other subscribe/transport failure. */
export type PipelineRunSubscriptionError = { kind: 'unsupported' | 'transient'; message: string }

const PIPELINE_SUBSCRIBE_METHOD = 'pipeline.subscribe'
const METHOD_NOT_FOUND_CODE = 'method_not_found'

let localPipelineRunSubscriptionSeq = 0

function classifySubscriptionError(raw: unknown): PipelineRunSubscriptionError {
  const message =
    raw instanceof Error
      ? raw.message
      : typeof raw === 'object' && raw !== null && typeof (raw as { message?: unknown }).message === 'string'
        ? (raw as { message: string }).message
        : String(raw)
  const code = typeof raw === 'object' && raw !== null ? (raw as { code?: unknown }).code : undefined
  return { kind: code === METHOD_NOT_FOUND_CODE ? 'unsupported' : 'transient', message }
}

/**
 * Streams `pipeline.subscribe` snapshots for one run. Mirrors
 * `subscribeRuntimeClientEvents`'s listener-first shape: for a remote runtime
 * environment the subscription rides the same envelope every other streaming
 * RPC uses, and the shared-control layer already keeps it alive and replays
 * it across reconnects (see `runtime-subscription-replay.ts`), so nothing
 * here needs to re-issue the call itself. A local target has no RPC envelope
 * to ride — `runtime:call` only carries unary methods — so it goes over the
 * dedicated `pipelineRuns` IPC bridge instead.
 */
export async function subscribeToPipelineRunSnapshot(
  target: RuntimeClientTarget,
  runId: string,
  onSnapshot: (snapshot: PipelineRunSnapshotWire) => void,
  onError: (error: PipelineRunSubscriptionError) => void = (error) => console.warn(error.message)
): Promise<PipelineRunSnapshotSubscription> {
  if (target.kind === 'local') {
    const subscriptionId = `pipeline-run-${runId}-${++localPipelineRunSubscriptionSeq}`
    const unsubscribe = window.api.pipelineRuns.subscribe({ subscriptionId, runId }, (frame) => {
      if (frame.type === 'error') {
        onError(classifySubscriptionError(new Error(frame.error)))
        return
      }
      const decoded = decodePipelineRunSnapshotWire(frame.snapshot)
      if (decoded) {
        onSnapshot(decoded)
      }
    })
    return { unsubscribe }
  }

  const handle = await window.api.runtimeEnvironments.subscribe(
    {
      selector: target.environmentId,
      method: PIPELINE_SUBSCRIBE_METHOD,
      params: { runId }
    },
    {
      onResponse: (response) => handlePipelineSubscribeResponse(response, onSnapshot, onError),
      onError: (error) => onError(classifySubscriptionError(error))
    }
  )
  return { unsubscribe: handle.unsubscribe }
}

function handlePipelineSubscribeResponse(
  response: RuntimeRpcResponse<unknown>,
  onSnapshot: (snapshot: PipelineRunSnapshotWire) => void,
  onError: (error: PipelineRunSubscriptionError) => void
): void {
  if (response.ok === false) {
    onError(classifySubscriptionError(response.error))
    return
  }
  const decoded = decodePipelineRunSnapshotWire(response.result)
  if (decoded) {
    onSnapshot(decoded)
  }
}
