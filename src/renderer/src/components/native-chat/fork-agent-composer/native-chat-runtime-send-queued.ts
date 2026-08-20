// Queue-serialized writes for the session-option/slash-command path and the
// stepped ask-answer path (r5-3): both used to write directly to the pty
// outside the per-PTY queue, so a card's selector write could land mid-body
// or mid-Enter of an in-flight option command's write. Routing both through
// `enqueueNativeChatPtySend` gives them the same ordering guarantee chat
// sends already have.

import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import {
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../../shared/native-chat-answer-stepping'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from '../native-chat-send'
import { enqueueNativeChatPtySend } from '../native-chat-pty-send-queue'
import { sendNativeChatAskAnswer as sendNativeChatAskAnswerRaw } from './native-chat-ask-answer-send'
import type { AskAnswerKeyGroup } from '../native-chat-interactive-prompt'
import type { NativeChatSendHandle, RuntimeSettings } from '../native-chat-runtime-send'

/**
 * Body + delayed Enter for the session-option/slash-command path, queued like
 * a chat send. Callers must cancel and drain prior sends first so a delayed
 * chat Enter cannot land on a confirmation dialog this write opens.
 */
export function sendNativeChatMessageVerifiedQueued(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  signal?: AbortSignal
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let accepted = false
    const handle = enqueueNativeChatPtySend(
      ptyId,
      NATIVE_CHAT_SUBMIT_DELAY_MS,
      ({ isCancelled, delay, markSubmitted }) => {
        if (isCancelled() || signal?.aborted) {
          markSubmitted()
          return
        }
        sendRuntimePtyInputVerified(settings, ptyId, buildNativeChatPasteBytes(text))
          .then((bodyAccepted) => {
            if (!bodyAccepted || isCancelled() || signal?.aborted) {
              markSubmitted()
              return
            }
            delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
              if (isCancelled() || signal?.aborted) {
                markSubmitted()
                return
              }
              sendRuntimePtyInputVerified(settings, ptyId, NATIVE_CHAT_SUBMIT)
                .then((sent) => {
                  accepted = sent
                  markSubmitted()
                })
                .catch(markSubmitted)
            })
          })
          .catch(markSubmitted)
      }
    )
    // Why: resolve through the queue's own settlement, not our promise chain
    // above — a cancel mid-write must still resolve `false` exactly once.
    const onAbort = (): void => handle.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    void handle.settled.then(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(accepted)
    })
  })
}

/**
 * Claude/Codex stepped selector answer, queued like `sendNativeChatMessage`.
 * A cancel while still queued behind another send never reaches the paced
 * writes, so it reports `onSettled(false)` here instead of dropping the
 * answer silently (mirrors the chat-send queued-cancel outcome).
 */
export function sendNativeChatAskAnswerQueued(
  settings: RuntimeSettings,
  ptyId: string,
  groups: AskAnswerKeyGroup[],
  onSettled?: (delivered: boolean) => void
): NativeChatSendHandle {
  if (groups.length === 0) {
    return { cancel: () => {}, settleAfterMs: 0 }
  }
  const durationMs =
    (groups.length - 1) * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
  let inner: NativeChatSendHandle | null = null
  const handle = enqueueNativeChatPtySend(
    ptyId,
    durationMs,
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        markSubmitted()
        return
      }
      const finish = (delivered: boolean): void => {
        markSubmitted()
        onSettled?.(delivered)
      }
      inner = sendNativeChatAskAnswerRaw(settings, ptyId, groups, onSettled ? finish : undefined)
      if (!onSettled) {
        delay(durationMs, markSubmitted)
      }
    },
    { onCancelUnsubmitted: () => inner?.cancel() }
  )
  return {
    cancel: () => {
      const startedBeforeCancel = handle.bodyStarted()
      inner?.cancel()
      handle.cancel()
      if (!startedBeforeCancel) {
        onSettled?.(false)
      }
    },
    settleAfterMs: handle.settleAfterMs,
    settled: handle.settled
  }
}
