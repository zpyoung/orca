import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import { selectHeadAsk } from '@/store/slices/fork-ask-question-tool/asks'
import type { AskAnswers } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskPartial } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { AskCardModel } from './ask-card-model'

/** Coalesces rapid keystrokes into far fewer `ask.updatePartial` calls while keeping restart-resilience current. */
const DRAFT_UPDATE_DEBOUNCE_MS = 500

export type AskPaneDock = {
  /** Null when there is no head ask, or the head ask has no spec yet. */
  model: AskCardModel | null
  isSubmitting: boolean
  onSubmit: (answers: AskAnswers, skipped: string[]) => void
  onCancel: () => void
  onDraftChange: (partial: AskPartial) => void
}

/**
 * Docks the pane's head ask: narrows the store's `spec: AskSpec | null` card down to what
 * `AskCard` requires, and wires submit/cancel through the runtime RPC bridge. A head entry with
 * no spec yet is not a bug — a status-only event can arrive before the one carrying the spec —
 * so it narrows to `null` and the caller renders nothing (tech.md § C8).
 *
 * `paneKey` is nullable so a host that renders outside any pane — the right-sidebar panel, which
 * follows whichever session is focused — can call it unconditionally.
 */
export function useAskPaneDock(paneKey: string | null): AskPaneDock {
  const entry = useAppStore((state) => selectHeadAsk(state, paneKey))
  const model = useMemo<AskCardModel | null>(() => {
    if (!entry?.spec) {
      return null
    }
    return {
      askId: entry.askId,
      status: entry.status,
      spec: entry.spec,
      partial: entry.partial,
      result: entry.result
    }
  }, [entry])

  const [submittingAskId, setSubmittingAskId] = useState<string | null>(null)
  const askId = model?.askId ?? null

  const onSubmit = useCallback(
    (answers: AskAnswers, skipped: string[]) => {
      if (!askId) {
        return
      }
      setSubmittingAskId(askId)
      void window.api.runtime
        .call({ method: 'ask.answer', params: { askId, answers, skipped } })
        .then((response) =>
          unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ committed: boolean }>)
        )
        .catch((error: unknown) => console.error('Failed to submit ask answer:', error))
        .finally(() => setSubmittingAskId((current) => (current === askId ? null : current)))
    },
    [askId]
  )

  const onCancel = useCallback(() => {
    if (!askId) {
      return
    }
    void window.api.runtime
      .call({ method: 'ask.cancel', params: { askId } })
      .then((response) => unwrapRuntimeRpcResult(response))
      .catch((error: unknown) => console.error('Failed to cancel ask:', error))
  }, [askId])

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Why: a pending timer belongs to the askId that scheduled it — a stale one must not fire a
  // partial update for whatever ask is current when it wakes up.
  useEffect(
    () => () => {
      if (draftTimerRef.current !== null) {
        clearTimeout(draftTimerRef.current)
        draftTimerRef.current = null
      }
    },
    [askId]
  )
  const onDraftChange = useCallback(
    (partial: AskPartial) => {
      if (!askId) {
        return
      }
      if (draftTimerRef.current !== null) {
        clearTimeout(draftTimerRef.current)
      }
      draftTimerRef.current = setTimeout(() => {
        draftTimerRef.current = null
        void window.api.runtime
          .call({ method: 'ask.updatePartial', params: { askId, partial } })
          .then((response) => unwrapRuntimeRpcResult(response))
          .catch((error: unknown) => console.error('Failed to update ask partial:', error))
      }, DRAFT_UPDATE_DEBOUNCE_MS)
    },
    [askId]
  )

  return {
    model,
    isSubmitting: askId !== null && submittingAskId === askId,
    onSubmit,
    onCancel,
    onDraftChange
  }
}
