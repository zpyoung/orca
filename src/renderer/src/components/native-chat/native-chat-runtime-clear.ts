import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'
import type { NativeChatSendOptions, RuntimeSettings } from './native-chat-runtime-send'

export const NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT = '\x15'
export const NATIVE_CHAT_CLEAR_CONFIRM_MS = 140

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

export function clearThenWrite(
  settings: RuntimeSettings,
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  delay: (ms: number, fn: () => void) => void,
  writeBody: () => void,
  rejectSend: () => void
): void {
  if (!clearUnsubmittedAgentInput(settings, ptyId, options)) {
    rejectSend()
    return
  }
  const confirmCleared = options?.confirmCleared
  if (!confirmCleared) {
    writeBody()
    return
  }
  delay(NATIVE_CHAT_CLEAR_CONFIRM_MS, () => {
    let cleared = false
    try {
      cleared = confirmCleared()
    } catch {
      // An unreadable terminal is unconfirmed; the maximal clear remains safe.
    }
    if (!cleared && !sendRuntimePtyInput(settings, ptyId, AGENT_TUI_CLEAR_INPUT_MAX)) {
      rejectSend()
      return
    }
    writeBody()
  })
}

export function clearConfirmDurationMs(options?: NativeChatSendOptions): number {
  return options?.confirmCleared ? NATIVE_CHAT_CLEAR_CONFIRM_MS : 0
}
