import { forwardRef, useCallback, useEffect, useImperativeHandle } from 'react'
import { useAppStore } from '../../store'
import { sendNativeChatTypedCommand } from './native-chat-runtime-send'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  useAgentComposerCoreState,
  useAgentComposerCompose,
  type AgentComposerHostBridges
} from './fork-agent-composer/AgentComposer'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import { useNativeChatLaunchDraftAdoption } from './use-native-chat-launch-draft-adoption'
import { AgentComposerField } from './fork-agent-composer/AgentComposerField'
import { nativeChatComposerTargetIsRemote } from './native-chat-composer-target'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { appendNativeChatAttachmentCache } from './native-chat-draft-cache'
import type { AgentComposerImageAttachment } from './fork-agent-composer/AgentComposerField'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { useNativeChatFileDrops } from './use-native-chat-file-drops'
import { useNativeChatMentionFiles } from './use-native-chat-mention-files'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'
import { useNativeChatContextUsageSummary } from './use-native-chat-context-usage-summary'
import { useNativeChatDictation } from './use-native-chat-dictation'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import { useNativeChatPickerState } from './use-native-chat-picker-state'
import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import { useNativeChatHeldQueueComposerSend } from './use-native-chat-held-queue-composer-send'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'
import { answerNativeChatCommandInComposer } from './use-native-chat-local-command-answer'
import { seedHistory } from './fork-agent-composer/agent-composer-history'
import { useAgentComposerStructuredHistory } from './fork-agent-composer/use-agent-composer-structured-history'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

export type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

function noop(): void {}

/**
 * Rich native input for the chat view. Sends prompts into the running agent
 * through the same verified runtime path as typed input (KTD4), so the agent
 * cannot distinguish native input from keystrokes. Enter sends; Shift+Enter
 * inserts a newline; multi-line is bracketed-paste wrapped; Esc interrupts.
 * Slash-command and `@file` autocomplete are agent-aware; image paste persists a
 * temp file and injects the agent-appropriate path (or reports unsupported).
 *
 * A thin host wrapper over the shared {@link useAgentComposerCoreState} /
 * {@link useAgentComposerCompose} composer core: it owns only what's specific
 * to the chat surface (launch-draft adoption, picker/attachment/dictation/
 * session-option wiring) and builds its bridges from the exact same core
 * state it renders, so draft and caret never desync from another host.
 */
