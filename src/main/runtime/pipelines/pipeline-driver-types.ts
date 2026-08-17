import type {
  ResolvedPipelineDefinition,
  ResolvedPipelineNode
} from '../../../shared/pipeline-template-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import type { PipelineRunDb } from '../orchestration/pipeline-run-db'
import type { PipelineSnapshotPublisher } from './pipeline-snapshot-publisher'

export type PipelineDriverArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  pipelineDb: PipelineRunDb
  runId: string
  definition: ResolvedPipelineDefinition
  publisher: PipelineSnapshotPublisher
}

export type PipelineCheckpointInfo = { head: string; snapshot: string; ref: string }

/** A node currently occupying the run's single dispatch slot: all nodes share one worktree. */
export type PipelineInFlightDispatch = {
  node: ResolvedPipelineNode
  taskId: string
  attempt: number
  dispatchId: string
  terminalHandle?: string
  checkpoint?: PipelineCheckpointInfo
}

/** A prepared re-dispatch (stage-B same-attempt cycle, or stage-C next attempt) awaiting a cycle. */
export type PipelinePendingRetry = {
  node: ResolvedPipelineNode
  taskId: string
  attempt: number
  retryOf?: string
}
