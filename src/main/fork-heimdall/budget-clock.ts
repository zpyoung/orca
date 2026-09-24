import { randomUUID } from 'node:crypto'
import type {
  IntervalCloseEntry,
  IntervalOpenEntry,
  LedgerEntry
} from '../../shared/fork-heimdall/ledger-types'
import type { HeimdallLedgerStore } from './ledger-store'

export const ACTIVE_TIME_CHECKPOINT_MS = 15_000
export const ACTIVE_TIME_LEDGER_INTERVAL_MS = 60_000

export type IntervalCause = IntervalOpenEntry['cause']
export type IntervalCloseReason = IntervalCloseEntry['closeReason']

export type IntervalHandle = {
  readonly watcherId: string
  readonly intervalId: string
}

export type BudgetClock = {
  open(watcherId: string, cause: IntervalCause): IntervalHandle
  checkpoint(watcherId: string): void
  close(handle: IntervalHandle, reason: IntervalCloseReason): void
  /** Best-effort teardown: a no-op when the interval is already durably closed. */
  release(handle: IntervalHandle, reason: IntervalCloseReason): void
  recoverOnStart(watcherId: string): boolean
  current(watcherId: string): IntervalHandle | null
  /** Returns only the interval whose sampler is owned by this clock instance. */
  owned(watcherId: string): IntervalHandle | null
}

export type HeimdallBudgetClockOptions = {
  now?: () => number
  eventId?: () => string
  intervalId?: () => string
}

type DurableInterval = {
  handle: IntervalHandle
  openedAtMs: number
  checkpointAtMs: number | null
  closedAtMs: number | null
}

type OwnedInterval = DurableInterval & {
  timer: NodeJS.Timeout
  failure: Error | null
  references: number
}

/** Ledger-backed active-time clock. It owns timers only while observable work is active. */
export class HeimdallBudgetClock implements BudgetClock {
  private readonly active = new Map<string, OwnedInterval>()
  private readonly now: () => number
  private readonly makeEventId: () => string
  private readonly makeIntervalId: () => string

  constructor(
    private readonly ledger: HeimdallLedgerStore,
    options: HeimdallBudgetClockOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.makeEventId = options.eventId ?? randomUUID
    this.makeIntervalId = options.intervalId ?? randomUUID
  }

  open(watcherId: string, cause: IntervalCause): IntervalHandle {
    this.requireWatcherId(watcherId)
    if (
      cause !== 'action-in-flight' &&
      cause !== 'worker-dispatched' &&
      cause !== 'owner-in-flight'
    ) {
      throw new Error(`Unknown Heimdall budget interval cause: ${String(cause)}`)
    }
    const ownedInterval = this.active.get(watcherId)
    if (ownedInterval) {
      if (ownedInterval.closedAtMs !== null) {
        throw new Error(
          `Heimdall budget interval ${ownedInterval.handle.intervalId} is already closed`
        )
      }
      ownedInterval.references += 1
      return ownedInterval.handle
    }
    const durableIntervals = this.foldIntervals(this.ledger.read(watcherId).entries)
    if (durableIntervals.some((interval) => interval.closedAtMs === null)) {
      throw new Error(`Heimdall watcher ${watcherId} already has an open budget interval`)
    }

    const openedAtMs = this.timestamp()
    const intervalId = this.makeIntervalId()
    if (!intervalId) {
      throw new Error('Heimdall generated an empty budget interval id')
    }
    if (durableIntervals.some((interval) => interval.handle.intervalId === intervalId)) {
      throw new Error(`Heimdall budget interval id already exists: ${intervalId}`)
    }

    const handle = Object.freeze({ watcherId, intervalId })
    this.ledger.append({
      kind: 'interval-open',
      eventId: this.eventId(),
      watcherId,
      atMs: openedAtMs,
      origin: 'owner',
      class: 'fact',
      intervalId,
      cause
    })

    const owned: OwnedInterval = {
      handle,
      openedAtMs,
      checkpointAtMs: null,
      closedAtMs: null,
      timer: setInterval(() => this.sample(watcherId), ACTIVE_TIME_CHECKPOINT_MS),
      failure: null,
      references: 1
    }
    owned.timer.unref?.()
    this.active.set(watcherId, owned)
    return handle
  }

