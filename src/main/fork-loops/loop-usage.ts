import type { TuiAgent } from '../../shared/tui-agent'
import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'
import type { UsageTotals } from '../../shared/fork-loops/loop-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'

export type LoopUsageProvider = 'claude' | 'codex'

export type LoopSessionTotals = { costUsd: number | null; totalTokens: number }

export type LoopUsageDeps = {
  isSshWorktree(worktreeId: string): boolean
  getProviderSessionIdentities(): { paneKey: string; sessionId: string; worktreeId?: string }[]
  /** Null when usage tracking is off or the session is not in the scan. */
  readSessionTotals(args: {
    provider: LoopUsageProvider
    sessionId: string
    worktreeId: string
  }): Promise<LoopSessionTotals | null>
}

export type LoopUsageLimitDeps = {
  getRateLimitState(): RateLimitState
  now?(): number
}

function usageProviderFor(agent: string): LoopUsageProvider | null {
  return agent === 'claude' || agent === 'codex' ? agent : null
}

/**
 * Cumulative usage of the provider session the pane is running, pinned from the hook server's
 * session identities. Null on SSH hosts, for agents other than Claude and Codex, when tracking is
 * off, or on any read failure, so the UI hides cost instead of showing a wrong one.
 */
export async function readUsageTotals(
  paneKey: string,
  worktreeId: string,
  agent: TuiAgent,
  deps: LoopUsageDeps
): Promise<UsageTotals | null> {
  const provider = usageProviderFor(agent)
  if (!provider) {
    return null
  }
  try {
    if (deps.isSshWorktree(worktreeId)) {
      return null
    }
    const identity = deps
      .getProviderSessionIdentities()
      .findLast(
        (entry) =>
          entry.paneKey === paneKey &&
          (entry.worktreeId === undefined || entry.worktreeId === worktreeId)
      )
    if (!identity) {
      return null
    }
    const totals = await deps.readSessionTotals({
      provider,
      sessionId: identity.sessionId,
      worktreeId
    })
    return totals ? { providerSessionId: identity.sessionId, ...totals } : null
  } catch {
    return null
  }
}

/**
 * Usage earned between two reads of the same pane. A changed session id means the agent was
 * relaunched, so the later total already is the iteration's own.
 */
export function usageDelta(
  before: UsageTotals | null,
  after: UsageTotals | null
): LoopSessionTotals | null {
  if (!before || !after) {
    return null
  }
  if (before.providerSessionId !== after.providerSessionId) {
    return { costUsd: after.costUsd, totalTokens: after.totalTokens }
  }
  return {
    costUsd:
      before.costUsd === null || after.costUsd === null
        ? null
        : Math.max(0, roundCost(after.costUsd - before.costUsd)),
    totalTokens: Math.max(0, after.totalTokens - before.totalTokens)
  }
}

function roundCost(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

function exhaustedWindows(limits: ProviderRateLimits, now: number): (number | null)[] {
  // the Fable-only weekly window is skipped: it gates one model, not the whole provider
  const windows = [limits.session, limits.weekly, limits.monthly, ...(limits.buckets ?? [])]
  const resets: (number | null)[] = []
  for (const window of windows) {
    if (!window || window.usedPercent < 100) {
      continue
    }
    if (window.resetsAt !== null && window.resetsAt <= now) {
      continue
    }
    resets.push(window.resetsAt)
  }
  return resets
}

/**
 * The usage limit currently blocking the agent's provider, or null. When several windows are
 * exhausted the loop must wait for the last one to reset, and any window with no known reset
 * leaves `resetsAt` null so the service never auto-resumes into a wall.
 */
export function readUsageLimit(
  provider: string,
  deps: LoopUsageLimitDeps
): { provider: LoopUsageProvider; resetsAt: number | null } | null {
  const limitProvider = usageProviderFor(provider)
  if (!limitProvider) {
    return null
  }
  try {
    const limits = deps.getRateLimitState()[limitProvider]
    if (!limits) {
      return null
    }
    const resets = exhaustedWindows(limits, deps.now?.() ?? Date.now())
    if (resets.length === 0) {
      return null
    }
    const known = resets.filter((value): value is number => value !== null)
    return {
      provider: limitProvider,
      resetsAt: known.length === resets.length ? Math.max(...known) : null
    }
  } catch {
    return null
  }
}

/**
 * Reads one provider session's cumulative totals from the Claude and Codex usage scans.
 * The lookup window is pushed past every session so only the pinned session id can match.
 */
export function createLoopSessionTotalsReader(stores: {
  claudeUsage: ClaudeUsageStore | null
  codexUsage: CodexUsageStore | null
}): LoopUsageDeps['readSessionTotals'] {
  return async ({ provider, sessionId, worktreeId }) => {
    const store = provider === 'claude' ? stores.claudeUsage : stores.codexUsage
    if (!store) {
      return null
    }
    const completedAt = Date.now()
    const usage = await store.getAutomationRunUsage({
      worktreeId,
      terminalSessionId: sessionId,
      startedAt: completedAt + 365 * 24 * 60 * 60 * 1000,
      completedAt
    })
    if (usage.status !== 'known') {
      return null
    }
    return { costUsd: usage.estimatedCostUsd, totalTokens: usage.totalTokens ?? 0 }
  }
}
