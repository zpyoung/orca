import type React from 'react'

import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { isSidebarSectionSeparatorEnabled } from '../../../../../shared/fork-sidebar-section-separator/sidebar-section-separator-setting'
import { SearchableSetting } from '../SearchableSetting'
import { SettingsSwitchRow } from '../SettingsFormControls'
import { getSidebarSectionSeparatorEntry } from './section-separator-search'

type SidebarSectionSeparatorSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}

export function SidebarSectionSeparatorSetting({
  settings,
  updateSettings,
  forceVisible = false
}: SidebarSectionSeparatorSettingProps): React.JSX.Element {
  const entry = getSidebarSectionSeparatorEntry()
  const enabled = isSidebarSectionSeparatorEnabled(settings)
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-2 py-2"
      forceVisible={forceVisible}
    >
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={enabled}
        onChange={() =>
          updateSettings({
            sidebarSectionSeparators: !enabled
          })
        }
      />
    </SearchableSetting>
  )
}
