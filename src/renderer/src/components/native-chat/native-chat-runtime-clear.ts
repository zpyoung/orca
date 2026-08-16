import {
  sendRuntimePtyInput,
  sendRuntimePtyInputAcceptance
} from '@/runtime/runtime-terminal-inspection'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'
import type { NativeChatSendOptions, RuntimeSettings } from './native-chat-runtime-send'

export const NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT = '\x15'
export const NATIVE_CHAT_CLEAR_CONFIRM_MS = 140

/** Best-effort cleanup clear (e.g. after cancel) — not gating a body write,
 *  so it stays on the fire-and-forget transport. */
export function clearUnsubmittedAgentInput(
  settings: RuntimeSettings,
  ptyId: string,
  options?: NativeChatSendOptions
): boolean {
  return sendRuntimePtyInput(
    settings,
    ptyId,
    options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
  )
}

/**
 * Clears the line, then hands off to `writeBody` — never before the clear
 * (and, when observed unclear, the maximal-clear escalation) is confirmed
 * accepted by the transport, so a rejected remote clear can't be followed by
 * a body that appends to residual text.
 */
export function clearThenWrite(
  settings: RuntimeSettings,
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void,
  writeBody: () => void,
  rejectSend: () => void
): void {
  sendRuntimePtyInputAcceptance(
    settings,
    ptyId,
    options?.clearInput ?? NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
  )
    .then((cleared) => {
      if (!cleared) {
        rejectSend()
        return
      }
      const confirmCleared = options?.confirmCleared
      if (!confirmCleared) {
        writeBody()
        return
      }
      delay(NATIVE_CHAT_CLEAR_CONFIRM_MS, () => {
        let confirmed = false
        try {
          confirmed = confirmCleared()
        } catch {
          // An unreadable terminal is unconfirmed; the maximal clear remains safe.
        }
        if (confirmed) {
          writeBody()
          return
        }
        sendRuntimePtyInputAcceptance(settings, ptyId, AGENT_TUI_CLEAR_INPUT_MAX)
          .then((escalated) => {
            if (!escalated) {
              rejectSend()
              return
            }
            writeBody()
          })
          .catch(rejectSend)
      })
    })
    .catch(rejectSend)
}

export function clearConfirmDurationMs(options?: NativeChatSendOptions): number {
  return options?.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0
}
