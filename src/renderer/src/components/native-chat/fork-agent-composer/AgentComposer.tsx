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
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { useNativeChatComposerAppMenuSelection } from '../use-native-chat-composer-app-menu-selection'
import type { NativeChatSendHandle, NativeChatSendOptions } from '../native-chat-runtime-send'
import { useNativeChatSendLifecycle } from '../use-native-chat-send-lifecycle'
import { useNativeChatTypedInsertion } from '../use-native-chat-typed-insertion'
import { useNativeChatComposerInterrupt } from '../use-native-chat-composer-interrupt'
import { useNativeChatComposerNotice } from '../use-native-chat-composer-notice'
import type { NativeChatComposerNotice } from '../native-chat-composer-notice'
import { nativeChatImageSendBlock } from '../native-chat-image-reattach'
import type { NativeChatMentionFiles } from '../use-native-chat-mention-files'
import type { NativeChatComposerGoalMode } from '../use-native-chat-composer-submit'
import type { NativeChatContextUsageSummary } from '../native-chat-context-usage-summary'
import type { NativeChatResolvedTarget } from '../native-chat-composer-target'
import { isTerminalInputQuarantined } from '../../terminal-pane/terminal-input-quarantine'
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

const EMPTY_ATTACHMENTS: readonly AgentComposerImageAttachment[] = []
const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const DEFAULT_AUTOCOMPLETE: ComposerAutocomplete = { mode: 'none' }
const NO_MENTION_FILES: NativeChatMentionFiles = { files: [], loading: false, failed: false }

function noop(): void {}

type PasteEventLike = Parameters<AgentComposerHandle['handlePasteEvent']>[0]

