/**
 * Wires the deterministic stub harness (stub-harness/**) into a real pipeline-node dispatch,
 * proving the seam a driver-level fake cannot reach: `dispatchPipelineNode` really launches a
 * process through `agentCmdOverrides`, that process really is a PTY's foreground process, the
 * real dispatch prompt really reaches it (as pasted stdin, exactly as `sendTerminalAgentPrompt`
 * delivers to any real interactive agent), and a scripted outcome really flows back through
 * `orchestration.send` into the task status `pollInFlightDispatch` reads.
 *
 * What this does NOT prove: the stub agent process itself never calls a real `orca` CLI
 * subprocess to report `worker_done` — building the CLI is a separate build step outside this
 * suite's `vitest run` invocation. Instead, once the stub's outcome file appears, the test
 * extracts the same `--dispatch-capability` token a real CLI call would carry (parsed out of
 * the actual preamble text the stub received) and invokes the exact same `orchestration.send`
 * RPC handler the CLI would reach over its socket, exercising the real handler and the real
 * `OrchestrationDb` write, but not the CLI-to-socket hop itself.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { assemblePipelineDispatchPrompt } from '../../../shared/pipeline-dispatch-prompt'
import type { ResolvedPipelineDefinition } from '../../../shared/pipeline-template-types'
import { createPtySubprocess } from '../../daemon/pty-subprocess'
import { TerminalHost } from '../../daemon/terminal-host'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { PipelineRunDb } from '../orchestration/pipeline-run-db'
import { buildDispatchPreamble } from '../orchestration/preamble'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'
import { dispatchPipelineNode, type PipelineDispatchOutcome } from './pipeline-driver-dispatch'
import { pollInFlightDispatch } from './pipeline-driver-poll'
import {
  buildStubAgentCmdOverride,
  createStubHarnessControlDir,
  readStubReceivedPrompt,
  STUB_AGENT_AWAIT_PASTE_ENV_VAR,
  waitForStubOutcome,
  writeStubInvocationScript
} from './stub-harness/stub-harness'

const DISPATCH_TIMEOUT_MS = 20_000
const NODE_PROMPT = 'do the scratch thing'

const NODE: ResolvedPipelineDefinition['nodes'][number] = {
  id: 'n1',
  title: 'Node 1',
  prompt: NODE_PROMPT,
  index: 0,
  needs: [],
  harness: 'claude'
}

function buildDefinition(): ResolvedPipelineDefinition {
  return {
    templateName: 'stub-harness-acceptance',
    templateVersion: 1,
    needsNewerOrca: false,
    inputText: 'input',
    nodes: [NODE]
  }
}

/**
 * Everything a real `dispatchPipelineNode` call needs to run for real: an OrchestrationDb, a
 * runtime whose PTY controller is backed by a real `TerminalHost` + real node-pty spawn, and
 * `agentCmdOverrides` pointed at the stub runner. `agentDefaultEnv` opts the runner into the
 * stdin-prompt mode a real orchestrated worker dispatch actually uses (see
 * stub-agent-runner.cjs) — pipeline dispatch never puts the prompt in argv.
 */
