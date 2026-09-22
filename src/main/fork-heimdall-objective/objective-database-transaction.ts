import type Database from '../sqlite/sync-database'
import type { ObjectiveDatabase } from './objective-database'

/**
 * Runs `operation` inside a single BEGIN IMMEDIATE transaction, committing its return value or
 * rolling back whatever it wrote if it throws. Every objective-store write goes through this one
 * implementation so a multi-table mutation can never land partially applied.
 */
export function runObjectiveMutation<T>(
  database: ObjectiveDatabase,
  operation: (db: Database.Database) => T
): T {
  database.assertWritable()
  const db: Database.Database = database.connection()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation(db)
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}
