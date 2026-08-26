import type {
  AutomationRunLaunchSetting,
  AutomationRunLaunchSettings,
  AutomationRunLaunchValueSource
} from '../../../shared/automations-types'
import { isTuiAgent } from '../../../shared/tui-agent-config'

const AUTOMATION_RUN_LAUNCH_OPTIONS_MAX = 16
const AUTOMATION_RUN_LAUNCH_KEY_MAX = 64
const AUTOMATION_RUN_LAUNCH_VALUE_MAX = 512
const AUTOMATION_RUN_LAUNCH_ARGS_MAX = 4096

const AUTOMATION_RUN_LAUNCH_SOURCES: readonly AutomationRunLaunchValueSource[] = [
  'explicit',
  'inherited',
  'raw_args'
]

function normalizeAutomationRunLaunchSetting(value: unknown): AutomationRunLaunchSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const source = candidate.source
  if (
    typeof source !== 'string' ||
    !AUTOMATION_RUN_LAUNCH_SOURCES.includes(source as AutomationRunLaunchValueSource)
  ) {
    return null
  }
  const raw = candidate.value
  const settingValue =
    typeof raw === 'boolean'
      ? raw
      : typeof raw === 'string' && raw.length <= AUTOMATION_RUN_LAUNCH_VALUE_MAX
        ? raw
        : undefined
  return {
    ...(settingValue !== undefined ? { value: settingValue } : {}),
    source: source as AutomationRunLaunchValueSource
  }
}

/** Bound what a dispatch result can persist: hosts are untrusted across the SSH bridge. */
export function normalizeAutomationRunLaunchSettings(
  value: AutomationRunLaunchSettings | null | undefined
): AutomationRunLaunchSettings | null {
  if (!value || !isTuiAgent(value.agentId)) {
    return null
  }
  const options: Record<string, AutomationRunLaunchSetting> = {}
  for (const [key, setting] of Object.entries(value.options ?? {})) {
    if (!key || key.length > AUTOMATION_RUN_LAUNCH_KEY_MAX) {
      continue
    }
    const normalized = normalizeAutomationRunLaunchSetting(setting)
    if (normalized) {
      options[key] = normalized
    }
    if (Object.keys(options).length >= AUTOMATION_RUN_LAUNCH_OPTIONS_MAX) {
      break
    }
  }
  const agentArgs = value.agentArgs
  const agentArgsValue = typeof agentArgs?.value === 'string' ? agentArgs.value : null
  return {
    agentId: value.agentId,
    options,
    ...(agentArgsValue !== null &&
    agentArgsValue.length <= AUTOMATION_RUN_LAUNCH_ARGS_MAX &&
    (agentArgs?.source === 'explicit' || agentArgs?.source === 'inherited')
      ? { agentArgs: { value: agentArgsValue, source: agentArgs.source } }
      : {})
  }
}