function setupRealDispatchHarness(root: string, controlDir: string) {
  const store = {
    getSettings: () => ({
      workspaceDir: root,
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: '',
      disabledTuiAgents: [],
      agentCmdOverrides: { claude: buildStubAgentCmdOverride(controlDir) },
      agentDefaultArgs: {},
      agentDefaultEnv: { claude: { [STUB_AGENT_AWAIT_PASTE_ENV_VAR]: '1' } }
    }),
    getRepos: () => [],
    getRepo: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getProjects: () => []
  }

  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setOrchestrationDb(db)
  const pipelineDb = new PipelineRunDb(db)
  const host = new TerminalHost({ spawnSubprocess: (opts) => createPtySubprocess(opts) })

  runtime.setPtyController({
    spawn: async (options) => {
      const requestedSessionId = `pipeline-stub-${Date.now()}-${Math.random().toString(36).slice(2)}`
      let resolvedSessionId = requestedSessionId
      const result = await host.createOrAttach({
        sessionId: requestedSessionId,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
        command: options.command,
        startupCommandDelivery: options.startupCommandDelivery,
        launchAgent: options.launchAgent,
        agentSessionEnsure: options.agentSessionEnsure,
        streamClient: {
          onData: (data) => runtime.onPtyData(resolvedSessionId, data, Date.now()),
          onExit: (code) => runtime.onPtyExit(resolvedSessionId, code)
        },
        onSessionResolved: (sessionId) => {
          resolvedSessionId = sessionId
        }
      })
      return {
        id: result.agentSessionEnsure?.owner.ptyId ?? resolvedSessionId,
        ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
      }
    },
    // Real writes/kills, not stubs — a no-op `write` would let `sendTerminalAgentPrompt`
    // "succeed" while the stub never receives anything, which is exactly the false-pass
    // this suite exists to rule out.
    write: (ptyId, data) => {
      host.write(ptyId, data)
      return true
    },
    kill: (ptyId) => {
      void host.kill(ptyId)
      return true
    },
    getForegroundProcess: async () => 'node'
  })

  return {
    db,
    runtime,
    pipelineDb,
    async cleanup() {
      await host.dispose()
      db.close()
    }
  }
}

function agentTerminalHandle(outcome: Extract<PipelineDispatchOutcome, { kind: 'started' }>): string {
  const effect = outcome.response.effects.find(
    (candidate): candidate is { kind: string; role?: string; id?: string } =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { kind?: string }).kind === 'terminal' &&
      (candidate as { role?: string }).role === 'agent'
  )
  const handle = effect?.id
  if (!handle) {
    throw new Error('dispatch did not report an agent terminal handle')
  }
  return handle
}

/** The same preamble the driver assembled, reconstructed independently for comparison — every
 * input is known to the test except `dispatchCapability`, an opaque per-dispatch token whose
 * plaintext is never returned to the caller (only its hash is persisted), so it is read back
 * out of the stub's own received prompt instead of re-derived. */
function reconstructExpectedPrompt(args: {
  runtime: OrcaRuntimeService
  runId: string
  taskId: string
  dispatchId: string
  workerHandle: string
  dispatchCapability: string
}): string {
  return buildDispatchPreamble({
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    dispatchCapability: args.dispatchCapability,
    taskSpec: assemblePipelineDispatchPrompt({ snapshotPrompt: NODE_PROMPT, dependencies: [] }),
    coordinatorHandle: `pipeline-driver:${args.runId}`,
    workerHandle: args.workerHandle,
    cliCommand: args.runtime.getTerminalOrchestrationCliCommand(args.workerHandle)
  })
}

async function reportWorkerDone(args: {
  runtime: OrcaRuntimeService
  workerHandle: string
  taskId: string
  dispatchId: string
  dispatchCapability: string
  outcome: 'succeeded' | 'failed'
}): Promise<void> {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === 'orchestration.send')
  if (!method?.params) {
    throw new Error('orchestration.send method not found')
  }
  const parsed = method.params.parse({
    from: args.workerHandle,
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      outcome: args.outcome
    })
  })
  await method.handler(parsed, { runtime: args.runtime, orchestrationCapability: args.dispatchCapability })
}

