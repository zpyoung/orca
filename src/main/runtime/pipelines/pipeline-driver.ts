/** The host-side dispatch loop: walks the run's task DAG, applying retry and failure accounting. */

import type { ResolvedPipelineNode } from '../../../shared/pipeline-template-types'
import {
  dispatchPipelineNode,
  interruptAbortedDispatch,
  type PipelineDispatchOutcome
} from './pipeline-driver-dispatch'
import {
  resolveFailedAttempt,
  type FailedAttemptContext,
  type FailedAttemptResolution
} from './pipeline-driver-failure'
import { beginInFlightSpawn, resolveAbortInterruptHandle } from './pipeline-driver-in-flight'
import {
  allNodesSucceeded,
  applyNodeOutcome,
  buildDependencyResults,
  buildPipelineNodeIndex,
  pickNextReadyNode,
  type PipelineNodeIndex
} from './pipeline-driver-node-graph'
import { pollDriverInFlight } from './pipeline-driver-poll'
import {
  resolvePipelineDriverRunContext,
  type PipelineDriverRunContext
} from './pipeline-driver-run-context'
import {
  writePipelineRunCompleted,
  writePipelineRunFailed,
  writePipelineRunPaused,
  writePipelineRunResumed
} from './pipeline-driver-run-control'
import type {
  PipelineDriverArgs,
  PipelineInFlightDispatch,
  PipelinePendingRetry
} from './pipeline-driver-types'

const DRIVER_CYCLE_MS = 1_000

export class PipelineDriver {
  private phase: 'running' | 'paused' | 'terminal' = 'running'
  private detached = false
  private ticking = false
  private timer?: ReturnType<typeof setInterval>
  private context?: PipelineDriverRunContext
  private nodeIndex?: PipelineNodeIndex
  private inFlight?: PipelineInFlightDispatch
  private pendingRetry?: PipelinePendingRetry

  constructor(private readonly args: PipelineDriverArgs) {}

  start(): void {
    if (this.timer || this.phase === 'terminal' || this.detached) {
      return
    }
    void this.tick()
    this.timer = setInterval(() => void this.tick(), DRIVER_CYCLE_MS)
    this.timer.unref?.()
  }

  pause(): void {
    if (this.phase !== 'running') {
      return
    }
    this.phase = 'paused'
    writePipelineRunPaused(this.args)
  }

  resume(): void {
    if (this.phase !== 'paused') {
      return
    }
    this.phase = 'running'
    writePipelineRunResumed(this.args)
  }

  async abort(): Promise<void> {
    if (this.phase === 'terminal') {
      return
    }
    this.phase = 'terminal'
    // the state write lands before the interrupt attempt: a crash mid-interrupt must not leave
    // the run looking live
    this.args.pipelineDb.updateRunState(this.args.runId, 'aborted')
    this.stopTimer()
    const handle = resolveAbortInterruptHandle(this.args.db, this.inFlight)
    this.inFlight = undefined
    this.pendingRetry = undefined
    if (handle) {
      try {
        await this.args.runtime.sendTerminal(handle, { interrupt: true })
      } catch {
        // abort only guarantees nothing further dispatches, not that the agent obeys \x03
      }
    }
    this.args.publisher.publish(this.args.runId)
  }

  stop(): void {
    this.detached = true
    this.stopTimer()
  }

  private stopTimer(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    if (this.detached || this.phase === 'terminal' || this.ticking) {
      return
    }
    this.ticking = true
    try {
      if (!this.context || !this.nodeIndex) {
        const run = this.args.pipelineDb.getPipelineRun(this.args.runId)
        if (!run) {
          throw new Error(`Pipeline run ${this.args.runId} was not found.`)
        }
        this.context = await resolvePipelineDriverRunContext(this.args.runtime, run)
        this.nodeIndex = buildPipelineNodeIndex(this.args.pipelineDb.getNodes(this.args.runId))
      }
      if (this.inFlight) {
        await this.pollInFlight()
        return
      }
      if (this.phase !== 'running') {
        return
      }
      if (this.pendingRetry) {
        const retry = this.pendingRetry
        this.pendingRetry = undefined
        await this.dispatchAttempt(retry.node, retry.taskId, retry.attempt, retry.retryOf)
        return
      }
      const next = pickNextReadyNode(this.args.definition, this.nodeIndex as PipelineNodeIndex)
      if (!next) {
        if (allNodesSucceeded(this.nodeIndex as PipelineNodeIndex)) {
          this.completeRun()
        }
        return
      }
      const taskId = (this.nodeIndex as PipelineNodeIndex).taskIdByNodeId.get(next.id)
      if (!taskId) {
        this.failRunInternally(`Pipeline node "${next.id}" has no backing task.`)
        return
      }
      await this.dispatchAttempt(next, taskId, 1)
    } catch (error) {
      this.failRunInternally(error instanceof Error ? error.message : String(error))
    } finally {
      this.ticking = false
    }
  }

