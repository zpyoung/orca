// Remembers which TUI agent a docked pane last ran so a persisted dock can
// mount before live agent status arrives: in-memory per session, mirrored to
// the client-local pane-state record so the latch survives a renderer remount.

import { useCallback, useRef } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  readTerminalDockPaneAgent,
  writeTerminalDockPaneAgent
} from '../terminal-dock/terminal-dock-pane-state'

export type TerminalDockAgentLatch = {
  agentForPane: (paneKey: string) => AgentType | undefined
  noteDetectedAgent: (paneKey: string, agent: AgentType) => void
  /** Live detection wins; otherwise a docked pane falls back to the latch, then the client-local record. */
  resolveDockAgent: (paneKey: string, detectedAgent: string | null) => AgentType | null
  forgetPaneAgent: (paneKey: string) => void
}

export function useTerminalDockAgentLatch(args: {
  enabled: boolean
  isPaneDocked: (paneKey: string) => boolean
}): TerminalDockAgentLatch {
  const { enabled, isPaneDocked } = args
  const paneAgentRef = useRef(new Map<string, AgentType>())

  const agentForPane = useCallback((paneKey: string) => paneAgentRef.current.get(paneKey), [])

  const noteDetectedAgent = useCallback(
    (paneKey: string, agent: AgentType): void => {
      const changed = paneAgentRef.current.get(paneKey) !== agent
      paneAgentRef.current.set(paneKey, agent)
      // Why: the kill switch — flag-off must not write a client-local latch either.
      if (changed && enabled) {
        writeTerminalDockPaneAgent(paneKey, agent)
      }
    },
    [enabled]
  )

  const resolveDockAgent = useCallback(
    (paneKey: string, detectedAgent: string | null): AgentType | null => {
      if (isTuiAgent(detectedAgent)) {
        noteDetectedAgent(paneKey, detectedAgent)
        return detectedAgent
      }
      if (!isPaneDocked(paneKey)) {
        return null
      }
      // Why: an empty in-memory latch after a remount must not read as "no agent" — rehydrate
      // from the client-local record before conceding no dock can be rendered.
      const resolved = paneAgentRef.current.get(paneKey) ?? readTerminalDockPaneAgent(paneKey)
      if (resolved) {
        paneAgentRef.current.set(paneKey, resolved)
      }
      return resolved
    },
    [isPaneDocked, noteDetectedAgent]
  )

  const forgetPaneAgent = useCallback((paneKey: string): void => {
    paneAgentRef.current.delete(paneKey)
  }, [])

  return { agentForPane, noteDetectedAgent, resolveDockAgent, forgetPaneAgent }
}