describe('pipeline stub harness acceptance', () => {
  const cleanups: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function runDispatchThroughRealAgent(scriptOutcome: 'success' | 'failure') {
    const root = mkdtempSync(join(tmpdir(), 'orca-pipeline-stub-acceptance-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const controlDir = createStubHarnessControlDir(root)
    writeStubInvocationScript(controlDir, 0, {
      outcome: scriptOutcome,
      ...(scriptOutcome === 'failure' ? { failureMessage: 'scripted to fail' } : {})
    })

    const harness = setupRealDispatchHarness(root, controlDir)
    cleanups.push(() => harness.cleanup())

    const definition = buildDefinition()
    const instantiated = harness.pipelineDb.instantiate({
      definition,
      workspaceId: null,
      workspaceDisplayName: 'stub harness acceptance workspace',
      baseCommit: null
    })
    const { runId } = instantiated
    const taskId = instantiated.taskIdByNodeId[NODE.id]

    const dispatchOutcome = await dispatchPipelineNode({
      runtime: harness.runtime,
      db: harness.db,
      runId,
      node: definition.nodes[0],
      taskId,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      attempt: 1,
      host: {},
      dependencies: []
    })
    if (dispatchOutcome.kind !== 'started') {
      throw new Error(`dispatch was refused: ${dispatchOutcome.message}`)
    }
    const workerHandle = agentTerminalHandle(dispatchOutcome)

    const stubOutcome = await waitForStubOutcome(controlDir, 0, DISPATCH_TIMEOUT_MS)
    const receivedPrompt = readStubReceivedPrompt(controlDir, 0)
    const dispatchCapability = /--dispatch-capability (\S+)/.exec(receivedPrompt)?.[1]
    if (!dispatchCapability) {
      throw new Error('stub never received a --dispatch-capability token')
    }

    return {
      harness,
      runId,
      taskId,
      dispatchId: dispatchOutcome.response.dispatchId,
      workerHandle,
      dispatchCapability,
      receivedPrompt,
      stubOutcome,
      node: definition.nodes[0]
    }
  }

  it(
    'dispatches through agentCmdOverrides, delivers the assembled prompt, and the driver observes success',
    async () => {
      const result = await runDispatchThroughRealAgent('success')
      expect(result.stubOutcome).toEqual({ index: 0, outcome: 'success', message: null })

      expect(result.receivedPrompt).toContain(`Your task ID is: ${result.taskId}`)
      expect(result.receivedPrompt).toContain(`--dispatch-id ${result.dispatchId}`)
      expect(result.receivedPrompt).toBe(
        reconstructExpectedPrompt({
          runtime: result.harness.runtime,
          runId: result.runId,
          taskId: result.taskId,
          dispatchId: result.dispatchId,
          workerHandle: result.workerHandle,
          dispatchCapability: result.dispatchCapability
        })
      )

      await reportWorkerDone({
        runtime: result.harness.runtime,
        workerHandle: result.workerHandle,
        taskId: result.taskId,
        dispatchId: result.dispatchId,
        dispatchCapability: result.dispatchCapability,
        outcome: 'succeeded'
      })
      expect(result.harness.db.getTask(result.taskId)?.status).toBe('completed')

      const pollOutcome = await pollInFlightDispatch({
        db: result.harness.db,
        runtime: result.harness.runtime,
        pipelineDb: result.harness.pipelineDb,
        runId: result.runId,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        inFlight: {
          node: result.node,
          taskId: result.taskId,
          attempt: 1,
          dispatchId: result.dispatchId,
          terminalHandle: result.workerHandle
        },
        taskStatus: result.harness.db.getTask(result.taskId)!.status
      })
      expect(pollOutcome).toEqual({ kind: 'succeeded' })
    },
    30_000
  )

  it(
    'propagates a scripted failure back through orchestration.send to a driver fail-node verdict',
    async () => {
      const result = await runDispatchThroughRealAgent('failure')
      expect(result.stubOutcome).toEqual({
        index: 0,
        outcome: 'failure',
        message: 'scripted to fail'
      })

      await reportWorkerDone({
        runtime: result.harness.runtime,
        workerHandle: result.workerHandle,
        taskId: result.taskId,
        dispatchId: result.dispatchId,
        dispatchCapability: result.dispatchCapability,
        outcome: 'failed'
      })
      expect(result.harness.db.getTask(result.taskId)?.status).toBe('failed')

      // attemptsAllowed = 1 + (node.onFailure?.retries ?? 0) = 1: the single attempt is
      // exhausted, so the driver's real failure-resolution path must fail the node outright.
      const pollOutcome = await pollInFlightDispatch({
        db: result.harness.db,
        runtime: result.harness.runtime,
        pipelineDb: result.harness.pipelineDb,
        runId: result.runId,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        inFlight: {
          node: result.node,
          taskId: result.taskId,
          attempt: 1,
          dispatchId: result.dispatchId,
          terminalHandle: result.workerHandle
        },
        taskStatus: result.harness.db.getTask(result.taskId)!.status
      })
      expect(pollOutcome).toMatchObject({ kind: 'fail-node' })
    },
    30_000
  )
})
