import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { translate } from '@/i18n/i18n'
import { sendNativeChatMessage, submitNativeChatPrompt } from '../native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from '../native-chat-runtime-image-send'
import type { NativeChatSendHandle, NativeChatSendOptions } from '../native-chat-runtime-send'
import { pushHistory } from './agent-composer-history'
import {
  readAgentComposerDraftCache,
  writeAgentComposerDraftCache
} from './agent-composer-draft-cache'
import { buildComposerSendOptions } from './composer-send-options'
import type { AgentComposerImageAttachment } from './AgentComposerField'
import type { AgentComposerCoreProps } from './agent-composer-types'
import type { AgentComposerCoreState, AgentComposerHostBridges } from './AgentComposer'

/** Rebuilds an unsent send's payload into the draft so it survives a
 *  `may-not-have-sent` outcome, regardless of which host or tier sent it. */
export function createComposerPayloadRestore(args: {
  paneKey: string
  text: string
  imageAttachments: readonly AgentComposerImageAttachment[]
  setDraft: (draft: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setNotice: Dispatch<SetStateAction<string | null>>
  restoreImageAttachments?: (attachments: readonly AgentComposerImageAttachment[]) => void
}): () => void {
  return () => {
    const prefix = `${args.text}\n\n`
    const currentDraft = readAgentComposerDraftCache(args.paneKey)
    const restoredDraft = prefix + currentDraft
    writeAgentComposerDraftCache(args.paneKey, restoredDraft)
    args.setDraft(restoredDraft)
    args.setCaret((current) => current + prefix.length)
    args.restoreImageAttachments?.(args.imageAttachments)
    args.setNotice(
      translate(
        'components.native-chat.composer.sendMayNotHaveCompleted',
        'Send may not have completed. Check the terminal before retrying.'
      )
    )
  }
}

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
    const restorePayload = createComposerPayloadRestore({
      paneKey: props.paneKey,
      text,
      imageAttachments: sentAttachments,
      setDraft: core.setDraft,
      setCaret: core.setCaret,
      setNotice: core.setNotice,
      restoreImageAttachments: bridges?.restoreImageAttachments
    })
    // Retention/outcome reporting applies to every send; only the verified-tier
    // confirm callbacks are tier-gated (inside buildComposerSendOptions).
    const outcomeSendOptions = buildComposerSendOptions({
      text,
      tier: props.sendTier ?? 'input',
      readTerminalScreen: props.readTerminalScreen,
      onOutcome: (outcome) => {
        if (outcome === 'may-not-have-sent') {
          restorePayload()
        }
        props.onSendOutcome?.(outcome)
      }
    })
    const sendOptions = mergeSendOptions(baseSendOptions, outcomeSendOptions)

    core.setHistory((previous) => pushHistory(previous, text))
    core.setDraft('')
    core.setCaret(0)
    bridges?.clearSkillOrigin?.()
    bridges?.clearImageAttachments?.()
    core.setNotice(null)

    const pendingId = classification === 'chat' ? onOptimisticSend?.(text, imagePaths) : undefined
    let pendingHandle: NativeChatSendHandle | null = null
    if (classification !== 'chat' && imagePaths.length === 0) {
      pendingHandle =
        bridges?.sendTypedCommand?.(target, text) ??
        sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
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
  tier: NativeChatSendOptions
): NativeChatSendOptions {
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
