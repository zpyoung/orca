// Runtime send for native chat: clear any unsubmitted TUI line, write the framed
// body, then Enter as a SEPARATE delayed pty write. Kept apart from the pure
// byte builders in native-chat-send.ts so those stay IO-free and unit-testable.

import {
  sendRuntimePtyInput,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { runBodyAcceptedThen } from './native-chat-runtime-send-acceptance'
import { sendNativeChatAskAnswer } from './native-chat-ask-answer-send'
import {
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../shared/native-chat-answer-stepping'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import {
  AGENT_TUI_COMMAND_KEY_INTERVAL_MS,
  typeAgentTuiCommand
} from '../../../../shared/agent-tui-command-typing'
import {
  cancelNativeChatPtySends,
  enqueueNativeChatPtySend,
  resetNativeChatPtySendQueuesForTests,
  waitForNativeChatPtyIdle,
  type NativeChatPtySendQueueHandle
} from './native-chat-pty-send-queue'
import {
  createOutcomeReporter,
  guardedDelay,
  runOutcomeGuarded,
  submitAndObserve
} from './native-chat-send-outcome'
import type { SendOutcome } from './native-chat-send-outcome'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  NATIVE_CHAT_CLEAR_CONFIRM_MS,
  NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
} from './native-chat-runtime-clear'

export { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS }
export { resetNativeChatPtySendQueuesForTests }

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

export { NATIVE_CHAT_CLEAR_CONFIRM_MS, NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT }

export type NativeChatSendOptions = {
  /** Bytes that empty the agent's input line. Defaults to a single Ctrl+U. */
  clearInput?: string
  /**
   * Observed check that the input line is now empty.
   * Supplied only for launch-draft replacement; when it reports "not cleared"
   * the send widens to a maximal burst before writing the body rather than
   * pasting on top of residue.
   */
  confirmCleared?: () => boolean
  /**
   * Observed check, after the submit CR, of whether the TUI's input line
   * emptied. Absent means the send is unobservable, not failed.
   */
  confirmSubmitted?: () => boolean
  /** Reports the post-send outcome exactly once per send; see `SendOutcome`. */
  onOutcome?: (outcome: SendOutcome) => void
}

/** Cancels an in-flight send's pending pty writes (the delayed Enter, and any
 *  later question bodies/Enters). Safe to call after the send completes. */
export type NativeChatSendHandle = {
  cancel: () => void
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
  /** Actual completion, which can outlive the nominal schedule if the renderer stalls. */
  settled?: Promise<void>
}

export type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

// The queue only reports `onCancelUnsubmitted` once `start` has run — a send
// cancelled while still queued behind another PTY send never reaches `start`,
// so it would otherwise report no outcome at all. Report it here instead.
const withQueuedCancelOutcome = (
  handle: NativeChatPtySendQueueHandle,
  reportOutcome: (outcome: SendOutcome) => void
): NativeChatPtySendQueueHandle => ({
  ...handle,
  cancel: () => {
    const startedBeforeCancel = handle.bodyStarted()
    handle.cancel()
    if (!startedBeforeCancel) {
      reportOutcome('may-not-have-sent')
    }
  }
})

/**
 * Chat message path:
 *   1. clear any unsubmitted TUI line
 *   2. write framed body
 *   3. delayed Enter (separate write — same-write CR can be swallowed by paste)
 *
 * Serialized per PTY so rapid sends cannot glue before Enter.
 */
export function sendNativeChatMessage(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  const reportOutcome = createOutcomeReporter(options?.onOutcome)
  const handle = enqueueNativeChatPtySend(
    ptyId,
    NATIVE_CHAT_SUBMIT_DELAY_MS + clearConfirmDurationMs(options),
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        reportOutcome('may-not-have-sent')
        return
      }
      const delayGuarded = guardedDelay(delay, markSubmitted, reportOutcome)
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
              [buildNativeChatPasteBytes(text)],
              isCancelled,
              markSubmitted,
              reportOutcome,
              () => {
                // Schedule from the actual body write: an overdue clear-confirm callback
                // must not collapse the required body-to-Enter gap after a renderer stall.
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
      onCancelUnsubmitted: () => {
        clearUnsubmittedAgentInput(settings, ptyId, options)
        reportOutcome('may-not-have-sent')
      }
    }
  )
  return withQueuedCancelOutcome(handle, reportOutcome)
}

function waitForNativeChatSubmit(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (completed: boolean): void => {
      if (timer === null) {
        return
      }
      clearTimeout(timer)
      timer = null
      signal?.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = (): void => finish(false)
    timer = setTimeout(() => finish(true), NATIVE_CHAT_SUBMIT_DELAY_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Session-option / slash command path (model switch, /effort, …).
 *
 * Does not pre-clear the line (model-switch confirmation watches the PTY).
 * Cancels any in-flight chat clear/body/Enter on this PTY first so a delayed
 * chat Enter cannot dismiss Claude's "Switch model?" dialog.
 */
export async function sendNativeChatMessageVerified(
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  signal?: AbortSignal
): Promise<boolean> {
  // Why: chat sends hold a delayed Enter for 500ms. Opening the model picker in
  // that window used to let that Enter hit Claude's confirmation UI, so
  // verification timed out with "Could not verify the model change".
  cancelNativeChatPtySends(ptyId)
  await waitForNativeChatPtyIdle(ptyId)
  if (signal?.aborted) {
    return false
  }

  // Why: option commands await remote/SSH acceptance so the Enter cannot race
  // ahead of the body while a model-change observer is already armed.
  const bodyAccepted = await sendRuntimePtyInputVerified(
    settings,
    ptyId,
    buildNativeChatPasteBytes(text)
  )
  if (!bodyAccepted || signal?.aborted || !(await waitForNativeChatSubmit(signal))) {
    return false
  }
  return sendRuntimePtyInputVerified(settings, ptyId, NATIVE_CHAT_SUBMIT)
}

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
  const durationMs =
    (trimmedText.length > 0
      ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
      : NATIVE_CHAT_SUBMIT_DELAY_MS) + clearConfirmDurationMs(options)
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
            const imageChunks = imagePaths.map(buildNativeChatImagePasteBytes)
            runBodyAcceptedThen(
              settings,
              ptyId,
              imageChunks,
              isCancelled,
              markSubmitted,
              reportOutcome,
              () => {
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
      onCancelUnsubmitted: () => {
        clearUnsubmittedAgentInput(settings, ptyId, options)
        reportOutcome('may-not-have-sent')
      }
    }
  )
  return withQueuedCancelOutcome(handle, reportOutcome)
}

/** Submit a TUI prompt with no body (Enter only) — e.g. a plain submit when the
 *  composer is empty. */
export function submitNativeChatPrompt(settings: RuntimeSettings, ptyId: string): void {
  sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
}

export { sendNativeChatAskAnswer }
