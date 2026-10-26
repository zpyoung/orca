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

/** Chat communicates the mobile lock in its composer; suppress the still-mounted terminal overlay above it. */
export function shouldChatTakeOverMobileSurface(viewMode: 'terminal' | 'chat'): boolean {
  return viewMode === 'chat'
}
