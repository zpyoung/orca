import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import {
  isTerminalUserInputFromKeyboard,
  primeTerminalUserInputKeyboardGate
} from './keyboard-input-gate'

describe('primeTerminalUserInputKeyboardGate', () => {
  it('does not throw for a double without onKey', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's Terminal is a large external class; this double only needs to fail the `typeof onKey === 'function'` guard.
    const terminal = {} as Terminal
    expect(() => primeTerminalUserInputKeyboardGate(terminal)).not.toThrow()
  })

  it('does not throw when the element lacks addEventListener', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's Terminal is a large external class; this double only needs onKey/element to exercise the addEventListener guard.
    const terminal = {
      onKey: vi.fn(),
      element: {}
    } as unknown as Terminal
    expect(() => primeTerminalUserInputKeyboardGate(terminal)).not.toThrow()
  })

  it('still gates a real-shaped terminal', () => {
    const listeners = new Map<string, (event: Event) => void>()
    let onKeyHandler: ((event: { domEvent: Event }) => void) | undefined

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm's Terminal is a large external class; this double only needs onKey/element.addEventListener, which is all the gate reads.
    const terminal = {
      onKey: vi.fn((handler: (event: { domEvent: Event }) => void) => {
        onKeyHandler = handler
      }),
      element: {
        addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
          listeners.set(type, listener)
        })
      }
    } as unknown as Terminal

    primeTerminalUserInputKeyboardGate(terminal)

    expect(isTerminalUserInputFromKeyboard(terminal)).toBe(false)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `isTrusted`/`eventPhase` are readonly on a real DOM Event and unsettable via its constructor; a literal is the only way to fake mid-dispatch.
    const keydown = { isTrusted: true, eventPhase: 2 } as unknown as Event
    listeners.get('keydown')?.(keydown)

    expect(isTerminalUserInputFromKeyboard(terminal)).toBe(true)
    expect(isTerminalUserInputFromKeyboard(terminal)).toBe(false)

    expect(onKeyHandler).toBeDefined()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `isTrusted`/`eventPhase` are readonly on a real DOM Event and unsettable via its constructor; a literal is the only way to fake mid-dispatch.
    const trustedDomEvent = { isTrusted: true, eventPhase: 2 } as unknown as Event
    onKeyHandler?.({ domEvent: trustedDomEvent })

    expect(isTerminalUserInputFromKeyboard(terminal)).toBe(true)
  })
})
