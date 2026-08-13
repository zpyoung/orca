import type { PipelineRunSnapshotWire } from '../../../shared/pipeline-run-snapshot'
import {
  assemblePipelineSnapshot,
  isLivePipelineRunState,
  isTerminalPipelineRunState,
  type PipelineSnapshotSource
} from './pipeline-snapshot-publisher-assemble'

export type { PipelineSnapshotSource } from './pipeline-snapshot-publisher-assemble'

const HEARTBEAT_INTERVAL_MS = 5_000

type Emit = (snapshot: PipelineRunSnapshotWire) => void

/**
 * Pushes complete pipeline-run snapshots to subscribers: an immediate snapshot on attach
 * (even for a terminal run), then a heartbeat republish at least every 5s while the run is
 * live, stopping the moment the run reaches a terminal state (L23a, L24a).
 */
export class PipelineSnapshotPublisher {
  private readonly subscribersByRunId = new Map<string, Set<Emit>>()
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly pausingByRunId = new Map<string, boolean>()

  constructor(
    private readonly source: PipelineSnapshotSource,
    private readonly heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS
  ) {}

  subscribe(runId: string, emit: Emit): () => void {
    let subscribers = this.subscribersByRunId.get(runId)
    if (!subscribers) {
      subscribers = new Set()
      this.subscribersByRunId.set(runId, subscribers)
    }
    subscribers.add(emit)

    emit(this.assemble(runId))
    this.ensureHeartbeat(runId)

    return () => {
      subscribers.delete(emit)
      if (subscribers.size === 0) {
        this.subscribersByRunId.delete(runId)
        this.stopHeartbeat(runId)
      }
    }
  }

  publish(runId: string): void {
    const snapshot = this.assemble(runId)
    for (const emit of this.subscribersByRunId.get(runId) ?? []) {
      emit(snapshot)
    }
    if (snapshot.state !== undefined && isTerminalPipelineRunState(snapshot.state)) {
      this.stopHeartbeat(runId)
    } else {
      this.ensureHeartbeat(runId)
    }
  }

  /** Records the L20 pause-requested-but-attempt-still-running annotation for future assembly. */
  setPausingAnnotation(runId: string, pausing: boolean): void {
    this.pausingByRunId.set(runId, pausing)
  }

  private assemble(runId: string): PipelineRunSnapshotWire {
    return assemblePipelineSnapshot(this.source, runId, {
      pausing: this.pausingByRunId.get(runId) ?? false
    })
  }

  private ensureHeartbeat(runId: string): void {
    if (this.heartbeatTimers.has(runId)) {
      return
    }
    const subscribers = this.subscribersByRunId.get(runId)
    if (!subscribers || subscribers.size === 0) {
      return
    }
    const run = this.source.getPipelineRun(runId)
    if (!run || !isLivePipelineRunState(run.state)) {
      return
    }
    const timer = setInterval(() => this.publish(runId), this.heartbeatIntervalMs)
    timer.unref?.()
    this.heartbeatTimers.set(runId, timer)
  }

  private stopHeartbeat(runId: string): void {
    const timer = this.heartbeatTimers.get(runId)
    if (timer) {
      clearInterval(timer)
      this.heartbeatTimers.delete(runId)
    }
  }
}
