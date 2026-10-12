import { hasExtraAgentArgs } from '../automation-extra-agent-args'
import type { Automation } from '../automations-types'
import {
  normalizeAgentLaunchOverrides,
  type AgentLaunchOptionSelection
} from './agent-launch-overrides'

/** Automation launch values: model and session options only; raw arguments are `extraAgentArgs`. */
export function normalizeAutomationLaunchOverrides(
  value: unknown
): AgentLaunchOptionSelection | undefined {
  const normalized = normalizeAgentLaunchOverrides(value)
  if (!normalized) {
    return undefined
  }
  const selection: AgentLaunchOptionSelection = {
    ...(normalized.model ? { model: normalized.model } : {}),
    ...(normalized.optionValues ? { optionValues: normalized.optionValues } : {})
  }
  return Object.keys(selection).length > 0 ? selection : undefined
}

/** The retired raw `launchOverrides.agentArgs` an older record or client still carries, if any. */
export function legacyLaunchOverridesAgentArgs(launchOverrides: unknown): string | undefined {
  return normalizeAgentLaunchOverrides(launchOverrides)?.agentArgs
}

/** Appends retired raw arguments to saved extras; extras of any other type pass through unchanged. */
export function foldLegacyLaunchAgentArgs(
  extraAgentArgs: unknown,
  legacyAgentArgs: string | undefined
): unknown {
  const legacy = legacyAgentArgs?.trim()
  if (!legacy) {
    return extraAgentArgs
  }
  return typeof extraAgentArgs === 'string' && hasExtraAgentArgs(extraAgentArgs)
    ? `${extraAgentArgs.trimEnd()} ${legacy}`
    : legacy
}

/** Moves a stored `launchOverrides.agentArgs` into `extraAgentArgs` so it keeps applying. */
export function migrateLegacyAutomationLaunchArgs(automation: Automation): Automation {
  const legacy = legacyLaunchOverridesAgentArgs(automation.launchOverrides)
  if (legacy === undefined) {
    return automation
  }
  const { launchOverrides, ...rest } = automation
  const selection = normalizeAutomationLaunchOverrides(launchOverrides)
  const extraAgentArgs = foldLegacyLaunchAgentArgs(automation.extraAgentArgs, legacy)
  return {
    ...rest,
    ...(typeof extraAgentArgs === 'string' ? { extraAgentArgs } : {}),
    ...(selection ? { launchOverrides: selection } : {})
  }
}
