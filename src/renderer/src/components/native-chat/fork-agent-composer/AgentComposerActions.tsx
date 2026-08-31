// FORK-COPY-OF: src/renderer/src/components/native-chat/NativeChatComposerActions.tsx
// FORK-COPY-SHA: 6e4f817101daa18d82824b69243d9079baa9c416
import { ArrowUp, Mic, Plus, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../shared/native-chat-session-options'
import { NativeChatSessionOptionPickers } from '../NativeChatSessionOptionPickers'

export type AgentComposerActionsProps = {
  attachDisabled: boolean
  dictationDisabled: boolean
  sendDisabled: boolean
  isWorking: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  onStop?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
}

export function AgentComposerActions({
  attachDisabled,
  dictationDisabled,
  sendDisabled,
  isWorking,
  isDictating,
  isDictationHoldMode,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot
}: AgentComposerActionsProps): React.JSX.Element {
  const dictationLabel = isDictating
    ? translate('components.native-chat.composer.stopDictation', 'Stop dictation')
    : translate('components.native-chat.composer.startDictation', 'Start dictation')
  return (
    <div className="flex w-full items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={translate('components.native-chat.composer.attach', 'Attach file')}
              disabled={attachDisabled}
              onClick={onAttach}
              className="pointer-coarse:size-11"
            >
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('components.native-chat.composer.attach', 'Attach file')}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {/* Why: keep session controls beside the actions they affect; the
        model trigger is ordered last so it sits directly next to dictation. */}
        <NativeChatSessionOptionPickers
          surface={sessionOptionsSurface}
          snapshot={sessionOptionsSnapshot}
          isWorking={isWorking}
          pickerRequest={sessionOptionsPickerRequest}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={isDictating ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={dictationLabel}
              disabled={dictationDisabled}
              onClick={isDictationHoldMode ? undefined : onDictationToggle}
              onPointerDown={(event) => {
                if (!isDictationHoldMode || dictationDisabled) {
                  return
                }
                event.preventDefault()
                onDictationHoldStart()
              }}
              onPointerUp={() => {
                if (isDictationHoldMode && !dictationDisabled) {
                  onDictationHoldEnd()
                }
              }}
              onPointerCancel={() => {
                if (isDictationHoldMode && !dictationDisabled) {
                  onDictationHoldEnd()
                }
              }}
              onPointerLeave={(event) => {
                if (isDictationHoldMode && event.buttons === 1 && !dictationDisabled) {
                  onDictationHoldEnd()
                }
              }}
              className="pointer-coarse:size-11"
            >
              {isDictating ? (
                <Square className="size-3.5 fill-current" />
              ) : (
                <Mic className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {dictationLabel}
          </TooltipContent>
        </Tooltip>
        {isWorking && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                aria-label={translate('components.native-chat.stop', 'Stop the agent')}
                disabled={!onStop}
                onClick={onStop}
                variant="secondary"
                size="icon"
                className="size-8 rounded-full pointer-coarse:size-10"
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('components.native-chat.stop', 'Stop the agent')}
            </TooltipContent>
          </Tooltip>
        )}
        <Button
          type="button"
          aria-label={translate('components.native-chat.composer.send', 'Send')}
          disabled={sendDisabled}
          onClick={onSend}
          variant="default"
          size="icon"
          className="size-8 rounded-full pointer-coarse:size-10"
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  )
}
