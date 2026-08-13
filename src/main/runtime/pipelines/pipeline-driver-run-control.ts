/** The run-state DB write and snapshot publish behind each driver phase transition. */

import type { PipelineRunDb } from '../orchestration/pipeline-run-db'
import type { PipelineSnapshotPublisher } from './pipeline-snapshot-publisher'

type PipelineRunControlArgs = {
  pipelineDb: PipelineRunDb
  publisher: PipelineSnapshotPublisher
  runId: string
}

export function writePipelineRunPaused(args: PipelineRunControlArgs): void {
  args.pipelineDb.updateRunState(args.runId, 'paused')
  args.publisher.setPausingAnnotation(args.runId, true)
  args.publisher.publish(args.runId)
}

export function writePipelineRunResumed(args: PipelineRunControlArgs): void {
  args.pipelineDb.updateRunState(args.runId, 'running')
  args.publisher.setPausingAnnotation(args.runId, false)
  args.publisher.publish(args.runId)
}

export function writePipelineRunCompleted(args: PipelineRunControlArgs): void {
  args.pipelineDb.updateRunState(args.runId, 'completed')
  args.publisher.publish(args.runId)
}

export function writePipelineRunFailed(args: PipelineRunControlArgs, failureReason: string): void {
  args.pipelineDb.updateRunState(args.runId, 'failed', { failureReason })
  args.publisher.publish(args.runId)
}
