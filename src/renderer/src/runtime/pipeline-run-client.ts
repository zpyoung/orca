import type { PipelineRunSnapshotWire } from '../../../shared/pipeline-run-snapshot'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeClientTarget } from './runtime-rpc-client'

export type PipelineRunSnapshotSubscription = { unsubscribe: () => void }

const PIPELINE_SUBSCRIBE_METHOD = 'pipeline.subscribe'

let localPipelineRunSubscriptionSeq = 0

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
  onError: (error: unknown) => void = console.warn
): Promise<PipelineRunSnapshotSubscription> {
  if (target.kind === 'local') {
    const subscriptionId = `pipeline-run-${runId}-${++localPipelineRunSubscriptionSeq}`
    const unsubscribe = window.api.pipelineRuns.subscribe({ subscriptionId, runId }, (frame) => {
      if (frame.type === 'error') {
        onError(new Error(frame.error))
        return
      }
      onSnapshot(frame.snapshot)
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
      onError
    }
  )
  return { unsubscribe: handle.unsubscribe }
}

function handlePipelineSubscribeResponse(
  response: RuntimeRpcResponse<unknown>,
  onSnapshot: (snapshot: PipelineRunSnapshotWire) => void,
  onError: (error: unknown) => void
): void {
  if (response.ok === false) {
    onError(response.error)
    return
  }
  const result = response.result as Partial<PipelineRunSnapshotWire> | undefined
  if (typeof result?.runId === 'string') {
    onSnapshot(result as PipelineRunSnapshotWire)
  }
}
