/**
 * Relay-side pipeline checkpoint RPCs.
 *
 * Narrow, shape-validated mutating operations that cross the relay's read-only `git.exec`
 * allowlist boundary without widening it: that allowlist stays read-only by design, so
 * checkpoint capture/restore — which genuinely need to mutate the repo — ship as their own
 * fixed-shape RPCs instead of new allowed subcommands. Every field is validated before
 * any git process runs, and the validated fields fully determine the only ref this
 * surface may write. Reuses the exact capture/restore plumbing the local/WSL backend
 * runs (`../main/runtime/pipelines/pipeline-checkpoint-capture.ts` /
 * `-restore.ts`), so relay observables match the local backend by construction.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expandTilde } from './context'
import { buildRelayGitEnv } from './relay-command-env'
import {
  captureCheckpoint,
  type CheckpointCaptureResult
} from '../main/runtime/pipelines/pipeline-checkpoint-capture'
import { restoreCheckpoint } from '../main/runtime/pipelines/pipeline-checkpoint-restore'
import type { CheckpointGitTarget } from '../main/runtime/pipelines/pipeline-checkpoint-git'

const execFileAsync = promisify(execFile)
const MAX_CHECKPOINT_GIT_BUFFER = 10 * 1024 * 1024

const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]+$/
const NODE_ID_PATTERN = /^[a-z0-9-]{1,64}$/
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/

export type PipelineCheckpointCaptureParams = {
  worktreePath: string
  runId: string
  nodeId: string
  attempt: number
}

export type PipelineCheckpointRestoreParams = {
  worktreePath: string
  head: string
  snapshot: string
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid pipeline checkpoint request: ${field} must be a non-empty string`)
  }
  return value
}

export function validatePipelineCheckpointCaptureArgs(
  params: Record<string, unknown>
): PipelineCheckpointCaptureParams {
  const worktreePath = requireString(params.worktreePath, 'worktreePath')
  const runId = requireString(params.runId, 'runId')
  const nodeId = requireString(params.nodeId, 'nodeId')
  const attempt = params.attempt
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('Invalid pipeline checkpoint request: runId has an unexpected shape')
  }
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new Error('Invalid pipeline checkpoint request: nodeId has an unexpected shape')
  }
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    throw new Error('Invalid pipeline checkpoint request: attempt must be an integer >= 1')
  }
  return { worktreePath, runId, nodeId, attempt }
}

export function validatePipelineCheckpointRestoreArgs(
  params: Record<string, unknown>
): PipelineCheckpointRestoreParams {
  const worktreePath = requireString(params.worktreePath, 'worktreePath')
  const head = requireString(params.head, 'head')
  const snapshot = requireString(params.snapshot, 'snapshot')
  if (!OBJECT_ID_PATTERN.test(head)) {
    throw new Error('Invalid pipeline checkpoint request: head must be a full 40-hex object id')
  }
  if (!OBJECT_ID_PATTERN.test(snapshot)) {
    throw new Error('Invalid pipeline checkpoint request: snapshot must be a full 40-hex object id')
  }
  return { worktreePath, head, snapshot }
}

// bypasses the git.exec allowlist deliberately: this narrow RPC's own
// validation is the only gate, so the git call itself must not be re-filtered by it
async function runRelayCheckpointGit(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: env ?? buildRelayGitEnv(),
    encoding: 'utf-8',
    maxBuffer: MAX_CHECKPOINT_GIT_BUFFER
  })
  return String(stdout)
}

function checkpointTarget(worktreePath: string): CheckpointGitTarget {
  return { cwd: expandTilde(worktreePath), run: runRelayCheckpointGit, baseEnv: buildRelayGitEnv }
}

export async function pipelineCheckpointSupportedOp(): Promise<{ supported: true }> {
  return { supported: true }
}

export async function pipelineCheckpointCaptureOp(
  params: Record<string, unknown>
): Promise<CheckpointCaptureResult> {
  const args = validatePipelineCheckpointCaptureArgs(params)
  return captureCheckpoint(checkpointTarget(args.worktreePath), {
    runId: args.runId,
    nodeId: args.nodeId,
    attempt: args.attempt
  })
}

export async function pipelineCheckpointRestoreOp(
  params: Record<string, unknown>
): Promise<{ restored: true }> {
  const args = validatePipelineCheckpointRestoreArgs(params)
  await restoreCheckpoint(checkpointTarget(args.worktreePath), {
    head: args.head,
    snapshot: args.snapshot
  })
  return { restored: true }
}
