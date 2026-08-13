import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getTerminalDockExperimentalSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.terminalDock.title',
      'Terminal dock'
    ),
    description: translate(
      'auto.components.settings.experimental.search.terminalDock.description',
      'Composer docked beneath a terminal pane for supported coding-agent sessions.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalDock.terminal',
        'terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalDock.dock',
        'dock'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalDock.composer',
        'composer'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalDock.compose',
        'compose'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalDock.prompt',
        'prompt'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalDock.agent',
        'agent'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.terminalDock.cli',
        'cli'
      )
    ]
  }
}
