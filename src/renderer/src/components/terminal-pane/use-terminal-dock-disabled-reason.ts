import { useCallback, useEffect, useState } from 'react'
import {
  isTerminalInputQuarantined,
  subscribeTerminalInputQuarantine
} from './terminal-input-quarantine'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import { resolveTerminalDockDisabledReason } from './terminal-pane-dock-disabled-reason'

export function useTerminalDockDisabledReason(args: {
  enabled: boolean
  tabId: string
}): (input: {
  paneKey: string
  targetPtyId: string | null
  recoveryPhase: PtyTransportRecoveryState['phase'] | null
  sshDisconnected?: boolean
}) => string | null {
  const [, forceRerender] = useState(0)
  useEffect(() => {
    if (!args.enabled) {
      return undefined
    }
    return subscribeTerminalInputQuarantine(args.tabId, () => {
      forceRerender((count) => count + 1)
    })
  }, [args.enabled, args.tabId])

  return useCallback((input) => {
    const parsed = parsePaneKey(input.paneKey)
    return resolveTerminalDockDisabledReason({
      targetPtyId: input.targetPtyId,
      recoveryPhase: input.recoveryPhase,
      quarantined: parsed ? isTerminalInputQuarantined(parsed.tabId) : false,
      sshDisconnected: input.sshDisconnected
    })
  }, [])
}
