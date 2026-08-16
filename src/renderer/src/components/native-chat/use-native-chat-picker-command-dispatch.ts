import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  emitNativeChatMessageSent,
  emitNativeChatPickerItemAccepted,
  emitNativeChatSendClassified
} from '@/lib/native-chat-telemetry'
import { sendNativeChatMessage, sendNativeChatTypedCommand } from './native-chat-runtime-send'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import { pushHistory, type HistoryState } from '../agent-composer/agent-composer-history'
import type { NativeChatPickerItem } from './native-chat-composer-state'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import type { SendOutcome } from './native-chat-send-outcome'
import { buildComposerSendOptions } from '../agent-composer/composer-send-options'
import { createComposerPayloadRestore } from '../agent-composer/use-agent-composer-send'
import type { ComposerSendTier } from '../agent-composer/composer-send-tier'
import type { AgentComposerImageAttachment } from '../agent-composer/AgentComposerField'

export function useNativeChatPickerCommandDispatch(args: {
  agent: AgentType
  disabled: boolean
  isDispatchingSessionOption: boolean
  paneKey: string
  sendTier?: ComposerSendTier
  onSendOutcome?: (outcome: SendOutcome) => void
  readTerminalScreen?: () => string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  onSlashCommand?: (command: string) => void
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
  imageAttachments: readonly AgentComposerImageAttachment[]
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  restoreImageAttachments: (attachments: readonly AgentComposerImageAttachment[]) => void
  setNotice: Dispatch<SetStateAction<string | null>>
}): (command: Extract<NativeChatPickerItem, { kind: 'command' }>) => void {
  const {
    agent,
    disabled,
    isDispatchingSessionOption,
    paneKey,
    sendTier,
    onSendOutcome,
    readTerminalScreen,
    resolveTarget,
    onSlashCommand,
    sessionOptionsSurface,
    trackPendingSend,
    setHistory,
    setDraft,
    setCaret,
    setActiveSuggestion,
    imageAttachments,
    clearSkillOrigin,
    clearImageAttachments,
    restoreImageAttachments,
    setNotice
  } = args
  return useCallback(
    (command) => {
      const text = `/${command.name}`
      const target = resolveTarget()
      if (!target || disabled || isDispatchingSessionOption) {
        return
      }
      const restorePayload = createComposerPayloadRestore({
        paneKey,
        text,
        imageAttachments,
        setDraft,
        setCaret,
        setNotice,
        restoreImageAttachments
      })
      // Same tiered send-options pipeline as a normal chat send, so a picker
      // command reports exactly once and restores on `may-not-have-sent`.
      const sendOptions = buildComposerSendOptions({
        text,
        tier: sendTier ?? 'input',
        readTerminalScreen,
        onOutcome: (outcome) => {
          if (outcome === 'may-not-have-sent') {
            restorePayload()
          }
          onSendOutcome?.(outcome)
        }
      })
      trackPendingSend(
        agent === 'codex'
          ? sendNativeChatTypedCommand(target.settings, target.ptyId, text)
          : sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
      )
      emitNativeChatPickerItemAccepted({ agent, itemKind: 'command' })
      // Why: picker dispatch is a catalog-verified command send; it must leave
      // the same telemetry and composer state as the typed path — including
      // disarming attachments, or a stale image rides the next prompt.
      emitNativeChatSendClassified({ agent, outcome: 'command' })
      onSlashCommand?.(text)
      sessionOptionsSurface?.recordOutgoingCommand(text)
      emitNativeChatMessageSent({
        agent,
        runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
      })
      setHistory((previous) => pushHistory(previous, text))
      setDraft('')
      setCaret(0)
      setActiveSuggestion(0)
      clearSkillOrigin()
      clearImageAttachments()
      setNotice(null)
    },
    [
      agent,
      clearImageAttachments,
      clearSkillOrigin,
      disabled,
      imageAttachments,
      isDispatchingSessionOption,
      onSendOutcome,
      onSlashCommand,
      paneKey,
      readTerminalScreen,
      resolveTarget,
      restoreImageAttachments,
      sendTier,
      sessionOptionsSurface,
      setActiveSuggestion,
      setCaret,
      setDraft,
      setHistory,
      setNotice,
      trackPendingSend
    ]
  )
}
