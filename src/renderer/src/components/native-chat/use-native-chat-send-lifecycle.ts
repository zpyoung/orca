import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { invalidateNativeChatPtySends, type NativeChatSendHandle } from './native-chat-runtime-send'
import { subscribeTerminalInputQuarantine } from '../terminal-pane/terminal-input-quarantine'

export type NativeChatSendLifecycle = {
  cancelPendingSends: () => void
  trackPendingSend: (handle: NativeChatSendHandle, pendingId?: string) => void
}

export function useNativeChatSendLifecycle(
  terminalTabId: string,
  targetPtyId: string | null,
  onPendingSendCanceled?: (pendingId: string) => void,
  cardOwnership?: {
    /** A prompt card owns the agent's input while the composer stays mounted. */
    inputOwnedByCard: boolean
    /** Settles the echo of a send the card retired; it keeps the user's text visible. */
    onPendingSendRetired?: (pendingId: string) => void
  },
  // Why: false only for a genuine transport-unsafe transition (recovery,
  // quarantine, ssh-disconnect, mobile lease) on the same pty — never for an
  // agent-status flap, which never touches this flag.
  transportSafe = true
): NativeChatSendLifecycle {
  const pendingSendHandlesRef = useRef(
    new Map<
      NativeChatSendHandle,
      { cleanupTimer: ReturnType<typeof setTimeout> | null; pendingId?: string }
    >()
  )
  const settlePendingSends = useCallback(
    (onSettled?: (pendingId: string) => void, keepInput = false) => {
      for (const [handle, entry] of pendingSendHandlesRef.current) {
        const { cleanupTimer, pendingId } = entry
        if (cleanupTimer !== null) {
          clearTimeout(cleanupTimer)
        }
        try {
          handle.cancel(keepInput)
        } catch {
          // Isolate one handle's throw so later queued sends still get cancelled.
        }
        if (pendingId) {
          onSettled?.(pendingId)
        }
      }
      pendingSendHandlesRef.current.clear()
    },
    []
  )
  const cancelPendingSends = useCallback(
    () => settlePendingSends(onPendingSendCanceled),
    [settlePendingSends, onPendingSendCanceled]
  )
  const trackPendingSend = useCallback((handle: NativeChatSendHandle, pendingId?: string) => {
    const entry = {
      cleanupTimer: null as ReturnType<typeof setTimeout> | null,
      ...(pendingId ? { pendingId } : {})
    }
    pendingSendHandlesRef.current.set(handle, entry)
    if (handle.settled) {
      void handle.settled.then(() => {
        if (pendingSendHandlesRef.current.get(handle) === entry) {
          pendingSendHandlesRef.current.delete(handle)
        }
      })
      return
    }
    entry.cleanupTimer = setTimeout(() => {
      pendingSendHandlesRef.current.delete(handle)
    }, handle.settleAfterMs)
  }, [])

  // Quarantine can arm without a PTY prop change. Invalidate synchronously so
  // a delayed Enter cannot beat the parent canSend rerender; unlike ordinary
  // cancellation this never sends cleanup bytes into the replacement shell.
  useLayoutEffect(
    () =>
      subscribeTerminalInputQuarantine(terminalTabId, (armed) => {
        if (armed && targetPtyId) {
          invalidateNativeChatPtySends(targetPtyId)
          cancelPendingSends()
        }
      }),
    [cancelPendingSends, targetPtyId, terminalTabId]
  )

  // Why: delayed Enter/image writes belong to the exact PTY target. A pane
  // swap or unmount must cancel them before that PTY can close or be reused.
  useLayoutEffect(() => cancelPendingSends, [cancelPendingSends, targetPtyId, terminalTabId])

  // Why: the same pty can turn transport-unsafe mid-delay (recovery,
  // quarantine, ssh-disconnect, a mobile client taking the lease) without
  // targetPtyId changing, so the effect above never fires for it.
  const wasTransportSafeRef = useRef(transportSafe)
  useEffect(() => {
    if (wasTransportSafeRef.current && !transportSafe) {
      cancelPendingSends()
    }
    wasTransportSafeRef.current = transportSafe
  }, [transportSafe, cancelPendingSends])

  const inputOwnedByCard = cardOwnership?.inputOwnedByCard === true
  const onPendingSendRetired = cardOwnership?.onPendingSendRetired ?? onPendingSendCanceled
  // Why: once a card owns the agent's input, an unsubmitted Enter would answer it. No line clear
  // either: it would type under the dialog, and the next send clears the line first.
  useLayoutEffect(() => {
    if (inputOwnedByCard) {
      settlePendingSends(onPendingSendRetired, true)
    }
  }, [inputOwnedByCard, onPendingSendRetired, settlePendingSends])

  return { cancelPendingSends, trackPendingSend }
}
