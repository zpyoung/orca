import type { GlobalSettings, NativeChatWidthTier } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_WIDTH_TIERS,
  nativeChatWidthTierLabel,
  resolveNativeChatWidthTier
} from '../native-chat/native-chat-width'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getExperimentalSearchEntry } from './experimental-search'

type NativeChatDefaultView = 'terminal-chat' | 'native-chat'

type NativeChatExperimentalSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function NativeChatExperimentalSetting({
  settings,
  updateSettings
}: NativeChatExperimentalSettingProps): React.JSX.Element {
  const nativeChatEnabled = settings.experimentalNativeChat === true
  const openByDefault = settings.openAgentTabsInChatByDefault === true
  const defaultView: NativeChatDefaultView = openByDefault ? 'native-chat' : 'terminal-chat'
  const widthTier = resolveNativeChatWidthTier(settings.nativeChatWidth)

  return (
    <SearchableSetting
      title={translate('auto.components.settings.ExperimentalPane.nativeChat.title', 'Chat UI')}
      description={translate(
        'auto.components.settings.ExperimentalPane.nativeChat.description',
        'Preview the desktop chat surface for supported agent terminal sessions.'
      )}
      keywords={getExperimentalSearchEntry().nativeChat.keywords}
      className="space-y-3 py-2"
      id="experimental-native-chat"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate('auto.components.settings.ExperimentalPane.nativeChat.title', 'Chat UI')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.nativeChat.copy',
              'Adds a Chat UI view you can switch to from supported agent terminal panes. Experimental while we tune transcript fidelity, streaming, and terminal parity.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={nativeChatEnabled}
          ariaLabel={translate(
            'auto.components.settings.ExperimentalPane.nativeChat.toggleLabel',
            'Toggle Chat UI'
          )}
          onChange={() =>
            updateSettings({
              experimentalNativeChat: !nativeChatEnabled
            })
          }
        />
      </div>
      {nativeChatEnabled ? (
        <div className="ml-4 space-y-3 border-l border-border pl-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.defaultTitle',
                  'Default view'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.defaultCopy',
                  'Choose how new supported agent terminal tabs open.'
                )}
              </p>
            </div>
            <Select
              value={defaultView}
              onValueChange={(value: NativeChatDefaultView) => {
                updateSettings({
                  openAgentTabsInChatByDefault: value === 'native-chat'
                })
              }}
            >
              <SelectTrigger
                aria-label={translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.defaultViewLabel',
                  'Default Chat UI view'
                )}
                className="w-36"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" sideOffset={4} avoidCollisions={false}>
                <SelectItem value="terminal-chat">
                  {translate(
                    'auto.components.settings.ExperimentalPane.nativeChat.defaultViewTerminal',
                    'Terminal chat'
                  )}
                </SelectItem>
                <SelectItem value="native-chat">
                  {translate(
                    'auto.components.settings.ExperimentalPane.nativeChat.defaultViewNative',
                    'Chat UI'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.widthTitle',
                  'Chat width'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.widthCopy',
                  'Set the reading column width for every chat pane.'
                )}
              </p>
            </div>
            <Select
              value={widthTier}
              onValueChange={(value: NativeChatWidthTier) => {
                updateSettings({ nativeChatWidth: value })
              }}
            >
              <SelectTrigger
                aria-label={translate(
                  'auto.components.settings.ExperimentalPane.nativeChat.widthLabel',
                  'Chat width'
                )}
                className="w-36"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" sideOffset={4} avoidCollisions={false}>
                {NATIVE_CHAT_WIDTH_TIERS.map((tier) => (
                  <SelectItem key={tier} value={tier}>
                    {nativeChatWidthTierLabel(tier)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
    </SearchableSetting>
  )
}