  checkpoint(watcherId: string): void {
    this.checkpointOwned(watcherId, true)
  }

  private checkpointOwned(watcherId: string, surfacePendingFailure: boolean): void {
    this.requireWatcherId(watcherId)
    const interval = this.active.get(watcherId)
    if (!interval) {
      const durable = this.findOpenIntervals(watcherId)
      if (durable.length === 0) {
        throw new Error(`Heimdall watcher ${watcherId} has no open interval`)
      }
      throw new Error(`Heimdall watcher ${watcherId} has a stale interval requiring recovery`)
    }
    if (surfacePendingFailure && interval.failure) {
      throw interval.failure
    }
    if (interval.closedAtMs !== null) {
      throw new Error(`Heimdall budget interval ${interval.handle.intervalId} is already closed`)
    }

    const observedAtMs = this.timestamp()
    const lastDurableAtMs = interval.checkpointAtMs ?? interval.openedAtMs
    if (observedAtMs - lastDurableAtMs < ACTIVE_TIME_LEDGER_INTERVAL_MS) {
      return
    }
    const atMs = Math.max(observedAtMs, lastDurableAtMs)

    try {
      this.ledger.append({
        kind: 'interval-checkpoint',
        eventId: this.eventId(),
        watcherId,
        atMs,
        origin: 'owner',
        class: 'fact',
        intervalId: interval.handle.intervalId
      })
      interval.checkpointAtMs = atMs
      interval.failure = null
    } catch (error) {
      interval.failure = error instanceof Error ? error : new Error(String(error))
      this.retireIfDurablyClosed(interval)
      throw interval.failure
    }
  }

  close(handle: IntervalHandle, reason: IntervalCloseReason): void {
    this.closeOrRelease(handle, reason, 'strict')
  }

  release(handle: IntervalHandle, reason: IntervalCloseReason): void {
    this.closeOrRelease(handle, reason, 'tolerant')
  }

  private closeOrRelease(
    handle: IntervalHandle,
    reason: IntervalCloseReason,
    mode: 'strict' | 'tolerant'
  ): void {
    this.requireHandle(handle)
    if (reason !== 'settled' && reason !== 'contact-lost' && reason !== 'shutdown') {
      throw new Error(`Unknown Heimdall budget close reason: ${String(reason)}`)
    }

    const interval = this.active.get(handle.watcherId)
    if (!interval || interval.handle.intervalId !== handle.intervalId) {
      const durable = this.findInterval(handle.watcherId, handle.intervalId)
      if (durable?.closedAtMs != null) {
        if (mode === 'tolerant') {
          return
        }
        throw new Error(`Heimdall budget interval ${handle.intervalId} is already closed`)
      }
      throw new Error(`Heimdall budget interval ${handle.intervalId} is not owned by this clock`)
    }
    if (interval.closedAtMs !== null) {
      if (mode === 'tolerant') {
        return
      }
      throw new Error(`Heimdall budget interval ${handle.intervalId} is already closed`)
    }
    if (interval.references > 1) {
      interval.references -= 1
      return
    }
    const lastDurableAtMs = interval.checkpointAtMs ?? interval.openedAtMs
    const atMs =
      reason === 'contact-lost' ? lastDurableAtMs : Math.max(this.timestamp(), lastDurableAtMs)
    try {
      this.ledger.append({
        kind: 'interval-close',
        eventId: this.eventId(),
        watcherId: handle.watcherId,
        atMs,
        origin: 'owner',
        class: 'fact',
        intervalId: handle.intervalId,
        closeReason: reason
      })
    } catch (error) {
      const alreadyDurablyClosed = this.retireIfDurablyClosed(interval)
      if (mode === 'tolerant' && alreadyDurablyClosed) {
        return
      }
      throw error
    }
    interval.closedAtMs = atMs
    clearInterval(interval.timer)
    this.active.delete(handle.watcherId)
  }

