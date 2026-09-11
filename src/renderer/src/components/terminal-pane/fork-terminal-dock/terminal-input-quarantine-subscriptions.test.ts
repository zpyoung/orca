import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine,
  isTerminalInputQuarantined,
  shouldDropQuarantinedTerminalInput,
  subscribeTerminalInputQuarantine
} from '../terminal-input-quarantine'

const TAB = 'tab-1'
// Re-attach measured at ~1.1s in STA-2373 live QA; the tail lands just after.
const REATTACH_MS = 1_100

beforeEach(() => {
  _resetTerminalInputQuarantineForTests()
})

describe('terminal input quarantine subscriptions', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires cb(true) on arm and cb(false) when the terminator releases it', () => {
    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS)).toBe(true)
    expect(events).toEqual([true, false])
  })

  it('fires cb(true) immediately for a tab that is already armed', () => {
    armTerminalInputQuarantine(TAB, 0)
    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    expect(events).toEqual([true])
  })

  it('fires cb(false) when the idle gap releases quarantine', () => {
    armTerminalInputQuarantine(TAB, 0)
    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    expect(shouldDropQuarantinedTerminalInput(TAB, 'c', REATTACH_MS)).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'l', REATTACH_MS + 700)).toBe(false)
    expect(events).toEqual([true, false])
  })

  it('fires cb(false) when the absolute cap releases quarantine', () => {
    armTerminalInputQuarantine(TAB, 0)
    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    expect(shouldDropQuarantinedTerminalInput(TAB, 'a', 5_000)).toBe(false)
    expect(events).toEqual([true, false])
  })

  it('fires cb(false) for a tab pruned by another tab arming', () => {
    armTerminalInputQuarantine('closed-tab', 0)
    const events: boolean[] = []
    subscribeTerminalInputQuarantine('closed-tab', (armed) => events.push(armed))
    armTerminalInputQuarantine(TAB, 5_000)
    expect(events).toEqual([true, false])
  })

  it('notifies every subscriber, and unsubscribing one leaves the others intact', () => {
    const a: boolean[] = []
    const b: boolean[] = []
    const unsubscribeA = subscribeTerminalInputQuarantine(TAB, (armed) => a.push(armed))
    subscribeTerminalInputQuarantine(TAB, (armed) => b.push(armed))
    armTerminalInputQuarantine(TAB, 0)
    unsubscribeA()
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS)).toBe(true)
    expect(a).toEqual([true])
    expect(b).toEqual([true, false])
  })

  it('stops notifying once unsubscribed', () => {
    const events: boolean[] = []
    const unsubscribe = subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    unsubscribe()
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS)).toBe(true)
    expect(events).toEqual([])
  })

  it('releases via the expiry timer when no further input ever arrives', () => {
    vi.useFakeTimers()
    armTerminalInputQuarantine(TAB)
    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    vi.advanceTimersByTime(4_999)
    expect(events).toEqual([true])
    expect(isTerminalInputQuarantined(TAB)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(events).toEqual([true, false])
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  // Proves the first arm's timer was actually cancelled, not just outraced: it
  // would otherwise fire at fake-time 5_000, between the two assertions below.
  it('clears the expiry timer on release so a released-then-rearmed tab does not fire early', () => {
    vi.useFakeTimers()
    armTerminalInputQuarantine(TAB, 0)
    vi.advanceTimersByTime(3_000)
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', 3_000)).toBe(true)
    armTerminalInputQuarantine(TAB, 3_000)
    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    vi.advanceTimersByTime(2_000)
    expect(events).toEqual([true])
    expect(isTerminalInputQuarantined(TAB)).toBe(true)
    vi.advanceTimersByTime(3_000)
    expect(events).toEqual([true, false])
  })

  it('clears pending timers and subscribers on test reset', () => {
    vi.useFakeTimers()
    armTerminalInputQuarantine(TAB, 0)
    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    _resetTerminalInputQuarantineForTests()
    vi.advanceTimersByTime(5_000)
    expect(events).toEqual([true])
  })

  it('still notifies remaining listeners and returns the correct decision when one throws', () => {
    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => {
      if (!armed) {
        throw new Error('boom')
      }
    })
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS)).toBe(true)
    expect(events).toEqual([true, false])
  })

  it('returns the same decision whether or not a throwing listener is subscribed', () => {
    const bare = shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS)
    armTerminalInputQuarantine(TAB, 0)
    const withoutListener = shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS)

    _resetTerminalInputQuarantineForTests()
    subscribeTerminalInputQuarantine(TAB, () => {
      throw new Error('boom')
    })
    armTerminalInputQuarantine(TAB, 0)
    const withListener = shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS)

    expect(withListener).toBe(withoutListener)
    expect(bare).toBe(false)
  })

  it('still notifies a listener removed mid-dispatch by another listener', () => {
    const events: boolean[] = []
    let unsubscribeB: () => void = () => {}
    subscribeTerminalInputQuarantine(TAB, (armed) => {
      if (!armed) {
        unsubscribeB()
      }
    })
    unsubscribeB = subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS)).toBe(true)
    expect(events).toEqual([true, false])
  })

  it('isolates a throwing subscriber on the immediate already-armed notification', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(() =>
      subscribeTerminalInputQuarantine(TAB, () => {
        throw new Error('boom')
      })
    ).not.toThrow()

    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS)).toBe(true)
    expect(events).toEqual([true, false])
  })

  it('isolates a throwing listener on the expiry timer path too', () => {
    vi.useFakeTimers()
    subscribeTerminalInputQuarantine(TAB, (armed) => {
      if (!armed) {
        throw new Error('boom')
      }
    })
    const events: boolean[] = []
    subscribeTerminalInputQuarantine(TAB, (armed) => events.push(armed))
    armTerminalInputQuarantine(TAB)
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
    expect(events).toEqual([true, false])
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })
})
