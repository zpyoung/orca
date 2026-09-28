export type EnrollmentRow = {
  watcher_id: string
  kind: string
  workspace_key: string
  execution_host_id: string
  repo_id: string
  worktree_id: string | null
  workspace_path: string
  scheduler_owner: string
  enabled: number
  paused: number
  command_revision: number
  capabilities_json: string
  budget_json: string
  kind_payload_json: string
  coordinator_handle: string
  coordinator_pane_key: string
  orchestration_run_id: string | null
  created_at_ms: number
  terminal_at_ms: number | null
  owner_json: string | null
}