  recoverOnStart(watcherId: string): boolean {
    this.requireWatcherId(watcherId)
    const staleIntervals = this.findOpenIntervals(watcherId)
    if (staleIntervals.length === 0) {
      return false
    }

    const owned = this.active.get(watcherId)
    if (owned) {
      clearInterval(owned.timer)
      this.active.delete(watcherId)
    }
    for (const interval of staleIntervals) {
      try {
        this.ledger.append({
          kind: 'interval-close',
          eventId: this.eventId(),
          watcherId,
          atMs: interval.checkpointAtMs ?? interval.openedAtMs,
          origin: 'owner',
          class: 'fact',
          intervalId: interval.handle.intervalId,
          closeReason: 'contact-lost'
        })
      } catch (error) {
        const durable = this.findInterval(watcherId, interval.handle.intervalId)
        if (!durable || durable.closedAtMs === null) {
          throw error
        }
      }
    }
    return true
  }

  owned(watcherId: string): IntervalHandle | null {
    this.requireWatcherId(watcherId)
    return this.active.get(watcherId)?.handle ?? null
  }

  current(watcherId: string): IntervalHandle | null {
    this.requireWatcherId(watcherId)
    const owned = this.active.get(watcherId)
    if (owned) {
      return owned.handle
    }
    return this.findOpenIntervals(watcherId)[0]?.handle ?? null
  }

  private sample(watcherId: string): void {
    try {
      this.checkpointOwned(watcherId, false)
    } catch {
      // The owned interval retains the current failure for the runner to surface. The sampler
      // stays armed so a transient persistence failure can be retried on the next sample.
    }
  }
  private retireIfDurablyClosed(interval: OwnedInterval): boolean {
    try {
      if (
        this.findInterval(interval.handle.watcherId, interval.handle.intervalId)?.closedAtMs == null
      ) {
        return false
      }
    } catch {
      return false
    }
    clearInterval(interval.timer)
    this.active.delete(interval.handle.watcherId)
    return true
  }

  private findInterval(watcherId: string, intervalId: string): DurableInterval | null {
    const intervals = this.foldIntervals(this.ledger.read(watcherId).entries)
    return intervals.find((interval) => interval.handle.intervalId === intervalId) ?? null
  }

  private findOpenIntervals(watcherId: string): DurableInterval[] {
    return this.foldIntervals(this.ledger.read(watcherId).entries).filter(
      (interval) => interval.closedAtMs === null
    )
  }

  private foldIntervals(entries: readonly LedgerEntry[]): DurableInterval[] {
    const intervals = new Map<string, DurableInterval>()
    for (const entry of entries) {
      if (entry.kind === 'interval-open') {
        if (!intervals.has(entry.intervalId)) {
          intervals.set(entry.intervalId, {
            handle: Object.freeze({ watcherId: entry.watcherId, intervalId: entry.intervalId }),
            openedAtMs: entry.atMs,
            checkpointAtMs: null,
            closedAtMs: null
          })
        }
        continue
      }
      if (entry.kind !== 'interval-checkpoint' && entry.kind !== 'interval-close') {
        continue
      }
      const interval = intervals.get(entry.intervalId)
      if (!interval || interval.closedAtMs !== null) {
        continue
      }
      if (entry.kind === 'interval-checkpoint') {
        interval.checkpointAtMs = Math.max(
          interval.checkpointAtMs ?? interval.openedAtMs,
          entry.atMs
        )
      } else {
        interval.closedAtMs = entry.atMs
      }
    }
    return [...intervals.values()]
  }

  private eventId(): string {
    const eventId = this.makeEventId()
    if (!eventId) {
      throw new Error('Heimdall generated an empty ledger event id')
    }
    return eventId
  }

  private timestamp(): number {
    const atMs = this.now()
    if (!Number.isSafeInteger(atMs) || atMs < 0) {
      throw new Error('Heimdall budget clock requires a non-negative integer timestamp')
    }
    return atMs
  }

  private requireWatcherId(watcherId: string): void {
    if (!watcherId) {
      throw new Error('A watcher id is required')
    }
  }

  private requireHandle(handle: IntervalHandle): void {
    if (!handle.watcherId || !handle.intervalId) {
      throw new Error('A complete Heimdall budget interval handle is required')
    }
  }
}
