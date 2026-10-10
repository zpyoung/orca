import { z } from 'zod'
import type { CapabilityMode } from '../fork-heimdall/watcher-types'
import type { PipelinePin } from './pipeline-pin'
import type { TaskList, TaskListWarning } from './task-list'

const PipelineTerminalNodeWarningSchema = z
  .object({
    code: z.literal('territory-overlap'),
    taskIds: z.tuple([z.string(), z.string()]),
    paths: z.array(z.string())
  })
  .strict()

export const PipelineTerminalNodeStateSchema = z
  .object({
    instanceId: z.string().min(1),
    status: z.enum([
      'pending',
      'ready',
      'running',
      'waiting',
      'done',
      'failed',
      'skipped',
      'unverifiable'
    ]),
    epoch: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    round: z.number().int().positive().optional(),
    waitingFor: z.enum(['gate', 'choice', 'capability-approval', 'owner']).optional(),
    phase: z.string().optional(),
    revision: z.number().int().positive().optional(),
    progress: z
      .object({
        done: z.number().int().nonnegative(),
        total: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    warnings: z.array(PipelineTerminalNodeWarningSchema).optional(),
    startedAtMs: z.number().int().nonnegative().optional(),
    elapsedMs: z.number().int().nonnegative().optional(),
    turns: z.number().int().nonnegative()
  })
  .strict()
export const PipelineTerminalNodeStatesSchema = z.array(PipelineTerminalNodeStateSchema).min(1)
export type PipelineTerminalNodeState = z.infer<typeof PipelineTerminalNodeStateSchema>

export type PipelineStoreFacts = {
  pin: (PipelinePin & { runNumber: number | null }) | null
  outputs: {
    instanceId: string
    epoch: number
    attempt: number
    outputs: Record<string, unknown>
    reportSha256: string | null
    reportSummary?: string | null
  }[]
  dispatches: {
    instanceId: string
    epoch: number
    attempt: number
    dispatchId: string
    workspaceId: string | null
    terminalHandle: string | null
    reportPath: string
    dispatchedAtMs: number
  }[]
  swarmExpansions: {
    swarmId: string
    epoch: number
    tasks: TaskList
    warnings: TaskListWarning[]
    baseCommit: string | null
  }[]
  childWorktrees: {
    instanceId: string
    epoch: number
    worktreeId: string
    setupState: string
  }[]
  mergeProgress: {
    mergeId: string
    epoch: number
    childInstanceId: string
    state: 'pending' | 'applied' | 'conflict' | 'resolving' | 'resolved' | 'skipped'
    commitSha: string | null
    appliedCommitSha: string | null
    conflict: { paths: string[]; conflictingChildren: string[] } | null
  }[]
  composites: {
    instanceId: string
    epoch: number
    kind: 'hosted-review'
    kindPayload: unknown
    capabilities: Record<string, CapabilityMode>
    activatedAtMs: number
  }[]
  /** Node outcomes and existing graph counters captured before terminal ledger compaction. */
  terminalNodeStates?: PipelineTerminalNodeState[]
}