  private async pollInFlight(): Promise<void> {
    const inFlight = this.inFlight
    if (!inFlight) {
      return
    }
    const context = this.context as PipelineDriverRunContext
    const outcome = await pollDriverInFlight({
      db: this.args.db,
      runtime: this.args.runtime,
      pipelineDb: this.args.pipelineDb,
      runId: this.args.runId,
      worktreeId: context.dispatchWorktreeId,
      checkpointBackend: context.checkpointBackend,
      worktreePath: context.worktreePath,
      inFlight
    })

    if (outcome.kind === 'task-missing') {
      this.failRunInternally(`Task ${inFlight.taskId} disappeared mid-run.`)
      return
    }
    if (outcome.kind === 'pending') {
      return
    }
    if (outcome.kind === 'succeeded') {
      applyNodeOutcome(this.nodeIndex as PipelineNodeIndex, inFlight.node.id, 'succeeded')
      this.inFlight = undefined
      if (allNodesSucceeded(this.nodeIndex as PipelineNodeIndex)) {
        this.completeRun()
        return
      }
      this.args.publisher.publish(this.args.runId)
      return
    }
    this.applyAttemptResolution(inFlight.node, inFlight.taskId, outcome)
  }

  private async dispatchAttempt(
    node: ResolvedPipelineNode,
    taskId: string,
    attempt: number,
    retryOf?: string
  ): Promise<void> {
    const context = this.context as PipelineDriverRunContext
    const nodeIndex = this.nodeIndex as PipelineNodeIndex

    const outcome: PipelineDispatchOutcome = await dispatchPipelineNode({
      runtime: this.args.runtime,
      db: this.args.db,
      runId: this.args.runId,
      node,
      taskId,
      worktreeId: context.dispatchWorktreeId,
      attempt,
      host: context.host,
      checkpointBackend: context.checkpointBackend,
      worktreePath: context.worktreePath,
      retryOf,
      dependencies: buildDependencyResults(this.args.db, node, nodeIndex),
      isDispatchable: () => this.phase === 'running',
      onSpawnStarted: (dispatchId) => {
        const inFlight = beginInFlightSpawn({ phase: this.phase, node, taskId, attempt, dispatchId })
        if (inFlight) {
          this.inFlight = inFlight
        }
      }
    })

    if (outcome.kind === 'abandoned') {
      // pause or abort landed before the launch committed: nothing spawned, so requeue as a
      // pending retry — a resume dispatches it fresh, and a terminal run never consults it
      this.pendingRetry = { node, taskId, attempt, retryOf }
      this.args.publisher.publish(this.args.runId)
      return
    }

    if (this.phase === 'terminal') {
      // abort ran while this dispatch was in flight: it must not become a live attempt, but if
      // it did spawn an agent, that agent still needs the interrupt abort() couldn't send it
      await interruptAbortedDispatch(this.args.runtime, outcome)
      return
    }

    if (outcome.kind === 'refused') {
      // stage A: retrying identical config cannot succeed, so this is terminal, not a retry
      this.failNode(node.id, `launch-rejected: ${outcome.message}`)
      return
    }

    if (outcome.kind === 'live') {
      const { dispatchId } = outcome.response
      const { terminalHandle, checkpoint } = outcome
      this.inFlight = { node, taskId, attempt, dispatchId, terminalHandle, checkpoint }
      this.args.pipelineDb.beginAttempt(this.args.runId, node.id, {
        attempt,
        dispatchId,
        checkpoint
      })
      this.args.pipelineDb.resetPrelaunchFailures(this.args.runId, node.id)
      this.args.publisher.publish(this.args.runId)
      return
    }

    await this.settleFailedAttempt({
      node,
      taskId,
      attempt,
      dispatchId: outcome.response.dispatchId,
      terminalHandle: outcome.terminalHandle,
      checkpoint: outcome.checkpoint,
      workerState: outcome.workerState,
      attemptAlreadyBegun: false
    })
  }

  private async settleFailedAttempt(ctx: FailedAttemptContext): Promise<void> {
    const context = this.context as PipelineDriverRunContext
    const resolution = await resolveFailedAttempt({
      db: this.args.db,
      runtime: this.args.runtime,
      pipelineDb: this.args.pipelineDb,
      runId: this.args.runId,
      worktreeId: context.dispatchWorktreeId,
      checkpointBackend: context.checkpointBackend,
      worktreePath: context.worktreePath,
      ctx
    })
    this.applyAttemptResolution(ctx.node, ctx.taskId, resolution)
  }

  private applyAttemptResolution(
    node: ResolvedPipelineNode,
    taskId: string,
    resolution: FailedAttemptResolution
  ): void {
    // a terminal run is absorbing: a resolution that only lands after abort must not overwrite
    // an outcome the run already has
    if (this.phase === 'terminal') {
      return
    }
    if (resolution.kind === 'fail-node') {
      this.failNode(node.id, resolution.reason)
      return
    }

    this.inFlight = undefined
    this.pendingRetry = {
      node,
      taskId,
      attempt: resolution.attempt,
      retryOf: resolution.retryOf
    }
    this.args.publisher.publish(this.args.runId)
  }

  private failNode(nodeId: string, reason: string): void {
    this.args.pipelineDb.setNodeOutcome(this.args.runId, nodeId, { outcome: 'failed', reason })
    applyNodeOutcome(this.nodeIndex as PipelineNodeIndex, nodeId, 'failed', reason)
    this.inFlight = undefined
    this.pendingRetry = undefined
    this.phase = 'terminal'
    this.stopTimer()
    writePipelineRunFailed(this.args, reason)
  }

  private completeRun(): void {
    this.phase = 'terminal'
    this.stopTimer()
    writePipelineRunCompleted(this.args)
  }

  private failRunInternally(reason: string): void {
    this.phase = 'terminal'
    this.inFlight = undefined
    this.pendingRetry = undefined
    this.stopTimer()
    writePipelineRunFailed(this.args, reason)
  }
}