const NativeChatComposerPane = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposerPane(
    {
      terminalTabId,
      paneKey,
      draftScopeKey = paneKey,
      targetPtyId,
      agent,
      canSend = true,
      sendDisabled = false,
      layout,
      isWorking = false,
      isStopping = false,
      afterStop,
      sendTier,
      historyPrompts,
      onSendOutcome,
      onStop,
      onOptimisticSend,
      optimisticSendOutcome,
      onOptimisticSendCanceled,
      onSlashCommand,
      onSubmitted,
      answerCommandLocally,
      onSwitchToTerminal,
      readTerminalScreen,
      launchSeed,
      reportedSessionOptions,
      structuredTransport,
      steerQueued,
      inputOwnedByCard = false,
      notices
    },
    ref
  ): React.JSX.Element {
    const coreProps = {
      terminalTabId,
      paneKey,
      draftScopeKey,
      targetPtyId,
      agent,
      canSend,
      allowWithoutTarget: Boolean(structuredTransport),
      sendDisabled,
      layout,
      isWorking,
      isStopping,
      afterStop,
      inputOwnedByCard,
      notices,
      sendTier,
      onSendOutcome,
      onStop,
      onOptimisticSend,
      optimisticSendOutcome,
      onOptimisticSendCanceled,
      readTerminalScreen
    }
    const core = useAgentComposerCoreState(coreProps)
    const setComposerHistory = core.setHistory
    useEffect(() => {
      if (historyPrompts && historyPrompts.length > 0) {
        setComposerHistory((previous) => seedHistory(previous, historyPrompts))
      }
    }, [setComposerHistory, historyPrompts])
    useNativeChatLaunchDraftAdoption({
      terminalTabId,
      agent,
      launchDraft: launchSeed?.launchDraft,
      launchDraftResolved: launchSeed?.launchDraftResolved === true,
      ownsTabWideLaunchDraft: launchSeed?.ownsTabWideLaunchDraft === true,
      draft: core.draft,
      setDraft: core.setDraft,
      setCaret: core.setCaret
    })

    const { agentCommands, sessionSkillNames } = useNativeChatComposerCatalog(
      agent,
      structuredTransport
    )
    const picker = useNativeChatPickerState({
      agent,
      terminalTabId,
      draftScopeKey: paneKey,
      draft: core.draft,
      caret: core.caret,
      agentCommands,
      recalledFromHistory: core.history.index !== null,
      sessionSkillNames,
      textareaRef: core.textareaRef,
      setDraft: core.setDraft,
      setCaret: core.setCaret,
      setActiveSuggestion: core.setActiveSuggestion
    })
    const mentionFiles = useNativeChatMentionFiles({
      query: picker.autocomplete.mode === 'mention' ? picker.autocomplete.query : null,
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId
    })

    const attachments = useNativeChatComposerAttachments({
      attachmentScopeKey: draftScopeKey,
      allowWithoutTarget: Boolean(structuredTransport),
      acceptsImages: structuredTransport?.acceptsImages !== false,
      caret: core.caret,
      disabled: core.disabled,
      isComposing: core.imeEnterGesture.isComposing,
      resolveTarget: core.resolveTarget,
      textareaRef: core.textareaRef,
      setCaret: core.setCaret,
      setDraft: core.setDraft,
      setNotice: core.setNotice
    })
    const {
      imageAttachments,
      attachResolvedPaths,
      clearImageAttachments,
      flushPendingAttachments,
      removeImageAttachment
    } = attachments
    const restoreImageAttachments = useCallback(
      (restored: readonly AgentComposerImageAttachment[]) =>
        appendNativeChatAttachmentCache(draftScopeKey, restored),
      [draftScopeKey]
    )

    const { pickAttachments, resolveAttachmentOwner } = useNativeChatFileDrops({
      paneKey,
      draftScopeKey,
      targetPtyId,
      structuredTransport,
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId,
      structuredSession: structuredTransport,
      disabled: core.disabled,
      attachResolvedPaths,
      pendingChips: attachments.pendingChips,
      setNotice: core.setNotice
    })

    const { handlePaste, pasteFromClipboard } = useNativeChatComposerPaste({
      targetKey: JSON.stringify([
        paneKey,
        targetPtyId,
        structuredTransport?.sessionId,
        structuredTransport?.worktreeId,
        structuredTransport?.runtimeEnvironmentId
      ]),
      attachmentScopeKey: draftScopeKey,
      agent,
      disabled: core.disabled,
      caret: core.caret,
      resolveAttachmentOwner,
      attachResolvedPaths,
      beginPendingImageAttachment: attachments.beginPendingImageAttachment,
      // Settles into the scope cache, which outlives a composer a prompt card unmounted.
      resolvePendingImageAttachment: attachments.pendingChips.resolve,
      revealPendingImageAttachment: attachments.revealPendingImageAttachment,
      dropPendingImageAttachment: attachments.dropPendingImageAttachment,
      insertTypedText: core.insertTypedText,
      setCaret: core.setCaret,
      setNotice: core.setNotice
    })

    const dictation = useNativeChatDictation(core.textareaRef)

    const { dispatch: dispatchSessionOptionCommand, isDispatching: isDispatchingSessionOption } =
      useNativeChatSessionOptionCommand({
        agent,
        disabled: core.disabled,
        onSlashCommand,
        onSubmitted,
        resolveTarget: core.resolveTarget,
        setHistory: core.setHistory
      })

    const { surface: ptySessionOptionsSurface, snapshot: ptySessionOptionsSnapshot } =
      useNativeChatSessionOptions({
        agent,
        terminalTabId,
        targetPtyId,
        dispatchCommand: dispatchSessionOptionCommand,
        onAgentPicker: onSwitchToTerminal,
        readTerminalScreen,
        reportedSessionOptions,
        paneKey
      })
    const sessionOptionsSurface = structuredTransport?.optionsSurface ?? ptySessionOptionsSurface
    const contextUsageSummary = useNativeChatContextUsageSummary(structuredTransport)
    const sessionOptionsSnapshot = structuredTransport?.optionSnapshot ?? ptySessionOptionsSnapshot

    const historyTransport = useAgentComposerStructuredHistory(structuredTransport, core.setHistory)
    const { send: sendStructured, fieldProps: queue } = useNativeChatHeldQueueComposerSend({
      agent,
      draftScopeKey,
      imageAttachments,
      structuredTransport: historyTransport,
      isComposing: core.imeEnterGesture.isComposing,
      clearSkillOrigin: picker.clearSkillOrigin,
      setDraft: core.setDraft,
      setCaret: core.setCaret
    })
    // A structured session sends over its own journal transport, never the PTY.
    const { send: submitStructured, goalMode } = useNativeChatComposerSubmit({
      structuredTransport,
      draftScopeKey,
      draft: core.draft,
      caret: core.caret,
      imageAttachments,
      disabled: core.disabled,
      sendPty: noop,
      sendStructured,
      setDraft: core.setDraft,
      setCaret: core.setCaret
    })

    const dispatchPtyPickerCommand = useNativeChatPickerCommandDispatch({
      agent,
      disabled: core.disabled,
      isDispatchingSessionOption,
      paneKey,
      sendTier,
      onSendOutcome,
      readTerminalScreen,
      resolveTarget: core.resolveTarget,
      onSlashCommand,
      answerCommandLocally,
      onSubmitted,
      sessionOptionsSurface: ptySessionOptionsSurface,
      trackPendingSend: core.trackPendingSend,
      setHistory: core.setHistory,
      setDraft: core.setDraft,
      setCaret: core.setCaret,
      setActiveSuggestion: core.setActiveSuggestion,
      imageAttachments,
      clearSkillOrigin: picker.clearSkillOrigin,
      clearImageAttachments,
      restoreImageAttachments,
      setNotice: core.setNotice
    })
    const dispatchPickerCommand = useCallback(
      (command: Parameters<typeof dispatchPtyPickerCommand>[0]) =>
        structuredTransport
          ? sendStructured(`/${command.name}`)
          : dispatchPtyPickerCommand(command),
      [dispatchPtyPickerCommand, sendStructured, structuredTransport]
    )

    const bridges: AgentComposerHostBridges = {
      ...(structuredTransport ? { sendOverride: submitStructured } : {}),
      sendHeld: structuredTransport?.sendOut === true,
      answerLocally: (text) =>
        isSlashCommandDraft(text) &&
        !isDispatchingSessionOption &&
        answerNativeChatCommandInComposer({
          draft: text,
          answerCommandLocally,
          sessionOptionsSurface: ptySessionOptionsSurface,
          onSlashCommand,
          onSubmitted,
          setDraft: core.setDraft,
          setCaret: core.setCaret,
          clearSkillOrigin: picker.clearSkillOrigin,
          setNotice: core.setNotice
        }),
      flushPendingAttachments,
      autocomplete: picker.autocomplete,
      pickerListboxId: picker.listboxId,
      classifySend: picker.classifySend,
      clearSkillOrigin: picker.clearSkillOrigin,
      completeItem: picker.completeItem,
      retrySkills: picker.retrySkills,
      dismissPicker: picker.dismiss,
      handleDraftOrCaretChange: picker.handleDraftOrCaretChange,
      dispatchPickerCommand,
      mentionFiles,
      completeMention: picker.completeMention,
      ...(steerQueued ? { steerQueued } : {}),
      goalMode,
      contextUsage: contextUsageSummary,
      ...queue,
      imageAttachments,
      onAttach: pickAttachments,
      onRemoveImageAttachment: removeImageAttachment,
      clearImageAttachments,
      restoreImageAttachments,
      onPaste: handlePaste,
      pasteFromClipboard,
      isDictating: dictation.isDictating,
      isDictationHoldMode: dictation.isDictationHoldMode,
      dictationDisabled: dictation.dictationDisabled,
      onDictationToggle: dictation.toggleDictation,
      onDictationHoldStart: dictation.startHoldDictation,
      onDictationHoldEnd: dictation.stopHoldDictation,
      sessionOptionsSurface,
      sessionOptionsSnapshot,
      isDispatchingSessionOption,
      onSlashCommand,
      onCommandDispatched: (command) => ptySessionOptionsSurface?.recordOutgoingCommand(command),
      // Codex's TUI only autocompletes a slash command it sees typed; a pasted
      // one lands as literal text.
      sendTypedCommand: (target, text) =>
        agent === 'codex' && isSlashCommandDraft(text)
          ? sendNativeChatTypedCommand(target, text)
          : null,
      buildSendOptions: () =>
        resolveNativeChatLaunchDraftSend({
          launchDraft: launchSeed?.launchDraft,
          launchDraftResolved: launchSeed?.launchDraftResolved === true,
          agent,
          readScreen: () => readTerminalScreen?.() ?? null
        }).sendOptions,
      onAfterSend: ({ ptyId }) => {
        // Why: U10 telemetry — record adoption + local-vs-remote runtime split.
        emitNativeChatMessageSent({
          agent,
          runtime: nativeChatComposerTargetIsRemote(ptyId) ? 'remote' : 'local'
        })
        onSubmitted?.()
        // The send cleared the TUI input line before its body, so retire the seed.
        useAppStore.getState().clearNativeChatLaunchDraft(terminalTabId)
      }
    }

    const { fieldProps } = useAgentComposerCompose(core, coreProps, bridges)

    useImperativeHandle(
      ref,
      () => ({
        focus: core.focus,
        insertTypedText: core.insertTypedText,
        acceptsText: core.acceptsText,
        appendText: core.appendText,
        handlePasteEvent: handlePaste,
        pasteFromClipboard,
        contains: core.contains
      }),
      [
        core.focus,
        core.insertTypedText,
        core.acceptsText,
        core.appendText,
        core.contains,
        handlePaste,
        pasteFromClipboard
      ]
    )

    return (
      <AgentComposerField
        {...fieldProps}
        sessionOptionsPickerRequest={structuredTransport?.optionPickerRequest ?? null}
        agent={agent}
      />
    )
  }
)

export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(props, ref): React.JSX.Element {
    return <NativeChatComposerPane key={props.paneKey} {...props} ref={ref} />
  }
)
