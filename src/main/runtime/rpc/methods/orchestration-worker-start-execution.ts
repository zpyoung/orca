import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../shared/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import {
  createWorkerLaunchReceipt,
  type OrchestrationWorkerLaunchReceipt
} from './orchestration-worker-launch-preferences'
import {
  createExistingWorktreeWorkerTerminal,
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'

/**
 * The merged shape the existing beneath-fence path already produces: the
 * success return `orchestration-workers.ts` builds on a ready dispatch, and
 * the failure return of `failWorkerStartWithReceipt`. This is not a new
 * union — it names that shape so the extraction can return it unchanged.
 */
export type OrchestrationWorkerStartResponse = {
  runId: string
  taskId: string
  dispatchId: string
  state: string
  stage: string
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
  effects: unknown[]
  residualResources: unknown[]
  timeoutMs?: number
  failedStage?: string
  lastError?: string
  warning?: string
  nextCommands?: string[]
}

export type ExecuteLocalWorkerStartArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  taskId: string
  worktreeId: string
  from: string
  dispatchPrompt?: string
  retryOf?: string
  timeoutMs?: number
  devMode?: boolean
  mutationReceipt?: Parameters<OrchestrationDb['createStartingWorkerDispatch']>[0]['mutationReceipt']
  requestedWorktree?: string
  name?: string
  repo?: string
  baseBranch?: string
} & (
  | {
      launch: 'new-terminal'
      agent: TuiAgent
      launchPreferences?: AgentLaunchPreferences
      onPtySpawnCommitted?: () => void
    }
  | { launch: 'reuse-terminal'; terminal: string }
)

function resolveLaunchReceipt(args: ExecuteLocalWorkerStartArgs): OrchestrationWorkerLaunchReceipt {
  if (args.launch === 'reuse-terminal') {
    return createWorkerLaunchReceipt({ agent: null })
  }
  return createWorkerLaunchReceipt({
    agent: args.agent,
    model: args.launchPreferences?.model,
    effort: args.launchPreferences?.effort
  })
}

/**
 * Runs the local existing-worktree worker-start path beneath the
 * `orchestration.workerStart` RPC fence. Has no pane, no consumer, and no
 * fence of its own — callers above the RPC boundary (the RPC handler today,
 * a pane-less pipeline driver later) apply the fence themselves.
 */
export async function executeLocalWorkerStart(
  args: ExecuteLocalWorkerStartArgs
): Promise<OrchestrationWorkerStartResponse> {
  const { runtime, db, runId, taskId, worktreeId } = args
  const task = db.getTask(taskId)
  if (!task) {
    throw new Error(`Task ${taskId} was not found.`)
  }
  const launchReceipt = resolveLaunchReceipt(args)
  const started = db.createStartingWorkerDispatch({
    taskId: task.id,
    retryOf: args.retryOf,
    startOptions: {
      worktree: args.requestedWorktree ?? null,
      resolvedWorktreeId: worktreeId,
      name: args.name ?? null,
      repo: args.repo ?? null,
      baseBranch: args.baseBranch ?? null,
      terminal: args.launch === 'reuse-terminal' ? args.terminal : null,
      agent: args.launch === 'new-terminal' ? args.agent : null,
      launch: launchReceipt,
      timeoutMs: args.timeoutMs ?? 60_000,
      setup: 'not_applicable',
      setupSource: 'existing_worktree'
    },
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: args.mutationReceipt
  })
  const effects: WorkerEffect[] = [
    { kind: 'worktree', action: 'reused', id: worktreeId },
    { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
  ]
  let terminalHandle = args.launch === 'reuse-terminal' ? args.terminal : undefined
  let terminalRevealWarning: string | undefined
  let failedStage = 'terminal_create'
  const setupReceipt: WorkerSetupReceipt = {
    requested: 'not_applicable',
    effective: 'not_applicable',
    source: 'existing_worktree',
    hookFound: false,
    startupPolicy: 'start-immediately',
    state: 'not_applicable'
  }
  try {
    if (args.launch === 'new-terminal') {
      db.recordWorkerStage({
        dispatchId: started.dispatch.id,
        stage: 'terminal_creating',
        worktreeId,
        effects
      })
      // recordSpawnAttempt must land before the PTY spawn call: its absence after a
      // failure is positive proof nothing spawned.
      db.recordSpawnAttempt(started.dispatch.id)
      const terminal = await createExistingWorktreeWorkerTerminal({
        runtime,
        worktreeId,
        agent: args.agent,
        launchPreferences: args.launchPreferences,
        taskId: task.id,
        effects,
        onPtySpawnCommitted: () => {
          db.markSpawnCommitted(started.dispatch.id)
          args.onPtySpawnCommitted?.()
        }
      })
      terminalHandle = terminal.handle
      terminalRevealWarning = terminal.warning
    } else {
      effects.push({ kind: 'terminal', role: 'agent', action: 'reused', id: terminalHandle })
    }
    if (!terminalHandle) {
      throw new Error('Worker topology did not resolve an agent terminal and worktree.')
    }
    const setupStage = {
      db,
      dispatchId: started.dispatch.id,
      worktreeId,
      terminalHandle,
      setup: setupReceipt,
      effects
    }
    if (persistGatedSetupSpawnFailure(setupStage)) {
      failedStage = 'setup_start'
      throw new Error('Setup terminal failed to start before the gated agent launch.')
    }
    persistWorkerReadinessStage(setupStage)

    failedStage = 'agent_readiness'
    const wait = await runtime.waitForTerminal(terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: args.timeoutMs ?? 60_000
    })
    persistWorkerSetupWaitOutcome({ ...setupStage, wait })
    if (!wait.satisfied) {
      if (setupReceipt.state === 'failed') {
        failedStage = 'setup_wait'
      }
      throw new Error(
        wait.blockedReason
          ? `Agent startup blocked: ${wait.blockedReason}`
          : `Agent did not become ready (${wait.status}).`
      )
    }
    const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      ...terminalAuthority,
      worktreeId,
      effects,
      setupState: setupReceipt.state,
      terminalOwnership: args.launch === 'reuse-terminal' ? 'external' : 'created'
    })

    failedStage = 'dispatch_input'
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: started.dispatch.id,
      taskSpec: args.dispatchPrompt ?? task.spec,
      coordinatorHandle: args.from,
      workerHandle: terminalHandle,
      dispatchCapability: capability,
      devMode: args.devMode,
      cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
    })
    await runtime.sendTerminalAgentPrompt(terminalHandle, preamble)
    effects.push({ kind: 'dispatch_input', role: 'agent', id: terminalHandle, state: 'accepted' })
    const worker = db.markWorkerDispatchReady(started.dispatch.id, effects)
    monitorWorkerSetup({
      runtime,
      db,
      runId,
      dispatchId: started.dispatch.id,
      setupReceipt,
      effects
    })
    return {
      runId,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      state: worker.state,
      stage: worker.stage,
      setup: setupReceipt,
      launch: launchReceipt,
      timeoutMs: args.timeoutMs ?? 60_000,
      effects,
      residualResources: [],
      ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
    }
  } catch (error) {
    return failWorkerStartWithReceipt({
      db,
      runId,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage,
      error,
      setup: setupReceipt,
      launch: launchReceipt
    }) as OrchestrationWorkerStartResponse
  }
}
