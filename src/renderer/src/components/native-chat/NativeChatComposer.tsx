import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { useAppStore } from '../../store'
import { sendNativeChatTypedCommand } from './native-chat-runtime-send'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { applyMentionSuggestion } from './native-chat-composer-state'
import {
  useAgentComposerCoreState,
  useAgentComposerCompose,
  type AgentComposerHostBridges
} from './fork-agent-composer/AgentComposer'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { useNativeChatLaunchDraftAdoption } from './use-native-chat-launch-draft-adoption'
import { AgentComposerField } from './fork-agent-composer/AgentComposerField'
import { nativeChatComposerTargetIsRemote } from './native-chat-composer-target'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { useNativeChatDictationActions } from './use-native-chat-dictation-actions'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import { useNativeChatPickerState } from './use-native-chat-picker-state'
import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import { pushHistory, seedHistory } from './fork-agent-composer/agent-composer-history'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'
import { isStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'

export type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

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
      targetPtyId,
      agent,
      canSend = true,
      sendDisabled = false,
      layout,
      isWorking = false,
      sendTier,
      historyPrompts,
      onSendOutcome,
      onStop,
      onOptimisticSend,
      onOptimisticSendCanceled,
      onSlashCommand,
      onSwitchToTerminal,
      readTerminalScreen,
      launchSeed,
      reportedSessionOptions,
      structuredTransport
    },
    ref
  ): React.JSX.Element {
    const coreProps = {
      terminalTabId,
      paneKey,
      targetPtyId,
      agent,
      canSend,
      allowWithoutTarget: Boolean(structuredTransport),
      sendDisabled,
      layout,
      isWorking,
      sendTier,
      onSendOutcome,
      onStop,
      onOptimisticSend,
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

    const agentCommands = useMemo(() => getVerifiedNativeChatCommands(agent), [agent])
    const picker = useNativeChatPickerState({
      agent,
      terminalTabId,
      draftScopeKey: paneKey,
      draft: core.draft,
      caret: core.caret,
      agentCommands,
      textareaRef: core.textareaRef,
      setDraft: core.setDraft,
      setCaret: core.setCaret,
      setActiveSuggestion: core.setActiveSuggestion
    })

    const {
      imageAttachments,
      attachResolvedPaths,
      clearImageAttachments,
      flushPendingAttachments,
      restoreImageAttachments,
      removeImageAttachment
    } = useNativeChatComposerAttachments({
      attachmentScopeKey: paneKey,
      allowWithoutTarget: Boolean(structuredTransport),
      caret: core.caret,
      disabled: core.disabled,
      isComposing: core.imeEnterGesture.isComposing,
      resolveTarget: core.resolveTarget,
      textareaRef: core.textareaRef,
      setCaret: core.setCaret,
      setDraft: core.setDraft,
      setNotice: core.setNotice
    })

    const { attachExternalPaths, resolveAttachmentOwner } = useNativeChatExternalAttachments({
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId,
      disabled: core.disabled,
      attachResolvedPaths,
      setNotice: core.setNotice
    })

    const { handlePaste, pasteFromClipboard } = useNativeChatComposerPaste({
      agent,
      disabled: core.disabled,
      caret: core.caret,
      resolveAttachmentOwner,
      attachResolvedPaths,
      insertTypedText: core.insertTypedText,
      setCaret: core.setCaret,
      setNotice: core.setNotice
    })

    const { pickAttachment } = useNativeChatFileAttachmentActions(attachExternalPaths, {
      terminalTabId,
      paneKey
    })
    const [dictationPressed, setDictationPressed] = useState(false)
    const { toggleDictation, startHoldDictation, stopHoldDictation } =
      useNativeChatDictationActions({ textareaRef: core.textareaRef, setDictationPressed })
    const dictationState = useAppStore((store) => store.dictationState)
    const voiceSettings = useAppStore((store) => store.settings?.voice)
    const isDictationHoldMode = voiceSettings?.dictationMode === 'hold'
    const dictationDisabled = voiceSettings?.enabled !== true || !voiceSettings.sttModel
    const isDictating =
      dictationPressed ||
      dictationState === 'starting' ||
      dictationState === 'listening' ||
      dictationState === 'stopping'

    const { dispatch: dispatchSessionOptionCommand, isDispatching: isDispatchingSessionOption } =
      useNativeChatSessionOptionCommand({
        agent,
        disabled: core.disabled,
        onSlashCommand,
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
        reportedSessionOptions
      })
    const sessionOptionsSurface = structuredTransport?.optionsSurface ?? ptySessionOptionsSurface
    const sessionOptionsSnapshot = structuredTransport?.optionSnapshot ?? ptySessionOptionsSnapshot

    const sendStructured = useCallback(
      (text: string, attachments = imageAttachments): void => {
        if (!structuredTransport) {
          return
        }
        if (attachments.length > 0 && isStructuredAgentSessionComposerCommand(text, agent)) {
          structuredTransport.onError('Remove attachments before using a chat-session command.')
          return
        }
        void dispatchNativeChatStructuredComposerText(structuredTransport, text, attachments)
          .then(({ accepted, error }) => {
            structuredTransport.onError(error)
            if (!accepted) {
              return
            }
            emitNativeChatMessageSent({ agent, runtime: structuredTransport.runtime })
            core.setHistory((previous) => pushHistory(previous, text))
            core.setDraft('')
            core.setCaret(0)
            picker.clearSkillOrigin()
            clearImageAttachments()
          })
          .catch((error) =>
            structuredTransport.onError(error instanceof Error ? error.message : String(error))
          )
      },
      [agent, clearImageAttachments, core, imageAttachments, picker, structuredTransport]
    )

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
      (command: Parameters<typeof dispatchPtyPickerCommand>[0]) => {
        if (structuredTransport) {
          sendStructured(`/${command.name}`)
          return
        }
        dispatchPtyPickerCommand(command)
      },
      [dispatchPtyPickerCommand, sendStructured, structuredTransport]
    )

    const bridges: AgentComposerHostBridges = {
      // A structured session sends over its own journal transport, never the PTY.
      ...(structuredTransport
        ? {
            sendOverride: () => {
              if ((core.draft.trim() !== '' || imageAttachments.length > 0) && !core.disabled) {
                sendStructured(core.draft, imageAttachments)
              }
            }
          }
        : {}),
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
      onAcceptMention: () => {
        if (picker.autocomplete.mode !== 'mention') {
          return
        }
        const result = applyMentionSuggestion(core.draft, core.caret, picker.autocomplete.query)
        core.setDraft(result.draft)
        core.setCaret(result.caret)
        const textarea = core.textareaRef.current
        textarea?.focus()
        requestAnimationFrame(() => textarea?.setSelectionRange(result.caret, result.caret))
      },
      imageAttachments,
      onAttach: pickAttachment,
      onRemoveImageAttachment: removeImageAttachment,
      clearImageAttachments,
      restoreImageAttachments,
      onPaste: handlePaste,
      pasteFromClipboard,
      isDictating,
      isDictationHoldMode,
      dictationDisabled,
      onDictationToggle: toggleDictation,
      onDictationHoldStart: startHoldDictation,
      onDictationHoldEnd: stopHoldDictation,
      sessionOptionsSurface,
      sessionOptionsSnapshot,
      isDispatchingSessionOption,
      onSlashCommand,
      onCommandDispatched: (command) => ptySessionOptionsSurface?.recordOutgoingCommand(command),
      // Codex's TUI only autocompletes a slash command it sees typed; a pasted
      // one lands as literal text.
      sendTypedCommand: (target, text) =>
        agent === 'codex' && isSlashCommandDraft(text)
          ? sendNativeChatTypedCommand(target.settings, target.ptyId, text)
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
        handlePasteEvent: handlePaste,
        pasteFromClipboard
      }),
      [core.focus, core.insertTypedText, handlePaste, pasteFromClipboard]
    )

    return (
      <AgentComposerField
        {...fieldProps}
        sessionOptionsPickerRequest={structuredTransport?.optionPickerRequest ?? null}
      />
    )
  }
)

export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(props, ref): React.JSX.Element {
    return <NativeChatComposerPane key={props.paneKey} {...props} ref={ref} />
  }
)
