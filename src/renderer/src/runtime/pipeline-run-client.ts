import type { PipelineRunSnapshotWire } from '../../../shared/pipeline-run-snapshot'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

export type PipelineRunSnapshotSubscription = { unsubscribe: () => void }

const PIPELINE_SUBSCRIBE_METHOD = 'pipeline.subscribe'

/**
 * Streams `pipeline.subscribe` snapshots for one run. Mirrors
 * `subscribeRuntimeClientEvents`'s listener-first shape: for a remote runtime
 * environment the subscription rides the same envelope every other streaming
 * RPC uses, and the shared-control layer already keeps it alive and replays
 * it across reconnects (see `runtime-subscription-replay.ts`), so nothing
 * here needs to re-issue the call itself.
 */
export async function subscribeToPipelineRunSnapshot(
  target: RuntimeClientTarget,
  runId: string,
  onSnapshot: (snapshot: PipelineRunSnapshotWire) => void,
  onError: (error: unknown) => void = console.warn
): Promise<PipelineRunSnapshotSubscription> {
  if (target.kind === 'local') {
    // The desktop's local `runtime:call` IPC channel only carries unary RPCs
    // (RpcDispatcher.dispatch rejects any streaming method outright), so a local
    // run has no bridge to ride yet; surface that instead of hanging silently.
    try {
      await callRuntimeRpc(target, PIPELINE_SUBSCRIBE_METHOD, { runId })
    } catch (error) {
      onError(error)
    }
    return { unsubscribe: () => {} }
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
