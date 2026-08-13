import { vi } from 'vitest'
import type {
  ResolvedPipelineDefinition,
  ResolvedPipelineNode
} from '../../../shared/pipeline-template-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import type {
  PipelineNodeRow,
  PipelineRunDb,
  PipelineRunRow
} from '../orchestration/pipeline-run-db'
import type { PipelineCheckpointBackend } from './pipeline-checkpoint'
import type { OrchestrationWorkerStartResponse } from '../rpc/methods/orchestration-worker-start-execution'

export function node(overrides: Partial<ResolvedPipelineNode> = {}): ResolvedPipelineNode {
  return {
    id: 'n1',
    title: 'Node 1',
    prompt: 'do the thing',
    index: 0,
    needs: [],
    harness: 'claude',
    ...overrides
  }
}

export function definitionOf(nodes: ResolvedPipelineNode[]): ResolvedPipelineDefinition {
  return {
    templateName: 'test-template',
    templateVersion: 1,
    needsNewerOrca: false,
    inputText: 'input',
    nodes
  }
}

export function nodeRow(overrides: Partial<PipelineNodeRow> = {}): PipelineNodeRow {
  return {
    run_id: 'run-1',
    node_id: 'n1',
    node_index: 0,
    task_id: 'task-n1',
    title: 'Node 1',
    retries_allowed: 0,
    outcome: null,
    outcome_reason: null,
    prelaunch_failures: 0,
    ...overrides
  }
}

export function runRow(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  return {
    run_id: 'run-1',
    template_name: 'test-template',
    template_version: 1,
    run_number: 1,
    needs_newer_orca: 0,
    state: 'running',
    failure_reason: null,
    input_text: 'input',
    snapshot_json: '{}',
    workspace_id: 'workspace-1',
    workspace_display_name: 'workspace',
    base_commit: 'base',
    branch: 'pipeline/test-1',
    run_worktree_id: 'worktree-1',
    created_at: 'now',
    updated_at: 'now',
    ended_at: null,
    ...overrides
  }
}

export function workerStartResponse(
  overrides: Partial<OrchestrationWorkerStartResponse> = {}
): OrchestrationWorkerStartResponse {
  return {
    runId: 'run-1',
    taskId: 'task-n1',
    dispatchId: 'dispatch-1',
    state: 'ready',
    stage: 'dispatched',
    setup: {} as OrchestrationWorkerStartResponse['setup'],
    launch: {} as OrchestrationWorkerStartResponse['launch'],
    effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: 'term-1' }],
    residualResources: [],
    ...overrides
  }
}

/** A minimal in-memory `OrchestrationDb` double covering only what the driver reads/writes. */
export class FakeOrchestrationDb {
  tasks = new Map<string, { id: string; status: string; result: string | null }>()
  dispatches = new Map<string, { id: string; task_id: string }>()
  latestDispatchByTask = new Map<string, string>()
  workers = new Map<string, { dispatch_id: string; state: string; agent_terminal_handle: string | null }>()
  spawnReceipts = new Map<string, { spawn_attempt_at: string; spawn_committed_at: string | null }>()

  getTask = vi.fn((id: string) => this.tasks.get(id))
  getSpawnReceipt = vi.fn((dispatchId: string) => this.spawnReceipts.get(dispatchId))
  getDispatchContext = vi.fn((taskId: string) => {
    const id = this.latestDispatchByTask.get(taskId)
    return id ? this.dispatches.get(id) : undefined
  })
  getWorkerDispatch = vi.fn((dispatchId: string) => this.workers.get(dispatchId))
  beginWorkerStop = vi.fn((dispatchId: string) => {
    const worker = this.workers.get(dispatchId)
    if (!worker) {
      throw new Error(`no worker for ${dispatchId}`)
    }
    if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(worker.state)) {
      return {
        disposition: 'already_settled' as const,
        worker,
        dispatch: this.dispatches.get(dispatchId)
      }
    }
    worker.state = 'stopping'
    return { disposition: 'stopping' as const, worker, dispatch: this.dispatches.get(dispatchId) }
  })
  settleWorkerStop = vi.fn((dispatchId: string) => {
    const worker = this.workers.get(dispatchId)
    if (!worker) {
      throw new Error(`no worker for ${dispatchId}`)
    }
    worker.state = 'stopped'
    return worker
  })

  registerDispatch(args: {
    dispatchId: string
    taskId: string
    workerState: string
    agentTerminalHandle?: string | null
    spawnReceipt?: { committed?: boolean }
  }): void {
    this.dispatches.set(args.dispatchId, { id: args.dispatchId, task_id: args.taskId })
    this.latestDispatchByTask.set(args.taskId, args.dispatchId)
    this.workers.set(args.dispatchId, {
      dispatch_id: args.dispatchId,
      state: args.workerState,
      agent_terminal_handle: args.agentTerminalHandle ?? null
    })
    if (args.spawnReceipt) {
      this.spawnReceipts.set(args.dispatchId, {
        spawn_attempt_at: 'now',
        spawn_committed_at: args.spawnReceipt.committed ? 'now' : null
      })
    }
  }

  asOrchestrationDb(): OrchestrationDb {
    return this as unknown as OrchestrationDb
  }
}

