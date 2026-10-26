import { useEffect, useMemo, useState } from 'react'
import { getDriverForPty, onDriverChange } from '@/lib/pane-manager/mobile-driver-state'
import { deriveNativeChatCanSend } from './native-chat-send-eligibility'
import {
  isTerminalInputQuarantined,
  subscribeTerminalInputQuarantine
} from '../terminal-pane/terminal-input-quarantine'

/** Subscribe to the external driver map and tab quarantine so mobile-owned or freshly replaced PTYs guard composer sends just like xterm input. */
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

  // Filter per-PTY driver events and rebind when pane ownership changes.
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
