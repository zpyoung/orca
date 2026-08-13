/** The host-side dispatch loop: walks the run's task DAG, applying retry and failure accounting. */

import type { ResolvedPipelineNode } from '../../../shared/pipeline-template-types'
import { dispatchPipelineNode, type PipelineDispatchOutcome } from './pipeline-driver-dispatch'
import { resolveFailedAttempt, type FailedAttemptContext } from './pipeline-driver-failure'
import {
  allNodesSucceeded,
  buildDependencyResults,
  buildPipelineNodeIndex,
  pickNextReadyNode,
  type PipelineNodeIndex
} from './pipeline-driver-node-graph'
import {
  resolvePipelineDriverRunContext,
  type PipelineDriverRunContext
} from './pipeline-driver-run-context'
import { extractDispatchTerminalHandle } from './pipeline-driver-stage-classify'
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
    this.args.pipelineDb.updateRunState(this.args.runId, 'paused')
    this.args.publisher.setPausingAnnotation(this.args.runId, true)
    this.args.publisher.publish(this.args.runId)
  }

  resume(): void {
    if (this.phase !== 'paused') {
      return
    }
    this.phase = 'running'
    this.args.pipelineDb.updateRunState(this.args.runId, 'running')
    this.args.publisher.setPausingAnnotation(this.args.runId, false)
    this.args.publisher.publish(this.args.runId)
  }

  async abort(): Promise<void> {
    if (this.phase === 'terminal') {
      return
    }
    this.phase = 'terminal'
    this.args.pipelineDb.updateRunState(this.args.runId, 'aborted')
    this.stopTimer()
    const handle = this.inFlight?.terminalHandle
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
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async ensureContext(): Promise<void> {
    const run = this.args.pipelineDb.getPipelineRun(this.args.runId)
    if (!run) {
      throw new Error(`Pipeline run ${this.args.runId} was not found.`)
    }
    this.context = await resolvePipelineDriverRunContext(this.args.runtime, run)
    this.nodeIndex = buildPipelineNodeIndex(this.args.pipelineDb.getNodes(this.args.runId))
  }

  private async tick(): Promise<void> {
    if (this.detached || this.phase === 'terminal' || this.ticking) {
      return
    }
    this.ticking = true
    try {
      if (!this.context || !this.nodeIndex) {
        await this.ensureContext()
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
    const task = this.args.db.getTask(inFlight.taskId)
    if (!task) {
      this.failRunInternally(`Task ${inFlight.taskId} disappeared mid-run.`)
      return
    }
    if (task.status === 'completed') {
      this.args.pipelineDb.endAttempt(this.args.runId, inFlight.node.id, inFlight.attempt, {
        outcome: 'succeeded'
      })
      this.args.pipelineDb.setNodeOutcome(this.args.runId, inFlight.node.id, {
        outcome: 'succeeded'
      })
      this.inFlight = undefined
      if (allNodesSucceeded(this.nodeIndex as PipelineNodeIndex)) {
        this.completeRun()
        return
      }
      this.args.publisher.publish(this.args.runId)
      return
    }
    if (task.status !== 'failed' && task.status !== 'blocked') {
      return
    }
    const dispatch = this.args.db.getDispatchContext(inFlight.taskId)
    const worker = dispatch ? this.args.db.getWorkerDispatch(dispatch.id) : undefined
    const workerState: 'failed' | 'start_unknown' =
      worker?.state === 'start_unknown' ? 'start_unknown' : 'failed'
    await this.settleFailedAttempt({
      node: inFlight.node,
      taskId: inFlight.taskId,
      attempt: inFlight.attempt,
      dispatchId: inFlight.dispatchId,
      terminalHandle: inFlight.terminalHandle,
      checkpoint: inFlight.checkpoint,
      workerState,
      attemptAlreadyBegun: true
    })
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
      dependencies: buildDependencyResults(this.args.db, node, nodeIndex)
    })

    if (outcome.kind === 'refused') {
      // stage A: retrying identical config cannot succeed, so this is terminal, not a retry
      this.failNode(node.id, `launch-rejected: ${outcome.message}`)
      return
    }

    const { response, checkpoint } = outcome
    const terminalHandle = extractDispatchTerminalHandle(response.effects)

    if (response.state !== 'failed' && response.state !== 'outcome_unknown') {
      this.inFlight = {
        node,
        taskId,
        attempt,
        dispatchId: response.dispatchId,
        terminalHandle,
        checkpoint
      }
      this.args.pipelineDb.beginAttempt(this.args.runId, node.id, {
        attempt,
        dispatchId: response.dispatchId,
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
      dispatchId: response.dispatchId,
      terminalHandle,
      checkpoint,
      workerState: response.state === 'outcome_unknown' ? 'start_unknown' : 'failed',
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

    if (resolution.kind === 'fail-node') {
      this.failNode(ctx.node.id, resolution.reason)
      return
    }

    this.inFlight = undefined
    this.pendingRetry = {
      node: ctx.node,
      taskId: ctx.taskId,
      attempt: resolution.attempt,
      retryOf: resolution.retryOf
    }
    this.args.publisher.publish(this.args.runId)
  }

  private failNode(nodeId: string, reason: string): void {
    this.args.pipelineDb.setNodeOutcome(this.args.runId, nodeId, { outcome: 'failed', reason })
    this.inFlight = undefined
    this.pendingRetry = undefined
    this.phase = 'terminal'
    this.args.pipelineDb.updateRunState(this.args.runId, 'failed', { failureReason: reason })
    this.stopTimer()
    this.args.publisher.publish(this.args.runId)
  }

  private completeRun(): void {
    this.phase = 'terminal'
    this.args.pipelineDb.updateRunState(this.args.runId, 'completed')
    this.stopTimer()
    this.args.publisher.publish(this.args.runId)
  }

  private failRunInternally(reason: string): void {
    this.phase = 'terminal'
    this.inFlight = undefined
    this.pendingRetry = undefined
    this.args.pipelineDb.updateRunState(this.args.runId, 'failed', { failureReason: reason })
    this.stopTimer()
    this.args.publisher.publish(this.args.runId)
  }
}
