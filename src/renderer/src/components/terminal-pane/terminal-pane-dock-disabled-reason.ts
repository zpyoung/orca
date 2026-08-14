import { translate } from '@/i18n/i18n'
import type { PtyTransportRecoveryState } from './pty-transport-types'

/** Composer copy for each recovery phase where sending isn't safe; phases absent here
 *  (e.g. 'connected') mean the transport is live and don't disable the composer. */
const RECOVERY_PHASE_REASON: Partial<Record<PtyTransportRecoveryState['phase'], string>> = {
  connecting: 'Connecting…',
  recovering: 'Reconnecting…',
  backoff: 'Reconnecting…',
  disconnected: 'Disconnected',
  offline: 'Offline',
  ended: 'Session ended',
  disposed: 'Session ended'
}

/** Resolves the dock's disabled-composer reason from transport liveness (primary) layered
 *  with reattach quarantine (additive) — quarantine only ever arms on top of an otherwise-live
 *  transport, so it's checked last rather than short-circuiting a transport reason. SSH
 *  liveness is checked ahead of the PTY recovery phase: an SSH drop is known to the store
 *  immediately, while the local PTY transport can lag behind reflecting it. */
export function resolveTerminalDockDisabledReason(args: {
  targetPtyId: string | null
  recoveryPhase: PtyTransportRecoveryState['phase'] | null
  quarantined: boolean
  sshDisconnected?: boolean
}): string | null {
  if (!args.targetPtyId) {
    return 'No terminal session'
  }
  if (args.sshDisconnected) {
    return translate('components.terminal-dock.sshDisconnected', 'SSH disconnected')
  }
  const recoveryReason = args.recoveryPhase ? RECOVERY_PHASE_REASON[args.recoveryPhase] : undefined
  if (recoveryReason) {
    return recoveryReason
  }
  if (args.quarantined) {
    return 'Reattaching…'
  }
  return null
}
