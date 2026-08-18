import type { NativeChatWidthTier } from '../../../../../shared/types'
import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_WIDTH_TIERS,
  nativeChatWidthTierLabel,
  resolveNativeChatWidthTier
} from '../../native-chat/fork-native-chat-width/native-chat-width'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'

type NativeChatWidthSettingProps = {
  value: NativeChatWidthTier | null | undefined
  onChange: (value: NativeChatWidthTier) => void
}

export function NativeChatWidthSetting({
  value,
  onChange
}: NativeChatWidthSettingProps): React.JSX.Element {
  const widthTier = resolveNativeChatWidthTier(value)

  return (
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
      <Select value={widthTier} onValueChange={onChange}>
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
  )
}
