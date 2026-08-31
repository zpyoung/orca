import { MessageSquarePlus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { getForkSessionHandoffSearchEntries } from './handoff-settings-search'

/** Returns the settings navigation entry for reusable session-handoff templates. */
export function getForkSessionHandoffNavSections(): SettingsNavSection[] {
  return [
    {
      id: 'session-handoff',
      title: translate('components.settings.forkSessionHandoff.title', 'Session handoff'),
      description: translate(
        'components.settings.forkSessionHandoff.description',
        'Create reusable instructions for continuing work in a new Agent session.'
      ),
      icon: MessageSquarePlus,
      searchEntries: getForkSessionHandoffSearchEntries(),
      group: 'workflows'
    }
  ]
}
