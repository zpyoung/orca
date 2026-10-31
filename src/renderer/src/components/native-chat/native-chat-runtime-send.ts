import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import {
  isTerminalInputQuarantined,
  subscribeTerminalInputQuarantine
} from '../terminal-pane/terminal-input-quarantine'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { runBodyAcceptedThen } from './fork-agent-composer/native-chat-runtime-send-acceptance'
import { enqueueNativeChatBodySend } from './fork-agent-composer/native-chat-body-send'
import type { SendOutcome } from './fork-agent-composer/native-chat-send-outcome'
import {
  sendNativeChatAskAnswerQueued,
  sendNativeChatMessageVerifiedQueued
} from './fork-agent-composer/native-chat-runtime-send-queued'
import {
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from '../../../../shared/native-chat/input/native-chat-answer-stepping'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../shared/native-chat-paste-bytes'
import {
  cancelNativeChatPtySends,
  invalidateNativeChatPtySends,
  resetNativeChatPtySendQueuesForTests,
  waitForNativeChatPtyIdle
} from './native-chat-pty-send-queue'
import { clearConfirmDurationMs } from './fork-agent-composer/native-chat-runtime-clear'
import type { NativeChatSendOptions as NativeChatDeliveryOptions } from './native-chat-input-clear'

export { NATIVE_CHAT_ADVANCE_BUFFER_MS, NATIVE_CHAT_QUESTION_STEP_MS, NATIVE_CHAT_SUBMIT_DELAY_MS }
export { invalidateNativeChatPtySends, resetNativeChatPtySendQueuesForTests }
export {
  sendNativeChatTypedCommand,
  typeNativeChatCommand
} from './fork-agent-composer/native-chat-typed-command-send'

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

/** Upstream's options, including its per-write delivery callbacks, plus the fork's outcome. */
export type NativeChatSendOptions = NativeChatDeliveryOptions & {
  /**
   * Observed check, after the submit CR, of whether the TUI's input line
   * emptied. Absent means the send is unobservable, not failed.
   */
  confirmSubmitted?: () => boolean
  /** Reports the post-send outcome exactly once per send; see `SendOutcome`. */
  onOutcome?: (outcome: SendOutcome) => void
}

/** Cancellation suppresses remaining scheduled writes and is safe after completion. */
export type NativeChatSendHandle = {
  /** `keepInput` skips the unsubmitted-input clear, e.g. while a dialog owns the agent's input. */
  cancel: (keepInput?: boolean) => void
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
  /** Actual completion, which can outlive the nominal schedule if the renderer stalls. */
  settled?: Promise<void>
}

const NOOP_NATIVE_CHAT_SEND_HANDLE: NativeChatSendHandle = {
  cancel: () => {},
  settleAfterMs: 0
}

function rejectQuarantinedNativeChatSend(options?: NativeChatSendOptions): NativeChatSendHandle {
  options?.onWriteRejected?.()
  options?.onDeliverySettled?.(false)
  options?.onOutcome?.('may-not-have-sent')
  return NOOP_NATIVE_CHAT_SEND_HANDLE
}

/** Serialize clear/body/delayed Enter per PTY; a CR sharing the paste write can be swallowed. */
export function sendNativeChatMessage(
  target: NativeChatResolvedTarget,
  text: string,
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (isTerminalInputQuarantined(target.terminalTabId)) {
    return rejectQuarantinedNativeChatSend(options)
  }
  return enqueueNativeChatBodySend({
    target,
    options,
    durationMs: NATIVE_CHAT_SUBMIT_DELAY_MS + clearConfirmDurationMs(options),
    chunks: [buildNativeChatPasteBytes(text)]
  })
}

/**
 * Cancel and await chat sends before verified commands; delayed Enter or pre-clear could disrupt model confirmation.
 * Queues its own body+Enter on the same per-PTY sequence so a card's selector write cannot land mid-command.
 */
export async function sendNativeChatMessageVerified(
  target: NativeChatResolvedTarget,
  text: string,
  signal?: AbortSignal
): Promise<boolean> {
  let invalidated = false
  const unsubscribe = subscribeTerminalInputQuarantine(target.terminalTabId, (armed) => {
    if (armed) {
      invalidated = true
    }
  })
  try {
    if (signal?.aborted || invalidated) {
      return false
    }
    cancelNativeChatPtySends(target.ptyId)
    await waitForNativeChatPtyIdle(target.ptyId)
    if (signal?.aborted || invalidated) {
      return false
    }
    return await sendNativeChatMessageVerifiedQueued(target, text, signal)
  } finally {
    unsubscribe()
  }
}

export function sendNativeChatMessageWithImageAttachments(
  target: NativeChatResolvedTarget,
  text: string,
  imagePaths: readonly string[],
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  return sendNativeChatImagePastes(
    target,
    text,
    imagePaths.map(buildNativeChatImagePasteBytes),
    options
  )
}

/** Image pastes already framed for the target agent, then the text body and Enter. */
export function sendNativeChatImagePastes(
  target: NativeChatResolvedTarget,
  text: string,
  imagePastes: readonly string[],
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (isTerminalInputQuarantined(target.terminalTabId)) {
    return rejectQuarantinedNativeChatSend(options)
  }
  if (imagePastes.length === 0) {
    return sendNativeChatMessage(target, text, options)
  }
  const trimmedText = text.trim()
  return enqueueNativeChatBodySend({
    target,
    options,
    durationMs:
      (trimmedText.length > 0
        ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
        : NATIVE_CHAT_SUBMIT_DELAY_MS) + clearConfirmDurationMs(options),
    chunks: imagePastes,
    afterAccepted: ({
      isCancelled,
      markSubmitted,
      reportOutcome,
      delayGuarded,
      delivery,
      submit
    }) => {
      if (trimmedText.length === 0) {
        submit()
        return
      }
      delayGuarded(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
        runBodyAcceptedThen(
          target.ptyId,
          [buildNativeChatPasteBytes(text)],
          isCancelled,
          markSubmitted,
          reportOutcome,
          submit,
          delivery
        )
      })
    }
  })
}

export function submitNativeChatPrompt(target: NativeChatResolvedTarget): void {
  if (!isTerminalInputQuarantined(target.terminalTabId)) {
    sendRuntimePtyInput(target.ptyId, NATIVE_CHAT_SUBMIT, 'driving')
  }
}

export { sendNativeChatAskAnswerQueued as sendNativeChatAskAnswer }
