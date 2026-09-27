import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../SearchableSetting'
import { SettingsSwitch } from '../SettingsFormControls'
import { getExperimentalSearchEntry } from '../experimental-search'

type TerminalDockExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalDockExperimentalSetting({
  settings,
  updateSettings
}: TerminalDockExperimentalSettingProps): React.JSX.Element {
  const enabled = settings.experimentalTerminalDock === true
  const autoOpen = settings.dockTerminalComposerByDefault !== false

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.ExperimentalPane.terminalDock.title',
        'Terminal dock'
      )}
      description={translate(
        'auto.components.settings.ExperimentalPane.terminalDock.description',
        'Composer docked beneath a terminal pane for supported coding-agent sessions.'
      )}
      keywords={getExperimentalSearchEntry().terminalDock.keywords}
      className="space-y-3 py-2"
      id="experimental-terminal-dock"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.ExperimentalPane.terminalDock.title',
              'Terminal dock'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.terminalDock.copy',
              'Docks a rich input composer beneath a terminal pane running a supported coding-agent CLI, so you can compose and send prompts without typing directly into the terminal. The terminal stays visible, so you can always fall back to typing directly. Experimental and independent of Chat UI while we tune composer behavior.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={enabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.terminalDock.toggleLabel',
            'Toggle terminal dock'
          )}
          onChange={() =>
            updateSettings({
              experimentalTerminalDock: !enabled
            })
          }
        />
      </div>
      {enabled ? (
        <div className="ml-4 space-y-3 border-l border-border pl-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.terminalDock.autoOpenTitle',
                  'Open automatically for new sessions'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.terminalDock.autoOpenCopy',
                  'Open the composer dock automatically when a supported coding-agent session starts.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={autoOpen}
              ariaLabel={translate(
                'auto.components.settings.ExperimentalPane.terminalDock.autoOpenToggleLabel',
                'Toggle automatic terminal dock opening'
              )}
              onChange={() =>
                updateSettings({
                  dockTerminalComposerByDefault: !autoOpen
                })
              }
            />
          </div>
        </div>
      ) : null}
    </SearchableSetting>
  )
}
