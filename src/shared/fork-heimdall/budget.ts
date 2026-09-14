import { z } from 'zod'
import type { WatcherLedger } from './ledger-types'

const LimitSchema = z.number().int().nonnegative().nullable()

export const BudgetPolicySchema = z
  .object({
    wallClockActiveMs: LimitSchema,
    turns: LimitSchema
  })
  .strict()
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>

export const BudgetExhaustionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wall-clock') }).strict(),
  z.object({ kind: z.literal('turns') }).strict()
])
export type BudgetExhaustion = z.infer<typeof BudgetExhaustionSchema>

export const BudgetStateSchema = z
  .object({
    activeMs: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    exhausted: BudgetExhaustionSchema.nullable()
  })
  .strict()
export type BudgetState = z.infer<typeof BudgetStateSchema>

type IntervalState = {
  openedAtMs: number
  checkpointAtMs: number | null
  closedAtMs: number | null
}

export function getWallClockActiveMs(ledger: WatcherLedger): number {
  const intervals = new Map<string, IntervalState>()
  for (const entry of ledger.entries) {
    if (entry.kind === 'interval-open' && !intervals.has(entry.intervalId)) {
      intervals.set(entry.intervalId, {
        openedAtMs: entry.atMs,
        checkpointAtMs: null,
        closedAtMs: null
      })
      continue
    }
    const interval =
      entry.kind === 'interval-checkpoint' || entry.kind === 'interval-close'
        ? intervals.get(entry.intervalId)
        : undefined
    if (!interval || interval.closedAtMs !== null) {
      continue
    }
    if (entry.kind === 'interval-checkpoint') {
      interval.checkpointAtMs = Math.max(interval.checkpointAtMs ?? interval.openedAtMs, entry.atMs)
    } else if (entry.kind === 'interval-close') {
      interval.closedAtMs =
        entry.closeReason === 'contact-lost'
          ? (interval.checkpointAtMs ?? interval.openedAtMs)
          : Math.max(interval.checkpointAtMs ?? interval.openedAtMs, entry.atMs)
    }
  }

  let activeMs = 0
  for (const interval of intervals.values()) {
    const accountedThrough = interval.closedAtMs ?? interval.checkpointAtMs ?? interval.openedAtMs
    activeMs += Math.max(0, accountedThrough - interval.openedAtMs)
  }
  return activeMs
}

export function getTurnsUsed(ledger: WatcherLedger): number {
  const dispatchIds = new Set<string>()
  for (const entry of ledger.entries) {
    if (entry.kind === 'turn') {
      dispatchIds.add(entry.dispatchId)
    }
  }
  return dispatchIds.size
}

export function deriveBudgetState(ledger: WatcherLedger, policy: BudgetPolicy): BudgetState {
  const activeMs = getWallClockActiveMs(ledger)
  const turns = getTurnsUsed(ledger)
  const exhausted =
    policy.wallClockActiveMs !== null && activeMs >= policy.wallClockActiveMs
      ? ({ kind: 'wall-clock' } as const)
      : policy.turns !== null && turns >= policy.turns
        ? ({ kind: 'turns' } as const)
        : null
  return { activeMs, turns, exhausted }
}
