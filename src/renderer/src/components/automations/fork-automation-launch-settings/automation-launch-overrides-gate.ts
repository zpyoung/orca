import type { AutomationHostTarget } from '../automation-host-client'

export type AutomationLaunchOverridesGate = 'supported' | 'pending' | 'unsupported'

/** Resolve whether an automation write target can preserve launch overrides. */
export function resolveAutomationLaunchOverridesGate(
  target: AutomationHostTarget,
  capabilityCheckState: boolean | null
): AutomationLaunchOverridesGate {
  if (target.kind === 'local') {
    return 'supported'
  }
  if (capabilityCheckState === null) {
    return 'pending'
  }
  return capabilityCheckState ? 'supported' : 'unsupported'
}