export type AgentComposerCoreState = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  imeEnterGesture: ReturnType<typeof useImeEnterGestureOwnership>
  draft: string
  setDraft: (next: string | ((previous: string) => string)) => void
  flushDraftAppends: () => void
  caret: number
  setCaret: Dispatch<SetStateAction<number>>
  history: HistoryState
  setHistory: Dispatch<SetStateAction<HistoryState>>
  activeSuggestion: number
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  notices: readonly NativeChatComposerNotice[]
  setNotice: (text: string | null, errorText?: string) => void
  /** Owner of the unsent draft and its attachments. */
  draftScopeKey: string
  hasPty: boolean
  disabled: boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  trackPendingSend: (handle: NativeChatSendHandle, pendingId?: string) => void
  interrupt: () => void
  insertTypedText: (text: string) => boolean
  appendText: (text: string) => void
  acceptsText: () => boolean
  contains: (node: Node | null) => boolean
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
    draftScopeKey = paneKey,
    targetPtyId,
    canSend = true,
    allowWithoutTarget = false,
    unavailableHint,
    isWorking = false,
    inputOwnedByCard = false,
    onStop,
    onOptimisticSendCanceled,
    optimisticSendOutcome
  } = props
  const imeEnterGesture = useImeEnterGestureOwnership()
  const { draft, setDraft, flushDraftAppends } = useAgentComposerDraft(
    draftScopeKey,
    imeEnterGesture.isComposing
  )
  const [caret, setCaret] = useState(draft.length)
  // History stays per pane: a structured conversation's draft scope is shared across panes.
  const { history, setHistory } = useAgentComposerHistory(paneKey)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const { notices, setNotice } = useNativeChatComposerNotice(props.notices)
  // Why: v1.4.200 widened the app-menu ref to NativeChatComposerInput for upstream's
  // contenteditable editor. This composer's field is a real <textarea>, so the ref
  // only ever holds one, and the overlay and scroll sync need the element itself.
  const { textareaRef: composerInputRef } = useNativeChatComposerAppMenuSelection(
    imeEnterGesture.isComposing
  )
  const textareaRef = composerInputRef as RefObject<HTMLTextAreaElement | null>
  const { cancelPendingSends, trackPendingSend } = useNativeChatSendLifecycle(
    terminalTabId,
    targetPtyId,
    onOptimisticSendCanceled,
    { inputOwnedByCard, onPendingSendRetired: optimisticSendOutcome?.reject },
    canSend
  )

  // Place the caret at the end of the (possibly restored) draft when the
  // composer is reused for a different pane, adjusted during render so caret
  // and text stay consistent on the first paint after the switch.
  const lastScopeKey = useRef(draftScopeKey)
  if (lastScopeKey.current !== draftScopeKey) {
    lastScopeKey.current = draftScopeKey
    setCaret(readAgentComposerDraftCache(draftScopeKey).length)
  }

  const resolveTarget = useCallback((): NativeChatResolvedTarget | null => {
    if (!targetPtyId || isTerminalInputQuarantined(terminalTabId)) {
      return null
    }
    return { terminalTabId, ptyId: targetPtyId }
  }, [targetPtyId, terminalTabId])

  const hasPty = allowWithoutTarget || targetPtyId !== null
  // Why inputOwnedByCard: the hidden field can still hold keyboard focus for a frame.
  const disabled = allowWithoutTarget
    ? !canSend || unavailableHint !== undefined
    : targetPtyId === null || !canSend || inputOwnedByCard

  const syncCaret = useCallback((element: HTMLTextAreaElement) => {
    setCaret(element.selectionStart ?? element.value.length)
  }, [])

  const {
    insertTypedText: insertIntoDraft,
    appendText: appendToDraft,
    focus,
    acceptsText,
    contains
  } = useNativeChatTypedInsertion({
    textareaRef,
    isComposing: imeEnterGesture.isComposing,
    setDraft,
    setCaret,
    setActiveSuggestion
  })
  const leaveHistory = useCallback(
    () => setHistory((previous) => ({ entries: previous.entries, index: null })),
    [setHistory]
  )
  const insertTypedText = useCallback(
    (text: string): boolean => {
      const inserted = insertIntoDraft(text)
      if (inserted) {
        leaveHistory()
      }
      return inserted
    },
    [insertIntoDraft, leaveHistory]
  )
  const appendText = useCallback(
    (text: string): void => {
      if (acceptsText()) {
        leaveHistory()
      }
      appendToDraft(text)
    },
    [acceptsText, appendToDraft, leaveHistory]
  )

  const interrupt = useNativeChatComposerInterrupt({
    inert: inputOwnedByCard,
    cancelPendingSends,
    isWorking,
    onStop,
    resolveTarget
  })

  return {
    textareaRef,
    imeEnterGesture,
    draft,
    setDraft,
    flushDraftAppends,
    caret,
    setCaret,
    history,
    setHistory,
    activeSuggestion,
    setActiveSuggestion,
    notices,
    setNotice,
    draftScopeKey,
    hasPty,
    disabled,
    resolveTarget,
    trackPendingSend,
    interrupt,
    insertTypedText,
    appendText,
    acceptsText,
    contains,
    focus,
    syncCaret
  }
}

/** Optional host wiring for the field's picker/attachment/dictation/session
 *  surfaces. Every field is inert when absent, so a host supplying none of
 *  this still gets a working compose-and-send composer. */
