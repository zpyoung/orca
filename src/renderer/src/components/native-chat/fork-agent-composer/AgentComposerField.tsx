// FORK-COPY-OF: src/renderer/src/components/native-chat/NativeChatComposerField.tsx
// FORK-COPY-SHA: 97b9bb3613a333450a38057d745628323f3ad185
import type { ClipboardEventHandler, KeyboardEventHandler, RefObject } from 'react'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import type { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useNotificationCardComposerClearance } from '@/lib/notification-card-composer-clearance'
import { basename } from '@/lib/path'
import { isNativeChatPastedImagePath } from '../../../../../shared/native-chat/native-chat-image-label'
import type { NativeChatFollowUpBehavior } from '../../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import type { ComposerAutocomplete } from '../../../../../shared/native-chat/input/native-chat-composer-autocomplete'
import type { NativeChatPickerItem } from '../../../../../shared/native-chat/input/native-chat-picker-items'
import { NativeChatMentionMenu, NativeChatPickerMenu } from '../NativeChatAutocompleteMenus'
import type { NativeChatMentionFiles } from '../use-native-chat-mention-files'
import { AgentComposerActions } from './AgentComposerActions'
import { NativeChatComposerNotices } from '../NativeChatComposerNotices'
import type { NativeChatComposerNotice } from '../native-chat-composer-notice'
import { AgentComposerAttachmentThumbnail } from './AgentComposerAttachmentThumbnail'
import { ComposerMarkdownOverlay } from './ComposerMarkdownOverlay'
import { COMPOSER_TEXT_CLASS } from './composer-markdown-style'
import {
  nativeChatComposerPlaceholder,
  type NativeChatAfterStopSend
} from '../native-chat-composer-target'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatOptionPickerRequest } from '../native-chat-composer-types'
import type { NativeChatContextUsageSummary } from '../native-chat-context-usage-summary'
import type { NativeChatComposerGoalMode } from '../use-native-chat-composer-submit'
import { useNativeChatComposerDraftUnsaved } from '../use-native-chat-draft-unsaved'
import { useLatestHandler } from '@/lib/use-latest-handler'

function noop(): void {}

export type AgentComposerFieldProps = {
  editSession?: { cancel: () => void }
  terminalTabId: string
  /** Owner of the draft the field's text is saved with. */
  draftScopeKey: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  disabled: boolean
  hasPty: boolean
  canSend: boolean
  unavailableHint?: string | undefined
  layout?: 'dock'
  autocomplete: ComposerAutocomplete
  mentionFiles: NativeChatMentionFiles
  activeSuggestion: number
  notices: readonly NativeChatComposerNotice[]
  imageAttachments: readonly AgentComposerImageAttachment[]
  sendButtonDisabled: boolean
  /** Why the send button is disabled, when the user can do something about it. */
  sendBlockedReason?: string | null
  isWorking: boolean
  /** While the agent works: what Cmd/Ctrl+Enter would do instead of a plain send, when it differs. */
  alternateSend?: NativeChatFollowUpBehavior
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  /** After Stop, describe whether the host queues the next message as a card or holds the send. */
  afterStop?: NativeChatAfterStopSend
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
  onChooseMentionFile: (path: string) => void
  onRemoveImageAttachment: (id: string) => void
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  onStop?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  contextUsage?: NativeChatContextUsageSummary | null
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
  goalMode?: NativeChatComposerGoalMode
  agent?: string
}

export type AgentComposerImageAttachment = {
  id: string
  /** Empty while `pending`: the clipboard image has no agent-readable path yet. */
  path: string
  connectionId?: string
  /** Show clipboard thumbnails immediately, without waiting for disk/upload completion. */
  previewUrl?: string
  /** True while the pasted image is still being written to disk or uploaded. */
  pending?: boolean
  /** The file's name while it uploads: a dropped or picked file, not a pasted image. */
  pendingName?: string
  /** Set on an image the draft names but can't send: the file to attach again. */
  unavailableName?: string
}

