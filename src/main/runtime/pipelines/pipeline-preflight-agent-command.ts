/** Derives the executable preflight (tech §3.3/§4.3) must probe for a node's agent. */

import { extractExecutableToken } from '../../../shared/managed-agent-command-token'
import {
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  type TuiAgentDetectionCommand
} from '../../../shared/tui-agent-detection-commands'
import type { TuiAgent } from '../../../shared/types'

export type EffectiveLaunchProbe = {
  commands: TuiAgentDetectionCommand[]
  primaryCommand: string
}

// launch construction lets settings.agentCmdOverrides replace an agent's whole command, so
// probing the catalog default here would pass a broken override and fail a working one
export function resolveEffectiveLaunchProbe(
  agent: TuiAgent,
  cmdOverrides: Partial<Record<TuiAgent, string>>
): EffectiveLaunchProbe | null {
  const override = cmdOverrides[agent]
  if (override) {
    const token = extractExecutableToken(override)
    if (!token) {
      return null
    }
    return { commands: [{ id: agent, cmd: token }], primaryCommand: token }
  }
  const catalogCommands = KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter(
    (command) => command.id === agent
  )
  return { commands: catalogCommands, primaryCommand: catalogCommands[0]?.cmd ?? agent }
}
