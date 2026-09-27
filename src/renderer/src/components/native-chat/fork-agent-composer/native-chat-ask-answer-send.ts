// Delivery of AskUserQuestion answers: paced keystroke-group writes, split out
// of native-chat-runtime-send.ts (which owns the clear/body/Enter message and
// image-attachment paths) to keep that file at a readable size.

import {
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import type { AskAnswerKeyGroup } from '../native-chat-interactive-prompt'
import {
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../../shared/native-chat-answer-stepping'
import { buildNativeChatPasteBytes } from '../native-chat-send'
import type { NativeChatSendHandle } from '../native-chat-runtime-send'
import type { NativeChatResolvedTarget } from '../native-chat-composer-target'

/**
 * Answer Claude's AskUserQuestion by writing its keystroke groups (built by
 * `buildAskAnswerKeys`) to the PTY, one group per `NATIVE_CHAT_QUESTION_STEP_MS`
 * step so the arrow-navigate selector applies each before the next.
 */
export function sendNativeChatAskAnswer(
  target: NativeChatResolvedTarget,
  groups: AskAnswerKeyGroup[],
  onSettled?: (delivered: boolean) => void
): NativeChatSendHandle {
  if (groups.length === 0) {
    return { cancel: () => {}, settleAfterMs: 0 }
  }
  const timers: ReturnType<typeof setTimeout>[] = []
  const verifiedWrites: Promise<boolean>[] = []
  let cancelled = false
  groups.forEach((group, index) => {
    timers.push(
      setTimeout(() => {
        const bytes = 'raw' in group ? group.raw : buildNativeChatPasteBytes(group.text)
        if (onSettled) {
          // Why: inference must use the remote host's acceptance result, not
          // the fire-and-forget renderer dispatch result.
          verifiedWrites.push(
            sendRuntimePtyInputVerified(
              target.settings,
              target.ptyId,
              bytes,
              () => cancelled
            ).catch(() => false)
          )
        } else {
          sendRuntimePtyInput(target.settings, target.ptyId, bytes)
        }
      }, index * NATIVE_CHAT_QUESTION_STEP_MS)
    )
  })
  const settleAfterMs =
    (groups.length - 1) * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
  if (onSettled) {
    // Why: status inference must wait for every paced write and must not run
    // after cancellation or a rejected runtime write.
    timers.push(
      setTimeout(() => {
        void Promise.all(verifiedWrites).then((results) => {
          if (!cancelled) {
            onSettled(results.every(Boolean))
          }
        })
      }, settleAfterMs)
    )
  }
  return {
    cancel: () => {
      cancelled = true
      timers.forEach((timer) => clearTimeout(timer))
    },
    // Hold the card until the last keystroke has fired and its submit gap passed.
    settleAfterMs
  }
}
