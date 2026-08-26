import type { AgentType } from '../agent-status-types'
import {
  findCatalogModel,
  getAgentSessionOptionCatalog,
  sessionOptionValueIsValid
} from '../agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from '../agent-session-option-launch'
import type { SessionOptionValue } from '../native-chat-session-options'
import { tokenizeStartupCommand, type AgentStartupShell } from '../tui-agent-startup-shell'

/** Structured launch values persisted by surfaces whose raw arguments live elsewhere. */
export type AgentLaunchOptionSelection = {
  model?: string
  optionValues?: Record<string, SessionOptionValue>
}

/** Per-entity launch values, where absent fields inherit from the consuming surface. */
export type AgentLaunchOverrides = AgentLaunchOptionSelection & {
  agentArgs?: string
}

export type ResolvedAgentLaunchOverrides = {
  args: string[]
  applied: Record<string, SessionOptionValue>
}

const UNSAFE_OPTION_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'model'])

function normalizedOptionValues(value: unknown): Record<string, SessionOptionValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const normalized: Record<string, SessionOptionValue> = Object.create(null)
  for (const [key, optionValue] of Object.entries(value)) {
    if (
      key.trim().length > 0 &&
      !UNSAFE_OPTION_KEYS.has(key) &&
      sessionOptionValueIsValid(optionValue)
    ) {
      normalized[key] = optionValue
    }
  }
  return Object.keys(normalized).length > 0 ? { ...normalized } : undefined
}

function tokenizeOverrideArgs(value: string | undefined, shell: AgentStartupShell): string[] {
  const trimmed = value?.trim()
  if (!trimmed) {
    return []
  }
  const tokenized = tokenizeStartupCommand(trimmed, shell)
  return tokenized.ok ? tokenized.tokens : []
}

/** Convert an explicit model selection into the session-option launch shape. */
export function agentLaunchOverridesToSessionOptionValues(
  overrides: AgentLaunchOverrides | null | undefined
): Record<string, SessionOptionValue> | undefined {
  const model = overrides?.model?.trim()
  if (!model) {
    return undefined
  }
  return {
    ...normalizedOptionValues(overrides?.optionValues),
    model
  }
}

/** Resolve structured launch values and append raw arguments with raw-args-win semantics. */
export function resolveAgentLaunchOverrides(
  agent: AgentType,
  overrides: AgentLaunchOverrides | null | undefined,
  shell: AgentStartupShell = 'posix'
): ResolvedAgentLaunchOverrides {
  const trailingAgentArgs = tokenizeOverrideArgs(overrides?.agentArgs, shell)
  const resolved = resolveAgentSessionOptionLaunch(
    agent,
    agentLaunchOverridesToSessionOptionValues(overrides),
    trailingAgentArgs,
    false
  )
  return {
    args: [...resolved.args, ...trailingAgentArgs],
    applied: resolved.appliedValues
  }
}

/** List structured picker ids shadowed by the override's raw arguments. */
export function describeOverriddenOptionIds(
  agent: AgentType,
  overrides: AgentLaunchOverrides | null | undefined,
  shell: AgentStartupShell = 'posix'
): string[] {
  const catalog = getAgentSessionOptionCatalog(agent)
  const tokens = tokenizeOverrideArgs(overrides?.agentArgs, shell)
  if (!catalog || tokens.length === 0) {
    return []
  }
  const overriddenIds: string[] = []
  if (catalog.modelApply.agentArgsOverride?.(tokens)) {
    overriddenIds.push('model')
  }
  const selectedModel = overrides?.model?.trim()
  if (!selectedModel) {
    return overriddenIds
  }
  const model = findCatalogModel(catalog, selectedModel)
  const options = model?.options ?? catalog.unknownModelOptions ?? []
  for (const option of options) {
    if (option.apply.agentArgsOverride?.(tokens)) {
      overriddenIds.push(option.id)
    }
  }
  return overriddenIds
}

/** Sanitize persisted or RPC launch overrides and collapse an empty value to undefined. */
export function normalizeAgentLaunchOverrides(value: unknown): AgentLaunchOverrides | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
  const optionValues = normalizedOptionValues(candidate.optionValues)
  const agentArgs = typeof candidate.agentArgs === 'string' ? candidate.agentArgs : ''
  const normalized: AgentLaunchOverrides = {
    ...(model ? { model } : {}),
    ...(optionValues ? { optionValues } : {}),
    ...(agentArgs.trim() ? { agentArgs } : {})
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

/** Return whether a launch override carries no effective persisted values. */
export function isEmptyAgentLaunchOverrides(
  overrides: AgentLaunchOverrides | null | undefined
): boolean {
  return normalizeAgentLaunchOverrides(overrides) === undefined
}
