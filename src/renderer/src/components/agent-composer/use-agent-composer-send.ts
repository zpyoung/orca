import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import {
  sendNativeChatMessage,
  sendNativeChatMessageWithImageAttachments,
  submitNativeChatPrompt
} from '../native-chat/native-chat-runtime-send'
import type {
  NativeChatSendHandle,
  NativeChatSendOptions
} from '../native-chat/native-chat-runtime-send'
import { pushHistory } from './agent-composer-history'
import {
  readAgentComposerDraftCache,
  writeAgentComposerDraftCache
} from './agent-composer-draft-cache'
import { buildComposerSendOptions } from './composer-send-options'
import type { AgentComposerImageAttachment } from './AgentComposerField'
import type { AgentComposerCoreProps } from './agent-composer-types'
import type { AgentComposerCoreState, AgentComposerHostBridges } from './AgentComposer'

export function useAgentComposerSend(
  core: AgentComposerCoreState,
  props: AgentComposerCoreProps,
  bridges: AgentComposerHostBridges | undefined,
  imageAttachments: readonly AgentComposerImageAttachment[]
): () => void {
  const { onOptimisticSend } = props
  return useCallback(() => {
    const text = core.draft
    const sentAttachments = [...imageAttachments]
    const imagePaths = sentAttachments.map((attachment) => attachment.path)
    if ((text.trim() === '' && imagePaths.length === 0) || core.disabled || props.sendDisabled) {
      return
    }
    if (bridges?.isDispatchingSessionOption) {
      return
    }
    const target = core.resolveTarget()
    if (!target) {
      return
    }
    const classification = bridges?.classifySend?.(text) ?? 'chat'
    const baseSendOptions = bridges?.buildSendOptions?.()
    const restorePayload = (): void => {
      const prefix = `${text}

`
      const currentDraft = readAgentComposerDraftCache(props.paneKey)
      const restoredDraft = prefix + currentDraft
      writeAgentComposerDraftCache(props.paneKey, restoredDraft)
      core.setDraft(restoredDraft)
      core.setCaret((current) => current + prefix.length)
      bridges?.restoreImageAttachments?.(sentAttachments)
      core.setNotice(
        translate(
          'components.native-chat.composer.sendMayNotHaveCompleted',
          'Send may not have completed. Check the terminal before retrying.'
        )
      )
    }
    const tierSendOptions = props.sendTier
      ? buildComposerSendOptions({
          text,
          tier: props.sendTier,
          readTerminalScreen: props.readTerminalScreen,
          onOutcome: (outcome) => {
            if (outcome === 'may-not-have-sent') {
              restorePayload()
            }
            props.onSendOutcome?.(outcome)
          }
        })
      : undefined
    const sendOptions = mergeSendOptions(baseSendOptions, tierSendOptions)

    core.setHistory((previous) => pushHistory(previous, text))
    core.setDraft('')
    core.setCaret(0)
    bridges?.clearSkillOrigin?.()
    bridges?.clearImageAttachments?.()
    core.setNotice(null)

    const pendingId = classification === 'chat' ? onOptimisticSend?.(text, imagePaths) : undefined
    let pendingHandle: NativeChatSendHandle | null = null
    if (classification !== 'chat' && imagePaths.length === 0) {
      pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
    } else if (imagePaths.length > 0) {
      pendingHandle = sendNativeChatMessageWithImageAttachments(
        target.settings,
        target.ptyId,
        text,
        imagePaths,
        sendOptions
      )
    } else if (text.trim().length > 0) {
      pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
    } else {
      submitNativeChatPrompt(target.settings, target.ptyId)
    }
    if (classification !== 'chat') {
      if (pendingHandle) {
        core.trackPendingSend(pendingHandle)
      }
      if (classification === 'command') {
        bridges?.onSlashCommand?.(text.trim())
        bridges?.onCommandDispatched?.(text.trim())
      }
    } else if (pendingHandle) {
      core.trackPendingSend(pendingHandle, pendingId)
    }
    bridges?.onAfterSend?.({ classification, ptyId: target.ptyId })
  }, [core, imageAttachments, bridges, onOptimisticSend, props])
}

function mergeSendOptions(
  base: NativeChatSendOptions | undefined,
  tier: NativeChatSendOptions | undefined
): NativeChatSendOptions | undefined {
  if (!tier) {
    return base
  }
  return {
    ...base,
    ...tier,
    clearInput: base?.clearInput ?? tier.clearInput,
    confirmCleared: base?.confirmCleared ?? tier.confirmCleared,
    confirmSubmitted: base?.confirmSubmitted ?? tier.confirmSubmitted,
    onOutcome: (outcome) => {
      tier.onOutcome?.(outcome)
      base?.onOutcome?.(outcome)
    }
  }
}
