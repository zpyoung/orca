export type TerminalDockFocusState = {
  docked: boolean
  passthroughActive: boolean
}

export type TerminalDockFocusAction = 'focus-composer' | 'focus-terminal' | null

/** Resolves which surface should claim keyboard focus across a dock/passthrough state
 *  change — docking and passthrough exit hand focus to the composer, undocking always
 *  returns it to xterm (checked first: an undock mid-passthrough must still return focus
 *  to the terminal, not the composer it's leaving docked mode without). */
export function resolveTerminalDockFocusTransition(
  previous: TerminalDockFocusState,
  next: TerminalDockFocusState
): TerminalDockFocusAction {
  if (previous.docked && !next.docked) {
    return 'focus-terminal'
  }
  if (!previous.docked && next.docked) {
    return 'focus-composer'
  }
  if (next.docked && previous.passthroughActive && !next.passthroughActive) {
    return 'focus-composer'
  }
  return null
}
