import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from '../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'

export type ScopedDatabaseDirectoryProvider = {
  getProfileStorageDirectory(): string
}

export type ScopedDatabaseDirectorySource =
  | string
  | (() => string)
  | ScopedDatabaseDirectoryProvider

export type ScopedSqliteDatabaseOptions = {
  profileDirectory: ScopedDatabaseDirectorySource
  /** Whether ':memory:' bypasses profile-directory resolution and opens an in-memory database. */
  supportsInMemory: boolean
  subdirectory: string
  filename: string
  schemaVersion: number
  /** Ordered migration SQL, one entry per schema version (index 0 applies when locked version < 1). */
  migrations: readonly string[]
  busyTimeoutMs: number
  missingDirectoryMessage: string
  readOnlyMessage: string
}

/** Lazily owns a single profile-scoped SQLite database, gated by a versioned migration ladder. */
export class ScopedSqliteDatabase {
  private opened: Database.Database | null = null
  private openedReadOnly = false
  private openedPath: string | null = null

  constructor(private readonly options: ScopedSqliteDatabaseOptions) {}

  connection(): Database.Database {
    if (this.opened) {
      return this.opened
    }

    const { busyTimeoutMs } = this.options
    const databasePath = this.resolveDatabasePath()
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
    }
    const probe = new Database(databasePath, { timeout: busyTimeoutMs })
    let storedVersion: number
    try {
      storedVersion = Number(probe.pragma('user_version', { simple: true }) ?? 0)
    } catch (error) {
      probe.close()
      throw error
    }
    if (storedVersion > this.options.schemaVersion) {
      probe.close()
      const readOnly = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
        timeout: busyTimeoutMs
      })
      this.opened = readOnly
      this.openedReadOnly = true
      this.openedPath = databasePath
      return readOnly
    }

    let probeOpen = true
    let transferred = false
    try {
      this.configure(probe)
      const initialization = this.createSchema(probe, storedVersion)
      if (initialization === 'future-schema') {
        probe.close()
        probeOpen = false
        const readOnly = new Database(databasePath, {
          readonly: true,
          fileMustExist: true,
          timeout: busyTimeoutMs
        })
        this.opened = readOnly
        this.openedReadOnly = true
        this.openedPath = databasePath
        transferred = true
        return readOnly
      }
      hardenSqliteDatabaseFiles(databasePath)
      this.opened = probe
      this.openedReadOnly = false
      this.openedPath = databasePath
      transferred = true
      return probe
    } finally {
      if (!transferred && probeOpen) {
        probe.close()
      }
    }
  }

  isReadOnly(): boolean {
    this.connection()
    return this.openedReadOnly
  }

  databasePath(): string {
    return this.openedPath ?? this.resolveDatabasePath()
  }

  assertWritable(): void {
    if (this.isReadOnly()) {
      throw new Error(this.options.readOnlyMessage)
    }
  }

  close(): void {
    this.opened?.close()
    this.opened = null
    this.openedReadOnly = false
    this.openedPath = null
  }

  private resolveDatabasePath(): string {
    const { profileDirectory, supportsInMemory, subdirectory, filename, missingDirectoryMessage } =
      this.options
    if (supportsInMemory && profileDirectory === ':memory:') {
      return ':memory:'
    }
    const resolved =
      typeof profileDirectory === 'string'
        ? profileDirectory
        : typeof profileDirectory === 'function'
          ? profileDirectory()
          : profileDirectory.getProfileStorageDirectory()
    if (!resolved) {
      throw new Error(missingDirectoryMessage)
    }
    return join(resolved, subdirectory, filename)
  }

  private configure(database: Database.Database): void {
    database.pragma('journal_mode = WAL')
    database.pragma(`busy_timeout = ${this.options.busyTimeoutMs}`)
    database.pragma('foreign_keys = ON')
    database.pragma('synchronous = FULL')
  }

  /**
   * The initial version probe chooses the no-write future-schema path. A second process can still
   * initialize or upgrade the fresh file before this connection obtains its writer lock, so the
   * version that authorizes DDL and the version write must be read again inside that transaction.
   */
  private createSchema(
    database: Database.Database,
    storedVersion: number
  ): 'writable' | 'future-schema' {
    const { schemaVersion, migrations } = this.options
    if (storedVersion >= schemaVersion) {
      return 'writable'
    }

    database.exec('BEGIN IMMEDIATE')
    try {
      const lockedVersion = Number(database.pragma('user_version', { simple: true }) ?? 0)
      if (lockedVersion > schemaVersion) {
        database.exec('ROLLBACK')
        return 'future-schema'
      }
      for (let index = 0; index < migrations.length; index += 1) {
        if (lockedVersion < index + 1) {
          database.exec(migrations[index])
        }
      }
      if (lockedVersion < schemaVersion) {
        database.pragma(`user_version = ${schemaVersion}`)
      }
      database.exec('COMMIT')
      return 'writable'
    } catch (error) {
      if (database.isTransaction) {
        database.exec('ROLLBACK')
      }
      throw error
    }
  }
}
