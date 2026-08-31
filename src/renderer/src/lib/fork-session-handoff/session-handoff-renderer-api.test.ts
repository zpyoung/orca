import { afterEach, describe, expect, it, vi } from 'vitest'
import { getForkSessionHandoffApi } from './session-handoff-renderer-api'

describe('getForkSessionHandoffApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the fork-owned preload API', () => {
    const forkSessionHandoff = {
      lineageList: vi.fn(),
      lineageRecord: vi.fn(),
      lineageEnrich: vi.fn()
    }
    vi.stubGlobal('window', { api: { forkSessionHandoff } })

    expect(getForkSessionHandoffApi()).toBe(forkSessionHandoff)
  })

  it('fails clearly when the preload API is unavailable', () => {
    vi.stubGlobal('window', { api: {} })

    expect(() => getForkSessionHandoffApi()).toThrow('Session handoff API is unavailable')
  })
})
