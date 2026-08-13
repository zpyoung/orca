import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedPipelineDefinition, ResolvedPipelineNode } from '../../../shared/pipeline-template-types'
import type { Repo } from '../../../shared/types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { PipelineRunDb } from '../orchestration/pipeline-run-db'

const isCommandOnPathMock = vi.fn()
const getSshGitProviderMock = vi.fn()
const getActiveMultiplexerMock = vi.fn()

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
  getActiveMultiplexer: getActiveMultiplexerMock
}))
vi.mock('../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
}))

const { instantiatePipelineRun } = await import('./pipeline-instantiation')

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
    kind: 'git',
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
    createManagedWorktree: vi.fn().mockResolvedValue({
      worktree: { id: 'wt_run', branch: 'pipeline/bugfix-fast-1', repoId: 'repo_1' }
    }),
    removeManagedWorktree: vi.fn().mockResolvedValue({}),
    ...overrides
  } as unknown as OrcaRuntimeService
}

describe('instantiatePipelineRun', () => {
  let orchestrationDb: OrchestrationDb | undefined

  beforeEach(() => {
    isCommandOnPathMock.mockReset().mockResolvedValue(true)
    getSshGitProviderMock.mockReset()
    getActiveMultiplexerMock.mockReset().mockReturnValue({
      isDisposed: () => false,
      request: vi.fn().mockResolvedValue({ agents: ['claude'] })
    })
  })

  afterEach(() => {
    orchestrationDb?.close()
  })

  function create(): { db: OrchestrationDb; pipelineDb: PipelineRunDb } {
    orchestrationDb = new OrchestrationDb(':memory:')
    return { db: orchestrationDb, pipelineDb: new PipelineRunDb(orchestrationDb) }
  }

  // A fresh OrchestrationDb seeds one legacy run row, so "nothing persisted" is measured as a
  // before/after diff rather than an absolute zero (mirrors PipelineRunDb's own fault test).
  function snapshotCounts(db: OrchestrationDb, pipelineDb: PipelineRunDb) {
    return {
      runs: db.listRuns().runs.length,
      tasks: db.listTasks().length,
      pipelineRuns: pipelineDb.listPipelineRuns().length
    }
  }

  function expectNoNewRows(
    db: OrchestrationDb,
    pipelineDb: PipelineRunDb,
    before: ReturnType<typeof snapshotCounts>
  ): void {
    expect(snapshotCounts(db, pipelineDb)).toEqual(before)
  }

  describe('preflight refusals create nothing', () => {
    it('refuses an unknown harness, naming the node and field, with no run, no tasks, no worktree', async () => {
      const { db, pipelineDb } = create()
      const before = snapshotCounts(db, pipelineDb)
      const runtime = runtimeStub()

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
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
      expectNoNewRows(db, pipelineDb, before)
      expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    })

    it('refuses a disabled agent, naming the node and field, with no run, no tasks, no worktree', async () => {
      const { db, pipelineDb } = create()
      const before = snapshotCounts(db, pipelineDb)
      const runtime = runtimeStub({
        validateOrchestrationAgentLauncher: vi.fn(() => {
          throw new Error('Agent launcher claude is disabled or unavailable.')
        })
      })

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      expect(result).toEqual({
        refused: { nodeId: 'repro', field: 'harness', message: expect.stringContaining('disabled') }
      })
      expectNoNewRows(db, pipelineDb, before)
      expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    })

    it('refuses a catalog-rejected model, naming the node and field "model", with no run, no tasks, no worktree', async () => {
      const { db, pipelineDb } = create()
      const before = snapshotCounts(db, pipelineDb)
      const runtime = runtimeStub()

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([
          node({ id: 'repro', harness: 'grok', model: 'grok-code-fast-1' })
        ])
      })

      expect(result).toEqual({
        refused: {
          nodeId: 'repro',
          field: 'model',
          message: expect.stringContaining('does not support launch-time model selection')
        }
      })
      expectNoNewRows(db, pipelineDb, before)
      expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    })

    it('checks nodes in list order and stops at the first failing node', async () => {
      const { db, pipelineDb } = create()
      const before = snapshotCounts(db, pipelineDb)
      const runtime = runtimeStub()

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([
          node({ id: 'first', harness: 'not-a-real-agent' }),
          node({ id: 'second', harness: 'also-not-real' })
        ])
      })

      expect(result).toEqual({ refused: expect.objectContaining({ nodeId: 'first' }) })
      expectNoNewRows(db, pipelineDb, before)
    })
  })

  describe('SSH relay checkpoint gate', () => {
    function sshRepo(): Repo {
      return repo({ connectionId: 'ssh-1' })
    }

    it('refuses an SSH-hosted git workspace whose relay lacks checkpoint support, creating nothing', async () => {
      const { db, pipelineDb } = create()
      const before = snapshotCounts(db, pipelineDb)
      getSshGitProviderMock.mockReturnValue({
        pipelineCheckpointSupported: vi.fn().mockResolvedValue(false)
      })
      const runtime = runtimeStub({ showRepo: vi.fn().mockResolvedValue(sshRepo()) })

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      expect(result).toEqual({
        refused: { message: expect.stringMatching(/update the remote orca/i) }
      })
      expectNoNewRows(db, pipelineDb, before)
      expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    })

    it('passes an SSH-hosted git workspace whose relay supports checkpoints', async () => {
      const { db, pipelineDb } = create()
      getSshGitProviderMock.mockReturnValue({
        pipelineCheckpointSupported: vi.fn().mockResolvedValue(true)
      })
      const runtime = runtimeStub({ showRepo: vi.fn().mockResolvedValue(sshRepo()) })

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      expect('refused' in result).toBe(false)
    })

    it('skips the relay gate entirely for a folder workspace even when the repo has a connectionId', async () => {
      const { db, pipelineDb } = create()
      const runtime = runtimeStub({
        showRepo: vi.fn().mockResolvedValue(repo({ kind: 'folder', connectionId: 'ssh-1' }))
      })

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      expect(getSshGitProviderMock).not.toHaveBeenCalled()
      expect('refused' in result).toBe(false)
    })
  })

  describe('folder workspaces (L10/E1)', () => {
    it('creates no branch and no worktree, with a null base commit, and reports success', async () => {
      const { db, pipelineDb } = create()
      const runtime = runtimeStub({
        showRepo: vi.fn().mockResolvedValue(repo({ kind: 'folder' }))
      })

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
      expect(result).toEqual({
        runId: expect.any(String),
        runNumber: 1
      })
      if ('refused' in result) {
        throw new Error('expected success')
      }
      expect(result.branch).toBeUndefined()
      expect(result.runWorktreeId).toBeUndefined()

      const run = pipelineDb.getPipelineRun(result.runId)
      expect(run?.base_commit).toBeNull()
      expect(run?.branch).toBeNull()
      expect(run?.run_worktree_id).toBeNull()
      expect(run?.state).toBe('running')
    })
  })

  describe('happy path (git workspace)', () => {
    it('commits the transaction, creates the worktree/branch, and transitions to running', async () => {
      const { db, pipelineDb } = create()
      const runtime = runtimeStub()

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      if ('refused' in result) {
        throw new Error(`expected success, got refusal: ${result.refused.message}`)
      }
      expect(result.runNumber).toBe(1)
      expect(result.branch).toBe('pipeline/bugfix-fast-1')
      expect(result.runWorktreeId).toBe('wt_run')

      expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          repoSelector: 'repo_1',
          baseBranch: 'abc123head',
          branchNameOverride: 'pipeline/bugfix-fast-1'
        })
      )

      const run = pipelineDb.getPipelineRun(result.runId)
      expect(run?.base_commit).toBe('abc123head')
      expect(run?.branch).toBe('pipeline/bugfix-fast-1')
      expect(run?.run_worktree_id).toBe('wt_run')
      expect(run?.state).toBe('running')
    })
  })

  describe('post-commit worktree failure compensation (L4b, E13, AC27)', () => {
    it('fails the run terminally with its allocated run number, dispatches nothing, and lets the next Start take the next run number', async () => {
      const { db, pipelineDb } = create()
      const runtime = runtimeStub({
        createManagedWorktree: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device'))
      })

      const failedResult = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      expect(failedResult).toEqual({
        refused: { message: expect.stringContaining('ENOSPC') }
      })

      const runs = pipelineDb.listPipelineRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0].run_number).toBe(1)
      expect(runs[0].state).toBe('failed')
      expect(runs[0].failure_reason).toContain('ENOSPC')

      const tasks = db.listTasks({ runId: runs[0].run_id })
      expect(tasks).toHaveLength(1)
      expect(tasks[0].status).toBe('ready')
      const dispatchCount = db
        .getSyncDatabase()
        .prepare('SELECT COUNT(*) AS n FROM dispatch_contexts WHERE task_id = ?')
        .get(tasks[0].id) as { n: number }
      expect(dispatchCount.n).toBe(0)

      const nextRuntime = runtimeStub()
      const nextResult = await instantiatePipelineRun({
        runtime: nextRuntime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })
      if ('refused' in nextResult) {
        throw new Error('expected the next start to succeed')
      }
      expect(nextResult.runNumber).toBe(2)
    })

    it('removes the worktree best-effort when it was created but recording setup then fails', async () => {
      const { db, pipelineDb } = create()
      const runtime = runtimeStub()
      vi.spyOn(pipelineDb, 'recordWorktreeSetup').mockImplementation(() => {
        throw new Error('disk full while updating pipeline_runs')
      })

      const result = await instantiatePipelineRun({
        runtime,
        db,
        pipelineDb,
        worktreeSelector: 'id:wt_origin',
        definition: definition([node({ id: 'repro' })])
      })

      expect(result).toEqual({
        refused: { message: expect.stringContaining('disk full') }
      })
      expect(runtime.removeManagedWorktree).toHaveBeenCalledWith('wt_run', true)
    })
  })
})
