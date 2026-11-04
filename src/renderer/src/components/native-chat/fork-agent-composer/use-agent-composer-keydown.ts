// FORK-COPY-OF: src/renderer/src/components/native-chat/use-native-chat-composer-keydown.ts
// FORK-COPY-SHA: 965978bc78bf03a6a43187c1ed28fcffe0e01bb5
import { useCallback, type Dispatch, type KeyboardEventHandler, type SetStateAction } from 'react'
import { recallNext, recallPrevious, type HistoryState } from './agent-composer-history'
import type { ComposerAutocomplete } from '../../../../../shared/native-chat/input/native-chat-composer-autocomplete'
import type { NativeChatPickerItem } from '../../../../../shared/native-chat/input/native-chat-picker-items'
import { isMacPlatform } from '../native-chat-shortcut'
import type { NativeChatMentionFiles } from '../use-native-chat-mention-files'
import type { NativeChatComposerSendIntent } from '../native-chat-composer-types'

export type UseAgentComposerKeyDownArgs = {
  autocomplete: ComposerAutocomplete
  mentionFiles: NativeChatMentionFiles
  completeMention: (path: string) => void
  activeSuggestion: number
  draft: string
  /** Image chips count as composer content, like typed text. */
  hasAttachments?: boolean
  history: HistoryState
  isComposing: () => boolean
  completePickerItem: (item: NativeChatPickerItem) => void
  dispatchPickerCommand: (item: Extract<NativeChatPickerItem, { kind: 'command' }>) => void
  dismissPicker: (triggerKey: string) => void
  interrupt: () => void
  send: (intent?: NativeChatComposerSendIntent) => void
  /** Cmd/Ctrl+Shift+Enter steers the head queued card, whatever the composer holds. */
  steerHead?: (() => boolean) | undefined
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  setDraft: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
  setHistory: Dispatch<SetStateAction<HistoryState>>
}

export function useAgentComposerKeyDown({
  autocomplete,
  mentionFiles,
  completeMention,
  activeSuggestion,
  draft,
  hasAttachments = false,
  history,
  isComposing,
  completePickerItem,
  dispatchPickerCommand,
  dismissPicker,
  interrupt,
  send,
  steerHead,
  setActiveSuggestion,
  setDraft,
  setCaret,
  setHistory
}: UseAgentComposerKeyDownArgs): KeyboardEventHandler<HTMLElement> {
  return useCallback(
    (event) => {
      if (isComposing() || event.nativeEvent.isComposing || event.keyCode === 229) {
        // IME Enter commits composition; never pick a suggestion or submit a partial draft.
        if (event.key === 'Enter') {
          event.preventDefault()
        }
        return
      }
      // An open layer that keeps focus here, like the context card, already spent this Escape closing
      // itself; a layer around the composer (a launch panel) leaves an open picker to take it.
      if (event.key === 'Escape' && event.defaultPrevented && autocomplete.mode === 'none') {
        return
      }

      if (autocomplete.mode !== 'none') {
        const items = autocomplete.mode === 'slash' ? autocomplete.items : mentionFiles.files
        if (event.key === 'ArrowDown' && items.length > 0) {
          event.preventDefault()
          setActiveSuggestion((index) => (index + 1) % items.length)
          return
        }
        if (event.key === 'ArrowUp' && items.length > 0) {
          event.preventDefault()
          setActiveSuggestion((index) => (index - 1 + items.length) % items.length)
          return
        }
        // Shift keeps its own meaning: a newline for Enter, focus back for Tab.
        const picks = (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey
        if (picks && items.length > 0) {
          event.preventDefault()
          if (autocomplete.mode === 'mention') {
            const { files } = mentionFiles
            completeMention(files[Math.min(activeSuggestion, files.length - 1)])
            return
          }
          const item = autocomplete.items[activeSuggestion] ?? autocomplete.items[0]
          // Only dispatch a command at a dispatchable prompt position; embedded tokens merely complete.
          if (event.key === 'Enter' && item.kind === 'command' && autocomplete.dispatchable) {
            dispatchPickerCommand(item)
          } else {
            completePickerItem(item)
          }
          return
        }
        // Why: the files are still on their way, so Enter here is a pick that came early, not a send.
        if (picks && autocomplete.mode === 'mention' && mentionFiles.loading) {
          event.preventDefault()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          dismissPicker(autocomplete.triggerKey)
          return
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        interrupt()
        return
      }
      const modified = event.key === 'Enter' && (isMacPlatform() ? event.metaKey : event.ctrlKey)
      // Why before Shift+Enter: that adds a newline, and this chord leaves the draft alone.
      if (modified && event.shiftKey) {
        event.preventDefault()
        // A held chord would otherwise steer each card that becomes the head.
        if (!event.repeat) {
          steerHead?.()
        }
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        if (!modified) {
          send()
        } else if (draft.trim() !== '' || hasAttachments) {
          // The other thing than the setting; an empty composer has nothing to send either way.
          send({ alternate: true })
        }
        return
      }
      if (event.key === 'ArrowUp' && (draft === '' || history.index !== null)) {
        const recall = recallPrevious(history)
        if (recall.draft !== null) {
          event.preventDefault()
          setHistory(recall.history)
          setDraft(recall.draft)
          setCaret(recall.draft.length)
        }
        return
      }
      if (event.key === 'ArrowDown' && history.index !== null) {
        const recall = recallNext(history)
        if (recall.draft !== null) {
          event.preventDefault()
          setHistory(recall.history)
          setDraft(recall.draft)
          setCaret(recall.draft.length)
        }
      }
    },
    [
      activeSuggestion,
      autocomplete,
      completeMention,
      completePickerItem,
      dismissPicker,
      dispatchPickerCommand,
      draft,
      hasAttachments,
      history,
      interrupt,
      isComposing,
      mentionFiles,
      send,
      steerHead,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setHistory
    ]
  )
}
