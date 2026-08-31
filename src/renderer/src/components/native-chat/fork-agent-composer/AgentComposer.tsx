import {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { NativeChatSendHandle, NativeChatSendOptions } from '../native-chat-runtime-send'
import { useNativeChatSendLifecycle } from '../use-native-chat-send-lifecycle'
import { useNativeChatTypedInsertion } from '../use-native-chat-typed-insertion'
import type { NativeChatResolvedTarget } from '../native-chat-composer-target'
import type {
  ComposerAutocomplete,
  NativeChatPickerItem,
  NativeChatSendClassification
} from '../native-chat-composer-state'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../shared/native-chat-session-options'
import type { HistoryState } from './agent-composer-history'
import { readAgentComposerDraftCache } from './agent-composer-draft-cache'
import { useAgentComposerDraft } from './use-agent-composer-draft'
import { useAgentComposerHistory } from './use-agent-composer-history'
import { useAgentComposerKeyDown } from './use-agent-composer-keydown'
import { useAgentComposerSend } from './use-agent-composer-send'
import {
  AgentComposerField,
  type AgentComposerFieldProps,
  type AgentComposerImageAttachment
} from './AgentComposerField'
import type { AgentComposerCoreProps, AgentComposerHandle } from './agent-composer-types'

// Why: a plain ESC byte is what the agent TUIs read as the interrupt key over a
// PTY (matching how xterm forwards Escape).
const ESC = '\x1b'

const EMPTY_ATTACHMENTS: readonly AgentComposerImageAttachment[] = []
const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const DEFAULT_AUTOCOMPLETE: ComposerAutocomplete = { mode: 'none' }

function noop(): void {}

type PasteEventLike = Parameters<AgentComposerHandle['handlePasteEvent']>[0]

export type AgentComposerCoreState = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  isComposingRef: RefObject<boolean>
  draft: string
  setDraft: (next: string | ((previous: string) => string)) => void
  caret: number
  setCaret: Dispatch<SetStateAction<number>>
  history: HistoryState
  setHistory: Dispatch<SetStateAction<HistoryState>>
  activeSuggestion: number
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  notice: string | null
  setNotice: Dispatch<SetStateAction<string | null>>
  hasPty: boolean
  disabled: boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  trackPendingSend: (handle: NativeChatSendHandle, pendingId?: string) => void
  interrupt: () => void
  insertTypedText: (text: string) => boolean
  focus: () => boolean
  syncCaret: (element: HTMLTextAreaElement) => void
}

/** Draft/caret/history/send-lifecycle/interrupt state for one composer mount,
 *  with no dependency on any particular host — usable standalone or shared by
 *  a host wrapper so its own bridges never desync from what's on screen. */
export function useAgentComposerCoreState(props: AgentComposerCoreProps): AgentComposerCoreState {
  const {
    terminalTabId,
    paneKey,
    targetPtyId,
    canSend = true,
    allowWithoutTarget = false,
    isWorking = false,
    onStop,
    onOptimisticSendCanceled
  } = props
  const { draft, setDraft } = useAgentComposerDraft(paneKey)
  const [caret, setCaret] = useState(draft.length)
  const { history, setHistory } = useAgentComposerHistory(paneKey)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)
  const { cancelPendingSends, trackPendingSend } = useNativeChatSendLifecycle(
    terminalTabId,
    targetPtyId,
    onOptimisticSendCanceled,
    canSend
  )

  // Place the caret at the end of the (possibly restored) draft when the
  // composer is reused for a different pane, adjusted during render so caret
  // and text stay consistent on the first paint after the switch.
  const lastScopeKey = useRef(paneKey)
  if (lastScopeKey.current !== paneKey) {
    lastScopeKey.current = paneKey
    setCaret(readAgentComposerDraftCache(paneKey).length)
  }

  const resolveTarget = useCallback((): NativeChatResolvedTarget | null => {
    if (!targetPtyId) {
      return null
    }
    return { ptyId: targetPtyId, settings: getSettingsForAgentTabRuntimeOwner(terminalTabId) }
  }, [targetPtyId, terminalTabId])

  const hasPty = allowWithoutTarget || targetPtyId !== null
  const disabled = (!allowWithoutTarget && targetPtyId === null) || !canSend

  const syncCaret = useCallback((element: HTMLTextAreaElement) => {
    setCaret(element.selectionStart ?? element.value.length)
  }, [])

  const { insertTypedText, focus } = useNativeChatTypedInsertion({
    textareaRef,
    caret,
    draft,
    setDraft,
    setCaret,
    setHistory,
    setActiveSuggestion
  })

  const interrupt = useCallback(() => {
    cancelPendingSends()
    if (isWorking && onStop) {
      onStop()
      return
    }
    const target = resolveTarget()
    if (!target) {
      return
    }
    sendRuntimePtyInput(target.settings, target.ptyId, ESC)
  }, [cancelPendingSends, isWorking, onStop, resolveTarget])

  return {
    textareaRef,
    isComposingRef,
    draft,
    setDraft,
    caret,
    setCaret,
    history,
    setHistory,
    activeSuggestion,
    setActiveSuggestion,
    notice,
    setNotice,
    hasPty,
    disabled,
    resolveTarget,
    trackPendingSend,
    interrupt,
    insertTypedText,
    focus,
    syncCaret
  }
}

