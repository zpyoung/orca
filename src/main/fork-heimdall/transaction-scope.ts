import type Database from '../sqlite/sync-database'

/**
 * Runs `operation` inside a BEGIN IMMEDIATE transaction, committing its return value or rolling
 * back whatever it wrote if it throws. Not reentrant: the caller must not already be inside a
 * transaction on this connection.
 */
export function withImmediateTransaction<T>(connection: Database.Database, operation: () => T): T {
  connection.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    connection.exec('COMMIT')
    return result
  } catch (error) {
    if (connection.isTransaction) {
      connection.exec('ROLLBACK')
    }
    throw error
  }
}

/**
 * Same contract as withImmediateTransaction, but nests: a call made while the connection is
 * already inside a transaction passes through without its own BEGIN/COMMIT/ROLLBACK, so only the
 * outermost caller commits (and onCommit fires only for that outermost caller).
 */
export function withReentrantImmediateTransaction<T>(
  connection: Database.Database,
  operation: () => T,
  onCommit?: () => void
): T {
  const ownsTransaction = !connection.isTransaction
  if (ownsTransaction) {
    connection.exec('BEGIN IMMEDIATE')
  }
  try {
    const result = operation()
    if (ownsTransaction) {
      connection.exec('COMMIT')
      onCommit?.()
    }
    return result
  } catch (error) {
    if (ownsTransaction && connection.isTransaction) {
      connection.exec('ROLLBACK')
    }
    throw error
  }
}
