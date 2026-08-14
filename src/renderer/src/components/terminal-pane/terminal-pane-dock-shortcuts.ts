import {
  keybindingMatchesAction,
  type KeybindingInput,
  type KeybindingOverrides
} from '../../../../shared/keybindings'

export type TerminalDockShortcutAction = 'toggleDock' | 'togglePassthrough'

/** Resolves the dock's two pane-scoped shortcuts independent of which element inside the
 *  pane has focus — unlike terminal-shortcut-policy.ts's resolver, which only ever sees
 *  keys typed while xterm itself is focused. Docked panes route keyboard focus to the
 *  composer, so toggling dock/passthrough must work from there too. */
export function resolveTerminalDockShortcutAction(
  event: KeybindingInput & { repeat?: boolean },
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): TerminalDockShortcutAction | null {
  if (event.repeat) {
    return null
  }
  if (keybindingMatchesAction('terminal.dock.toggle', event, platform, keybindings)) {
    return 'toggleDock'
  }
  if (keybindingMatchesAction('terminal.dock.passthrough', event, platform, keybindings)) {
    return 'togglePassthrough'
  }
  return null
}
