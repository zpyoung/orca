/** Local/WSL pipeline checkpoint backend (logic L9, L9a, L9b; tech §4.6). SSH ships separately behind the same contract. */

import { captureCheckpoint } from './pipeline-checkpoint-capture'
import { restoreCheckpoint } from './pipeline-checkpoint-restore'

export type PipelineCheckpointBackend = {
  capture(args: {
    worktreePath: string
    runId: string
    nodeId: string
    attempt: number
  }): Promise<{ head: string; snapshot: string; ref: string }>
  restore(args: { worktreePath: string; head: string; snapshot: string }): Promise<void>
}

export function createLocalCheckpointBackend(opts: {
  wslDistro?: string
}): PipelineCheckpointBackend {
  return {
    capture: (args) =>
      captureCheckpoint(
        { cwd: args.worktreePath, wslDistro: opts.wslDistro },
        { runId: args.runId, nodeId: args.nodeId, attempt: args.attempt }
      ),
    restore: (args) =>
      restoreCheckpoint(
        { cwd: args.worktreePath, wslDistro: opts.wslDistro },
        { head: args.head, snapshot: args.snapshot }
      )
  }
}
