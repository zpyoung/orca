import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'
import { Coordinator, type CoordinatorRuntime } from './coordinator'
import { resolveCoordinatorTaskRunId } from '../rpc/methods/orchestration-gates'

// Pins the L12a total invariant: a Coordinator bound to one orchestration run must never read or
// mutate another run's tasks, messages, dispatch contexts, decision gates, or lifecycle state —
// even though every one of those tables is shared across all runs in one database.

function createMockRuntime(
  terminals: { handle: string }[] = []
): CoordinatorRuntime & {
  sentMessages: { handle: string; text: string }[]
  createdTerminals: string[]
} {
  const mock = {
    sentMessages: [] as { handle: string; text: string }[],
    createdTerminals: [] as string[],
    terminals: terminals.map((t) => ({
      handle: t.handle,
      worktreeId: 'wt1',
      connected: true,
      writable: true
    })),
    async sendTerminalAgentPrompt(handle: string, prompt: string) {
      mock.sentMessages.push({ handle, text: prompt })
      return { handle, accepted: true, bytesWritten: 0 }
    },
    async listTerminals() {
      return { terminals: mock.terminals }
    },
    async createTerminal() {
      const handle = `term_new_${mock.createdTerminals.length}`
      mock.createdTerminals.push(handle)
      mock.terminals.push({ handle, worktreeId: 'wt1', connected: true, writable: true })
      return { handle, worktreeId: 'wt1' }
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'exit' }
    },
    async probeWorktreeDrift() {
      return null
    }
  }
  return mock
}

function insertWorkerDone(
  db: OrchestrationDb,
  params: {
    to: string
    runId: string
    taskId: string
    dispatchId: string
    from?: string
    outcome?: 'succeeded' | 'failed'
  }
): void {
  const dispatch = db.getDispatchContextById(params.dispatchId)
  const from = params.from ?? dispatch?.assignee_handle ?? 'term_unknown'
  db.insertMessage({
    from,
    to: params.to,
    subject: 'Done',
    type: 'worker_done',
    runId: params.runId,
    payload: JSON.stringify({
      taskId: params.taskId,
      dispatchId: params.dispatchId,
      outcome: params.outcome ?? 'succeeded'
    })
  })
}

// Completes a task the coordinator has already dispatched, as its own assignee would report.
function completeDispatchedTask(db: OrchestrationDb, taskId: string, to: string, runId: string): void {
  const dispatch = db.getDispatchContext(taskId)
  if (!dispatch) {
    throw new Error(`no dispatch for task ${taskId}`)
  }
  insertWorkerDone(db, { to, runId, taskId, dispatchId: dispatch.id })
}

function setDispatchedAt(db: OrchestrationDb, dispatchId: string, dispatchedAt: string): void {
  const sqlite = (db as unknown as { db: Database.Database }).db
  sqlite.prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?').run(dispatchedAt, dispatchId)
}

// Bypasses createGate's own run_id derivation to simulate a gate row with no enforced link between
// its run_id and its task_id's actual run — decision_gates has no FK for this (see db.ts).
function insertMisscopedGateRow(
  db: OrchestrationDb,
  params: { id: string; runId: string; taskId: string; question: string }
): void {
  const sqlite = (db as unknown as { db: Database.Database }).db
  sqlite
    .prepare('INSERT INTO decision_gates (id, run_id, task_id, question) VALUES (?, ?, ?, ?)')
    .run(params.id, params.runId, params.taskId, params.question)
}