export type AgentComposerHostBridges = {
  autocomplete?: ComposerAutocomplete
  /** Applies attachments the host deferred while an IME composition was live. */
  flushPendingAttachments?: () => void
  pickerListboxId?: string
  classifySend?: (draft: string) => NativeChatSendClassification
  clearSkillOrigin?: () => void
  completeItem?: (item: NativeChatPickerItem) => void
  retrySkills?: () => void
  dismissPicker?: (triggerKey: string) => void
  handleDraftOrCaretChange?: (value: string, caret: number) => void
  dispatchPickerCommand?: (item: Extract<NativeChatPickerItem, { kind: 'command' }>) => void
  mentionFiles?: NativeChatMentionFiles
  completeMention?: (path: string) => void
  /** Cmd/Ctrl+Enter from an empty composer: send the newest queued draft now. */
  steerQueued?: () => boolean
  goalMode?: NativeChatComposerGoalMode
  contextUsage?: NativeChatContextUsageSummary | null
  /** The host holds sends for this reason, which the disabled Send button says. */
  sendBlockedReason?: string

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
  /** The host's transport has a send out; Send stays disabled until it settles. */
  sendHeld?: boolean
  /** Answers a command in the composer instead of sending it; true when it did. */
  answerLocally?: (text: string) => boolean

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

  const imageBlock = nativeChatImageSendBlock(imageAttachments)
  const ptySend = useAgentComposerSend(core, props, bridges, imageAttachments)
  const sendOverride = bridges?.sendOverride
  const answerLocally = bridges?.answerLocally
  const { sendDisabled } = props
  const send = useCallback(() => {
    if (imageBlock.holdsSend) {
      return
    }
    if (sendOverride) {
      sendOverride()
      return
    }
    const answerable = core.resolveTarget() && !core.disabled && !sendDisabled
    if (answerable && answerLocally?.(core.draft)) {
      return
    }
    ptySend()
  }, [answerLocally, core, imageBlock.holdsSend, ptySend, sendDisabled, sendOverride])

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

  const goalMode = bridges?.goalMode
  const completeItem = bridges?.completeItem ?? noop
  const dispatchPickerCommand = bridges?.dispatchPickerCommand ?? noop
  const mentionFiles = bridges?.mentionFiles ?? NO_MENTION_FILES
  const handleKeyDown = useAgentComposerKeyDown({
    autocomplete,
    mentionFiles,
    completeMention: bridges?.completeMention ?? noop,
    activeSuggestion: core.activeSuggestion,
    draft: core.draft,
    hasAttachments: imageAttachments.length > 0,
    history: core.history,
    isComposing: core.imeEnterGesture.isComposing,
    completePickerItem: goalMode ? goalMode.interceptPick(completeItem) : completeItem,
    dispatchPickerCommand: goalMode
      ? goalMode.interceptPick(dispatchPickerCommand)
      : dispatchPickerCommand,
    dismissPicker: bridges?.dismissPicker ?? noop,
    interrupt: core.interrupt,
    send,
    ...(bridges?.steerQueued ? { steerQueued: bridges.steerQueued } : {}),
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
    bridges?.sendHeld === true ||
    bridges?.sendBlockedReason !== undefined ||
    imageBlock.holdsSend ||
    (core.draft.trim() === '' && imageAttachments.length === 0)

  const fieldProps: AgentComposerFieldProps = {
    terminalTabId: props.terminalTabId,
    draftScopeKey: core.draftScopeKey,
    textareaRef: core.textareaRef,
    draft: core.draft,
    disabled: core.disabled,
    hasPty: core.hasPty,
    canSend,
    unavailableHint: props.unavailableHint,
    layout: props.layout,
    autocomplete,
    mentionFiles,
    activeSuggestion: core.activeSuggestion,
    notices: core.notices,
    imageAttachments,
    sendButtonDisabled,
    sendBlockedReason: imageBlock.reason ?? bridges?.sendBlockedReason ?? null,
    isWorking,
    isStopping: props.isStopping,
    afterStop: props.afterStop,
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
    imeEnterGesture: core.imeEnterGesture,
    onImeSettled: (element) => {
      if (element.value !== core.draft) {
        handleDraftChange(element.value, element)
      }
      core.flushDraftAppends()
      bridges?.flushPendingAttachments?.()
    },
    onPaste: (event) => handlePasteEvent(event),
    pickerListboxId: bridges?.pickerListboxId ?? generatedListboxId,
    onChoosePickerItem: goalMode ? goalMode.interceptPick(completeItem) : completeItem,
    onRetrySkills: bridges?.retrySkills ?? noop,
    onChooseMentionFile: bridges?.completeMention ?? noop,
    onRemoveImageAttachment: bridges?.onRemoveImageAttachment ?? noop,
    onAttach: bridges?.onAttach ?? noop,
    onDictationToggle: bridges?.onDictationToggle ?? noop,
    onDictationHoldStart: bridges?.onDictationHoldStart ?? noop,
    onDictationHoldEnd: bridges?.onDictationHoldEnd ?? noop,
    onSend: send,
    onStop: core.interrupt,
    sessionOptionsSurface: bridges?.sessionOptionsSurface ?? null,
    sessionOptionsSnapshot: bridges?.sessionOptionsSnapshot ?? EMPTY_SNAPSHOT,
    contextUsage: bridges?.contextUsage ?? null,
    goalMode
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
