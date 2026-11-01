import { agentImagePasteWrites } from '../../../../shared/agent-image-paste'
import { agentImagePastePath } from '../../../../shared/agent-image-paste-path'
import type { AgentType } from '../../../../shared/agent-status-types'
import { buildNativeChatImagePasteBytes } from '../../../../shared/native-chat-paste-bytes'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import {
  NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS,
  sendNativeChatImagePastes,
  type NativeChatSendHandle,
  type NativeChatSendOptions
} from './native-chat-runtime-send'

export { NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS }

/** Agent-aware image pastes on the quarantine-scoped send path, which observes every write. */
export function sendNativeChatMessageWithImageAttachments(
  agent: AgentType,
  target: NativeChatResolvedTarget,
  text: string,
  imagePaths: readonly string[],
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  const imagePastes = agentImagePasteWrites(
    agent,
    imagePaths.map((path) => buildNativeChatImagePasteBytes(agentImagePastePath(agent, path))),
    text.trim().length > 0
  )
  return sendNativeChatImagePastes(target, text, imagePastes, options)
}
