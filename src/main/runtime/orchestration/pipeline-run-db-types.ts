import type { PipelineRunState } from '../../../shared/pipeline-run-snapshot'

/** Mirrors the `pipeline_runs` table (tech.md §5.1) column-for-column. */
export type PipelineRunRow = {
  run_id: string
  template_name: string
  template_version: number
  run_number: number
  needs_newer_orca: number
  state: PipelineRunState
  failure_reason: string | null
  input_text: string
  snapshot_json: string
  workspace_id: string | null
  workspace_display_name: string
  base_commit: string | null
  branch: string | null
  run_worktree_id: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
}

/** Mirrors the `pipeline_nodes` table (tech.md §5.2) column-for-column. */
export type PipelineNodeRow = {
  run_id: string
  node_id: string
  node_index: number
  task_id: string
  title: string
  retries_allowed: number
  outcome: 'succeeded' | 'failed' | null
  outcome_reason: string | null
  prelaunch_failures: number
}

/** Mirrors the `pipeline_attempts` table (tech.md §5.2) column-for-column. */
export type PipelineAttemptRow = {
  run_id: string
  node_id: string
  attempt: number
  dispatch_id: string | null
  checkpoint_head: string | null
  checkpoint_snapshot: string | null
  checkpoint_ref: string | null
  started_at: string
  ended_at: string | null
  outcome: 'succeeded' | 'failed' | null
  failure_stage: string | null
}
