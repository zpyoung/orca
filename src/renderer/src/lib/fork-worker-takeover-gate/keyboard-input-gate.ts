import type { Terminal } from '@xterm/xterm'

const XTERM_COMPOSITION_SESSION_END_EVENT = 'xterm-composition-session-end'

type TerminalKeyboardInputGate = {
  event: Event | null
}

const keyboardInputGates = new WeakMap<Terminal, TerminalKeyboardInputGate>()

/** Records only event-scoped keyboard/text provenance from one xterm. */
export function primeTerminalUserInputKeyboardGate(terminal: Terminal): void {
  if (keyboardInputGates.has(terminal)) {
    return
  }

  // test doubles without a real xterm shape must be tolerated, not crash the caller
  if (typeof terminal.onKey !== 'function') {
    return
  }
  if (terminal.element && typeof terminal.element.addEventListener !== 'function') {
    return
  }

  const gate: TerminalKeyboardInputGate = { event: null }
  keyboardInputGates.set(terminal, gate)

  terminal.onKey(({ domEvent }) => {
    if (domEvent.isTrusted) {
      gate.event = domEvent
    }
  })

  const element = terminal.element
  if (!element) {
    return
  }
  const rememberTrustedInput = (event: Event): void => {
    if (event.isTrusted) {
      gate.event = event
    }
  }

  // Capture precedes xterm's synchronous textarea encoding. The IME route
  // likewise calls Terminal.input while its custom commit event is dispatching.
  element.addEventListener('keydown', rememberTrustedInput, true)
  element.addEventListener('keypress', rememberTrustedInput, true)
  element.addEventListener('keyup', rememberTrustedInput, true)
  element.addEventListener('input', rememberTrustedInput, true)
  element.addEventListener('paste', rememberTrustedInput, true)
  element.addEventListener(
    XTERM_COMPOSITION_SESSION_END_EVENT,
    (event) => {
      gate.event = event
    },
    true
  )
}

/** Consumes input provenance only while its originating event is still dispatching. */
export function isTerminalUserInputFromKeyboard(terminal: Terminal): boolean {
  const gate = keyboardInputGates.get(terminal)
  if (!gate?.event || gate.event.eventPhase === Event.NONE) {
    return false
  }
  gate.event = null
  return true
}
