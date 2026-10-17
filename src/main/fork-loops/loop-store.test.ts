import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoopConfig } from '../../shared/fork-loops/loop-types'
import { LoopDatabase, LoopStoreError, type LoopInsert } from './loop-database'
import { LoopStore } from './loop-store'

const CONFIG: LoopConfig = {
  promptSource: { kind: 'repeat', body: 'keep going' },
  pacing: { kind: 'interval', minutes: 15, anchor: 'wall-clock' },
  sessionPolicy: 'continue',
  done: { check: { command: 'pnpm test', timeoutSeconds: 120, runWhen: 'every-iteration' } },
  caps: { maxIterations: 10, maxCostUsd: 2.5 },
  noProgress: true,
  protectedPaths: ['src/**'],
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: true
}

function loopInput(id: string, overrides: Partial<LoopInsert> = {}): LoopInsert {
  return {
    id,
    worktreeId: 'wt-1',
    workspaceKind: 'git',
    executionHostId: 'local',
    name: `Loop ${id}`,
    slug: `loop-${id}`,
    agent: 'claude',
    preset: 'interval',
    config: CONFIG,
    state: 'running',
    ...overrides
  }
}

let database: LoopDatabase
let clock: number
let store: LoopStore

beforeEach(() => {
  database = new LoopDatabase(':memory:')
  clock = 1_000
  store = new LoopStore(database, () => clock)
})

afterEach(() => {
  database.close()
})

function addIterations(loopId: string, count: number): void {
  for (let n = 1; n <= count; n += 1) {
    store.insertIteration(loopId, { n, attempt: 0, promptSent: `p${n}`, startedAt: n })
  }
}

describe('LoopStore construction', () => {
  it('does not open the database until first use', () => {
    const lazy = new LoopDatabase(':memory:')
    const spy = vi.spyOn(lazy, 'connection')
    const lazyStore = new LoopStore(lazy)
    expect(spy).not.toHaveBeenCalled()
    lazyStore.listLoops()
    expect(spy).toHaveBeenCalled()
    lazy.close()
  })
})

describe('loops', () => {
  it('round-trips a loop and its config', () => {
    const inserted = store.insertLoop(
      loopInput('a', { launchOverrides: { model: 'opus', optionValues: { fast: true } } })
    )
    expect(inserted.createdAt).toBe(1_000)
    expect(inserted.updatedAt).toBe(1_000)
    expect(inserted.endedAt).toBeNull()
    expect(inserted.detached).toBe(false)
    expect(inserted.iterationsCompleted).toBe(0)

    const fetched = store.getLoop('a')
    expect(fetched).toEqual(inserted)
    expect(fetched?.config).toEqual(CONFIG)
    expect(fetched?.launchOverrides).toEqual({ model: 'opus', optionValues: { fast: true } })
  })

  it('returns null for an unknown loop', () => {
    expect(store.getLoop('missing')).toBeNull()
  })

  it('updates fields, bumps updatedAt, and clears nullable columns', () => {
    store.insertLoop(loopInput('a', { tabId: 'tab', paneKey: 'pane', ptyId: 'pty' }))
    clock = 2_000
    const updated = store.updateLoop('a', {
      state: 'paused',
      pauseReason: 'user',
      pauseDetail: 'stopped by hand',
      iterationsCompleted: 3,
      activeMs: 500,
      costUsd: 0.4,
      detached: true,
      ptyId: null,
      nextIterationAt: 9_000,
      config: { ...CONFIG, askBeforeNext: true }
    })
    expect(updated).toMatchObject({
      state: 'paused',
      pauseReason: 'user',
      pauseDetail: 'stopped by hand',
      iterationsCompleted: 3,
      activeMs: 500,
      costUsd: 0.4,
      detached: true,
      ptyId: null,
      tabId: 'tab',
      nextIterationAt: 9_000,
      updatedAt: 2_000,
      createdAt: 1_000,
      endedAt: null
    })
    expect(updated.config.askBeforeNext).toBe(true)
    expect(store.getLoop('a')).toEqual(updated)
  })

  it('stamps endedAt the first time a loop reaches a terminal state', () => {
    store.insertLoop(loopInput('a'))
    clock = 3_000
    expect(store.updateLoop('a', { state: 'completed' }).endedAt).toBe(3_000)
    clock = 4_000
    expect(store.updateLoop('a', { iterationsCompleted: 1 }).endedAt).toBe(3_000)
  })

  it('throws loop_not_found when updating an unknown loop', () => {
    expect(() => store.updateLoop('missing', { state: 'paused' })).toThrow(
      expect.objectContaining({ code: 'loop_not_found' })
    )
  })

  it('lists loops newest-updated first and filters by worktree', () => {
    store.insertLoop(loopInput('a'))
    clock = 2_000
    store.insertLoop(loopInput('b', { worktreeId: 'wt-2' }))
    clock = 3_000
    store.insertLoop(loopInput('c'))
    expect(store.listLoops().map((loop) => loop.id)).toEqual(['c', 'b', 'a'])
    expect(store.listLoops({ worktreeId: 'wt-1' }).map((loop) => loop.id)).toEqual(['c', 'a'])
    expect(store.listLoops({ worktreeId: 'none' })).toEqual([])
  })
})

