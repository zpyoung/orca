import { translate } from '@/i18n/i18n'

export const TERMINAL_DOCK_KEYBINDING_TITLE_COPY = {
  'terminal.dock.toggle': () =>
    translate('keybindings.title.terminalDockToggle', 'Toggle agent composer dock'),
  'terminal.dock.passthrough': () =>
    translate('keybindings.title.terminalDockPassthrough', 'Toggle terminal passthrough mode')
}
