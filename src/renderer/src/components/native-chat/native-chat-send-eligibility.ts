import type { DriverState } from '@/lib/pane-manager/mobile-driver-state'

/**
 * Pure derivation of the composer's `canSend` (R8). Quarantine prevents input
 * from reaching a replacement shell, while a pty held by a mobile client
 * (`driver.kind === 'mobile'`) keeps the existing mobile presence-lock.
 * A null driver (pty not yet resolved) remains unlocked unless quarantine is
 * armed; the actual send still no-ops without a ptyId.
 */
export function deriveNativeChatCanSend(
  driver: DriverState | null | undefined,
  quarantined: boolean
): boolean {
  return !quarantined && driver?.kind !== 'mobile'
}

/**
 * Pure predicate for whether the native chat surface should take over the mobile
 * driver surface for a pane. When a tab is in chat view, the chat view is the
 * visible/active layer above the still-mounted terminal, so the terminal's own
 * mobile-driver overlay (presence-lock banner / phone-fit hold) must not render
 * on top of it — the composer's guarded `canSend` state communicates the lock
 * inside the chat surface instead. Keeps the terminal mounted underneath either
 * way (R2).
 */
export function shouldChatTakeOverMobileSurface(viewMode: 'terminal' | 'chat'): boolean {
  return viewMode === 'chat'
}
