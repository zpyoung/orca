import type { TuiAgent } from '../../../../shared/types'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import {
  createWorkerWorktree,
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
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'
import { executeLocalWorkerStart } from './orchestration-worker-start-execution'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (params, { runtime, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const coordinatorPane = runtime.getTerminalPaneKey(params.from)
      const run = coordinatorPane ? db.getCurrentRunForPane(coordinatorPane) : undefined
      if (!run || (params.run && params.run !== run.id)) {
        throw new OrchestrationError(
          'consumer_fenced',
          'worker-start requires the coordinator terminal currently bound to the Task Run.'
        )
      }
      const task = db.getTask(params.task)
      if (!task || task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }

      if (params.on) {
        return startFederatedWorker({
          params,
          runtime,
          db,
          runId: run.id,
          task,
          orchestrationMutation
        })
      }

      const requestedWorktree = params.worktree ?? 'current'
      const createsWorktree =
        requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
      const { agent, launch } = prepareLocalWorkerStart({ params, createsWorktree, runtime })

      const coordinatorTerminal = await runtime.showTerminal(params.from)
      const coordinatorWorktree = await runtime.showManagedWorktree(
        `id:${coordinatorTerminal.worktreeId}`
      )
      if (createsWorktree) {
        await assertOrchestrationWorktreeCreationSupported({
          runtime,
          repoSelector: params.repo ?? coordinatorWorktree.repoId,
          existingPlacement: 'current or an exact existing folder workspace'
        })
      }
      const resolvedWorktree = createsWorktree
        ? undefined
        : requestedWorktree === 'current'
          ? coordinatorWorktree
          : await runtime.showManagedWorktree(requestedWorktree)
      if (params.terminal) {
        const explicitTerminal = await runtime.showTerminal(params.terminal)
        if (explicitTerminal.worktreeId !== resolvedWorktree?.id) {
          throw new OrchestrationError(
            'terminal_worktree_mismatch',
            `Terminal ${params.terminal} does not belong to worktree ${resolvedWorktree?.id}.`
          )
        }
        if (!(await runtime.isTerminalRunningAgent(params.terminal))) {
          throw new OrchestrationError(
            'agent_unconfigured',
            `Terminal ${params.terminal} is not running a recognized agent.`
          )
        }
      }

      if (!createsWorktree) {
        return executeLocalWorkerStart({
          runtime,
          db,
          runId: run.id,
          taskId: task.id,
          worktreeId: resolvedWorktree!.id,
          from: params.from,
          retryOf: params.retryOf,
          timeoutMs: params.timeoutMs,
          devMode: params.devMode,
          mutationReceipt: orchestrationMutation,
          requestedWorktree,
          name: params.name,
          repo: params.repo,
          baseBranch: params.baseBranch,
          ...(params.terminal
            ? { launch: 'reuse-terminal' as const, terminal: params.terminal }
            : {
                launch: 'new-terminal' as const,
                agent: agent as TuiAgent,
                launchPreferences: launch.preferences
              })
        })
      }

      const startOptions = {
        worktree: requestedWorktree,
        name: params.name ?? null,
        repo: params.repo ?? coordinatorWorktree.repoId,
        baseBranch: params.baseBranch ?? null,
        agent: agent ?? null,
        launch: launch.receipt,
        timeoutMs: params.timeoutMs ?? 60_000,
        setup: params.setup ?? 'run',
        setupSource: params.setup ? 'explicit_request' : 'orchestration_default'
      }
      const started = db.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: params.retryOf,
        startOptions,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      const effects: WorkerEffect[] = []
      let terminalHandle: string | undefined
      let failedStage = 'worktree_create'
      let setupReceipt: WorkerSetupReceipt = {
        requested: 'not_applicable',
        effective: 'not_applicable',
        source: 'existing_worktree',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_applicable'
      }
      try {
        const created = await createWorkerWorktree({
          runtime,
          db,
          dispatchId: started.dispatch.id,
          requestedWorktree,
          coordinatorWorktree,
          params,
          agent: agent as TuiAgent,
          launchPreferences: launch.preferences,
          effects
        })
        const createdWorktree = created.worktree
        terminalHandle = created.terminalHandle
        setupReceipt = created.setupReceipt
        const setupStage = {
          db,
          dispatchId: started.dispatch.id,
          worktreeId: createdWorktree.id,
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
          timeoutMs: params.timeoutMs ?? 60_000
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
          worktreeId: createdWorktree.id,
          effects,
          setupState: setupReceipt.state,
          terminalOwnership: 'created'
        })

        failedStage = 'dispatch_input'
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: started.dispatch.id,
          taskSpec: task.spec,
          coordinatorHandle: params.from,
          workerHandle: terminalHandle,
          dispatchCapability: capability,
          devMode: params.devMode,
          cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
        })
        await runtime.sendTerminalAgentPrompt(terminalHandle, preamble)
        effects.push({
          kind: 'dispatch_input',
          role: 'agent',
          id: terminalHandle,
          state: 'accepted'
        })
        const worker = db.markWorkerDispatchReady(started.dispatch.id, effects)
        monitorWorkerSetup({
          runtime,
          db,
          runId: run.id,
          dispatchId: started.dispatch.id,
          setupReceipt,
          effects
        })
        return {
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          state: worker.state,
          stage: worker.stage,
          setup: setupReceipt,
          launch: launch.receipt,
          timeoutMs: params.timeoutMs ?? 60_000,
          effects,
          residualResources: []
        }
      } catch (error) {
        return failWorkerStartWithReceipt({
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          failedStage,
          error,
          setup: setupReceipt,
          launch: launch.receipt
        })
      }
    }
  })
]
