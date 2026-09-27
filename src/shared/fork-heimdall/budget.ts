import { z } from 'zod'
import type { WatcherLedger } from './ledger-types'

export const HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND = 'budget-generation'

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

function budgetGenerationStartIndex(ledger: WatcherLedger): number {
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (
      entry?.kind === 'evidence' &&
      entry.evidenceKind === HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND
    ) {
      return index + 1
    }
  }
  return 0
}

export function attemptPredatesCurrentBudgetGeneration(
  ledger: WatcherLedger,
  attemptId: string
): boolean {
  const startIndex = budgetGenerationStartIndex(ledger)
  for (let index = 0; index < startIndex; index += 1) {
    const entry = ledger.entries[index]!
    if (entry.kind === 'attempt' && entry.attemptId === attemptId) {
      return true
    }
  }
  return false
}

function wallClockActiveMsSince(ledger: WatcherLedger, startIndex: number): number {
  const intervals = new Map<string, IntervalState>()
  for (let index = startIndex; index < ledger.entries.length; index += 1) {
    const entry = ledger.entries[index]!
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

function turnsUsedSince(ledger: WatcherLedger, startIndex: number): number {
  const previousAttemptIds = new Set<string>()
  for (let index = 0; index < startIndex; index += 1) {
    const entry = ledger.entries[index]!
    if (entry.kind === 'attempt') {
      previousAttemptIds.add(entry.attemptId)
    }
  }

  const dispatchIds = new Set<string>()
  for (let index = startIndex; index < ledger.entries.length; index += 1) {
    const entry = ledger.entries[index]!
    if (
      entry.kind === 'turn' &&
      (entry.attemptId === undefined || !previousAttemptIds.has(entry.attemptId))
    ) {
      dispatchIds.add(entry.dispatchId)
    }
  }
  return dispatchIds.size
}

export function getWallClockActiveMs(ledger: WatcherLedger): number {
  return wallClockActiveMsSince(ledger, budgetGenerationStartIndex(ledger))
}

export function deriveBudgetState(ledger: WatcherLedger, policy: BudgetPolicy): BudgetState {
  const startIndex = budgetGenerationStartIndex(ledger)
  const activeMs = wallClockActiveMsSince(ledger, startIndex)
  const turns = turnsUsedSince(ledger, startIndex)
  const exhausted =
    policy.wallClockActiveMs !== null && activeMs >= policy.wallClockActiveMs
      ? ({ kind: 'wall-clock' } as const)
      : policy.turns !== null && turns >= policy.turns
        ? ({ kind: 'turns' } as const)
        : null
  return { activeMs, turns, exhausted }
}