/** Optional host wiring for the field's picker/attachment/dictation/session
 *  surfaces. Every field is inert when absent, so a host supplying none of
 *  this still gets a working compose-and-send composer. */
export type AgentComposerHostBridges = {
  autocomplete?: ComposerAutocomplete
  pickerListboxId?: string
  classifySend?: (draft: string) => NativeChatSendClassification
  clearSkillOrigin?: () => void
  completeItem?: (item: NativeChatPickerItem) => void
  retrySkills?: () => void
  dismissPicker?: (triggerKey: string) => void
  handleDraftOrCaretChange?: (value: string, caret: number) => void
  dispatchPickerCommand?: (item: Extract<NativeChatPickerItem, { kind: 'command' }>) => void
  onAcceptMention?: () => void

  imageAttachments?: readonly AgentComposerImageAttachment[]
  onAttach?: () => void
  onRemoveImageAttachment?: (id: string) => void
  clearImageAttachments?: () => void
  restoreImageAttachments?: (attachments: readonly AgentComposerImageAttachment[]) => void

  onPaste?: (event: PasteEventLike) => void
  pasteFromClipboard?: () => void

  isDictating?: boolean
  isDictationHoldMode?: boolean
  dictationDisabled?: boolean
  onDictationToggle?: () => void
  onDictationHoldStart?: () => void
  onDictationHoldEnd?: () => void

  sessionOptionsSurface?: SessionOptionsSurface | null
  sessionOptionsSnapshot?: SessionOptionDescriptor[]
  isDispatchingSessionOption?: boolean

  onSlashCommand?: (command: string) => void
  /** Replaces the PTY send entirely; for a host whose transport is not a PTY. */
  sendOverride?: () => void
  /** Notified with the dispatched text when a send classifies as a command. */
  onCommandDispatched?: (command: string) => void
  /** Sends a classified command as typed keystrokes rather than a paste, for
   *  agents whose TUI only autocompletes typed input. Returning null takes the
   *  ordinary paste path. */
  sendTypedCommand?: (target: NativeChatResolvedTarget, text: string) => NativeChatSendHandle | null
  /** Overrides the clear/confirm bytes a send uses, e.g. to replace a parked
   *  launch draft rather than paste on top of it. */
  buildSendOptions?: () => NativeChatSendOptions | undefined
  onAfterSend?: (info: { classification: NativeChatSendClassification; ptyId: string }) => void
}

export type AgentComposerComposeResult = {
  fieldProps: AgentComposerFieldProps
  handlePasteEvent: (event: PasteEventLike) => void
  pasteFromClipboard: () => void
}

/** Builds the field props (and the paste imperative-handle pair) from core
 *  state plus whatever bridges a host supplies. */
