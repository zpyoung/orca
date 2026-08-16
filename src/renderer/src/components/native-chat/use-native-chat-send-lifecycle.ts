import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { NativeChatSendHandle } from './native-chat-runtime-send'

export type NativeChatSendLifecycle = {
  cancelPendingSends: () => void
  trackPendingSend: (handle: NativeChatSendHandle, pendingId?: string) => void
}

export function useNativeChatSendLifecycle(
  terminalTabId: string,
  targetPtyId: string | null,
  onPendingSendCanceled?: (pendingId: string) => void,
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
  const cancelPendingSends = useCallback(() => {
    for (const [handle, entry] of pendingSendHandlesRef.current) {
      const { cleanupTimer, pendingId } = entry
      if (cleanupTimer !== null) {
        clearTimeout(cleanupTimer)
      }
      try {
        handle.cancel()
      } catch {
        // Isolate one handle's throw so later queued sends still get cancelled.
      }
      if (pendingId) {
        onPendingSendCanceled?.(pendingId)
      }
    }
    pendingSendHandlesRef.current.clear()
  }, [onPendingSendCanceled])
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

  return { cancelPendingSends, trackPendingSend }
}
