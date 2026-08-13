import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine,
  isTerminalInputQuarantined,
  shouldDropQuarantinedTerminalInput,
  subscribeTerminalInputQuarantine
} from './terminal-input-quarantine'

const TAB = 'tab-1'
// Re-attach measured at ~1.1s in STA-2373 live QA; the tail lands just after.
const REATTACH_MS = 1_100

beforeEach(() => {
  _resetTerminalInputQuarantineForTests()
})

describe('terminal input quarantine', () => {
  it('passes input through when nothing is armed', () => {
    expect(shouldDropQuarantinedTerminalInput(TAB, 'e', 0)).toBe(false)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('drops the surviving tail of an interrupted line and its Enter', () => {
    armTerminalInputQuarantine(TAB, 0)
    // The tail of `echo hi; rm -rf x` after the head was eaten by recovery.
    let at = REATTACH_MS
    for (const char of 'cho hi; rm -rf x') {
      expect(shouldDropQuarantinedTerminalInput(TAB, char, at)).toBe(true)
      at += 30
    }
    // The user's own Enter would have submitted the mangled line.
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', at)).toBe(true)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('lets the next command through once the terminator disarmed it', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'x', REATTACH_MS)).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', REATTACH_MS + 30)).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'l', REATTACH_MS + 60)).toBe(false)
  })

  it.each([
    ['carriage return', '\r'],
    ['newline', '\n'],
    ['ctrl-c', '\x03']
  ])('treats %s as the line terminator', (_label, terminator) => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, terminator, REATTACH_MS)).toBe(true)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('drops a pasted tail that carries its terminator mid-chunk', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'cho hi; rm -rf x\r', REATTACH_MS)).toBe(true)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('releases on an idle gap once a quarantined byte has been seen', () => {
    armTerminalInputQuarantine(TAB, 0)
    // Burst tail, no Enter — the user was still mid-line when the endpoint died.
    expect(shouldDropQuarantinedTerminalInput(TAB, 'c', REATTACH_MS)).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'h', REATTACH_MS + 40)).toBe(true)
    // Then they notice, pause, and type a real command.
    expect(shouldDropQuarantinedTerminalInput(TAB, 'l', REATTACH_MS + 40 + 700)).toBe(false)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  // The accepted cost of the cap, pinned so it is not "fixed" by shortening it:
  // over-quarantine is visible (nothing echoes) and recoverable by retyping,
  // while under-quarantine executes half a command. A tail takes seconds to
  // type, so a cap short enough to spare this command would cut that tail
  // mid-line and deliver its remainder to the fresh shell.
  it('eats a fresh command typed inside the cap, terminator included', () => {
    armTerminalInputQuarantine(TAB, 0)
    // No byte yet, so the idle gate cannot release the first keystroke however
    // long the user waited; from there normal typing never opens a 700ms gap.
    let at = 1_500
    for (const char of 'ls -la\r') {
      expect(shouldDropQuarantinedTerminalInput(TAB, char, at)).toBe(true)
      at += 150
    }
  })

  it('does not let the idle gate fire on the re-attach delay itself', () => {
    armTerminalInputQuarantine(TAB, 0)
    // First quarantined byte arrives well past the idle window, because the
    // remount itself took that long. It is still the interrupted line.
    expect(shouldDropQuarantinedTerminalInput(TAB, 'c', REATTACH_MS)).toBe(true)
  })

  it('releases at the absolute cap so input can never wedge', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'a', 4_999)).toBe(true)
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'a', 5_000)).toBe(false)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('keeps quarantine per tab', () => {
    armTerminalInputQuarantine(TAB, 0)
    expect(shouldDropQuarantinedTerminalInput('tab-2', 'a', REATTACH_MS)).toBe(false)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'a', REATTACH_MS)).toBe(true)
  })

  it('prunes expired entries for tabs that closed mid-quarantine', () => {
    armTerminalInputQuarantine('closed-tab', 0)
    armTerminalInputQuarantine(TAB, 5_000)
    expect(isTerminalInputQuarantined('closed-tab')).toBe(false)
    expect(isTerminalInputQuarantined(TAB)).toBe(true)
  })
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