function attachmentChipLabel(attachment: AgentComposerImageAttachment): string {
  if (attachment.pending) {
    return attachment.pendingName
      ? translate('components.native-chat.composer.uploadingFile', 'Uploading {{name}}…', {
          name: attachment.pendingName
        })
      : translate('components.native-chat.composer.imageSaving', 'Saving pasted image…')
  }
  if (attachment.unavailableName !== undefined) {
    return attachment.unavailableName
  }
  return isNativeChatPastedImagePath(attachment.path)
    ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
    : basename(attachment.path)
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
  editSession,
  terminalTabId,
  draftScopeKey,
  textareaRef,
  draft,
  disabled,
  hasPty,
  canSend,
  unavailableHint,
  layout,
  autocomplete,
  mentionFiles,
  activeSuggestion,
  notices,
  imageAttachments,
  sendButtonDisabled,
  sendBlockedReason,
  isWorking,
  alternateSend,
  isStopping = false,
  afterStop,
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
  onChooseMentionFile,
  onRemoveImageAttachment,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  contextUsage,
  sessionOptionsPickerRequest,
  goalMode,
  agent
}: AgentComposerFieldProps): React.JSX.Element {
  const draftNotSaved = useNativeChatComposerDraftUnsaved(draftScopeKey)
  const optionCount =
    autocomplete.mode === 'slash'
      ? autocomplete.items.length
      : autocomplete.mode === 'mention'
        ? mentionFiles.files.length
        : 0
  // Value the IME started from, and whether a programmatic clear was dropped on top of it.
  const compositionBaseRef = useRef('')
  const droppedDraftClearRef = useRef(false)

  // Stable identities let the memoized actions bar skip the per-keystroke render.
  const attach = useLatestHandler(onAttach)
  const dictationToggle = useLatestHandler(onDictationToggle)
  const dictationHoldStart = useLatestHandler(onDictationHoldStart)
  const dictationHoldEnd = useLatestHandler(onDictationHoldEnd)
  const send = useLatestHandler(onSend)
  const stop = useLatestHandler(onStop ?? noop)
  const exitGoalMode = useLatestHandler(goalMode?.exit ?? noop)

  // Browser owns the provisional value; React synchronizes drafts only between IME sessions.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    if (imeEnterGesture.isComposing()) {
      // Remember async send clears during composition so sent text cannot leak into the next message; other drafts still yield to IME.
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

  // Stable so the memoized option pickers keep their identity.
  const focusComposer = useCallback(() => textareaRef.current?.focus(), [textareaRef])
  const paneRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  useNotificationCardComposerClearance(paneRef, columnRef, editSession === undefined)

  return (
    <div
      ref={paneRef}
      className={cn('bg-chat-pane', layout === 'dock' ? 'h-full min-h-0' : 'shrink-0')}
    >
      {/* Extra bottom padding keeps the chat input box off the window rim. */}
      <div className={cn(layout === 'dock' ? 'h-full min-h-0' : 'px-3 pb-4 pt-2 sm:px-4')}>
        <div
          ref={columnRef}
          className={cn(
            'relative w-full',
            layout === 'dock'
              ? 'flex h-full min-h-0 flex-col'
              : 'mx-auto max-w-(--chat-content-max-width)'
          )}
        >
          {autocomplete.mode === 'slash' ? (
            <NativeChatPickerMenu
              autocomplete={autocomplete}
              activeIndex={activeSuggestion}
              listboxId={pickerListboxId}
              onChoose={onChoosePickerItem}
              onRetry={onRetrySkills}
            />
          ) : null}
          {autocomplete.mode === 'mention' ? (
            <NativeChatMentionMenu
              mention={mentionFiles}
              activeIndex={activeSuggestion}
              listboxId={pickerListboxId}
              onChoose={onChooseMentionFile}
            />
          ) : null}
          <NativeChatComposerNotices
            notices={notices.map((notice) =>
              // A dismissed row takes its focused × with it; the message box gets focus back.
              notice.onDismiss
                ? {
                    ...notice,
                    onDismiss: () => {
                      notice.onDismiss?.()
                      textareaRef.current?.focus()
                    }
                  }
                : notice
            )}
            className="mb-1.5"
          />
          <div
            className={cn(
              // Why: always-on hairline (token-level border, not focus ring) —
              // no focus/click border flash. The box is a container, not a
              // focus target.
              'border border-chat-composer-border p-1.5 shadow-xs',
              'bg-chat-composer-surface',
              // Why (#10481): the native caret blink invalidates paint up to the
              // nearest containment boundary; without this the whole transcript
              // re-rasterizes twice a second. Pickers are siblings and every menu
              // and tooltip in here is a Radix portal, so nothing floating clips.
              // Tightest descendant is the attachment remove button, which
              // overhangs its thumbnail by 6px and clears this box's padding by
              // 4px — keep that slack if the padding below ever shrinks.
              '[contain:paint]',
              layout === 'dock'
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-none'
                : 'rounded-xl'
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
                  const label = attachmentChipLabel(attachment)
                  return (
                    <div
                      key={attachment.id}
                      className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                      title={attachment.pending ? label : attachment.path}
                      aria-busy={attachment.pending === true}
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
                  if (imeEnterGesture.isComposing()) {
                    imeEnterGesture.setComposing(false)
                    const element = event.currentTarget
                    // Settle the interrupted composition before the new one takes browser ownership.
                    flushSync(() => settleImeValue(element))
                  }
                  compositionBaseRef.current = event.currentTarget.value
                  imeEnterGesture.setComposing(true)
                }}
                onCompositionEnd={(event) => {
                  const compositionWasActive = imeEnterGesture.isComposing()
                  imeEnterGesture.setComposing(false, event.data)
                  if (compositionWasActive) {
                    settleImeValue(event.currentTarget)
                  }
                }}
                onPasteCapture={onPaste}
                onSelect={(e) => onTextareaSelect(e.currentTarget)}
                aria-expanded={autocomplete.mode !== 'none'}
                aria-controls={autocomplete.mode !== 'none' ? pickerListboxId : undefined}
                aria-activedescendant={
                  optionCount > 0
                    ? `${pickerListboxId}-option-${Math.min(activeSuggestion, optionCount - 1)}`
                    : undefined
                }
                placeholder={
                  editSession
                    ? translate('components.native-chat.queuedMessages.editMessage', 'Edit message')
                    : goalMode?.active
                      ? translate(
                          'components.native-chat.goal.placeholder',
                          'Describe your goal, define measurable outcomes for best results'
                        )
                      : (unavailableHint ??
                        nativeChatComposerPlaceholder(hasPty, canSend, afterStop))
                }
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
                  'placeholder:text-chat-foreground-faint disabled:cursor-not-allowed disabled:opacity-50'
                )}
              />
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 pt-0.5">
              <AgentComposerActions
                editSession={editSession}
                attachDisabled={attachDisabled}
                dictationDisabled={dictationDisabled}
                sendDisabled={sendButtonDisabled}
                sendBlockedReason={sendBlockedReason}
                draftNotSaved={draftNotSaved}
                isWorking={isWorking}
                alternateSend={alternateSend}
                isStopping={isStopping}
                isDictating={isDictating}
                isDictationHoldMode={isDictationHoldMode}
                onAttach={attach}
                onDictationToggle={dictationToggle}
                onDictationHoldStart={dictationHoldStart}
                onDictationHoldEnd={dictationHoldEnd}
                onSend={send}
                onStop={onStop ? stop : undefined}
                sessionOptionsSurface={sessionOptionsSurface}
                sessionOptionsSnapshot={sessionOptionsSnapshot}
                contextUsage={contextUsage}
                sessionOptionsPickerRequest={sessionOptionsPickerRequest}
                focusComposer={focusComposer}
                onExitGoalMode={goalMode?.active ? exitGoalMode : undefined}
                {...(agent ? { agent } : {})}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
