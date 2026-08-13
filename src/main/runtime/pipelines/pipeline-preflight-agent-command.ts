/** Derives the executable preflight must probe for a node's agent. */

import { extractExecutableToken } from '../../../shared/managed-agent-command-token'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgentDetectionCommand } from '../../../shared/tui-agent-detection-commands'
import type { TuiAgent } from '../../../shared/types'
import type { PreflightExecutionHost } from './pipeline-preflight-executable-presence'

export type EffectiveLaunchProbe = {
  commands: TuiAgentDetectionCommand[]
  primaryCommand: string
}

// a WSL guest is always a POSIX shell regardless of the controller's own platform; an SSH host
// with no reported platform falls back to the controller's, since overrides are typically quoted
// for the remote OS and guessing POSIX would corrupt a quoted Windows path with backslash escaping
function executingHostPlatform(host: PreflightExecutionHost): NodeJS.Platform {
  if (host.wslDistro) {
    return 'linux'
  }
  if (host.connectionId) {
    return host.hostPlatform ?? process.platform
  }
  return process.platform
}

// launch construction lets settings.agentCmdOverrides replace an agent's whole command and
// resolves the catalog default per platform/remote — probing anything but that exact resolved
// command (aliases included) would pass a broken override/launch command or fail a working one
export function resolveEffectiveLaunchProbe(
  agent: TuiAgent,
  cmdOverrides: Partial<Record<TuiAgent, string>>,
  host: PreflightExecutionHost
): EffectiveLaunchProbe | null {
  const platform = executingHostPlatform(host)
  const override = cmdOverrides[agent]
  const launchCommand =
    override ??
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], platform, {
      isRemote: Boolean(host.connectionId)
    })
  const token = extractExecutableToken(launchCommand, { platform })
  if (!token) {
    return null
  }
  return { commands: [{ id: agent, cmd: token }], primaryCommand: token }
}
