import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import {
  isTerminalUserInputFromKeyboard,
  primeTerminalUserInputKeyboardGate
} from './keyboard-input-gate'

describe('primeTerminalUserInputKeyboardGate', () => {
  it('does not throw for a double without onKey', () => {
    const terminal = {} as Terminal
    expect(() => primeTerminalUserInputKeyboardGate(terminal)).not.toThrow()
  })

  it('does not throw when the element lacks addEventListener', () => {
    const terminal = {
      onKey: vi.fn(),
      element: {}
    } as unknown as Terminal
    expect(() => primeTerminalUserInputKeyboardGate(terminal)).not.toThrow()
  })

  it('still gates a real-shaped terminal', () => {
    const listeners = new Map<string, (event: Event) => void>()
    let onKeyHandler: ((event: { domEvent: Event }) => void) | undefined

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

    const keydown = { isTrusted: true, eventPhase: 2 } as unknown as Event
    listeners.get('keydown')?.(keydown)

    expect(isTerminalUserInputFromKeyboard(terminal)).toBe(true)
    expect(isTerminalUserInputFromKeyboard(terminal)).toBe(false)

    expect(onKeyHandler).toBeDefined()
    const trustedDomEvent = { isTrusted: true, eventPhase: 2 } as unknown as Event
    onKeyHandler?.({ domEvent: trustedDomEvent })

    expect(isTerminalUserInputFromKeyboard(terminal)).toBe(true)
  })
})
