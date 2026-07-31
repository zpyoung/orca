import { UnfoldHorizontal } from 'lucide-react'
import type { NativeChatWidthTier } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { NATIVE_CHAT_WIDTH_TIERS, nativeChatWidthTierLabel } from './native-chat-width'
import { useNativeChatWidthTier } from './use-native-chat-width'

/**
 * Inline quick-switch for the chat reading-column width, rendered beside the
 * chat/terminal toggle in the pane header. Takes no props and reads the store
 * itself: `TerminalPaneHeaderOverlay` is prop-driven by design, so the store
 * access stays here rather than becoming another prop pair on that interface.
 * The width is a global setting, so a change here moves every open chat pane.
 */
export function NativeChatWidthMenu(): React.JSX.Element {
  const widthTier = useNativeChatWidthTier()
  const updateSettings = useAppStore((s) => s.updateSettings)

  const label = translate('components.native-chat.width.menuLabel', 'Chat width')

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              // Same class as the adjacent chat toggle so it shares the hover
              // reveal and sits as a peer in the header action cluster.
              className="pane-title-split-trigger"
              aria-label={label}
              onClick={(event) => event.stopPropagation()}
            >
              <UnfoldHorizontal className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate(
            'components.native-chat.width.menuTooltip',
            'Chat width (applies to all chat panes)'
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={widthTier}
          onValueChange={(value) => {
            updateSettings({ nativeChatWidth: value as NativeChatWidthTier })
          }}
        >
          {NATIVE_CHAT_WIDTH_TIERS.map((tier) => (
            <DropdownMenuRadioItem key={tier} value={tier}>
              {nativeChatWidthTierLabel(tier)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