async function tick(ms = 100): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('Coordinator run isolation (L12a)', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('dispatches only its own run tasks (a wrong-id-space filter would dispatch nothing)', async () => {
    db = new OrchestrationDb(':memory:')
    const runA = db.createRun({
      objective: 'A',
      coordinatorHandle: 'coord_a1',
      coordinatorPaneKey: 'tab_a1:11111111-1111-4111-8111-111111111111'
    })
    const runB = db.createRun({
      objective: 'B',
      coordinatorHandle: 'coord_b1',
      coordinatorPaneKey: 'tab_b1:22222222-2222-4222-8222-222222222222'
    })
    const taskA = db.createTask({ spec: 'work A', runId: runA.id })
    const taskB = db.createTask({ spec: 'work B', runId: runB.id })

    const runtime = createMockRuntime([{ handle: 'term_a1' }])
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord_a1',
      taskRunId: runA.id,
      pollIntervalMs: 30
    })
    const runPromise = coordinator.run()
    await tick()

    // Assert the positive: run A's own task was actually dispatched, not merely "run B's wasn't".
    const dispatchA = db.getDispatchContext(taskA.id)
    expect(dispatchA?.assignee_handle).toBe('term_a1')
    expect(db.getTask(taskB.id)?.status).toBe('ready')

    completeDispatchedTask(db, taskA.id, 'coord_a1', runA.id)
    const result = await runPromise
    expect(result.status).toBe('completed')
    expect(result.completedTasks).toEqual([taskA.id])
  })

  it('does not treat a handle busy only in another run as unavailable', async () => {
    db = new OrchestrationDb(':memory:')
    const runA = db.createRun({
      objective: 'A',
      coordinatorHandle: 'coord_a2',
      coordinatorPaneKey: 'tab_a2:11111111-1111-4111-8111-111111111112'
    })
    const runB = db.createRun({
      objective: 'B',
      coordinatorHandle: 'coord_b2',
      coordinatorPaneKey: 'tab_b2:22222222-2222-4222-8222-222222222223'
    })
    const taskB = db.createTask({ spec: 'b work', runId: runB.id })
    const dispatchB = db.createDispatchContext(taskB.id, 'term_shared')
    // Why: settles run B's dispatch context while leaving the task row's status stale, so the
    // handle only *looks* busy through the (now-unscoped-free) task-status scan, not the DB-level
    // dispatch lock — isolating exactly the read this test targets.
    db.completeDispatch(dispatchB.id)

    const taskA = db.createTask({ spec: 'a work', runId: runA.id })
    const runtime = createMockRuntime([{ handle: 'term_shared' }])
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord_a2',
      taskRunId: runA.id,
      pollIntervalMs: 30
    })
    const runPromise = coordinator.run()
    await tick()

    expect(runtime.createdTerminals).toHaveLength(0)
    expect(db.getDispatchContext(taskA.id)?.assignee_handle).toBe('term_shared')

    completeDispatchedTask(db, taskA.id, 'coord_a2', runA.id)
    const result = await runPromise
    expect(result.status).toBe('completed')
  })

  it('converges and reports success while another run has pending tasks', async () => {
    db = new OrchestrationDb(':memory:')
    const runA = db.createRun({
      objective: 'A',
      coordinatorHandle: 'coord_a3',
      coordinatorPaneKey: 'tab_a3:11111111-1111-4111-8111-111111111113'
    })
    const runB = db.createRun({
      objective: 'B',
      coordinatorHandle: 'coord_b3',
      coordinatorPaneKey: 'tab_b3:22222222-2222-4222-8222-222222222224'
    })
    const taskA = db.createTask({ spec: 'a work', runId: runA.id })
    // Run B's task is never touched by anything in this test — it must not stop run A converging.
    db.createTask({ spec: 'b work, never dispatched', runId: runB.id })

    const runtime = createMockRuntime([{ handle: 'term_a3' }])
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord_a3',
      taskRunId: runA.id,
      pollIntervalMs: 30
    })
    const runPromise = coordinator.run()
    await tick()
    completeDispatchedTask(db, taskA.id, 'coord_a3', runA.id)

    const result = await runPromise
    expect(result.status).toBe('completed')
    expect(result.failedTasks).toEqual([])
  })

  it('does not warn about a stale dispatch belonging to another run', async () => {
    db = new OrchestrationDb(':memory:')
    const runA = db.createRun({
      objective: 'A',
      coordinatorHandle: 'coord_a4',
      coordinatorPaneKey: 'tab_a4:11111111-1111-4111-8111-111111111114'
    })
    const runB = db.createRun({
      objective: 'B',
      coordinatorHandle: 'coord_b4',
      coordinatorPaneKey: 'tab_b4:22222222-2222-4222-8222-222222222225'
    })
    const taskB = db.createTask({ spec: 'b work', runId: runB.id })
    const dispatchB = db.createDispatchContext(taskB.id, 'term_b4')
    setDispatchedAt(db, dispatchB.id, new Date(Date.now() - 20 * 60 * 1000).toISOString())

    const taskA = db.createTask({ spec: 'a work', runId: runA.id })
    const runtime = createMockRuntime([{ handle: 'term_a4' }])
    const logs: string[] = []
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord_a4',
      taskRunId: runA.id,
      pollIntervalMs: 30,
      onLog: (msg) => logs.push(msg)
    })
    const runPromise = coordinator.run()
    await tick()
    completeDispatchedTask(db, taskA.id, 'coord_a4', runA.id)
    await runPromise

    expect(logs.some((line) => line.includes('has not sent a heartbeat'))).toBe(false)
  })

  it('does not process a message belonging to another run even if addressed to the same handle', async () => {
    db = new OrchestrationDb(':memory:')
    const runA = db.createRun({
      objective: 'A',
      coordinatorHandle: 'coord_shared5',
      coordinatorPaneKey: 'tab_a5:11111111-1111-4111-8111-111111111115'
    })
    const runB = db.createRun({
      objective: 'B',
      coordinatorHandle: 'coord_b5',
      coordinatorPaneKey: 'tab_b5:22222222-2222-4222-8222-222222222226'
    })
    const foreignMessage = db.insertMessage({
      from: 'term_x5',
      to: 'coord_shared5',
      subject: 'B only status',
      type: 'status',
      runId: runB.id
    })

    const taskA = db.createTask({ spec: 'a work', runId: runA.id })
    const runtime = createMockRuntime([{ handle: 'term_a5' }])
    const logs: string[] = []
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord_shared5',
      taskRunId: runA.id,
      pollIntervalMs: 30,
      onLog: (msg) => logs.push(msg)
    })
    const runPromise = coordinator.run()
    await tick()
    completeDispatchedTask(db, taskA.id, 'coord_shared5', runA.id)
    await runPromise

    expect(logs.some((line) => line.includes('B only status'))).toBe(false)
    const stillUnread = db.getUnreadMessages('coord_shared5', undefined, runB.id)
    expect(stillUnread.map((m) => m.id)).toContain(foreignMessage.id)
  })

  it('never re-blocks another run task that drifted out of its blocked state', async () => {
    db = new OrchestrationDb(':memory:')
    const runA = db.createRun({
      objective: 'A',
      coordinatorHandle: 'coord_a6',
      coordinatorPaneKey: 'tab_a6:11111111-1111-4111-8111-111111111116'
    })
    const runB = db.createRun({
      objective: 'B',
      coordinatorHandle: 'coord_b6',
      coordinatorPaneKey: 'tab_b6:22222222-2222-4222-8222-222222222227'
    })
    const taskB = db.createTask({ spec: 'b work', runId: runB.id })
    db.createGate({ taskId: taskB.id, question: 'Proceed?' })
    // Why: simulates the drift processDecisionGates exists to repair — but only within its own run.
    db.updateTaskStatus(taskB.id, 'ready')

    const taskA = db.createTask({ spec: 'a work', runId: runA.id })
    const runtime = createMockRuntime([{ handle: 'term_a6' }])
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord_a6',
      taskRunId: runA.id,
      pollIntervalMs: 30
    })
    const runPromise = coordinator.run()
    await tick()

    expect(db.getTask(taskB.id)?.status).toBe('ready')

    completeDispatchedTask(db, taskA.id, 'coord_a6', runA.id)
    await runPromise
  })

  it('rejects a worker_done that names another run task without mutating it', async () => {
    db = new OrchestrationDb(':memory:')
    const runA = db.createRun({
      objective: 'A',
      coordinatorHandle: 'coord_a7',
      coordinatorPaneKey: 'tab_a7:11111111-1111-4111-8111-111111111117'
    })
    const runB = db.createRun({
      objective: 'B',
      coordinatorHandle: 'coord_b7',
      coordinatorPaneKey: 'tab_b7:22222222-2222-4222-8222-222222222228'
    })
    const taskB = db.createTask({ spec: 'b work', runId: runB.id })
    const dispatchB = db.createDispatchContext(taskB.id, 'term_b7')

    // Why: addressed and run-scoped to A (so the coordinator's own message read picks it up) but
    // its payload names a run-B task, simulating a rogue or misrouted worker_done.
    const rogueMessage = db.insertMessage({
      from: 'term_b7',
      to: 'coord_a7',
      subject: 'Done',
      type: 'worker_done',
      runId: runA.id,
      payload: JSON.stringify({
        taskId: taskB.id,
        dispatchId: dispatchB.id,
        outcome: 'succeeded'
      })
    })

    const taskA = db.createTask({ spec: 'a work', runId: runA.id })
    const runtime = createMockRuntime([{ handle: 'term_a7' }])
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord_a7',
      taskRunId: runA.id,
      pollIntervalMs: 30
    })
    const runPromise = coordinator.run()
    await tick()
    completeDispatchedTask(db, taskA.id, 'coord_a7', runA.id)

    const result = await runPromise
    expect(result.completedTasks).toEqual([taskA.id])
    expect(db.getTask(taskB.id)?.status).toBe('dispatched')
    expect(db.getMessageById(rogueMessage.id)?.subject).toContain('Rejected worker_done')
  })

  it('never blocks another run task via a gate row whose run_id does not match its task (G2)', async () => {
    db = new OrchestrationDb(':memory:')
    const runA = db.createRun({
      objective: 'A',
      coordinatorHandle: 'coord_a8',
      coordinatorPaneKey: 'tab_a8:11111111-1111-4111-8111-111111111129'
    })
    const runB = db.createRun({
      objective: 'B',
      coordinatorHandle: 'coord_b8',
      coordinatorPaneKey: 'tab_b8:22222222-2222-4222-8222-222222222239'
    })
    const taskB = db.createTask({ spec: 'b work', runId: runB.id })
    insertMisscopedGateRow(db, {
      id: 'gate_misscoped_1',
      runId: runA.id,
      taskId: taskB.id,
      question: 'Proceed?'
    })

    const taskA = db.createTask({ spec: 'a work', runId: runA.id })
    const runtime = createMockRuntime([{ handle: 'term_a8' }])
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord_a8',
      taskRunId: runA.id,
      pollIntervalMs: 30
    })
    const runPromise = coordinator.run()
    await tick()

    expect(db.getTask(taskB.id)?.status).toBe('ready')

    completeDispatchedTask(db, taskA.id, 'coord_a8', runA.id)
    await runPromise
  })

  it('excludes a terminal holding a genuinely active dispatch in another run, without repeatedly retrying it (G5)', async () => {
    db = new OrchestrationDb(':memory:')
    const runA = db.createRun({
      objective: 'A',
      coordinatorHandle: 'coord_a9',
      coordinatorPaneKey: 'tab_a9:11111111-1111-4111-8111-111111111130'
    })
    const runB = db.createRun({
      objective: 'B',
      coordinatorHandle: 'coord_b9',
      coordinatorPaneKey: 'tab_b9:22222222-2222-4222-8222-222222222240'
    })
    const taskB = db.createTask({ spec: 'b work', runId: runB.id })
    db.createDispatchContext(taskB.id, 'term_shared')

    const taskA = db.createTask({ spec: 'a work', runId: runA.id })
    const runtime = createMockRuntime([{ handle: 'term_shared' }])
    const logs: string[] = []
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord_a9',
      taskRunId: runA.id,
      pollIntervalMs: 30,
      onLog: (msg) => logs.push(msg)
    })
    const runPromise = coordinator.run()
    await tick()
    await tick()

    const dispatchA = db.getDispatchContext(taskA.id)
    expect(dispatchA?.assignee_handle).not.toBe('term_shared')
    expect(logs.some((line) => line.includes('Failed to dispatch'))).toBe(false)

    completeDispatchedTask(db, taskA.id, 'coord_a9', runA.id)
    const result = await runPromise
    expect(result.status).toBe('completed')
  })
})