export function useAgentComposerCompose(
  core: AgentComposerCoreState,
  props: AgentComposerCoreProps,
  bridges?: AgentComposerHostBridges
): AgentComposerComposeResult {
  const { canSend = true, isWorking = false } = props
  const generatedListboxId = `agent-composer-picker-${useId().replaceAll(':', '')}`
  const imageAttachments = bridges?.imageAttachments ?? EMPTY_ATTACHMENTS
  const autocomplete = bridges?.autocomplete ?? DEFAULT_AUTOCOMPLETE

  const ptySend = useAgentComposerSend(core, props, bridges, imageAttachments)
  const send = bridges?.sendOverride ?? ptySend

  const handleDraftChange = useCallback(
    (value: string, element: HTMLTextAreaElement) => {
      core.setDraft(value)
      core.setHistory((previous) => ({ entries: previous.entries, index: null }))
      core.syncCaret(element)
      bridges?.handleDraftOrCaretChange?.(value, element.selectionStart ?? value.length)
      core.setActiveSuggestion(0)
    },
    [core, bridges]
  )

  const handleKeyDown = useAgentComposerKeyDown({
    autocomplete,
    activeSuggestion: core.activeSuggestion,
    draft: core.draft,
    history: core.history,
    isComposing: () => core.isComposingRef.current,
    completePickerItem: bridges?.completeItem ?? noop,
    dispatchPickerCommand: bridges?.dispatchPickerCommand ?? noop,
    dismissPicker: bridges?.dismissPicker ?? noop,
    interrupt: core.interrupt,
    send,
    setActiveSuggestion: core.setActiveSuggestion,
    setDraft: core.setDraft,
    setCaret: core.setCaret,
    setHistory: core.setHistory
  })

  const handlePasteEvent = useCallback(
    (event: PasteEventLike) => {
      if (bridges?.onPaste) {
        bridges.onPaste(event)
        return
      }
      if (event.defaultPrevented) {
        return
      }
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text.length === 0) {
        return
      }
      event.preventDefault()
      core.insertTypedText(text)
    },
    [bridges, core]
  )

  const pasteFromClipboard = useCallback(() => {
    if (bridges?.pasteFromClipboard) {
      bridges.pasteFromClipboard()
      return
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      return
    }
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text.length > 0) {
          core.insertTypedText(text)
        }
      })
      .catch(() => {})
  }, [bridges, core])

  const sendButtonDisabled =
    core.disabled ||
    props.sendDisabled ||
    (core.draft.trim() === '' && imageAttachments.length === 0)

  const fieldProps: AgentComposerFieldProps = {
    terminalTabId: props.terminalTabId,
    paneKey: props.paneKey,
    textareaRef: core.textareaRef,
    draft: core.draft,
    disabled: core.disabled,
    hasPty: core.hasPty,
    canSend,
    layout: props.layout,
    autocomplete,
    activeSuggestion: core.activeSuggestion,
    notice: core.notice,
    imageAttachments,
    sendButtonDisabled,
    isWorking,
    attachDisabled: core.disabled,
    dictationDisabled: core.disabled || (bridges?.dictationDisabled ?? true),
    isDictating: bridges?.isDictating ?? false,
    isDictationHoldMode: bridges?.isDictationHoldMode ?? false,
    onDraftChange: handleDraftChange,
    onTextareaSelect: (element) => {
      core.syncCaret(element)
      bridges?.handleDraftOrCaretChange?.(
        element.value,
        element.selectionStart ?? element.value.length
      )
      core.setActiveSuggestion(0)
    },
    onKeyDown: handleKeyDown,
    onCompositionStart: () => {
      core.isComposingRef.current = true
    },
    onCompositionEnd: (event) => {
      core.isComposingRef.current = false
      if (event.currentTarget.value !== core.draft) {
        handleDraftChange(event.currentTarget.value, event.currentTarget)
      }
    },
    onPaste: (event) => handlePasteEvent(event),
    pickerListboxId: bridges?.pickerListboxId ?? generatedListboxId,
    onChoosePickerItem: bridges?.completeItem ?? noop,
    onRetrySkills: bridges?.retrySkills ?? noop,
    onAcceptMention: bridges?.onAcceptMention ?? noop,
    onRemoveImageAttachment: bridges?.onRemoveImageAttachment ?? noop,
    onAttach: bridges?.onAttach ?? noop,
    onDictationToggle: bridges?.onDictationToggle ?? noop,
    onDictationHoldStart: bridges?.onDictationHoldStart ?? noop,
    onDictationHoldEnd: bridges?.onDictationHoldEnd ?? noop,
    onSend: send,
    onStop: core.interrupt,
    sessionOptionsSurface: bridges?.sessionOptionsSurface ?? null,
    sessionOptionsSnapshot: bridges?.sessionOptionsSnapshot ?? EMPTY_SNAPSHOT
  }

  return { fieldProps, handlePasteEvent, pasteFromClipboard }
}

/** Host-agnostic composer: mounts with only {@link AgentComposerCoreProps} and
 *  renders a working compose-and-send field. A host that needs pickers,
 *  attachments, dictation, or session options builds those as bridges via
 *  {@link useAgentComposerCoreState} + {@link useAgentComposerCompose} instead
 *  of mounting this directly, so its bridges share this exact draft/caret
 *  state rather than a second copy of it. */
export const AgentComposer = forwardRef<AgentComposerHandle, AgentComposerCoreProps>(
  function AgentComposer(props, ref): React.JSX.Element {
    const core = useAgentComposerCoreState(props)
    const { fieldProps, handlePasteEvent, pasteFromClipboard } = useAgentComposerCompose(
      core,
      props
    )

    useImperativeHandle(
      ref,
      () => ({
        focus: core.focus,
        insertTypedText: core.insertTypedText,
        handlePasteEvent,
        pasteFromClipboard
      }),
      [core.focus, core.insertTypedText, handlePasteEvent, pasteFromClipboard]
    )

    return <AgentComposerField {...fieldProps} />
  }
)
