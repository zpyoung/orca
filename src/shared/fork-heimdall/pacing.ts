import { z } from 'zod'

export const HEIMDALL_RAPID_POLL_MS = 15_000
export const HEIMDALL_ACTIVE_POLL_MS = 60_000
export const HEIMDALL_IDLE_POLL_MS = 5 * 60_000
export const HEIMDALL_FULL_RESYNC_MS = 15 * 60_000
export const HEIMDALL_ERROR_BACKOFF_BASE_MS = 30_000
export const HEIMDALL_ERROR_BACKOFF_MAX_MS = 15 * 60_000

export const PacingTierSchema = z.enum(['rapid', 'active', 'idle', 'stopped'])
export type PacingTier = z.infer<typeof PacingTierSchema>

export const PacingInputSchema = z
  .object({
    consecutiveErrors: z.number().int().nonnegative(),
    lastFullResyncAtMs: z.number().int().nonnegative().nullable(),
    evaluatedAtMs: z.number().int().nonnegative()
  })
  .strict()
export type PacingInput = z.infer<typeof PacingInputSchema>

export const PacingDecisionSchema = z
  .object({
    tier: PacingTierSchema,
    delayMs: z.number().int().nonnegative().nullable(),
    stateDelayMs: z.number().int().nonnegative().nullable(),
    errorBackoffMs: z.number().int().nonnegative().nullable(),
    fullResyncDue: z.boolean(),
    nextFullResyncInMs: z.number().int().nonnegative()
  })
  .strict()
export type PacingDecision = z.infer<typeof PacingDecisionSchema>

export function errorBackoffMs(consecutiveErrors: number): number | null {
  if (consecutiveErrors <= 0) {
    return null
  }
  const exponent = Math.min(Math.max(0, consecutiveErrors - 1), 5)
  return Math.min(HEIMDALL_ERROR_BACKOFF_MAX_MS, HEIMDALL_ERROR_BACKOFF_BASE_MS * 2 ** exponent)
}

export function derivePacing(tier: PacingTier, input: PacingInput): PacingDecision {
  const delays: Record<PacingTier, number | null> = {
    rapid: HEIMDALL_RAPID_POLL_MS,
    active: HEIMDALL_ACTIVE_POLL_MS,
    idle: HEIMDALL_IDLE_POLL_MS,
    stopped: null
  }
  const stateDelayMs = delays[tier]
  const backoffMs = errorBackoffMs(input.consecutiveErrors)
  const elapsedSinceFullResync =
    input.lastFullResyncAtMs === null
      ? HEIMDALL_FULL_RESYNC_MS
      : Math.max(0, input.evaluatedAtMs - input.lastFullResyncAtMs)
  const nextFullResyncInMs = Math.max(0, HEIMDALL_FULL_RESYNC_MS - elapsedSinceFullResync)
  const delayMs =
    stateDelayMs === null
      ? null
      : backoffMs === null
        ? stateDelayMs
        : Math.max(stateDelayMs, backoffMs)

  return {
    tier,
    delayMs,
    stateDelayMs,
    errorBackoffMs: backoffMs,
    fullResyncDue: nextFullResyncInMs === 0,
    nextFullResyncInMs
  }
}
