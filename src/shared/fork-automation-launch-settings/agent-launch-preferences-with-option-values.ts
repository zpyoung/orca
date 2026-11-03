import { toAgentLaunchPreferences } from '../agent-launch-preferences'
import type { AgentLaunchPreferences } from '../agent-session/agent-session-host-authority'
import type { AgentType } from '../agent-status-types'
import type { SessionOptionValue } from '../native-chat/input/native-chat-session-options'

const LEGACY_PREFERENCE_KEYS = new Set(['model', 'effort', 'mode'])

/**
 * `toAgentLaunchPreferences` plus the non-legacy session options as `optionValues`, for hosts that
 * negotiated launch overrides. An empty `optionValues` still tells the host to skip catalog defaults.
 */
export function toAgentLaunchPreferencesWithOptionValues(
  sessionOptions: Record<string, SessionOptionValue> | null | undefined,
  options: { agent: AgentType; includeOptionValues?: boolean }
): AgentLaunchPreferences | undefined {
  const preferences = toAgentLaunchPreferences(sessionOptions, options.agent)
  if (!options.includeOptionValues) {
    return preferences
  }
  const optionValues = Object.fromEntries(
    Object.entries(sessionOptions ?? {}).filter(([id]) => !LEGACY_PREFERENCE_KEYS.has(id))
  )
  return { ...preferences, optionValues }
}

/** Upstream's flat preferences shape, for callers typed against plain session-option records. */
export function withoutForkOptionValues(
  preferences: AgentLaunchPreferences | undefined
): Omit<AgentLaunchPreferences, 'optionValues'> {
  if (!preferences) {
    return {}
  }
  const { optionValues: _optionValues, ...flat } = preferences
  return flat
}
