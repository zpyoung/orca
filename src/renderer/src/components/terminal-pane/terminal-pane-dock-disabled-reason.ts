import { translate } from '@/i18n/i18n'
import type { PtyTransportRecoveryState } from './pty-transport-types'

/** Composer copy for each recovery phase where sending isn't safe; phases absent here
 *  (e.g. 'connected') mean the transport is live and don't disable the composer. */
const RECOVERY_PHASE_REASON: Partial<Record<PtyTransportRecoveryState['phase'], () => string>> = {
  connecting: () => translate('components.terminal-dock.connecting', 'Connecting…'),
  recovering: () => translate('components.terminal-dock.reconnecting', 'Reconnecting…'),
  backoff: () => translate('components.terminal-dock.reconnecting', 'Reconnecting…'),
  disconnected: () => translate('components.terminal-dock.disconnected', 'Disconnected'),
  offline: () => translate('components.terminal-dock.offline', 'Offline'),
  ended: () => translate('components.terminal-dock.sessionEnded', 'Session ended'),
  disposed: () => translate('components.terminal-dock.sessionEnded', 'Session ended')
}

/** Resolves the dock's disabled-composer reason from transport liveness (primary) layered
 *  with reattach quarantine (additive) — quarantine only ever arms on top of an otherwise-live
 *  transport, so it's checked last rather than short-circuiting a transport reason. SSH
 *  liveness is checked ahead of the PTY recovery phase: an SSH drop is known to the store
 *  immediately, while the local PTY transport can lag behind reflecting it. The mobile driver
 *  lease is checked ahead of quarantine too: another client actively driving this PTY blocks
 *  sends the same way a dead transport does, independent of reattach churn. */
export function resolveTerminalDockDisabledReason(args: {
  targetPtyId: string | null
  recoveryPhase: PtyTransportRecoveryState['phase'] | null
  quarantined: boolean
  sshDisconnected?: boolean
  mobileDriverLeaseHeld?: boolean
}): string | null {
  if (!args.targetPtyId) {
    return translate('components.terminal-dock.noSession', 'No terminal session')
  }
  if (args.sshDisconnected) {
    return translate('components.terminal-dock.sshDisconnected', 'SSH disconnected')
  }
  const recoveryReason = args.recoveryPhase ? RECOVERY_PHASE_REASON[args.recoveryPhase] : undefined
  if (recoveryReason) {
    return recoveryReason()
  }
  if (args.mobileDriverLeaseHeld) {
    return translate('components.terminal-dock.mobileDriverLeaseHeld', 'Mobile device is composing')
  }
  if (args.quarantined) {
    return translate('components.terminal-dock.reattaching', 'Reattaching…')
  }
  return null
}
