import { agentImagePasteWrites, formatAgentImagePath } from '../../../../shared/agent-image-paste'
import type { AgentType } from '../../../../shared/agent-status-types'
import { buildNativeChatImagePasteBytes } from '../../../../shared/native-chat-paste-bytes'
import { formatImageDropPasteText } from '../terminal-pane/terminal-drop-image-path'
import { isTerminalDropWindowsPathLike } from '../terminal-pane/terminal-drop-shell'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import {
  NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS,
  sendNativeChatImagePastes,
  type NativeChatSendHandle,
  type NativeChatSendOptions
} from './native-chat-runtime-send'

export { NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS }

/** The path text an agent detects as an image. One with spaces or shell characters is escaped as a
 *  terminal image drop is, which agent TUIs undo before checking the file exists. */
export function agentImagePastePath(agent: AgentType, path: string): string {
  const formatted = formatAgentImagePath(agent, path)
  if (formatted !== path) {
    return formatted
  }
  const targetShell = isTerminalDropWindowsPathLike(path) ? 'windows' : 'posix'
  return formatImageDropPasteText(path, targetShell) ?? path
}

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
