import type { AgentLaunchOverrides } from './agent-launch-overrides'
import {
  agentLaunchOverridesToSessionOptionValues,
  describeOverriddenOptionIds,
  resolveAgentLaunchOverrides
} from './agent-launch-overrides'
import type { SessionOptionValue } from '../native-chat-session-options'
import type { AgentStartupShell } from '../tui-agent-startup-shell'
import type { TuiAgent } from '../tui-agent'

export type AutomationRunLaunchValueSource = 'explicit' | 'inherited' | 'raw_args'

export type AutomationRunLaunchSetting = {
  value?: SessionOptionValue
  source: AutomationRunLaunchValueSource
}

/** Launch values retained so run history remains stable after settings change. */
export type AutomationRunLaunchSettings = {
  agentId: TuiAgent
  options: Record<string, AutomationRunLaunchSetting>
  agentArgs?: { value: string; source: 'explicit' | 'inherited' }
}

function pickedValues(
  overrides: AgentLaunchOverrides | null | undefined
): Record<string, SessionOptionValue> {
  return agentLaunchOverridesToSessionOptionValues(overrides) ?? {}
}

/** Snapshot the effective launch values and their provenance for automation history. */
export function buildAutomationRunLaunchSettings(args: {
  agentId: TuiAgent
  overrides: AgentLaunchOverrides | null | undefined
  effectiveAgentArgs: string
  agentArgsSource: 'explicit' | 'inherited'
  shell?: AgentStartupShell
}): AutomationRunLaunchSettings | null {
  const effectiveOverrides = {
    ...args.overrides,
    agentArgs: args.effectiveAgentArgs
  }
  const resolved = resolveAgentLaunchOverrides(args.agentId, effectiveOverrides, args.shell)
  const picked = pickedValues(args.overrides)
  const options: Record<string, AutomationRunLaunchSetting> = Object.create(null)
  for (const [id, value] of Object.entries(resolved.applied)) {
    options[id] = { value, source: 'explicit' }
  }
  for (const id of describeOverriddenOptionIds(args.agentId, effectiveOverrides, args.shell)) {
    if (picked[id] !== undefined) {
      options[id] = { source: 'raw_args' }
    }
  }
  const effectiveAgentArgs = args.effectiveAgentArgs.trim()
  if (Object.keys(options).length === 0 && !effectiveAgentArgs) {
    return null
  }
  return {
    agentId: args.agentId,
    options: { ...options },
    ...(effectiveAgentArgs
      ? {
          agentArgs: {
            value: args.effectiveAgentArgs,
            source: args.agentArgsSource
          }
        }
      : {})
  }
}
