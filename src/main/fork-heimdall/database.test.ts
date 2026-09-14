import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { HEIMDALL_DATABASE_SCHEMA_VERSION, HeimdallDatabase } from './database'

let root: string
const opened: HeimdallDatabase[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-heimdall-database-'))
})

afterEach(() => {
  for (const database of opened) {
    database.close()
  }
  opened.length = 0
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('Heimdall database initialization', () => {
  it('rechecks user_version under the write lock when two first-open callers race', () => {
    const first = new HeimdallDatabase(root)
    const competing = new HeimdallDatabase(root)
    opened.push(first, competing)
    const originalPragma = Database.prototype.pragma
    let raced = false
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      options?: { simple?: boolean }
    ) {
      const result = originalPragma.call(this, sql, options)
      if (!raced && sql === 'user_version' && Number(result) === 0) {
        raced = true
        competing.connection()
      }
      return result
    })

    expect(() => first.connection()).not.toThrow()
    expect(raced).toBe(true)
    expect(first.isReadOnly()).toBe(false)
    expect(first.connection().pragma('user_version', { simple: true })).toBe(
      HEIMDALL_DATABASE_SCHEMA_VERSION
    )
    expect(
      first
        .connection()
        .prepare(
          `SELECT COUNT(*) AS count
             FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'heimdall_%'`
        )
        .get()
    ).toMatchObject({ count: 4 })
  })

  it('latches read-only instead of downgrading a future schema that wins first-open', () => {
    const first = new HeimdallDatabase(root)
    const competing = new HeimdallDatabase(root)
    opened.push(first, competing)
    const futureVersion = HEIMDALL_DATABASE_SCHEMA_VERSION + 1
    const originalPragma = Database.prototype.pragma
    let raced = false
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      options?: { simple?: boolean }
    ) {
      const result = originalPragma.call(this, sql, options)
      if (!raced && sql === 'user_version' && Number(result) === 0) {
        raced = true
        competing.connection().pragma(`user_version = ${futureVersion}`)
      }
      return result
    })

    expect(() => first.connection()).not.toThrow()
    expect(raced).toBe(true)
    expect(first.isReadOnly()).toBe(true)
    expect(first.connection().pragma('user_version', { simple: true })).toBe(futureVersion)
    expect(() => first.assertWritable()).toThrow('database is read-only')
    expect(competing.connection().pragma('user_version', { simple: true })).toBe(futureVersion)
  })
})