describe('iterations', () => {
  beforeEach(() => {
    store.insertLoop(loopInput('a'))
  })

  it('upserts by (loop_id, n, attempt)', () => {
    store.insertIteration('a', { n: 1, attempt: 0, promptSent: 'first', startedAt: 10 })
    store.insertIteration('a', {
      n: 1,
      attempt: 0,
      promptSent: 'second',
      startedAt: 10,
      endedAt: 20,
      endReason: 'settled'
    })
    store.insertIteration('a', { n: 1, attempt: 1, promptSent: 'retry', startedAt: 30 })
    const rows = store.listIterations('a')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      n: 1,
      attempt: 0,
      promptSent: 'second',
      endedAt: 20,
      endReason: 'settled'
    })
    expect(rows[1]).toMatchObject({ n: 1, attempt: 1, promptSent: 'retry', endedAt: null })
  })

  it('round-trips evidence columns and updates them in place', () => {
    store.insertIteration('a', { n: 1, attempt: 0, promptSent: 'p', startedAt: 10 })
    const updated = store.updateIteration('a', 1, 0, {
      endedAt: 50,
      endReason: 'settled',
      check: {
        ran: true,
        pass: false,
        exitCode: 1,
        timedOut: false,
        stdoutTail: 'o'.repeat(5_000),
        stderrTail: 'e',
        durationMs: 12
      },
      evaluator: { verdict: 'not-met', reason: 'tests red' },
      diff: { added: 4, removed: 1, files: ['a.ts'] },
      costUsd: 0.12,
      markers: [{ kind: 'blocked', text: 'need key' }],
      outputTail: 'x'.repeat(20_000),
      treeBefore: 'tree-a',
      treeAfter: 'tree-b'
    })
    expect(updated.check?.stdoutTail).toHaveLength(4_000)
    expect(updated.check?.stderrTail).toBe('e')
    expect(updated.outputTail).toHaveLength(16 * 1024)
    expect(updated).toMatchObject({
      evaluator: { verdict: 'not-met', reason: 'tests red' },
      diff: { added: 4, removed: 1, files: ['a.ts'] },
      costUsd: 0.12,
      markers: [{ kind: 'blocked', text: 'need key' }],
      treeBefore: 'tree-a',
      treeAfter: 'tree-b'
    })
    expect(store.listIterations('a')[0]).toEqual(updated)
  })

  it('round-trips protected path hits, checkpoint commit, and error', () => {
    const inserted = store.insertIteration('a', {
      n: 1,
      attempt: 0,
      promptSent: 'p',
      startedAt: 10,
      protectedPathHits: ['src/a.ts', 'src/b.ts'],
      checkpointCommit: 'abc123',
      error: 'checkpoint commit failed'
    })
    expect(inserted).toMatchObject({
      protectedPathHits: ['src/a.ts', 'src/b.ts'],
      checkpointCommit: 'abc123',
      error: 'checkpoint commit failed'
    })
    const updated = store.updateIteration('a', 1, 0, {
      protectedPathHits: [],
      checkpointCommit: null,
      error: 'again'
    })
    expect(updated).toMatchObject({ protectedPathHits: [], checkpointCommit: null, error: 'again' })
    expect(store.listIterations('a')[0]).toEqual(updated)

    store.insertIteration('a', { n: 2, attempt: 0, promptSent: 'p', startedAt: 20 })
    expect(store.listIterations('a')[1]).toMatchObject({
      protectedPathHits: [],
      checkpointCommit: null,
      error: null
    })
  })

  it('keeps the tail of an oversized output', () => {
    store.insertIteration('a', {
      n: 1,
      attempt: 0,
      promptSent: 'p',
      startedAt: 10,
      outputTail: `${'a'.repeat(16 * 1024)}END`
    })
    const tail = store.listIterations('a')[0].outputTail
    expect(tail).toHaveLength(16 * 1024)
    expect(tail?.endsWith('END')).toBe(true)
  })

  it('throws loop_not_found when updating an unknown iteration', () => {
    expect(() => store.updateIteration('a', 9, 0, { endedAt: 1 })).toThrow(
      expect.objectContaining({ code: 'loop_not_found' })
    )
  })

  it('returns the latest rows in chronological order when limited', () => {
    addIterations('a', 5)
    expect(store.listIterations('a', { limit: 2 }).map((row) => row.n)).toEqual([4, 5])
    expect(store.listIterations('a').map((row) => row.n)).toEqual([1, 2, 3, 4, 5])
  })

  it('applies the limit after dropping unfinished rows when finishedOnly is set', () => {
    addIterations('a', 3)
    store.updateIteration('a', 1, 0, { endedAt: 5, endReason: 'settled' })
    store.updateIteration('a', 2, 0, { endedAt: 6, endReason: 'settled' })
    expect(store.listIterations('a', { limit: 2, finishedOnly: true }).map((row) => row.n)).toEqual(
      [1, 2]
    )
    expect(store.listIterations('a', { limit: 2 }).map((row) => row.n)).toEqual([2, 3])
  })
})

