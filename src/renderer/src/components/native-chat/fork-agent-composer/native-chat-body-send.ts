import {
  enqueueNativeChatPtySend,
  type NativeChatPtySendQueueHandle
} from '../native-chat-pty-send-queue'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../../shared/native-chat-answer-stepping'
import { runBodyAcceptedThen } from './native-chat-runtime-send-acceptance'
import {
  createOutcomeReporter,
  guardedDelay,
  runOutcomeGuarded,
  submitAndObserve,
  type SendOutcome
} from './native-chat-send-outcome'
import { clearThenWrite, clearUnsubmittedAgentInput } from './native-chat-runtime-clear'
import type { NativeChatSendOptions, RuntimeSettings } from '../native-chat-runtime-send'

// The queue only reports `onCancelUnsubmitted` once `start` has run — a send
// cancelled while still queued behind another PTY send never reaches `start`,
// so it would otherwise report no outcome at all. Report it here instead.
// The outcome must fire even if the queue's own cancel throws (r5-2) so a
// throwing cleanup clear can never suppress it.
const withQueuedCancelOutcome = (
  handle: NativeChatPtySendQueueHandle,
  reportOutcome: (outcome: SendOutcome) => void
): NativeChatPtySendQueueHandle => ({
  ...handle,
  cancel: () => {
    const startedBeforeCancel = handle.bodyStarted()
    try {
      handle.cancel()
    } finally {
      if (!startedBeforeCancel) {
        reportOutcome('may-not-have-sent')
      }
    }
  }
})

// Isolates the best-effort cleanup clear from outcome reporting (r5-2): a
// synchronous throw from the preload write must not swallow the outcome.
function bestEffortCancelClear(
  settings: RuntimeSettings,
  ptyId: string,
  options: NativeChatSendOptions | undefined,
  reportOutcome: (outcome: SendOutcome) => void
): void {
  try {
    clearUnsubmittedAgentInput(settings, ptyId, options)
  } catch {
    // Cleanup only — the outcome report below must still fire.
  }
  reportOutcome('may-not-have-sent')
}

/** What a caller may do once its first body write is accepted by the TUI. */
export type NativeChatBodySendContext = {
  isCancelled: () => boolean
  markSubmitted: () => void
  reportOutcome: (outcome: SendOutcome) => void
  delayGuarded: (ms: number, fn: () => void) => void
  /** Schedules the submit CR from the actual body write: an overdue clear-confirm
   *  callback must not collapse the required body-to-Enter gap after a stall. */
  submit: () => void
}

/**
 * Enqueue one clear-then-write body send whose outcome is reported exactly once,
 * whether it lands, is rejected, or is cancelled at any point — including while
 * still queued behind another send.
 *
 * `afterAccepted` runs only once the first body write is accepted; it defaults
 * to submitting immediately, and a caller that needs to write more (image
 * attachments settling before the text body) drives that from the context.
 */
export function enqueueNativeChatBodySend(args: {
  settings: RuntimeSettings
  ptyId: string
  options: NativeChatSendOptions | undefined
  durationMs: number
  chunks: readonly string[]
  afterAccepted?: (context: NativeChatBodySendContext) => void
}): NativeChatPtySendQueueHandle {
  const { settings, ptyId, options, durationMs, chunks, afterAccepted } = args
  const reportOutcome = createOutcomeReporter(options?.onOutcome)
  const handle = enqueueNativeChatPtySend(
    ptyId,
    durationMs,
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        reportOutcome('may-not-have-sent')
        return
      }
      const delayGuarded = guardedDelay(delay, markSubmitted, reportOutcome)
      const submit = (): void => {
        delayGuarded(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
          void submitAndObserve(
            settings,
            ptyId,
            markSubmitted,
            reportOutcome,
            options?.confirmSubmitted
          )
        })
      }
      runOutcomeGuarded(markSubmitted, reportOutcome, () => {
        clearThenWrite(
          settings,
          ptyId,
          options,
          delayGuarded,
          () => {
            if (isCancelled()) {
              reportOutcome('may-not-have-sent')
              return
            }
            runBodyAcceptedThen(
              settings,
              ptyId,
              chunks,
              isCancelled,
              markSubmitted,
              reportOutcome,
              () => {
                if (afterAccepted) {
                  afterAccepted({ isCancelled, markSubmitted, reportOutcome, delayGuarded, submit })
                  return
                }
                submit()
              }
            )
          },
          () => {
            markSubmitted()
            reportOutcome('may-not-have-sent')
          }
        )
      })
    },
    {
      onCancelUnsubmitted: () => bestEffortCancelClear(settings, ptyId, options, reportOutcome)
    }
  )
  return withQueuedCancelOutcome(handle, reportOutcome)
}
