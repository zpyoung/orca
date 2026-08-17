import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ResolvedPipelineDefinition,
  ResolvedPipelineNode
} from '../../../shared/pipeline-template-types'
import type { Repo } from '../../../shared/types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { PipelineRunDb } from '../orchestration/pipeline-run-db'

const isCommandOnPathMock = vi.fn()
const getSshGitProviderMock = vi.fn()
const getActiveMultiplexerMock = vi.fn()
const driverStartMock = vi.fn()
const driverPauseMock = vi.fn()
const driverResumeMock = vi.fn()
const driverAbortMock = vi.fn().mockResolvedValue(undefined)
const driverCtorMock = vi.fn()

vi.mock('../../ipc/preflight-command-exec', () => ({
  isCommandOnPath: isCommandOnPathMock,
  execCommandInWsl: vi.fn()
}))
vi.mock('../../ipc/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: vi.fn().mockReturnValue(new Set())
}))
vi.mock('../../ipc/preflight-wsl-agent-detection', () => ({
  detectWslCommandsOnPath: vi.fn().mockResolvedValue(new Set())
}))
vi.mock('../../ipc/ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock,
  getRegisteredSshState: vi.fn()
}))
vi.mock('../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
}))
// The lifecycle test suite is concerned with registry/RPC wiring, not dispatch mechanics (already
// covered by pipeline-driver.test.ts), so the driver itself is a spy double.
vi.mock('./pipeline-driver', () => ({
  PipelineDriver: class {
    start = driverStartMock
    pause = driverPauseMock
    resume = driverResumeMock
    abort = driverAbortMock
    constructor(args: unknown) {
      driverCtorMock(args)
    }
  }
}))

const {
  startPipelineRun,
  pausePipelineRun,
  resumePipelineRun,
  abortPipelineRun,
  subscribeToPipelineRun,
  listPipelineRuns
} = await import('./pipeline-run-lifecycle')
const { getPipelineSnapshotPublisher } = await import('./pipeline-run-lifecycle-registry')

function node(overrides: Partial<ResolvedPipelineNode> & { id: string }): ResolvedPipelineNode {
  return {
    title: overrides.id,
    prompt: `prompt for ${overrides.id}`,
    index: 0,
    needs: [],
    harness: 'claude',
    ...overrides
  }
}

function definition(
  nodes: ResolvedPipelineNode[],
  overrides?: Partial<ResolvedPipelineDefinition>
): ResolvedPipelineDefinition {
  return {
    templateName: 'bugfix-fast',
    templateVersion: 1,
    needsNewerOrca: false,
    inputText: 'fix the flaky test',
    nodes,
    ...overrides
  }
}

function originWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt_origin',
    repoId: 'repo_1',
    displayName: 'my-repo',
    head: 'abc123head',
    branch: 'main',
    path: '/repo',
    isBare: false,
    isMainWorktree: true,
    ...overrides
  }
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo_1',
    path: '/repo',
    displayName: 'my-repo',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'folder',
    ...overrides
  } as Repo
}

function runtimeStub(overrides: Partial<OrcaRuntimeService> = {}) {
  return {
    showManagedWorktree: vi.fn().mockResolvedValue(originWorktree()),
    showRepo: vi.fn().mockResolvedValue(repo()),
    resolveProjectRuntimeForWorktree: vi.fn().mockReturnValue(undefined),
    validateOrchestrationAgentLauncher: vi.fn(),
    getClientSettings: vi.fn().mockReturnValue({ agentCmdOverrides: {} }),
    searchRepoRefs: vi.fn().mockResolvedValue({ refs: [], truncated: false }),
    createManagedWorktree: vi.fn().mockImplementation(async (createArgs) => ({
      worktree: { id: 'wt_run', branch: createArgs.branchNameOverride, repoId: 'repo_1' }
    })),
    removeManagedWorktree: vi.fn().mockResolvedValue({}),
    listManagedWorktrees: vi
      .fn()
      .mockResolvedValue({ worktrees: [], totalCount: 0, truncated: false }),
    ...overrides
    // no pane/consumer methods (getTerminalPaneKey, getCurrentRunForPane) are stubbed — if the
    // pipeline path ever called them, the test would fail loudly instead of passing by accident
  } as unknown as OrcaRuntimeService
}

