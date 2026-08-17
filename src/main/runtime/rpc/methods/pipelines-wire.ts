import type { PipelineRunRow } from '../../orchestration/pipeline-run-db'
import type { InstantiatePipelineRunOutcome } from '../../pipelines/pipeline-instantiation'

export type PipelineRunListEntry = {
  runId: string
  templateName: string
  runNumber: number
  state: string
  workspaceDisplayName: string
  workspaceId?: string
  createdAt: string
  endedAt?: string
}

export function toPipelineRunListEntry(row: PipelineRunRow): PipelineRunListEntry {
  return {
    runId: row.run_id,
    templateName: row.template_name,
    runNumber: row.run_number,
    state: row.state,
    workspaceDisplayName: row.workspace_display_name,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    createdAt: row.created_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {})
  }
}

export type PipelineStartResult =
  | { runId: string; runNumber: number; branch?: string }
  | { refused: { nodeId?: string; field?: string; message: string } }

export function toPipelineStartResult(outcome: InstantiatePipelineRunOutcome): PipelineStartResult {
  if ('refused' in outcome) {
    return { refused: outcome.refused }
  }
  return {
    runId: outcome.runId,
    runNumber: outcome.runNumber,
    ...(outcome.branch ? { branch: outcome.branch } : {})
  }
}
