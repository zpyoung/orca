import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { imagePasteWritesFollowedByText } from '../../../../shared/image-paste-following-text'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat-answer-stepping'
import { buildNativeChatImagePasteBytes, buildNativeChatPasteBytes } from './native-chat-send'
import { enqueueNativeChatBodySend } from './fork-agent-composer/native-chat-body-send'
import { runBodyAcceptedThen } from './fork-agent-composer/native-chat-runtime-send-acceptance'
import { clearConfirmDurationMs } from './fork-agent-composer/native-chat-runtime-clear'
import {
  sendNativeChatMessage,
  type NativeChatSendHandle,
  type NativeChatSendOptions
} from './native-chat-runtime-send'

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

export function sendNativeChatMessageWithImageAttachments(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  imagePaths: readonly string[],
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (imagePaths.length === 0) {
    return sendNativeChatMessage(settings, ptyId, text, options)
  }
  const trimmedText = text.trim()
  return enqueueNativeChatBodySend({
    settings,
    ptyId,
    options,
    durationMs:
      (trimmedText.length > 0
        ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
        : NATIVE_CHAT_SUBMIT_DELAY_MS) + clearConfirmDurationMs(options),
    chunks: imagePasteWritesFollowedByText(
      imagePaths.map(buildNativeChatImagePasteBytes),
      trimmedText.length > 0
    ),
    afterAccepted: ({ isCancelled, markSubmitted, reportOutcome, delayGuarded, submit }) => {
      if (trimmedText.length === 0) {
        submit()
        return
      }
      delayGuarded(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
        runBodyAcceptedThen(
          settings,
          ptyId,
          [buildNativeChatPasteBytes(text)],
          isCancelled,
          markSubmitted,
          reportOutcome,
          submit
        )
      })
    }
  })
}
