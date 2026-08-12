import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_WORKER_START_METHODS } from './orchestration-workers'
import { executeLocalWorkerStart } from './orchestration-worker-start-execution'

describe('orchestration worker-start execution seam', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  function mockWorkerStartRuntime(): void {
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker'
          ? 'tab_worker:leaf_worker'
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({ id: 'repo::worktree' } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    mockWorkerStartRuntime()
  })

  afterEach(() => db.close())

  function createRunAndTask(spec: string) {
    const run = db.createRun({
      objective: 'Test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    })
    const task = db.createTask({ spec, runId: run.id })
    return { run, task }
  }

  async function callWorkerStart(params: Record<string, unknown>) {
    const method = ORCHESTRATION_WORKER_START_METHODS[0]
    return method.handler(method.params!.parse(params), { runtime })
  }

  describe('extraction neutrality', () => {
    it.each([
      ['a freshly created agent terminal', { agent: 'codex' }],
      ['an explicitly reused terminal', { terminal: 'term_worker' }]
    ])('preserves the RPC path preamble taskSpec and coordinatorHandle via %s', async (_label, extra) => {
      const { task } = createRunAndTask('implement the seam extraction')

      const result = (await callWorkerStart({
        task: task.id,
        from: 'term_coord',
        ...extra
      })) as { state: string }

      expect(result.state).toBe('ready')
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        'term_worker',
        expect.stringContaining(task.spec)
      )
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        'term_worker',
        expect.stringContaining("Your coordinator's terminal handle is: term_coord")
      )
    })
  })

  describe('pane-less invocation', () => {
    it('succeeds with a synthetic driver identity and no bound pane', async () => {
      const { run, task } = createRunAndTask('driver dispatched task')

      const result = await executeLocalWorkerStart({
        runtime,
        db,
        runId: run.id,
        taskId: task.id,
        worktreeId: 'repo::worktree',
        from: `pipeline-driver:${run.id}`,
        launch: 'new-terminal',
        agent: 'codex'
      })

      expect(result.state).toBe('ready')
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        'term_worker',
        expect.stringContaining(`Your coordinator's terminal handle is: pipeline-driver:${run.id}`)
      )
    })
  })

  describe('dispatchPrompt override', () => {
    it('replaces task.spec in the preamble without mutating the task row', async () => {
      const { run, task } = createRunAndTask('original snapshot prompt')
      const assembledPrompt = 'assembled prompt including dependency results'

      const result = await executeLocalWorkerStart({
        runtime,
        db,
        runId: run.id,
        taskId: task.id,
        worktreeId: 'repo::worktree',
        from: `pipeline-driver:${run.id}`,
        dispatchPrompt: assembledPrompt,
        launch: 'new-terminal',
        agent: 'codex'
      })

      expect(result.state).toBe('ready')
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        'term_worker',
        expect.stringContaining(assembledPrompt)
      )
      expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
        'term_worker',
        expect.not.stringContaining('original snapshot prompt')
      )
      expect(db.getTask(task.id)?.spec).toBe('original snapshot prompt')
    })
  })
})
