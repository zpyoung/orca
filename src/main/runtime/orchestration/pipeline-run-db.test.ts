import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedPipelineDefinition, ResolvedPipelineNode } from '../../../shared/pipeline-template-types'
import { OrchestrationDb } from './db'
import { PipelineRunDb } from './pipeline-run-db'
import type { TaskRow } from './types'

const TASK_TABLE_COLUMNS = new Set([
  'id',
  'run_id',
  'parent_id',
  'created_by_terminal_handle',
  'created_by_pane_key',
  'created_by_process_incarnation',
  'created_by_run_generation',
  'task_title',
  'display_name',
  'spec',
  'status',
  'deps',
  'result',
  'created_at',
  'completed_at'
])

function makeNode(overrides: Partial<ResolvedPipelineNode> & { id: string }): ResolvedPipelineNode {
  return {
    title: overrides.id,
    prompt: `prompt for ${overrides.id}`,
    index: 0,
    needs: [],
    harness: 'claude',
    onFailure: { retries: 0 },
    ...overrides
  }
}

function makeDefinition(
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

describe('PipelineRunDb', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
  })

  function create(): { db: OrchestrationDb; pipelineDb: PipelineRunDb } {
    orchestrationDb = new OrchestrationDb(':memory:')
    return { db: orchestrationDb, pipelineDb: new PipelineRunDb(orchestrationDb) }
  }

  describe('instantiate', () => {
    it('commits one detached run, one opaque task per node, and the pipeline snapshot', () => {
      const { db, pipelineDb } = create()
      const repro = makeNode({ id: 'repro', index: 0 })
      const fix = makeNode({ id: 'fix', index: 1, needs: ['repro'] })
      const definition = makeDefinition([repro, fix])

      const result = pipelineDb.instantiate({
        definition,
        workspaceId: 'wt_1',
        workspaceDisplayName: 'my-repo',
        baseCommit: 'abc123'
      })

      expect(result.runNumber).toBe(1)
      expect(Object.keys(result.taskIdByNodeId).sort()).toEqual(['fix', 'repro'])

      const run = db.getRun(result.runId)
      expect(run).toBeDefined()
      expect(run?.legacy).toBe(0)
      expect(run?.coordinator_handle).toBeNull()
      expect(run?.coordinator_pane_key).toBeNull()

      const reproTask = db.getTask(result.taskIdByNodeId.repro) as TaskRow
      const fixTask = db.getTask(result.taskIdByNodeId.fix) as TaskRow
      expect(reproTask.spec).toBe(repro.prompt)
      expect(fixTask.spec).toBe(fix.prompt)
      expect(JSON.parse(fixTask.deps)).toEqual([result.taskIdByNodeId.repro])
      for (const task of [reproTask, fixTask]) {
        expect(task.created_by_terminal_handle).toBeNull()
        expect(task.created_by_pane_key).toBeNull()
        expect(task.created_by_process_incarnation).toBeNull()
        expect(task.created_by_run_generation).toBeNull()
      }

      const pipelineRun = pipelineDb.getPipelineRun(result.runId)
      expect(pipelineRun?.state).toBe('setup')
      expect(pipelineRun?.run_number).toBe(1)
      expect(pipelineRun?.template_name).toBe('bugfix-fast')
      expect(pipelineRun?.workspace_display_name).toBe('my-repo')
      expect(pipelineRun?.base_commit).toBe('abc123')
      expect(pipelineRun?.branch).toBeNull()
      expect(pipelineRun?.run_worktree_id).toBeNull()
      expect(JSON.parse(pipelineRun?.snapshot_json ?? '{}')).toEqual(definition)

      const nodes = pipelineDb.getNodes(result.runId)
      expect(nodes.map((n) => n.node_id)).toEqual(['repro', 'fix'])
      expect(nodes[1].task_id).toBe(result.taskIdByNodeId.fix)
    })

    it('never writes harness/model/effort/limits/onFailure to a task row, and leaves the tasks schema untouched', () => {
      const { db, pipelineDb } = create()
      const node = makeNode({
        id: 'repro',
        harness: 'claude',
        model: 'opus',
        effort: 'high',
        limits: { maxMinutes: 10 },
        onFailure: { retries: 3 }
      })
      const result = pipelineDb.instantiate({
        definition: makeDefinition([node]),
        workspaceId: null,
        workspaceDisplayName: 'folder-repo',
        baseCommit: null
      })

      const taskRow = db.getTask(result.taskIdByNodeId.repro) as unknown as Record<string, unknown>
      expect(new Set(Object.keys(taskRow))).toEqual(TASK_TABLE_COLUMNS)

      const columns = (
        db.getSyncDatabase().prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
      ).map((c) => c.name)
      expect(new Set(columns)).toEqual(TASK_TABLE_COLUMNS)
    })

    it('leaves zero rows anywhere when a fault occurs mid-transaction', () => {
      const { db, pipelineDb } = create()
      const before = {
        runs: db.listRuns().runs.length,
        tasks: db.listTasks().length,
        pipelineRuns: pipelineDb.listPipelineRuns().length
      }

      const duplicate = makeNode({ id: 'repro', index: 0 })
      const duplicateAgain = { ...makeNode({ id: 'repro', index: 1 }) }
      expect(() =>
        pipelineDb.instantiate({
          definition: makeDefinition([duplicate, duplicateAgain]),
          workspaceId: null,
          workspaceDisplayName: 'folder-repo',
          baseCommit: null
        })
      ).toThrow()

      expect(db.listRuns().runs.length).toBe(before.runs)
      expect(db.listTasks().length).toBe(before.tasks)
      expect(pipelineDb.listPipelineRuns().length).toBe(before.pipelineRuns)
      const nodeCount = db
        .getSyncDatabase()
        .prepare('SELECT COUNT(*) AS n FROM pipeline_nodes')
        .get() as { n: number }
      expect(nodeCount.n).toBe(0)
    })

    it('allocates distinct, monotonic run numbers per template name across successive starts', () => {
      const { pipelineDb } = create()
      const first = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })
      const second = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })
      const otherTemplate = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })], { templateName: 'other' }),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })

      expect(first.runNumber).toBe(1)
      expect(second.runNumber).toBe(2)
      expect(otherTemplate.runNumber).toBe(1)
      expect(first.runId).not.toBe(second.runId)
    })

    it('orders a dependency chain deep enough to overflow a recursive DFS, preserving deps as already-created task ids', () => {
      const { db, pipelineDb } = create()
      // Comfortably above the ~7000-node depth where the previous recursive
      // DFS overflowed the call stack in this test environment.
      const chainLength = 10000
      const nodes: ResolvedPipelineNode[] = []
      for (let i = 0; i < chainLength; i++) {
        nodes.push(
          makeNode({
            id: `n${i}`,
            index: i,
            needs: i < chainLength - 1 ? [`n${i + 1}`] : []
          })
        )
      }

      const result = pipelineDb.instantiate({
        definition: makeDefinition(nodes),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })

      expect(Object.keys(result.taskIdByNodeId)).toHaveLength(chainLength)
      const dbNodes = pipelineDb.getNodes(result.runId)
      expect(dbNodes).toHaveLength(chainLength)
      for (let i = 0; i < chainLength - 1; i++) {
        const task = db.getTask(result.taskIdByNodeId[`n${i}`]) as TaskRow
        expect(JSON.parse(task.deps)).toEqual([result.taskIdByNodeId[`n${i + 1}`]])
      }
    })
  })

  describe('createDetachedRun (OrchestrationDb seam)', () => {
    it('inserts a run with NULL pane/handle and legacy = 0, with no unbind side effect', () => {
      const { db } = create()
      const bound = db.createRun({
        objective: 'coordinator work',
        coordinatorHandle: 'term_a',
        coordinatorPaneKey: 'pane_a'
      })

      const detached = db.createDetachedRun({ objective: 'pipeline run' })
      expect(detached.coordinator_handle).toBeNull()
      expect(detached.coordinator_pane_key).toBeNull()
      expect(detached.legacy).toBe(0)

      const stillBound = db.getCurrentRunForPane('pane_a')
      expect(stillBound?.id).toBe(bound.id)
    })

    it('exposes the same connection PipelineRunDb writes to', () => {
      const { db } = create()
      const run = db.createDetachedRun({ objective: 'x' })
      const raw = db
        .getSyncDatabase()
        .prepare('SELECT id FROM runs WHERE id = ?')
        .get(run.id) as { id: string } | undefined
      expect(raw?.id).toBe(run.id)
    })
  })

  describe('markOrphanedRunsInterrupted', () => {
    it('marks setup/running/paused runs interrupted, leaves terminal runs untouched, and is idempotent', () => {
      const { pipelineDb } = create()
      const live = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })
      pipelineDb.updateRunState(live.runId, 'running')

      const done = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })], { templateName: 'other' }),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })
      pipelineDb.updateRunState(done.runId, 'completed')

      const affected = pipelineDb.markOrphanedRunsInterrupted()
      expect(affected).toEqual([live.runId])
      expect(pipelineDb.getPipelineRun(live.runId)?.state).toBe('interrupted')
      expect(pipelineDb.getPipelineRun(live.runId)?.failure_reason).toBeTruthy()
      expect(pipelineDb.getPipelineRun(live.runId)?.ended_at).toBeTruthy()
      expect(pipelineDb.getPipelineRun(done.runId)?.state).toBe('completed')

      expect(pipelineDb.markOrphanedRunsInterrupted()).toEqual([])
    })
  })

  describe('updateRunState', () => {
    it('is idempotent for same-state writes and absorbs terminal transitions', () => {
      const { pipelineDb } = create()
      const run = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })

      pipelineDb.updateRunState(run.runId, 'running')
      pipelineDb.updateRunState(run.runId, 'running')
      expect(pipelineDb.getPipelineRun(run.runId)?.state).toBe('running')

      pipelineDb.updateRunState(run.runId, 'failed', { failureReason: 'boom' })
      expect(pipelineDb.getPipelineRun(run.runId)?.state).toBe('failed')

      pipelineDb.updateRunState(run.runId, 'running')
      expect(pipelineDb.getPipelineRun(run.runId)?.state).toBe('failed')
      expect(pipelineDb.getPipelineRun(run.runId)?.failure_reason).toBe('boom')
    })

    it('a same-state write with no failureReason change touches no column, including updated_at', async () => {
      const { pipelineDb } = create()
      const run = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })
      pipelineDb.updateRunState(run.runId, 'running')
      const before = pipelineDb.getPipelineRun(run.runId)

      // updated_at is an ISO string (millisecond resolution); sleep past it so a
      // spurious rewrite would be observable.
      await new Promise((resolve) => setTimeout(resolve, 10))
      pipelineDb.updateRunState(run.runId, 'running')

      const after = pipelineDb.getPipelineRun(run.runId)
      expect(after?.updated_at).toBe(before?.updated_at)
      expect(after?.failure_reason).toBe(before?.failure_reason)
    })

    it('a failureReason that differs from the stored value is a material change even for a same-state write', async () => {
      const { pipelineDb } = create()
      const run = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })
      pipelineDb.updateRunState(run.runId, 'running')
      const before = pipelineDb.getPipelineRun(run.runId)

      await new Promise((resolve) => setTimeout(resolve, 10))
      pipelineDb.updateRunState(run.runId, 'running', { failureReason: 'transient hiccup' })

      const afterChange = pipelineDb.getPipelineRun(run.runId)
      expect(afterChange?.state).toBe('running')
      expect(afterChange?.failure_reason).toBe('transient hiccup')
      expect(afterChange?.updated_at).not.toBe(before?.updated_at)

      // Repeating the same reason is once again a true no-op.
      await new Promise((resolve) => setTimeout(resolve, 10))
      pipelineDb.updateRunState(run.runId, 'running', { failureReason: 'transient hiccup' })
      expect(pipelineDb.getPipelineRun(run.runId)?.updated_at).toBe(afterChange?.updated_at)
    })
  })

  describe('recordWorktreeSetup', () => {
    it('sets branch and run_worktree_id', () => {
      const { pipelineDb } = create()
      const run = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: 'wt_1',
        workspaceDisplayName: 'repo',
        baseCommit: 'abc'
      })
      pipelineDb.recordWorktreeSetup(run.runId, { branch: 'pipeline/bugfix-fast-1', runWorktreeId: 'wt_2' })
      const row = pipelineDb.getPipelineRun(run.runId)
      expect(row?.branch).toBe('pipeline/bugfix-fast-1')
      expect(row?.run_worktree_id).toBe('wt_2')
    })
  })

  describe('attempts', () => {
    it('begins and ends attempts, and endAttempt is a no-op once already ended', () => {
      const { pipelineDb } = create()
      const run = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })

      pipelineDb.beginAttempt(run.runId, 'a', {
        attempt: 1,
        dispatchId: 'dispatch_1',
        checkpoint: { head: 'h1', snapshot: 's1', ref: 'refs/orca/pipeline/x/a-1' }
      })
      pipelineDb.endAttempt(run.runId, 'a', 1, { outcome: 'failed', failureStage: 'task_failed' })

      let attempts = pipelineDb.getAttempts(run.runId, 'a')
      expect(attempts).toHaveLength(1)
      expect(attempts[0].outcome).toBe('failed')
      expect(attempts[0].ended_at).toBeTruthy()

      const endedAt = attempts[0].ended_at
      pipelineDb.endAttempt(run.runId, 'a', 1, { outcome: 'succeeded' })
      attempts = pipelineDb.getAttempts(run.runId, 'a')
      expect(attempts[0].outcome).toBe('failed')
      expect(attempts[0].ended_at).toBe(endedAt)

      pipelineDb.beginAttempt(run.runId, 'a', { attempt: 2 })
      expect(pipelineDb.getAttempts(run.runId, 'a').map((a) => a.attempt)).toEqual([1, 2])
      expect(pipelineDb.getAttempts(run.runId)).toHaveLength(2)
    })
  })

  describe('node outcome and prelaunch failures', () => {
    it('records terminal node outcomes and tracks consecutive prelaunch failures', () => {
      const { pipelineDb } = create()
      const run = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: null,
        workspaceDisplayName: 'repo',
        baseCommit: null
      })

      expect(pipelineDb.incrementPrelaunchFailures(run.runId, 'a')).toBe(1)
      expect(pipelineDb.incrementPrelaunchFailures(run.runId, 'a')).toBe(2)
      pipelineDb.resetPrelaunchFailures(run.runId, 'a')
      expect(pipelineDb.getNodes(run.runId)[0].prelaunch_failures).toBe(0)

      pipelineDb.setNodeOutcome(run.runId, 'a', { outcome: 'failed', reason: 'exhausted' })
      const node = pipelineDb.getNodes(run.runId)[0]
      expect(node.outcome).toBe('failed')
      expect(node.outcome_reason).toBe('exhausted')
    })
  })

  describe('listPipelineRuns', () => {
    it('filters by workspaceId', () => {
      const { pipelineDb } = create()
      const inWorkspace = pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })]),
        workspaceId: 'wt_1',
        workspaceDisplayName: 'repo-1',
        baseCommit: null
      })
      pipelineDb.instantiate({
        definition: makeDefinition([makeNode({ id: 'a' })], { templateName: 'other' }),
        workspaceId: 'wt_2',
        workspaceDisplayName: 'repo-2',
        baseCommit: null
      })

      const filtered = pipelineDb.listPipelineRuns({ workspaceId: 'wt_1' })
      expect(filtered.map((r) => r.run_id)).toEqual([inWorkspace.runId])
      expect(pipelineDb.listPipelineRuns()).toHaveLength(2)
    })
  })
})
