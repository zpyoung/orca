// FORK-COPY-OF: src/renderer/src/components/native-chat/NativeChatComposerField.tsx
// FORK-COPY-SHA: bc2f593ebba70a0ee6ff900129e4918f57b143aa
import type { ClipboardEventHandler, KeyboardEventHandler, RefObject } from 'react'
import { useLayoutEffect, useRef } from 'react'
import type { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { ImageOff, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { NATIVE_FILE_DROP_TARGET } from '../../../../../shared/native-file-drop'
import { basename } from '@/lib/path'
import { isNativeChatPastedImagePath } from '../native-chat-image-paste'
import type { ComposerAutocomplete, NativeChatPickerItem } from '../native-chat-composer-state'
import { NativeChatMentionHint, NativeChatPickerMenu } from '../NativeChatAutocompleteMenus'
import { AgentComposerActions } from './AgentComposerActions'
import { AgentComposerAttachmentThumbnail } from './AgentComposerAttachmentThumbnail'
import { ComposerMarkdownOverlay } from './ComposerMarkdownOverlay'
import { COMPOSER_TEXT_CLASS } from './composer-markdown-style'
import { useNativeChatWidthClassName } from '../fork-native-chat-width/use-native-chat-width'
import { nativeChatComposerPlaceholder } from '../native-chat-composer-target'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../shared/native-chat-session-options'
import type { NativeChatOptionPickerRequest } from '../native-chat-composer-types'

export type AgentComposerFieldProps = {
  /** Identifies which composer a native OS file drop landed on, so a drop
   *  reaches only this one when several composers are mounted at once. */
  terminalTabId: string
  paneKey: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  disabled: boolean
  hasPty: boolean
  canSend: boolean
  layout?: 'dock'
  autocomplete: ComposerAutocomplete
  activeSuggestion: number
  notice: string | null
  imageAttachments: readonly AgentComposerImageAttachment[]
  sendButtonDisabled: boolean
  isWorking: boolean
  attachDisabled: boolean
  dictationDisabled: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  onDraftChange: (value: string, element: HTMLTextAreaElement) => void
  onTextareaSelect: (element: HTMLTextAreaElement) => void
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>
  imeEnterGesture: ReturnType<typeof useImeEnterGestureOwnership>
  onImeSettled: (element: HTMLTextAreaElement) => void
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>
  pickerListboxId: string
  onChoosePickerItem: (item: NativeChatPickerItem) => void
  onRetrySkills: () => void
  onAcceptMention: () => void
  onRemoveImageAttachment: (id: string) => void
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

export type AgentComposerImageAttachment = {
  id: string
  path: string
  connectionId?: string
}

/**
 * Applies a draft clear that was dropped mid-composition: everything the field held when the
 * IME started is what the clear was meant to erase, so only the composed segment survives.
 * Diffed from both ends because an IME edits at the caret, which need not be the end.
 */
function imeComposedSegment(base: string, settled: string): string {
  const limit = Math.min(base.length, settled.length)
  let prefix = 0
  while (prefix < limit && base[prefix] === settled[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < limit - prefix &&
    base[base.length - 1 - suffix] === settled[settled.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return settled.slice(prefix, settled.length - suffix)
}

export function AgentComposerField({
  terminalTabId,
  paneKey,
  textareaRef,
  draft,
  disabled,
  hasPty,
  canSend,
  layout,
  autocomplete,
  activeSuggestion,
  notice,
  imageAttachments,
  sendButtonDisabled,
  isWorking,
  attachDisabled,
  dictationDisabled,
  isDictating,
  isDictationHoldMode,
  onDraftChange,
  onTextareaSelect,
  onKeyDown,
  imeEnterGesture,
  onImeSettled,
  onPaste,
  pickerListboxId,
  onChoosePickerItem,
  onRetrySkills,
  onAcceptMention,
  onRemoveImageAttachment,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  sessionOptionsPickerRequest
}: AgentComposerFieldProps): React.JSX.Element {
  const widthClassName = useNativeChatWidthClassName()
  // Value the IME started from, and whether a programmatic clear was dropped on top of it.
  const compositionBaseRef = useRef('')
  const droppedDraftClearRef = useRef(false)

  // Browser owns the provisional value; React synchronizes drafts only between IME sessions.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    if (imeEnterGesture.isComposing()) {
      // Why: a clear (an async structured send confirming) would otherwise be lost outright and
      // the sent text would ride along into the next message. Only clears are carved out of
      // browser ownership; every other programmatic draft still loses to the live composition.
      droppedDraftClearRef.current ||= draft === '' && textarea.value !== ''
      return
    }
    droppedDraftClearRef.current = false
    if (textarea.value === draft) {
      return
    }
    textarea.value = draft
  }, [draft, imeEnterGesture, textareaRef])

  const settleImeValue = (element: HTMLTextAreaElement): void => {
    if (droppedDraftClearRef.current) {
      droppedDraftClearRef.current = false
      element.value = imeComposedSegment(compositionBaseRef.current, element.value)
    }
    onImeSettled(element)
  }

  return (
    <div className={cn('bg-background', layout === 'dock' ? 'h-full min-h-0' : 'shrink-0')}>
      {/* Extra bottom padding keeps the chat input box off the window rim. */}
      <div className={cn(layout === 'dock' ? 'h-full min-h-0' : 'px-3 pb-4 pt-2 sm:px-4')}>
        <div
          className={cn(
            'relative w-full',
            layout === 'dock' ? 'flex h-full min-h-0 flex-col' : cn('mx-auto', widthClassName)
          )}
        >
          {autocomplete.mode === 'slash' || autocomplete.mode === 'skill' ? (
            <NativeChatPickerMenu
              autocomplete={autocomplete}
              activeIndex={activeSuggestion}
              listboxId={pickerListboxId}
              onChoose={onChoosePickerItem}
              onRetry={onRetrySkills}
            />
          ) : null}
          {autocomplete.mode === 'mention' ? (
            <NativeChatMentionHint query={autocomplete.query} onAccept={onAcceptMention} />
          ) : null}
          {notice ? (
            <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ImageOff className="size-3.5 shrink-0" />
              <span>{notice}</span>
            </div>
          ) : null}
          <div
            data-native-file-drop-target={NATIVE_FILE_DROP_TARGET.composer}
            data-terminal-tab-id={terminalTabId}
            data-terminal-pane-leaf-id={paneKey}
            className={cn(
              // Why: always-on hairline (token-level border, not focus ring) —
              // no focus/click border flash. The box is a container, not a
              // focus target.
              'border border-border p-1.5 shadow-xs',
              'bg-muted/50 dark:bg-input/40',
              layout === 'dock'
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-none'
                : 'rounded-lg'
            )}
          >
            {imageAttachments.length > 0 ? (
              <div
                className={cn(
                  'mb-2 flex flex-wrap gap-1.5 px-1',
                  layout === 'dock' && 'scrollbar-sleek max-h-12 shrink-0 overflow-y-auto'
                )}
              >
                {imageAttachments.map((attachment) => {
                  const label = isNativeChatPastedImagePath(attachment.path)
                    ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
                    : basename(attachment.path)
                  return (
                    <div
                      key={attachment.id}
                      className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                      title={attachment.path}
                    >
                      <AgentComposerAttachmentThumbnail
                        path={attachment.path}
                        label={label}
                        terminalTabId={terminalTabId}
                      />
                      <span className="max-w-56 truncate">{label}</span>
                      <button
                        type="button"
                        onClick={() => onRemoveImageAttachment(attachment.id)}
                        aria-label={translate(
                          'components.native-chat.composer.removeAttachment',
                          'Remove attachment'
                        )}
                        className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : null}
            <div className={cn('relative', layout === 'dock' && 'flex min-h-0 flex-1 flex-col')}>
              <ComposerMarkdownOverlay
                text={draft}
                layout={layout}
                disabled={disabled}
                textareaRef={textareaRef}
              />
              <textarea
                ref={textareaRef}
                defaultValue={draft}
                disabled={disabled}
                rows={2}
                onChange={(e) => onDraftChange(e.target.value, e.currentTarget)}
                onKeyDown={(event) => {
                  if (!imeEnterGesture.ownsKeyDown(event)) {
                    onKeyDown(event)
                  }
                }}
                onKeyUp={imeEnterGesture.onKeyUp}
                onBlur={(event) => {
                  const compositionWasActive = imeEnterGesture.isComposing()
                  imeEnterGesture.reset()
                  if (compositionWasActive) {
                    settleImeValue(event.currentTarget)
                  }
                }}
                onCompositionStart={(event) => {
                  compositionBaseRef.current = event.currentTarget.value
                  imeEnterGesture.setComposing(true)
                }}
                onCompositionEnd={(event) => {
                  const compositionWasActive = imeEnterGesture.isComposing()
                  imeEnterGesture.setComposing(false)
                  if (compositionWasActive) {
                    settleImeValue(event.currentTarget)
                  }
                }}
                onPaste={onPaste}
                onSelect={(e) => onTextareaSelect(e.currentTarget)}
                aria-expanded={autocomplete.mode === 'slash' || autocomplete.mode === 'skill'}
                aria-controls={
                  autocomplete.mode === 'slash' || autocomplete.mode === 'skill'
                    ? pickerListboxId
                    : undefined
                }
                aria-activedescendant={
                  (autocomplete.mode === 'slash' || autocomplete.mode === 'skill') &&
                  autocomplete.items.length > 0
                    ? `${pickerListboxId}-option-${Math.min(activeSuggestion, autocomplete.items.length - 1)}`
                    : undefined
                }
                placeholder={nativeChatComposerPlaceholder(hasPty, canSend)}
                // Why: coarse-pointer min-height follows the app's touch target convention.
                // field-sizing:content grows the field with the draft; the 8lh cap (plus
                // py-1) turns further growth into internal scrolling, and scrollbar-sleek
                // keeps that gutter off the heavy native scrollbar. Both are layout-driven,
                // so re-wrap on window/pane resize is handled without a measure pass.
                className={cn(
                  COMPOSER_TEXT_CLASS,
                  'scrollbar-sleek relative resize-none bg-transparent outline-none',
                  'text-transparent caret-foreground selection:bg-ring/35',
                  layout === 'dock'
                    ? 'scrollbar-sleek min-h-0 flex-1 overflow-y-auto'
                    : 'min-h-12 [field-sizing:content] max-h-[calc(8lh+0.5rem)] pointer-coarse:min-h-14',
                  'placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50'
                )}
              />
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 pt-0.5">
              <AgentComposerActions
                attachDisabled={attachDisabled}
                dictationDisabled={dictationDisabled}
                sendDisabled={sendButtonDisabled}
                isWorking={isWorking}
                isDictating={isDictating}
                isDictationHoldMode={isDictationHoldMode}
                onAttach={onAttach}
                onDictationToggle={onDictationToggle}
                onDictationHoldStart={onDictationHoldStart}
                onDictationHoldEnd={onDictationHoldEnd}
                onSend={onSend}
                onStop={onStop}
                sessionOptionsSurface={sessionOptionsSurface}
                sessionOptionsSnapshot={sessionOptionsSnapshot}
                sessionOptionsPickerRequest={sessionOptionsPickerRequest}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
