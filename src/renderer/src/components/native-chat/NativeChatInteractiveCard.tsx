import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

/**
 * Render one prompt occurrence the view chose (see useNativeChatPromptCardPresentation): a
 * question wizard or a tool approval, in the composer's place. Sends through the composer's
 * verified runtime path (R8/R6): answers via agent-specific paste or selector keystrokes;
 * cancel/deny as ESC. Unmount cancels scheduled writes and ignores late results; writes already
 * issued to the transport cannot be recalled.
 *
 * The card hides (`onDismiss`) only once its answer was delivered: a refused or unconfirmed
 * answer keeps the choices up, so the user can answer again here or in the terminal.
 */
export function NativeChatInteractiveCard({
  card,
  send,
  canSend,
  onShowingQuestionChange,
  onShowingCardChange,
  answerInputRef
}: {
  card: NonNullable<InteractivePromptCard>
  send: NativeChatInteractiveSend
  canSend: boolean
  /** Reports whether a question card is on screen so the view can replace the
   *  composer with it (the card's free-text row is the answer input). */
  onShowingQuestionChange?: (showing: boolean) => void
  /** Reports any visible card without changing native chat's question-only exclusion. */
  onShowingCardChange?: (showing: boolean) => void
  /** Forwarded to the question card's free-text row so pane-level Paste keeps
   *  a target while the composer is unmounted. */
  answerInputRef?: React.RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const { sendAnswer, sendRawVerified, cancelPending, cancelAsk } = send
  // A question answer is a paced multi-step write (body→Enter per question); keep
  // the card up until it settles instead of dismissing on the click, so it doesn't
  // vanish mid-send. `submitting` also gates a second submit racing the first.
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const resetSubmitting = useCallback((): void => {
    submittingRef.current = false
    setSubmitting(false)
    cancellingRef.current = false
    setCancelling(false)
  }, [])
  // A replacement prompt, ownership loss, or unmount must stop both timers and
  // PTY writes during commit, before an old answer can type into the new prompt.
  useLayoutEffect(
    () => () => {
      resetSubmitting()
      cancelPending()
    },
    [canSend, cardKey, cancelPending, resetSubmitting]
  )

  // Forget the dismissal once the prompt clears so a fresh prompt can show.
  const present = card != null
  useEffect(() => {
    if (!present) {
      setDismissedKey(null)
      resetSubmitting()
    }
  }, [present, resetSubmitting])

  // Tell the view when a question card is up so it can hide the composer (this
  // card supplies its own input). Reset on unmount so the composer comes back.
  const showingCard = card != null && canSend && cardKey !== dismissedKey
  const showingQuestion = showingCard && card.kind === 'question'
  useEffect(() => {
    onShowingQuestionChange?.(showingQuestion)
    return () => onShowingQuestionChange?.(false)
  }, [showingQuestion, onShowingQuestionChange])
  useLayoutEffect(() => {
    onShowingCardChange?.(showingCard)
    return () => onShowingCardChange?.(false)
  }, [showingCard, onShowingCardChange])

  if (!showingCard) {
    return null
  }
  if (card.kind === 'question') {
    return (
      <NativeChatQuestionCard
        prompt={card.prompt}
        isSubmitting={submitting}
        isCancelling={cancelling}
        answerInputRef={answerInputRef}
        onAnswer={(selections) => {
          if (submittingRef.current) {
            return
          }
          submittingRef.current = true
          const dismissAnsweredCard = (): void => {
            setDismissedKey(cardKey)
            resetSubmitting()
          }
          const keepRejectedAnswerVisible = (): void => {
            resetSubmitting()
          }
          const result = sendAnswer(card.prompt, selections, (delivered) => {
            if (!activeRef.current || attempt !== attemptRef.current) {
              return
            }
            settle()
            if (delivered) {
              onDismiss()
            }
          })
          if (result.settleAfterMs <= 0) {
            // Keep the actionable card visible when its PTY disappeared between
            // render and submit; the next live target update can make it retryable.
            settle()
            return
          }
          // Why: the send now settles from its own real lifecycle (r5-1), not a
          // nominal timer — dismiss only once `onDeliverySettled` actually fires.
          setSubmitting(true)
        }}
        onCancel={() => {
          resetSubmitting()
          setDismissedKey(cardKey)
          cancelAsk()
        }}
      />
    )
  }
  const choose = (raw: string): void => {
    if (submittingRef.current) {
      return
    }
    submittingRef.current = true
    const attempt = ++attemptRef.current
    setSubmitting(true)
    void sendRawVerified(raw)
      .catch(() => false)
      .then((delivered) => {
        if (!activeRef.current || attempt !== attemptRef.current) {
          return
        }
        settle()
        if (delivered) {
          onDismiss()
        }
      })
  }
  return (
    <NativeChatApprovalCard
      approval={card.approval}
      shouldFocus={shouldFocus}
      isSubmitting={submitting}
      onChoose={choose}
      onCollapse={onCollapse}
    />
  )
}
