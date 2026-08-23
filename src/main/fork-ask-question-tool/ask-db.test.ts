import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AskDb, type RegisterAskParams } from './ask-db'

function baseParams(overrides: Partial<RegisterAskParams> = {}): RegisterAskParams {
  return {
    askId: 'ask_1',
    requestId: 'req_1',
    paneKey: 'pane:1',
    worktreeId: 'wt_1',
    origin: 'cli',
    specJson: '{"questions":[]}',
    timeoutMs: null,
    handoff: null,
    ...overrides
  }
}

describe('AskDb', () => {
  let db: AskDb | undefined
  let dir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  it('durably inserts a registered ask', () => {
    db = new AskDb(':memory:')
    const { row, created } = db.registerAsk(baseParams())
    expect(created).toBe(true)
    expect(row.ask_id).toBe('ask_1')
    expect(row.status).toBe('registered')
    expect(row.pane_key).toBe('pane:1')
    expect(row.answers_json).toBeNull()
  })

  it('restores rows unchanged after reopening the database file', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-ask-db-'))
    const dbPath = join(dir, 'asks.db')
    const first = new AskDb(dbPath)
    first.registerAsk(baseParams())
    first.close()

    const reopened = new AskDb(dbPath)
    db = reopened
    const row = reopened.getAsk('ask_1')
    expect(row?.request_id).toBe('req_1')
    expect(row?.spec_json).toBe('{"questions":[]}')
  })

  it('persists a partial and survives a reopen', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-ask-db-'))
    const dbPath = join(dir, 'asks.db')
    const first = new AskDb(dbPath)
    first.registerAsk(baseParams())
    first.updatePartial('ask_1', '{"q1":{"draft":"in progress"}}')
    first.close()

    const reopened = new AskDb(dbPath)
    db = reopened
    expect(reopened.getAsk('ask_1')?.partial_json).toBe('{"q1":{"draft":"in progress"}}')
  })

  it('purges resolved rows older than 24h but keeps pending rows', () => {
    db = new AskDb(':memory:')
    db.registerAsk(baseParams({ askId: 'ask_stale', requestId: 'req_stale' }))
    db.commitAskResult(
      'ask_stale',
      { status: 'answered', answersJson: '{}' },
      '2024-01-01T00:00:00.000Z'
    )
    db.registerAsk(baseParams({ askId: 'ask_pending', requestId: 'req_pending' }))

    const purged = db.purgeStaleTerminalRows('2024-01-02T00:00:01.000Z')

    expect(purged).toBe(1)
    expect(db.getAsk('ask_stale')).toBeUndefined()
    expect(db.getAsk('ask_pending')).toBeDefined()
  })

  it('does not purge a resolved row inside the 24h retention window', () => {
    db = new AskDb(':memory:')
    db.registerAsk(baseParams())
    db.commitAskResult('ask_1', { status: 'answered', answersJson: '{}' }, '2024-01-01T12:00:00.000Z')

    const purged = db.purgeStaleTerminalRows('2024-01-02T00:00:00.000Z')

    expect(purged).toBe(0)
    expect(db.getAsk('ask_1')).toBeDefined()
  })

  it('keeps seq monotonic across row changes and across a reopen', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-ask-db-'))
    const dbPath = join(dir, 'asks.db')
    const first = new AskDb(dbPath)
    const registered = first.registerAsk(baseParams())
    const afterPartial = first.updatePartial('ask_1', '{}')
    expect(afterPartial.seq).toBeGreaterThan(registered.row.seq)
    first.close()

    const reopened = new AskDb(dbPath)
    db = reopened
    const second = reopened.registerAsk(baseParams({ askId: 'ask_2', requestId: 'req_2' }))
    expect(second.row.seq).toBeGreaterThan(afterPartial.seq)
  })

  it('is idempotent on request_id: a replay returns the first row and inserts no second one', () => {
    db = new AskDb(':memory:')
    const first = db.registerAsk(baseParams())
    const replay = db.registerAsk(baseParams({ askId: 'ask_2' }))

    expect(replay.created).toBe(false)
    expect(replay.row.ask_id).toBe(first.row.ask_id)
    expect(db.getAsk('ask_2')).toBeUndefined()
  })

  it('derives expires_at from timeout_ms at registration and keeps it unchanged after a reopen', () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-ask-db-'))
    const dbPath = join(dir, 'asks.db')
    const first = new AskDb(dbPath)
    const { row } = first.registerAsk(
      baseParams({ timeoutMs: 60_000 }),
      '2024-01-01T00:00:00.000Z'
    )
    expect(row.expires_at).toBe('2024-01-01T00:01:00.000Z')
    first.close()

    const reopened = new AskDb(dbPath)
    db = reopened
    expect(reopened.getAsk('ask_1')?.expires_at).toBe('2024-01-01T00:01:00.000Z')
  })

  it('round-trips the hand-off identity columns', () => {
    db = new AskDb(':memory:')
    const { row } = db.registerAsk(
      baseParams({
        origin: 'handoff',
        handoff: { runId: 'run_1', dispatchId: 'dispatch_1', askerHandle: 'coordinator', questionId: null }
      })
    )
    expect(row.handoff_run_id).toBe('run_1')
    expect(row.handoff_dispatch_id).toBe('dispatch_1')
    expect(row.handoff_asker).toBe('coordinator')
    expect(row.handoff_question_id).toBeNull()

    const updated = db.setHandoffQuestionId('ask_1', 'question_1')
    expect(updated.handoff_question_id).toBe('question_1')
  })
})
