import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('OrchestrationDb dispatch spawn receipts', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function createDispatch(d: OrchestrationDb): string {
    const task = d.createTask({ spec: 'spawn receipt fixture' })
    const started = d.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'codex' }
    })
    return started.dispatch.id
  }

  it('has no receipt before any spawn attempt is recorded — the stage-B evidence', () => {
    const d = createDb()
    const dispatchId = createDispatch(d)

    expect(d.getSpawnReceipt(dispatchId)).toBeUndefined()
  })

  it('records a spawn attempt with no commit stamp yet — the stage-U evidence', () => {
    const d = createDb()
    const dispatchId = createDispatch(d)

    d.recordSpawnAttempt(dispatchId)

    const receipt = d.getSpawnReceipt(dispatchId)
    expect(receipt?.spawn_attempt_at).toEqual(expect.any(String))
    expect(receipt?.spawn_committed_at).toBeNull()
  })

  it('stamps the commit time once the spawn commits — the stage-C floor', () => {
    const d = createDb()
    const dispatchId = createDispatch(d)
    d.recordSpawnAttempt(dispatchId)

    d.markSpawnCommitted(dispatchId)

    const receipt = d.getSpawnReceipt(dispatchId)
    expect(receipt?.spawn_attempt_at).toEqual(expect.any(String))
    expect(receipt?.spawn_committed_at).toEqual(expect.any(String))
  })

  it('is a no-op when marking commit for a dispatch with no recorded attempt', () => {
    const d = createDb()
    const dispatchId = createDispatch(d)

    expect(() => d.markSpawnCommitted(dispatchId)).not.toThrow()
    expect(d.getSpawnReceipt(dispatchId)).toBeUndefined()
  })

  it('clears receipts on a full reset', () => {
    const d = createDb()
    const dispatchId = createDispatch(d)
    d.recordSpawnAttempt(dispatchId)

    d.resetAll()

    expect(d.getSpawnReceipt(dispatchId)).toBeUndefined()
  })
})
