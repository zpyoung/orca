import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'

const WATCHER_ID = 'watcher-gate-attempts-1'
const CONTENT_IDENTITY = 'content-1'

let database: ObjectiveDatabase
let store: ObjectiveStore
const opened: ObjectiveDatabase[] = []

beforeEach(() => {
  database = new ObjectiveDatabase(':memory:')
  opened.push(database)
  store = new ObjectiveStore(database, () => 9_999)
})

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
})

describe('ObjectiveStore gate attempts', () => {
  it('starts a gate attempt pending and replays the same start unchanged', () => {
    const args = {
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'pnpm typecheck:node',
      epoch: 1,
      startedAtMs: 100
    }

    const started = store.startGateAttempt(args)
    expect(started.exitCode).toBeNull()
    expect(started.timedOut).toBeNull()
    expect(started.completedAtMs).toBeNull()
    expect(store.startGateAttempt(args)).toEqual(started)
    expect(store.getGateAttempt(WATCHER_ID, 'typecheck:node', CONTENT_IDENTITY)).toEqual(started)
  })

  it('refuses replaying a start with different inputs', () => {
    store.startGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'pnpm typecheck:node',
      epoch: 1,
      startedAtMs: 100
    })

    expect(() =>
      store.startGateAttempt({
        watcherId: WATCHER_ID,
        gateName: 'typecheck:node',
        contentIdentity: CONTENT_IDENTITY,
        executionHostId: 'local',
        command: 'pnpm typecheck:node --different',
        epoch: 1,
        startedAtMs: 100
      })
    ).toThrow(/different inputs/)
  })

  it('completes a started attempt and replays the same result unchanged', () => {
    store.startGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'pnpm typecheck:node',
      epoch: 1,
      startedAtMs: 100
    })
    const completion = {
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'ok',
      stderrTail: '',
      completedAtMs: 150
    }

    const completed = store.completeGateAttempt(completion)
    expect(completed.exitCode).toBe(0)
    expect(completed.timedOut).toBe(false)
    expect(completed.completedAtMs).toBe(150)
    expect(store.completeGateAttempt(completion)).toEqual(completed)
  })

  it('refuses completing an attempt that was never started', () => {
    expect(() =>
      store.completeGateAttempt({
        watcherId: WATCHER_ID,
        gateName: 'typecheck:node',
        contentIdentity: CONTENT_IDENTITY,
        exitCode: 0,
        timedOut: false,
        stdoutTail: '',
        stderrTail: '',
        completedAtMs: 150
      })
    ).toThrow(/must be started/)
  })

  it('refuses replaying a completion with a different result', () => {
    store.startGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'pnpm typecheck:node',
      epoch: 1,
      startedAtMs: 100
    })
    store.completeGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'ok',
      stderrTail: '',
      completedAtMs: 150
    })

    expect(() =>
      store.completeGateAttempt({
        watcherId: WATCHER_ID,
        gateName: 'typecheck:node',
        contentIdentity: CONTENT_IDENTITY,
        exitCode: 1,
        timedOut: false,
        stdoutTail: 'ok',
        stderrTail: '',
        completedAtMs: 150
      })
    ).toThrow(/different result/)
  })

  it('refuses replaying a completion with the same exit code but a different timedOut', () => {
    store.startGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'pnpm typecheck:node',
      epoch: 1,
      startedAtMs: 100
    })
    store.completeGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 1,
      timedOut: true,
      stdoutTail: '',
      stderrTail: 'timeout',
      completedAtMs: 150
    })

    expect(() =>
      store.completeGateAttempt({
        watcherId: WATCHER_ID,
        gateName: 'typecheck:node',
        contentIdentity: CONTENT_IDENTITY,
        exitCode: 1,
        timedOut: false,
        stdoutTail: '',
        stderrTail: 'timeout',
        completedAtMs: 150
      })
    ).toThrow(/different result/)
  })

  it('returns null for an attempt that was never started', () => {
    expect(store.getGateAttempt(WATCHER_ID, 'typecheck:node', CONTENT_IDENTITY)).toBeNull()
  })

  it('lists gate attempts newest first', () => {
    store.startGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:node',
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'pnpm typecheck:node',
      epoch: 1,
      startedAtMs: 100
    })
    store.startGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'typecheck:web',
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'local',
      command: 'pnpm typecheck:web',
      epoch: 1,
      startedAtMs: 200
    })

    expect(store.listGateAttempts(WATCHER_ID).map((attempt) => attempt.gateName)).toEqual([
      'typecheck:web',
      'typecheck:node'
    ])
  })
})
