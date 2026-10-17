import { randomUUID } from 'node:crypto'
import type { LoopState, QueueOp } from '../../shared/fork-loops/loop-types'
import { withImmediateTransaction } from '../fork-heimdall/transaction-scope'
import type Database from '../sqlite/sync-database'
import {
  boundCheck,
  ENDED_LOOP_ITERATIONS_KEPT,
  ITERATION_COLUMNS,
  ITERATION_OUTPUT_TAIL_LIMIT,
  LOOP_COLUMNS,
  LoopStoreError,
  nullableJson,
  patchAssignments,
  pick,
  QUEUE_COLUMNS,
  STEER_NOTE_COLUMNS,
  tail,
  toQueueItem,
  toSteerNote,
  toStoredIteration,
  toStoredLoop,
  type IterationInsert,
  type IterationPatch,
  type LoopDatabase,
  type LoopInsert,
  type LoopPatch,
  type QueueItem,
  type QueueItemState,
  type SteerNote,
  type StoredIteration,
  type StoredLoop
} from './loop-database'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isEnded(state: LoopState): boolean {
  return state === 'completed' || state === 'stopped'
}

/**
 * Persistence for loops, their iteration evidence, prompt queues and steer notes. The database is
 * opened on first use, and every write runs in one immediate transaction so multi-row mutations
 * (queue reorders, note hand-off) never land partially. Writes against a read-only database throw
 * a `loop_store_read_only` error; reads keep working.
 */
export class LoopStore {
  constructor(
    private readonly database: LoopDatabase,
    private readonly now: () => number = Date.now
  ) {}

