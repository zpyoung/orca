import { useEffect, useMemo, useState } from 'react'
import { getDriverForPty, onDriverChange } from '@/lib/pane-manager/mobile-driver-state'
import { deriveNativeChatCanSend } from './native-chat-send-eligibility'
import {
  isTerminalInputQuarantined,
  subscribeTerminalInputQuarantine
} from '../terminal-pane/terminal-input-quarantine'

/**
 * Track both native-chat input guards for the live tab/pty pair: the tab-keyed
 * fresh-shell quarantine and the pty-keyed mobile presence lock.
 */
export function useNativeChatCanSend(terminalTabId: string, ptyId: string | null): boolean {
  const [quarantineTick, setQuarantineTick] = useState(0)
  const [driverTick, setDriverTick] = useState(0)
  useEffect(
    () =>
      subscribeTerminalInputQuarantine(terminalTabId, () => {
        setQuarantineTick((n) => n + 1)
      }),
    [terminalTabId]
  )

  // Why: the driver event fires for every pty; only re-derive when it targets
  // this pane's pty. ptyId is a dep so the listener re-binds on a pty swap.
  useEffect(
    () =>
      onDriverChange((event) => {
        if (event.ptyId !== ptyId) {
          return
        }
        setDriverTick((n) => n + 1)
      }),
    [ptyId]
  )
  return useMemo(() => {
    void driverTick
    void quarantineTick
    return deriveNativeChatCanSend(
      ptyId ? getDriverForPty(ptyId) : null,
      isTerminalInputQuarantined(terminalTabId)
    )
  }, [terminalTabId, ptyId, driverTick, quarantineTick])
}