/** A minimal in-memory `PipelineRunDb` double covering only what the driver reads/writes. */
export class FakePipelineRunDb {
  constructor(
    public run: PipelineRunRow,
    public nodesById: Map<string, PipelineNodeRow>
  ) {}

  getPipelineRun = vi.fn(() => this.run)
  // a real SQL-backed store returns fresh rows per query; cloning here means a caller that
  // caches this array cannot observe later writes without calling getNodes() again
  getNodes = vi.fn(() =>
    [...this.nodesById.values()].sort((a, b) => a.node_index - b.node_index).map((row) => ({ ...row }))
  )
  getAttempts = vi.fn(() => [])
  beginAttempt: ReturnType<typeof vi.fn> = vi.fn()
  endAttempt: ReturnType<typeof vi.fn> = vi.fn()
  setNodeOutcome = vi.fn(
    (
      _runId: string,
      nodeId: string,
      args: { outcome: 'succeeded' | 'failed'; reason?: string }
    ) => {
      const row = this.nodesById.get(nodeId)
      if (row) {
        row.outcome = args.outcome
        row.outcome_reason = args.reason ?? null
      }
    }
  )
  incrementPrelaunchFailures = vi.fn((_runId: string, nodeId: string) => {
    const row = this.nodesById.get(nodeId)
    if (!row) {
      return 0
    }
    row.prelaunch_failures += 1
    return row.prelaunch_failures
  })
  resetPrelaunchFailures = vi.fn((_runId: string, nodeId: string) => {
    const row = this.nodesById.get(nodeId)
    if (row) {
      row.prelaunch_failures = 0
    }
  })
  updateRunState = vi.fn(
    (_runId: string, state: PipelineRunRow['state'], opts?: { failureReason?: string }) => {
      const terminal: ReadonlySet<string> = new Set([
        'completed',
        'failed',
        'aborted',
        'interrupted'
      ])
      if (terminal.has(this.run.state)) {
        return
      }
      this.run.state = state
      if (opts?.failureReason) {
        this.run.failure_reason = opts.failureReason
      }
    }
  )

  asPipelineRunDb(): PipelineRunDb {
    return this as unknown as PipelineRunDb
  }
}

export function runtimeStub(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    sendTerminal: vi.fn().mockResolvedValue({ handle: 'h', accepted: true, bytesWritten: 1 }),
    waitForLeafPtyId: vi.fn().mockResolvedValue('pty-1'),
    stopExactTerminalsForWorktree: vi.fn().mockResolvedValue({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: [],
      postStopVerified: true
    }),
    ...overrides
  } as unknown as OrcaRuntimeService
}

export function publisherStub(): {
  publish: ReturnType<typeof vi.fn>
  setPausingAnnotation: ReturnType<typeof vi.fn>
} {
  return { publish: vi.fn(), setPausingAnnotation: vi.fn() }
}

export function fakeCheckpointBackend(): {
  capture: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
} & PipelineCheckpointBackend {
  return {
    capture: vi.fn().mockResolvedValue({ head: 'head-1', snapshot: 'snapshot-1', ref: 'ref-1' }),
    restore: vi.fn().mockResolvedValue(undefined)
  }
}

/** Drains the microtask chain behind a driver tick under fake timers (0ms still yields turns). */
export async function flushAsync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}