  insertLoop(input: LoopInsert): StoredLoop {
    return this.write((db) => {
      const timestamp = this.now()
      db.prepare(
        `INSERT INTO loops (${LOOP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id,
        input.worktreeId,
        input.workspaceKind,
        input.executionHostId,
        input.name,
        input.slug,
        input.agent,
        nullableJson(input.launchOverrides),
        input.preset,
        JSON.stringify(input.config),
        input.state,
        input.pauseReason ?? null,
        input.pauseDetail ?? null,
        input.tabId ?? null,
        input.paneKey ?? null,
        input.ptyId ?? null,
        input.detached ? 1 : 0,
        input.iterationsCompleted ?? 0,
        input.activeMs ?? 0,
        input.costUsd ?? null,
        input.skippedTicks ?? 0,
        input.nextIterationAt ?? null,
        timestamp,
        timestamp,
        isEnded(input.state) ? timestamp : null
      )
      return this.requireLoop(db, input.id)
    })
  }

  /**
   * Applies `patch` and bumps `updatedAt`. `endedAt` is stamped the first time the loop reaches a
   * terminal state unless the patch sets it explicitly.
   */
  updateLoop(id: string, patch: LoopPatch): StoredLoop {
    return this.write((db) => {
      const current = this.requireLoop(db, id)
      const assignments = patchAssignments(patch)
      if (
        patch.endedAt === undefined &&
        patch.state !== undefined &&
        isEnded(patch.state) &&
        current.endedAt === null
      ) {
        assignments.push(['ended_at', this.now()])
      }
      assignments.push(['updated_at', this.now()])
      db.prepare(
        `UPDATE loops SET ${assignments.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`
      ).run(...assignments.map(([, value]) => value), id)
      return this.requireLoop(db, id)
    })
  }

  getLoop(id: string): StoredLoop | null {
    return this.readLoop(this.database.connection(), id)
  }

  /** Newest-updated first. */
  listLoops(filter: { worktreeId?: string } = {}): StoredLoop[] {
    const db = this.database.connection()
    const rows =
      filter.worktreeId === undefined
        ? db.prepare(`SELECT ${LOOP_COLUMNS} FROM loops ORDER BY updated_at DESC, rowid DESC`).all()
        : db
            .prepare(
              `SELECT ${LOOP_COLUMNS} FROM loops WHERE worktree_id = ? ORDER BY updated_at DESC, rowid DESC`
            )
            .all(filter.worktreeId)
    return rows.map(toStoredLoop)
  }

  /**
   * Upserts one attempt of one iteration; a repeat of `(loopId, n, attempt)` replaces the row.
   * Oversized evidence is trimmed to its tail before it is stored.
   */
  insertIteration(loopId: string, input: IterationInsert): StoredIteration {
    return this.write((db) => {
      this.requireLoop(db, loopId)
      db.prepare(
        `INSERT INTO iterations (${ITERATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (loop_id, n, attempt) DO UPDATE SET
           prompt_sent = excluded.prompt_sent, started_at = excluded.started_at,
           ended_at = excluded.ended_at, end_reason = excluded.end_reason,
           check_json = excluded.check_json, evaluator_json = excluded.evaluator_json,
           diff_json = excluded.diff_json, cost_usd = excluded.cost_usd,
           markers_json = excluded.markers_json, output_tail = excluded.output_tail,
           tree_before = excluded.tree_before, tree_after = excluded.tree_after,
           protected_path_hits_json = excluded.protected_path_hits_json,
           checkpoint_commit = excluded.checkpoint_commit, error = excluded.error`
      ).run(
        loopId,
        input.n,
        input.attempt,
        input.promptSent,
        input.startedAt,
        input.endedAt ?? null,
        input.endReason ?? null,
        input.check ? JSON.stringify(boundCheck(input.check)) : null,
        nullableJson(input.evaluator),
        nullableJson(input.diff),
        input.costUsd ?? null,
        input.markers ? JSON.stringify(input.markers) : null,
        input.outputTail == null ? null : tail(input.outputTail, ITERATION_OUTPUT_TAIL_LIMIT),
        input.treeBefore ?? null,
        input.treeAfter ?? null,
        input.protectedPathHits ? JSON.stringify(input.protectedPathHits) : null,
        input.checkpointCommit ?? null,
        input.error ?? null
      )
      return this.requireIteration(db, loopId, input.n, input.attempt)
    })
  }

  updateIteration(
    loopId: string,
    n: number,
    attempt: number,
    patch: IterationPatch
  ): StoredIteration {
    return this.write((db) => {
      const current = this.requireIteration(db, loopId, n, attempt)
      const merged: StoredIteration = {
        ...current,
        promptSent: pick(patch.promptSent, current.promptSent),
        endedAt: pick(patch.endedAt, current.endedAt),
        endReason: pick(patch.endReason, current.endReason),
        check: pick(patch.check, current.check),
        evaluator: pick(patch.evaluator, current.evaluator),
        diff: pick(patch.diff, current.diff),
        costUsd: pick(patch.costUsd, current.costUsd),
        markers: pick(patch.markers, current.markers),
        outputTail: pick(patch.outputTail, current.outputTail),
        treeBefore: pick(patch.treeBefore, current.treeBefore),
        treeAfter: pick(patch.treeAfter, current.treeAfter),
        protectedPathHits: pick(patch.protectedPathHits, current.protectedPathHits),
        checkpointCommit: pick(patch.checkpointCommit, current.checkpointCommit),
        error: pick(patch.error, current.error)
      }
      db.prepare(
        `UPDATE iterations SET prompt_sent = ?, ended_at = ?, end_reason = ?, check_json = ?,
           evaluator_json = ?, diff_json = ?, cost_usd = ?, markers_json = ?, output_tail = ?,
           tree_before = ?, tree_after = ?, protected_path_hits_json = ?, checkpoint_commit = ?,
           error = ?
         WHERE loop_id = ? AND n = ? AND attempt = ?`
      ).run(
        merged.promptSent,
        merged.endedAt,
        merged.endReason,
        merged.check ? JSON.stringify(boundCheck(merged.check)) : null,
        nullableJson(merged.evaluator),
        nullableJson(merged.diff),
        merged.costUsd,
        JSON.stringify(merged.markers),
        merged.outputTail === null ? null : tail(merged.outputTail, ITERATION_OUTPUT_TAIL_LIMIT),
        merged.treeBefore,
        merged.treeAfter,
        JSON.stringify(merged.protectedPathHits),
        merged.checkpointCommit,
        merged.error,
        loopId,
        n,
        attempt
      )
      return this.requireIteration(db, loopId, n, attempt)
    })
  }

  /** The latest `limit` attempts (all when omitted), returned oldest first; `finishedOnly` filters before the limit. */
  listIterations(
    loopId: string,
    options: { limit?: number; finishedOnly?: boolean } = {}
  ): StoredIteration[] {
    const db = this.database.connection()
    const limit = options.limit ?? -1
    const finishedClause = options.finishedOnly
      ? ' AND ended_at IS NOT NULL AND end_reason IS NOT NULL'
      : ''
    return db
      .prepare(
        `SELECT ${ITERATION_COLUMNS} FROM (
           SELECT ${ITERATION_COLUMNS} FROM iterations WHERE loop_id = ?${finishedClause}
           ORDER BY n DESC, attempt DESC LIMIT ?
         ) ORDER BY n ASC, attempt ASC`
      )
      .all(loopId, limit)
      .map(toStoredIteration)
  }

  listQueue(loopId: string): QueueItem[] {
    return this.readQueue(this.database.connection(), loopId)
  }

  /**
   * Applies one queue edit and returns the resulting queue. Any op naming an in-flight item is
   * rejected with `loop_invalid_transition`; positions stay dense from 0.
   */
  applyQueueOp(loopId: string, op: QueueOp): QueueItem[] {
    return this.write((db) => {
      this.requireLoop(db, loopId)
      const items = this.readQueue(db, loopId)
      const order = items.map((item) => item.id)
      if (op.op === 'add') {
        const id = randomUUID()
        db.prepare(
          'INSERT INTO queue_items (loop_id, id, position, body, state) VALUES (?, ?, ?, ?, ?)'
        ).run(loopId, id, order.length, op.body, 'pending')
        order.splice(clamp(op.position ?? order.length, 0, order.length), 0, id)
      } else {
        const target = items.find((item) => item.id === op.id)
        if (!target) {
          throw new LoopStoreError('loop_not_found', `Queue item ${op.id} not found`)
        }
        if (target.state === 'in-flight') {
          throw new LoopStoreError(
            'loop_invalid_transition',
            `Queue item ${op.id} is in flight and cannot be changed`
          )
        }
        const index = order.indexOf(op.id)
        if (op.op === 'edit') {
          db.prepare('UPDATE queue_items SET body = ? WHERE loop_id = ? AND id = ?').run(
            op.body,
            loopId,
            op.id
          )
        } else if (op.op === 'move') {
          order.splice(index, 1)
          order.splice(clamp(op.position, 0, order.length), 0, op.id)
        } else {
          order.splice(index, 1)
          db.prepare('DELETE FROM queue_items WHERE loop_id = ? AND id = ?').run(loopId, op.id)
        }
      }
      const setPosition = db.prepare(
        'UPDATE queue_items SET position = ? WHERE loop_id = ? AND id = ?'
      )
      order.forEach((id, position) => setPosition.run(position, loopId, id))
      return this.readQueue(db, loopId)
    })
  }

  /** Runner-side lifecycle for a queue item (claim, finish); not a user edit. */
  setQueueItemState(loopId: string, itemId: string, state: QueueItemState): void {
    this.write((db) => {
      const result = db
        .prepare('UPDATE queue_items SET state = ? WHERE loop_id = ? AND id = ?')
        .run(state, loopId, itemId)
      if (Number(result.changes) === 0) {
        throw new LoopStoreError('loop_not_found', `Queue item ${itemId} not found`)
      }
    })
  }

  addSteerNote(loopId: string, body: string): SteerNote {
    return this.write((db) => {
      this.requireLoop(db, loopId)
      const note: SteerNote = {
        loopId,
        id: randomUUID(),
        body,
        createdAt: this.now(),
        consumedByIteration: null
      }
      db.prepare(
        'INSERT INTO steer_notes (loop_id, id, body, created_at, consumed_by_iteration) VALUES (?, ?, ?, ?, NULL)'
      ).run(loopId, note.id, note.body, note.createdAt)
      return note
    })
  }

  /** Returns the loop's unconsumed notes oldest first and marks them consumed by `iterationN`. */
  takePendingSteerNotes(loopId: string, iterationN: number): SteerNote[] {
    return this.write((db) => {
      const pending = db
        .prepare(
          `SELECT ${STEER_NOTE_COLUMNS} FROM steer_notes
           WHERE loop_id = ? AND consumed_by_iteration IS NULL ORDER BY created_at ASC, rowid ASC`
        )
        .all(loopId)
        .map(toSteerNote)
      if (pending.length > 0) {
        db.prepare(
          'UPDATE steer_notes SET consumed_by_iteration = ? WHERE loop_id = ? AND consumed_by_iteration IS NULL'
        ).run(iterationN, loopId)
      }
      return pending.map((note) => ({ ...note, consumedByIteration: iterationN }))
    })
  }

  /**
   * Trims every completed or stopped loop to its newest `keep` iteration attempts; loops that are
   * still live keep everything. Returns the number of rows removed.
   */
  pruneEndedLoopIterations(keep: number = ENDED_LOOP_ITERATIONS_KEPT): number {
    return this.write((db) => {
      const result = db
        .prepare(
          `DELETE FROM iterations
           WHERE loop_id IN (SELECT id FROM loops WHERE state IN ('completed', 'stopped'))
             AND rowid NOT IN (
               SELECT kept.rowid FROM iterations AS kept
               WHERE kept.loop_id = iterations.loop_id
               ORDER BY kept.n DESC, kept.attempt DESC LIMIT ?
             )`
        )
        .run(keep)
      return Number(result.changes)
    })
  }

  private write<T>(operation: (db: Database.Database) => T): T {
    if (this.database.isReadOnly()) {
      throw new LoopStoreError(
        'loop_store_read_only',
        'Loop database is read-only; its schema is newer than this build'
      )
    }
    const db = this.database.connection()
    return withImmediateTransaction(db, () => operation(db))
  }

  private readLoop(db: Database.Database, id: string): StoredLoop | null {
    const row = db.prepare(`SELECT ${LOOP_COLUMNS} FROM loops WHERE id = ?`).get(id)
    return row ? toStoredLoop(row) : null
  }

  private requireLoop(db: Database.Database, id: string): StoredLoop {
    const loop = this.readLoop(db, id)
    if (!loop) {
      throw new LoopStoreError('loop_not_found', `Loop ${id} not found`)
    }
    return loop
  }

  private requireIteration(
    db: Database.Database,
    loopId: string,
    n: number,
    attempt: number
  ): StoredIteration {
    const row = db
      .prepare(
        `SELECT ${ITERATION_COLUMNS} FROM iterations WHERE loop_id = ? AND n = ? AND attempt = ?`
      )
      .get(loopId, n, attempt)
    if (!row) {
      throw new LoopStoreError(
        'loop_not_found',
        `Iteration ${n}.${attempt} of loop ${loopId} not found`
      )
    }
    return toStoredIteration(row)
  }

  private readQueue(db: Database.Database, loopId: string): QueueItem[] {
    return db
      .prepare(
        `SELECT ${QUEUE_COLUMNS} FROM queue_items WHERE loop_id = ? ORDER BY position ASC, rowid ASC`
      )
      .all(loopId)
      .map(toQueueItem)
  }
}
