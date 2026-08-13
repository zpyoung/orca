import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type { PipelineRunSnapshotWire } from '../../shared/pipeline-run-snapshot'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { subscribeToPipelineRun } from '../runtime/pipelines/pipeline-run-lifecycle'

export type PipelineRunSubscribeArgs = {
  /** Renderer-minted id, unique per webContents, echoed back on every emit so
   *  a window watching several runs can route frames to the right handle. */
  subscriptionId: string
  runId: string
}

export type PipelineRunSubscriptionFrame =
  | { type: 'snapshot'; snapshot: PipelineRunSnapshotWire }
  | { type: 'error'; error: string }

/** Wire payload for the `pipelineRun:snapshot` push channel. */
export type PipelineRunSnapshotPayload = {
  subscriptionId: string
  frame: PipelineRunSubscriptionFrame
}

type LiveSubscription = { unsubscribe: () => void }

// A renderer that keeps calling subscribe with fresh ids (bug or otherwise) must not grow this
// map without bound — each entry retains a host publisher subscriber.
export const MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER = 64

// Why: subscriptions are keyed by (webContents.id, subscriptionId) so a window
// watching several runs tears down only what it asked to, and a destroyed
// window releases every host-side watcher it owns — a subscription leak on
// window close is the failure mode this map exists to prevent.
const liveSubscriptions = new Map<number, Map<string, LiveSubscription>>()
const senderCleanupRegistered = new Set<number>()

function teardownSubscription(senderId: number, subscriptionId: string): void {
  const bySubId = liveSubscriptions.get(senderId)
  const live = bySubId?.get(subscriptionId)
  if (!live || !bySubId) {
    return
  }
  live.unsubscribe()
  bySubId.delete(subscriptionId)
  if (bySubId.size === 0) {
    liveSubscriptions.delete(senderId)
  }
}

function teardownAllForSender(senderId: number): void {
  senderCleanupRegistered.delete(senderId)
  const bySubId = liveSubscriptions.get(senderId)
  if (!bySubId) {
    return
  }
  for (const live of bySubId.values()) {
    live.unsubscribe()
  }
  liveSubscriptions.delete(senderId)
}

function registerSenderCleanup(sender: WebContents): void {
  if (senderCleanupRegistered.has(sender.id)) {
    return
  }
  senderCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => teardownAllForSender(sender.id))
}

function sendFrame(
  sender: WebContents,
  subscriptionId: string,
  frame: PipelineRunSubscriptionFrame
): void {
  if (sender.isDestroyed()) {
    return
  }
  sender.send('pipelineRun:snapshot', {
    subscriptionId,
    frame
  } satisfies PipelineRunSnapshotPayload)
}

function handleSubscribe(
  event: IpcMainEvent,
  args: PipelineRunSubscribeArgs,
  runtime: OrcaRuntimeService
): void {
  const sender = event.sender
  if (sender.isDestroyed()) {
    return
  }
  const { subscriptionId, runId } = args
  // Replace any prior subscription under the same id (run change/resubscribe).
  teardownSubscription(sender.id, subscriptionId)
  registerSenderCleanup(sender)

  const liveCount = liveSubscriptions.get(sender.id)?.size ?? 0
  if (liveCount >= MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER) {
    sendFrame(sender, subscriptionId, {
      type: 'error',
      error: `too many active pipeline subscriptions for this window (limit ${MAX_PIPELINE_SUBSCRIPTIONS_PER_SENDER})`
    })
    return
  }

  let unsubscribe: () => void
  try {
    unsubscribe = subscribeToPipelineRun(runtime.getOrchestrationDb(), runId, (snapshot) =>
      sendFrame(sender, subscriptionId, { type: 'snapshot', snapshot })
    )
  } catch (error) {
    sendFrame(sender, subscriptionId, {
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }

  const bySubId = liveSubscriptions.get(sender.id) ?? new Map<string, LiveSubscription>()
  bySubId.set(subscriptionId, { unsubscribe })
  liveSubscriptions.set(sender.id, bySubId)
}

/** Test-only: drop all live pipeline-run subscriptions between runs. */
export function clearPipelineRunSubscriptions(): void {
  const senderIds = new Set(liveSubscriptions.keys())
  for (const senderId of senderIds) {
    teardownAllForSender(senderId)
  }
  senderCleanupRegistered.clear()
}

export function _getPipelineRunSenderCleanupCountForTest(): number {
  return senderCleanupRegistered.size
}

/**
 * Bridges local pipeline-run snapshot subscriptions over IPC. Main is
 * in-process with the runtime, so this calls `subscribeToPipelineRun`
 * directly instead of routing through `RpcDispatcher` — the dispatcher only
 * carries unary methods and rejects streaming ones outright, and
 * `runtime:call` is the only local RPC channel the preload exposes.
 */
export function registerPipelineSubscriptionHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.on('pipelineRun:subscribe', (event, args: PipelineRunSubscribeArgs) => {
    handleSubscribe(event, args, runtime)
  })
  ipcMain.on('pipelineRun:unsubscribe', (event, args: { subscriptionId: string }) => {
    teardownSubscription(event.sender.id, args.subscriptionId)
  })
}
