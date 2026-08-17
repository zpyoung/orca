import type { PipelineRunSnapshotWire } from '../../../shared/pipeline-run-snapshot'
import {
  assemblePipelineSnapshot,
  isLivePipelineRunState,
  isTerminalPipelineRunState,
  type PipelineSnapshotSource
} from './pipeline-snapshot-publisher-assemble'

export type { PipelineSnapshotSource } from './pipeline-snapshot-publisher-assemble'

const HEARTBEAT_INTERVAL_MS = 5_000
const MAX_SUBSCRIBER_FAILURES = 3

type Emit = (snapshot: PipelineRunSnapshotWire) => void

export type PipelineSnapshotPublisherOptions = {
  heartbeatIntervalMs?: number
  /** Runs once per run id, after every attached subscriber has received the final snapshot. */
  onTerminal?: (runId: string) => void
}

/**
 * Pushes complete pipeline-run snapshots to subscribers: an immediate snapshot on attach
 * (even for a terminal run, so a client that subscribes after the run finished still learns
 * the outcome instead of hanging with no data), then a heartbeat republish at least every 5s
 * while the run is live — the heartbeat is what lets a client detect staleness even when
 * nothing has changed since the last push — stopping the moment the run reaches a terminal
 * state. A subscriber that throws is isolated from its peers, from the heartbeat, and from
 * the run being observed.
 */
export class PipelineSnapshotPublisher {
  private readonly subscribersByRunId = new Map<string, Set<Emit>>()
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly pausingByRunId = new Map<string, boolean>()
  private readonly subscriberFailureCounts = new Map<Emit, number>()
  private readonly heartbeatIntervalMs: number
  private readonly onTerminal?: (runId: string) => void

  constructor(
    private readonly source: PipelineSnapshotSource,
    options: PipelineSnapshotPublisherOptions = {}
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this.onTerminal = options.onTerminal
  }

  subscribe(runId: string, emit: Emit): () => void {
    let subscribers = this.subscribersByRunId.get(runId)
    if (!subscribers) {
      subscribers = new Set()
      this.subscribersByRunId.set(runId, subscribers)
    }
    subscribers.add(emit)

    this.safeEmit(runId, emit, this.assemble(runId))
    this.ensureHeartbeat(runId)

    return () => {
      this.dropSubscriber(runId, emit)
    }
  }

  publish(runId: string): void {
    const snapshot = this.assemble(runId)
    for (const emit of this.subscribersByRunId.get(runId) ?? []) {
      this.safeEmit(runId, emit, snapshot)
    }
    if (snapshot.state !== undefined && isTerminalPipelineRunState(snapshot.state)) {
      this.stopHeartbeat(runId)
      this.onTerminal?.(runId)
    } else {
      this.ensureHeartbeat(runId)
    }
  }

  /** Records the pause-requested-but-attempt-still-running annotation for future assembly. */
  setPausingAnnotation(runId: string, pausing: boolean): void {
    this.pausingByRunId.set(runId, pausing)
  }

  private assemble(runId: string): PipelineRunSnapshotWire {
    return assemblePipelineSnapshot(this.source, runId, {
      pausing: this.pausingByRunId.get(runId) ?? false
    })
  }

  private safeEmit(runId: string, emit: Emit, snapshot: PipelineRunSnapshotWire): void {
    try {
      emit(snapshot)
      this.subscriberFailureCounts.delete(emit)
    } catch (error) {
      // a subscriber is a passive observer, never a participant — its failure stops here rather
      // than reaching the publisher, its peers, the heartbeat, or the run
      console.error('[pipeline-snapshot-publisher] subscriber threw while receiving a snapshot:', error)
      const failures = (this.subscriberFailureCounts.get(emit) ?? 0) + 1
      if (failures >= MAX_SUBSCRIBER_FAILURES) {
        console.error(
          `[pipeline-snapshot-publisher] dropping a subscriber after ${failures} consecutive failures`
        )
        this.dropSubscriber(runId, emit)
      } else {
        this.subscriberFailureCounts.set(emit, failures)
      }
    }
  }

  private dropSubscriber(runId: string, emit: Emit): void {
    this.subscriberFailureCounts.delete(emit)
    const subscribers = this.subscribersByRunId.get(runId)
    if (!subscribers?.delete(emit)) {
      return
    }
    if (subscribers.size === 0) {
      this.subscribersByRunId.delete(runId)
      this.stopHeartbeat(runId)
    }
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
