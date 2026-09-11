// Typed slash-command sends: keys are written one at a time so a TUI that only
// autocompletes typed input (Codex) opens its command palette, instead of
// receiving one pasted line it treats as literal text.

import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import {
  AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
  typeAgentTuiCommand
} from '../../../../../shared/agent-tui-command-typing'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  waitForNativeChatPtyIdle
} from '../native-chat-pty-send-queue'
import { clearUnsubmittedAgentInput } from './native-chat-runtime-clear'
import type { NativeChatSendHandle, RuntimeSettings } from '../native-chat-runtime-send'

/** Types a slash command as individual keys so Codex opens its command palette. */
export async function typeNativeChatCommand(
  settings: RuntimeSettings,
  ptyId: string,
  command: string,
  signal?: AbortSignal
): Promise<boolean> {
  cancelNativeChatPtySends(ptyId)
  await waitForNativeChatPtyIdle(ptyId)
  const outcome = await typeAgentTuiCommand({
    command,
    signal,
    write: async (key) =>
      (await sendRuntimePtyInputVerified(settings, ptyId, key)) ? 'accepted' : 'rejected'
  })
  return outcome === 'accepted'
}

/** Queues a typed slash command with composer sends on the same PTY. */
export function sendNativeChatTypedCommand(
  settings: RuntimeSettings,
  ptyId: string,
  command: string
): NativeChatSendHandle {
  const controller = new AbortController()
  return enqueueNativeChatPtySend(
    ptyId,
    (command.length + 1) * AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
    ({ isCancelled, markSubmitted }) => {
      const finish = (outcome: 'accepted' | 'rejected' | 'unknown'): void => {
        if (!isCancelled() && outcome !== 'accepted') {
          clearUnsubmittedAgentInput(settings, ptyId)
        }
        markSubmitted()
      }
      void typeAgentTuiCommand({
        command,
        signal: controller.signal,
        write: async (key) => {
          if (isCancelled()) {
            return 'rejected'
          }
          return (await sendRuntimePtyInputVerified(settings, ptyId, key)) ? 'accepted' : 'rejected'
        }
      }).then(finish, () => finish('rejected'))
    },
    {
      onCancelUnsubmitted: () => {
        controller.abort()
        clearUnsubmittedAgentInput(settings, ptyId)
      }
    }
  )
}