describe('queue', () => {
  beforeEach(() => {
    store.insertLoop(loopInput('a', { preset: 'queue' }))
  })

  const bodies = (): string[] => store.listQueue('a').map((item) => item.body)

  it('adds at the end by default and at a position when given', () => {
    store.applyQueueOp('a', { op: 'add', body: 'one' })
    store.applyQueueOp('a', { op: 'add', body: 'two' })
    store.applyQueueOp('a', { op: 'add', body: 'zero', position: 0 })
    expect(bodies()).toEqual(['zero', 'one', 'two'])
    expect(store.listQueue('a').map((item) => item.position)).toEqual([0, 1, 2])
    expect(store.listQueue('a').every((item) => item.state === 'pending')).toBe(true)
  })

  it('moves, edits, and removes pending items', () => {
    store.applyQueueOp('a', { op: 'add', body: 'one' })
    store.applyQueueOp('a', { op: 'add', body: 'two' })
    store.applyQueueOp('a', { op: 'add', body: 'three' })
    const [one, , three] = store.listQueue('a')

    store.applyQueueOp('a', { op: 'move', id: three.id, position: 0 })
    expect(bodies()).toEqual(['three', 'one', 'two'])

    store.applyQueueOp('a', { op: 'edit', id: one.id, body: 'uno' })
    expect(bodies()).toEqual(['three', 'uno', 'two'])

    const remaining = store.applyQueueOp('a', { op: 'remove', id: one.id })
    expect(remaining.map((item) => item.body)).toEqual(['three', 'two'])
    expect(remaining.map((item) => item.position)).toEqual([0, 1])
  })

  it('rejects edits to an in-flight item with loop_invalid_transition', () => {
    const [item] = store.applyQueueOp('a', { op: 'add', body: 'one' })
    store.setQueueItemState('a', item.id, 'in-flight')
    for (const op of [
      { op: 'edit', id: item.id, body: 'x' },
      { op: 'move', id: item.id, position: 0 },
      { op: 'remove', id: item.id }
    ] as const) {
      expect(() => store.applyQueueOp('a', op)).toThrow(
        expect.objectContaining({ code: 'loop_invalid_transition' })
      )
    }
    expect(bodies()).toEqual(['one'])
  })

  it('throws loop_not_found for an unknown queue item or loop', () => {
    expect(() => store.applyQueueOp('a', { op: 'remove', id: 'nope' })).toThrow(
      expect.objectContaining({ code: 'loop_not_found' })
    )
    expect(() => store.applyQueueOp('missing', { op: 'add', body: 'x' })).toThrow(
      expect.objectContaining({ code: 'loop_not_found' })
    )
  })

  it('tracks item state transitions', () => {
    const [item] = store.applyQueueOp('a', { op: 'add', body: 'one' })
    store.setQueueItemState('a', item.id, 'done')
    expect(store.listQueue('a')[0].state).toBe('done')
  })
})

