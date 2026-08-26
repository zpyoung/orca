import type { Automation } from '../../../shared/automations-types'
import {
  buildAutomationRunLaunchSettings,
  type AutomationRunLaunchSettings
} from '../../../shared/fork-automation-launch-settings/automation-run-launch-settings'
import { resolveTuiAgentLaunchArgs } from '../../../shared/tui-agent-launch-defaults'
import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveStartupShell } from '../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

type AutomationLaunchSettings = {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  terminalWindowsShell?: string | null
}

/** Snapshot effective automation launch settings for a resolved execution host. */
export function resolveAutomationRunLaunchSettings(args: {
  automation: Automation
  settings: AutomationLaunchSettings
  platform: NodeJS.Platform
  isRemote: boolean
}): AutomationRunLaunchSettings | null {
  const shell = resolveStartupShell(
    args.platform,
    resolveLocalWindowsAgentStartupShell({
      platform: args.platform,
      isRemote: args.isRemote,
      terminalWindowsShell: args.settings.terminalWindowsShell
    })
  )
  const inheritedAgentArgs = resolveTuiAgentLaunchArgs(
    args.automation.agentId,
    args.settings.agentDefaultArgs
  )
  const effectiveAgentArgs = args.automation.launchOverrides?.agentArgs?.trim()
    ? args.automation.launchOverrides.agentArgs
    : inheritedAgentArgs
  return buildAutomationRunLaunchSettings({
    agentId: args.automation.agentId,
    overrides: args.automation.launchOverrides,
    effectiveAgentArgs,
    agentArgsSource: args.automation.launchOverrides?.agentArgs?.trim() ? 'explicit' : 'inherited',
    shell
  })
}