describe('resolveCoordinatorTaskRunId (L12a three-step resolution)', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('resolves via the coordinator pane bound run when one exists', () => {
    db = new OrchestrationDb(':memory:')
    const paneKey = 'tab_bound:11111111-1111-4111-8111-111111111118'
    const run = db.createRun({
      objective: 'bound',
      coordinatorHandle: 'coord_bound',
      coordinatorPaneKey: paneKey
    })
    expect(resolveCoordinatorTaskRunId(db, paneKey)).toBe(run.id)
  })

  it('resolves via the adopted run id on a migrated database, never the raw legacy id', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-coordinator-scope-'))
    const dbPath = join(tempDir, 'orchestration.db')

    const seed = new OrchestrationDb(dbPath)
    const legacyTask = seed.createTask({ spec: 'legacy work' })
    seed.close()

    db = new OrchestrationDb(dbPath)
    const adoption = db.getLegacyAdoption()
    expect(adoption).toBeDefined()
    const adoptedRunId = adoption!.adopted_run_id

    // The defect this resolution order exists to avoid: a raw-legacy-id filter finds zero tasks.
    expect(db.listTasks({ runId: LEGACY_RUN_ID })).toHaveLength(0)
    expect(db.listTasks({ runId: adoptedRunId }).map((t) => t.id)).toContain(legacyTask.id)

    expect(resolveCoordinatorTaskRunId(db, null)).toBe(adoptedRunId)
  })

  it('falls back to the raw legacy id only when no adoption row exists', () => {
    db = new OrchestrationDb(':memory:')
    expect(db.getLegacyAdoption()).toBeUndefined()
    expect(resolveCoordinatorTaskRunId(db, null)).toBe(LEGACY_RUN_ID)
  })
})
