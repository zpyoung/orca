import React from 'react'
import { AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY } from '../../../../../shared/protocol-version'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { getAutomationHostTargetKey, type AutomationHostTarget } from '../automation-host-client'
import {
  resolveAutomationLaunchOverridesGate,
  type AutomationLaunchOverridesGate
} from './automation-launch-overrides-gate'

/** Track launch-override support for the host that will receive an automation save. */
export function useAutomationLaunchOverridesGate(args: {
  open: boolean
  target: AutomationHostTarget
}): AutomationLaunchOverridesGate {
  const targetKey = getAutomationHostTargetKey(args.target)
  const [check, setCheck] = React.useState<{
    targetKey: string
    supported: boolean
  } | null>(null)

  React.useEffect(() => {
    if (!args.open || args.target.kind === 'local') {
      return
    }
    let active = true
    setCheck(null)
    void runtimeEnvironmentSupportsCapability(
      args.target.environmentId,
      AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY,
      15_000
    )
      .then((supported) => {
        if (active) {
          setCheck({ targetKey, supported })
        }
      })
      .catch(() => {
        if (active) {
          setCheck({ targetKey, supported: false })
        }
      })
    return () => {
      active = false
    }
  }, [args.open, args.target, targetKey])

  const capabilityState = check?.targetKey === targetKey ? check.supported : null
  return resolveAutomationLaunchOverridesGate(args.target, capabilityState)
}
