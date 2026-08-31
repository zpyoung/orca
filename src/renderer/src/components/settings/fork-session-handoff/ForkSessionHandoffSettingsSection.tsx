import { translate } from '@/i18n/i18n'
import { SettingsSection } from '../SettingsSection'
import { getForkSessionHandoffSearchEntries } from './handoff-settings-search'
import { HandoffTemplatesPane } from './HandoffTemplatesPane'

/** Registers the settings surface for reusable session-handoff templates. */
export function ForkSessionHandoffSettingsSection(): React.JSX.Element | null {
  return (
    <SettingsSection
      id="session-handoff"
      title={translate('components.settings.forkSessionHandoff.title', 'Session handoff')}
      description={translate(
        'components.settings.forkSessionHandoff.description',
        'Create reusable instructions for continuing work in a new Agent session.'
      )}
      searchEntries={getForkSessionHandoffSearchEntries()}
    >
      <HandoffTemplatesPane />
    </SettingsSection>
  )
}