describe('pipeline-run-lifecycle', () => {
  let orchestrationDb: OrchestrationDb | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    isCommandOnPathMock.mockReset().mockResolvedValue(true)
    getSshGitProviderMock.mockReset()
    getActiveMultiplexerMock.mockReset().mockReturnValue({
      isDisposed: () => false,
      request: vi.fn().mockResolvedValue({ agents: ['claude'] })
    })
    driverStartMock.mockReset()
    driverPauseMock.mockReset()
    driverResumeMock.mockReset()
    driverAbortMock.mockReset().mockResolvedValue(undefined)
    driverCtorMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    orchestrationDb?.close()
    orchestrationDb = undefined
  })

  function create(): OrchestrationDb {
    orchestrationDb = new OrchestrationDb(':memory:')
    return orchestrationDb
  }

  // Touches the db once so the once-per-db startup sweep runs with nothing to sweep, isolating
  // later assertions from that sweep (its own behavior is covered separately below).
  function primeSweep(db: OrchestrationDb): void {
    listPipelineRuns(db)
  }

  describe('startPipelineRun', () => {
    it('succeeds from a freshly created workspace with no bound pane and no orchestration state', async () => {
      const db = create()
      const runtime = runtimeStub()

      const result = await startPipelineRun({
        runtime,
        db,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      if ('refused' in result) {
        throw new Error(`expected success, got refusal: ${result.refused.message}`)
      }
      expect(result.runNumber).toBe(1)
    })

    it('registers and starts a driver on success', async () => {
      const db = create()
      const runtime = runtimeStub()

      const result = await startPipelineRun({
        runtime,
        db,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      if ('refused' in result) {
        throw new Error('expected success')
      }
      expect(driverCtorMock).toHaveBeenCalledWith(expect.objectContaining({ runId: result.runId }))
      expect(driverStartMock).toHaveBeenCalledTimes(1)
    })

    it('relays a preflight refusal naming the node and field, creating nothing and starting no driver', async () => {
      const db = create()
      const pipelineDb = new PipelineRunDb(db)
      const runtime = runtimeStub()

      const result = await startPipelineRun({
        runtime,
        db,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro', harness: 'not-a-real-agent' })])
      })

      expect(result).toEqual({
        refused: {
          nodeId: 'repro',
          field: 'harness',
          message: expect.stringContaining('not-a-real-agent')
        }
      })
      expect(pipelineDb.listPipelineRuns()).toHaveLength(0)
      expect(driverCtorMock).not.toHaveBeenCalled()
      expect(driverStartMock).not.toHaveBeenCalled()
    })

    it('post-commit worktree setup failure: fails the run terminally with its allocated run number, dispatches nothing, starts no driver, and the next start takes the next number', async () => {
      const db = create()
      const pipelineDb = new PipelineRunDb(db)
      const runtime = runtimeStub({
        showRepo: vi.fn().mockResolvedValue(repo({ kind: 'git' })),
        createManagedWorktree: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left'))
      })

      const failedResult = await startPipelineRun({
        runtime,
        db,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      expect(failedResult).toEqual({ refused: { message: expect.stringContaining('ENOSPC') } })
      const runs = pipelineDb.listPipelineRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0].run_number).toBe(1)
      expect(runs[0].state).toBe('failed')
      expect(runs[0].failure_reason).toContain('ENOSPC')
      const tasks = db.listTasks({ runId: runs[0].run_id })
      expect(tasks).toHaveLength(1)
      const dispatchCount = db
        .getSyncDatabase()
        .prepare('SELECT COUNT(*) AS n FROM dispatch_contexts WHERE task_id = ?')
        .get(tasks[0].id) as { n: number }
      expect(dispatchCount.n).toBe(0)
      expect(driverCtorMock).not.toHaveBeenCalled()

      const nextRuntime = runtimeStub({
        showRepo: vi.fn().mockResolvedValue(repo({ kind: 'git' }))
      })
      const nextResult = await startPipelineRun({
        runtime: nextRuntime,
        db,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })
      if ('refused' in nextResult) {
        throw new Error('expected the next start to succeed')
      }
      expect(nextResult.runNumber).toBe(2)
    })

    it('starts two runs concurrently, both succeeding with distinct run numbers', async () => {
      const db = create()

      const [first, second] = await Promise.all([
        startPipelineRun({
          runtime: runtimeStub(),
          db,
          worktreeSelector: 'id:wt_origin',
          definition: definition([node({ id: 'repro' })])
        }),
        startPipelineRun({
          runtime: runtimeStub(),
          db,
          worktreeSelector: 'id:wt_origin',
          definition: definition([node({ id: 'repro' })])
        })
      ])

      if ('refused' in first || 'refused' in second) {
        throw new Error('expected both starts to succeed')
      }
      expect(first.runId).not.toBe(second.runId)
      expect(new Set([first.runNumber, second.runNumber])).toEqual(new Set([1, 2]))
      expect(driverStartMock).toHaveBeenCalledTimes(2)
    })

    it('starts two runs concurrently in git workspaces with distinct branch names, not just distinct run numbers', async () => {
      const db = create()
      const gitRuntime = () =>
        runtimeStub({ showRepo: vi.fn().mockResolvedValue(repo({ kind: 'git' })) })

      const [first, second] = await Promise.all([
        startPipelineRun({
          runtime: gitRuntime(),
          db,
          worktreeSelector: 'id:wt_origin',
          definition: definition([node({ id: 'repro' })])
        }),
        startPipelineRun({
          runtime: gitRuntime(),
          db,
          worktreeSelector: 'id:wt_origin',
          definition: definition([node({ id: 'repro' })])
        })
      ])

      if ('refused' in first || 'refused' in second) {
        throw new Error('expected both starts to succeed')
      }
      expect(first.branch).toBeDefined()
      expect(first.branch).not.toBe(second.branch)
    })

    it('coexists with an active coordinator run: starting a pipeline never raises "Coordinator already running"', async () => {
      const db = create()
      db.createCoordinatorRun({ spec: 'do the thing', coordinatorHandle: 'coordinator' })
      expect(db.getActiveCoordinatorRun()).toBeDefined()

      const result = await startPipelineRun({
        runtime: runtimeStub(),
        db,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      if ('refused' in result) {
        throw new Error(`expected success, got refusal: ${result.refused.message}`)
      }
      expect(db.getActiveCoordinatorRun()).toBeDefined()
    })
  })

  describe('pause/resume/abort idempotency', () => {
    async function startedRun(db: OrchestrationDb) {
      const result = await startPipelineRun({
        runtime: runtimeStub(),
        db,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })
      if ('refused' in result) {
        throw new Error('expected success')
      }
      return result.runId
    }

    it('pause is idempotent: repeated calls never error and only ever reach the driver', async () => {
      const db = create()
      const runId = await startedRun(db)

      const first = pausePipelineRun(runId, db)
      const second = pausePipelineRun(runId, db)

      expect(first).toEqual({ state: expect.any(String) })
      expect(second).toEqual({ state: expect.any(String) })
      expect(driverPauseMock).toHaveBeenCalledTimes(2)
    })

    it('resume is idempotent', async () => {
      const db = create()
      const runId = await startedRun(db)

      resumePipelineRun(runId, db)
      resumePipelineRun(runId, db)

      expect(driverResumeMock).toHaveBeenCalledTimes(2)
    })

    it('abort is idempotent and awaits the driver', async () => {
      const db = create()
      const runId = await startedRun(db)

      await abortPipelineRun(runId, db)
      await abortPipelineRun(runId, db)

      expect(driverAbortMock).toHaveBeenCalledTimes(2)
    })

    it('pause/resume/abort on an unknown run id throw rather than silently succeeding', () => {
      const db = create()
      expect(() => pausePipelineRun('nope', db)).toThrow(/not found/i)
    })

    it('removes the driver at the terminal transition without breaking the final snapshot delivered to an attached subscriber', async () => {
      const db = create()
      const runId = await startedRun(db)
      const pipelineDb = new PipelineRunDb(db)

      const emit = vi.fn()
      subscribeToPipelineRun(db, runId, emit)
      emit.mockClear() // drop the synchronous on-attach snapshot

      pipelineDb.updateRunState(runId, 'completed')
      getPipelineSnapshotPublisher(db).publish(runId)

      expect(emit).toHaveBeenCalledTimes(1)
      expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'completed' }))

      driverPauseMock.mockClear()
      pausePipelineRun(runId, db)
      expect(driverPauseMock).not.toHaveBeenCalled()
    })

    it('pause/resume/abort on a run with no live driver in this process reads back its DB state without throwing', async () => {
      const db = create()
      primeSweep(db)
      const pipelineDb = new PipelineRunDb(db)
      const { runId } = pipelineDb.instantiate({
        definition: definition([node({ id: 'repro' })]),
        workspaceId: 'wt_origin',
        workspaceDisplayName: 'my-repo',
        baseCommit: null
      })
      pipelineDb.updateRunState(runId, 'running')

      const result = pausePipelineRun(runId, db)

      expect(result.state).toBe('running')
      expect(driverPauseMock).not.toHaveBeenCalled()
    })
  })

  describe('subscribeToPipelineRun', () => {
    it('delivers the on-attach snapshot synchronously, including for a run already in a terminal state', () => {
      const db = create()
      const pipelineDb = new PipelineRunDb(db)
      const { runId } = pipelineDb.instantiate({
        definition: definition([node({ id: 'repro' })]),
        workspaceId: 'wt_origin',
        workspaceDisplayName: 'my-repo',
        baseCommit: null
      })
      pipelineDb.updateRunState(runId, 'running')
      pipelineDb.updateRunState(runId, 'completed')

      const emit = vi.fn()
      const unsubscribe = subscribeToPipelineRun(db, runId, emit)

      expect(emit).toHaveBeenCalledTimes(1)
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ runId, state: 'completed' }))
      unsubscribe()
    })

    it('throws a not-found error for an unknown run id before attaching', () => {
      const db = create()
      expect(() => subscribeToPipelineRun(db, 'nope', vi.fn())).toThrow(/not found/i)
    })

    it('heartbeats at least every 5s while the run is live, then stops after the final terminal snapshot', () => {
      const db = create()
      primeSweep(db)
      const pipelineDb = new PipelineRunDb(db)
      const { runId } = pipelineDb.instantiate({
        definition: definition([node({ id: 'repro' })]),
        workspaceId: 'wt_origin',
        workspaceDisplayName: 'my-repo',
        baseCommit: null
      })
      pipelineDb.updateRunState(runId, 'running')

      const emit = vi.fn()
      subscribeToPipelineRun(db, runId, emit)
      expect(emit).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(5_000)
      expect(emit).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(5_000)
      expect(emit).toHaveBeenCalledTimes(3)

      pipelineDb.updateRunState(runId, 'completed')
      getPipelineSnapshotPublisher(db).publish(runId)
      expect(emit).toHaveBeenCalledTimes(4)
      expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'completed' }))

      // terminal: no further heartbeat, ever
      vi.advanceTimersByTime(30_000)
      expect(emit).toHaveBeenCalledTimes(4)
    })

    it('marks an orphaned running/paused run interrupted before its subscription is served (startup sweep)', () => {
      const db = create()
      const pipelineDb = new PipelineRunDb(db)
      const { runId } = pipelineDb.instantiate({
        definition: definition([node({ id: 'repro' })]),
        workspaceId: 'wt_origin',
        workspaceDisplayName: 'my-repo',
        baseCommit: null
      })
      // Simulates a run left `running` by a process that died — no driver was ever started for
      // it in this process, so nothing but the sweep can account for its liveness.
      pipelineDb.updateRunState(runId, 'running')

      const emit = vi.fn()
      subscribeToPipelineRun(db, runId, emit)

      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ state: 'interrupted' }))
    })
  })
})
