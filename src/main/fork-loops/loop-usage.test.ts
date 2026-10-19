import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'
import { readUsageLimit, readUsageTotals, usageDelta, type LoopUsageDeps } from './loop-usage'

function usageDeps(overrides: Partial<LoopUsageDeps> = {}): LoopUsageDeps {
  return {
    isSshWorktree: () => false,
    getProviderSessionIdentities: () => [
      { paneKey: 'tab-1:pane-1', sessionId: 'sess-a', worktreeId: 'wt-1' },
      { paneKey: 'tab-2:pane-1', sessionId: 'sess-other', worktreeId: 'wt-2' }
    ],
    readSessionTotals: async () => ({ costUsd: 1.5, totalTokens: 900 }),
    ...overrides
  }
}

describe('readUsageTotals', () => {
  it('pins the provider session of the pane and returns its cumulative totals', async () => {
    const readSessionTotals = vi.fn(async () => ({ costUsd: 1.5, totalTokens: 900 }))
    const totals = await readUsageTotals(
      'tab-1:pane-1',
      'wt-1',
      'claude',
      usageDeps({ readSessionTotals })
    )
    expect(totals).toEqual({ providerSessionId: 'sess-a', costUsd: 1.5, totalTokens: 900 })
    expect(readSessionTotals).toHaveBeenCalledWith({
      provider: 'claude',
      sessionId: 'sess-a',
      worktreeId: 'wt-1'
    })
  })

  it('supports codex', async () => {
    const totals = await readUsageTotals('tab-1:pane-1', 'wt-1', 'codex', usageDeps())
    expect(totals?.providerSessionId).toBe('sess-a')
  })

  it('returns null for agents other than claude and codex', async () => {
    expect(await readUsageTotals('tab-1:pane-1', 'wt-1', 'gemini', usageDeps())).toBeNull()
  })

  it('returns null on an SSH worktree without reading local usage', async () => {
    const readSessionTotals = vi.fn()
    const totals = await readUsageTotals(
      'tab-1:pane-1',
      'wt-1',
      'claude',
      usageDeps({ isSshWorktree: () => true, readSessionTotals })
    )
    expect(totals).toBeNull()
    expect(readSessionTotals).not.toHaveBeenCalled()
  })

  it('returns null when the pane has no provider session yet', async () => {
    expect(await readUsageTotals('tab-9:pane-1', 'wt-1', 'claude', usageDeps())).toBeNull()
  })

  it('returns null when usage tracking is off or the reader fails', async () => {
    expect(
      await readUsageTotals(
        'tab-1:pane-1',
        'wt-1',
        'claude',
        usageDeps({ readSessionTotals: async () => null })
      )
    ).toBeNull()
    expect(
      await readUsageTotals(
        'tab-1:pane-1',
        'wt-1',
        'claude',
        usageDeps({
          readSessionTotals: async () => {
            throw new Error('scan failed')
          }
        })
      )
    ).toBeNull()
  })
})

describe('usageDelta', () => {
  const at = (cost: number | null, tokens: number, id = 'sess-a') => ({
    providerSessionId: id,
    costUsd: cost,
    totalTokens: tokens
  })

  it('subtracts the earlier totals from the later ones', () => {
    expect(usageDelta(at(1, 100), at(1.75, 340))).toEqual({ costUsd: 0.75, totalTokens: 240 })
  })

  it('treats a different session as a fresh counter', () => {
    expect(usageDelta(at(9, 900, 'old'), at(0.5, 50, 'new'))).toEqual({
      costUsd: 0.5,
      totalTokens: 50
    })
  })

  it('is unknown when either side is unavailable', () => {
    expect(usageDelta(null, at(1, 1))).toBeNull()
    expect(usageDelta(at(1, 1), null)).toBeNull()
  })

  it('keeps cost unknown when the provider reports no cost', () => {
    expect(usageDelta(at(null, 10), at(null, 30))).toEqual({ costUsd: null, totalTokens: 20 })
  })

  it('never reports a negative delta', () => {
    expect(usageDelta(at(2, 200), at(1, 100))).toEqual({ costUsd: 0, totalTokens: 0 })
  })
})

function limits(overrides: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function window(usedPercent: number, resetsAt: number | null) {
  return { usedPercent, windowMinutes: 300, resetsAt, resetDescription: null }
}

function stateWith(entry: Partial<RateLimitState>): RateLimitState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture sets only the provider rows the reader looks at.
  return entry as RateLimitState
}

describe('readUsageLimit', () => {
  const now = 1_000_000

  it('reports a window at 100 percent with its reset time', () => {
    const result = readUsageLimit('claude', {
      getRateLimitState: () =>
        stateWith({ claude: limits({ session: window(100, now + 60_000) }) }),
      now: () => now
    })
    expect(result).toEqual({ provider: 'claude', resetsAt: now + 60_000 })
  })

  it('reports a window past 100 percent', () => {
    const result = readUsageLimit('codex', {
      getRateLimitState: () =>
        stateWith({ codex: limits({ provider: 'codex', weekly: window(104, now + 5) }) }),
      now: () => now
    })
    expect(result).toEqual({ provider: 'codex', resetsAt: now + 5 })
  })

  it('is null below 100 percent', () => {
    const result = readUsageLimit('claude', {
      getRateLimitState: () =>
        stateWith({ claude: limits({ session: window(99.9, now + 1), weekly: window(10, now) }) }),
      now: () => now
    })
    expect(result).toBeNull()
  })

  it('waits for the latest reset when several windows are exhausted', () => {
    const result = readUsageLimit('claude', {
      getRateLimitState: () =>
        stateWith({
          claude: limits({ session: window(100, now + 10), weekly: window(100, now + 500) })
        }),
      now: () => now
    })
    expect(result?.resetsAt).toBe(now + 500)
  })

  it('has no resume time when an exhausted window reports no reset', () => {
    const result = readUsageLimit('claude', {
      getRateLimitState: () =>
        stateWith({ claude: limits({ session: window(100, null), weekly: window(100, now + 5) }) }),
      now: () => now
    })
    expect(result).toEqual({ provider: 'claude', resetsAt: null })
  })

  it('ignores an exhausted window whose reset time has already passed', () => {
    const result = readUsageLimit('claude', {
      getRateLimitState: () => stateWith({ claude: limits({ session: window(100, now - 1) }) }),
      now: () => now
    })
    expect(result).toBeNull()
  })

  it('is null for other agents, missing provider state, or a failing service', () => {
    const deps = {
      getRateLimitState: () => stateWith({ claude: null }),
      now: () => now
    }
    expect(readUsageLimit('claude', deps)).toBeNull()
    expect(readUsageLimit('gemini', deps)).toBeNull()
    expect(
      readUsageLimit('claude', {
        getRateLimitState: () => {
          throw new Error('service down')
        }
      })
    ).toBeNull()
  })
})
