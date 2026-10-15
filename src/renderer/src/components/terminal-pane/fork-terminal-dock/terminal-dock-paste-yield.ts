import { NATIVE_CHAT_ROOT_SELECTOR } from '@/lib/native-chat-paste-request'
import { isInsideNativeChatCover } from '../native-chat-covered-pane'

/**
 * True when the terminal pane must leave a paste to a chat: anything under a chat cover,
 * or inside the dock's chat root, which sits beside the xterm instead of covering it.
 */
export function isTerminalPasteOwnedByChat(target: EventTarget | null): boolean {
  return (
    isInsideNativeChatCover(target) ||
    (target instanceof Element && target.closest(NATIVE_CHAT_ROOT_SELECTOR) !== null)
  )
}