describe('steer notes', () => {
  beforeEach(() => {
    store.insertLoop(loopInput('a'))
  })

  it('hands each pending note out once, oldest first', () => {
    store.addSteerNote('a', 'use the cache')
    clock = 1_500
    store.addSteerNote('a', 'skip lint')
    const first = store.takePendingSteerNotes('a', 3)
    expect(first.map((note) => note.body)).toEqual(['use the cache', 'skip lint'])
    expect(first.every((note) => note.consumedByIteration === 3)).toBe(true)
    expect(store.takePendingSteerNotes('a', 4)).toEqual([])
  })

  it('delivers a note added after an earlier take on the next take', () => {
    store.addSteerNote('a', 'one')
    store.takePendingSteerNotes('a', 1)
    const note = store.addSteerNote('a', 'two')
    expect(note).toMatchObject({ loopId: 'a', body: 'two', consumedByIteration: null })
    expect(store.takePendingSteerNotes('a', 2).map((n) => n.body)).toEqual(['two'])
  })

  it('does not leak notes across loops', () => {
    store.insertLoop(loopInput('b'))
    store.addSteerNote('a', 'for a')
    expect(store.takePendingSteerNotes('b', 1)).toEqual([])
    expect(store.takePendingSteerNotes('a', 1)).toHaveLength(1)
  })
})

describe('iteration retention', () => {
  it('keeps the last 200 iterations of ended loops and all of live ones', () => {
    store.insertLoop(loopInput('ended'))
    store.insertLoop(loopInput('live'))
    store.insertLoop(loopInput('paused'))
    addIterations('ended', 250)
    addIterations('live', 250)
    addIterations('paused', 250)
    store.updateLoop('ended', { state: 'completed' })
    store.updateLoop('paused', { state: 'paused' })

    const deleted = store.pruneEndedLoopIterations()

    expect(deleted).toBe(50)
    const ended = store.listIterations('ended', { limit: 1_000 })
    expect(ended).toHaveLength(200)
    expect(ended[0].n).toBe(51)
    expect(ended[199].n).toBe(250)
    expect(store.listIterations('live', { limit: 1_000 })).toHaveLength(250)
    expect(store.listIterations('paused', { limit: 1_000 })).toHaveLength(250)
  })

  it('honors a custom keep and treats stopped loops as ended', () => {
    store.insertLoop(loopInput('a'))
    addIterations('a', 10)
    store.updateLoop('a', { state: 'stopped' })
    expect(store.pruneEndedLoopIterations(3)).toBe(7)
    expect(store.listIterations('a').map((row) => row.n)).toEqual([8, 9, 10])
  })
})

describe('read-only database', () => {
  it('rejects every write with loop_store_read_only but still reads', () => {
    store.insertLoop(loopInput('a'))
    vi.spyOn(database, 'isReadOnly').mockReturnValue(true)
    const rejected = expect.objectContaining({ code: 'loop_store_read_only' })
    expect(() => store.insertLoop(loopInput('b'))).toThrow(rejected)
    expect(() => store.updateLoop('a', { state: 'paused' })).toThrow(rejected)
    expect(() =>
      store.insertIteration('a', { n: 1, attempt: 0, promptSent: 'p', startedAt: 1 })
    ).toThrow(rejected)
    expect(() => store.updateIteration('a', 1, 0, { endedAt: 1 })).toThrow(rejected)
    expect(() => store.applyQueueOp('a', { op: 'add', body: 'x' })).toThrow(rejected)
    expect(() => store.setQueueItemState('a', 'x', 'done')).toThrow(rejected)
    expect(() => store.addSteerNote('a', 'x')).toThrow(rejected)
    expect(() => store.takePendingSteerNotes('a', 1)).toThrow(rejected)
    expect(() => store.pruneEndedLoopIterations()).toThrow(rejected)
    expect(store.getLoop('a')?.id).toBe('a')
    expect(store.listLoops()).toHaveLength(1)
    expect(new LoopStoreError('loop_store_read_only', 'x')).toBeInstanceOf(Error)
  })
})
