import { planSourceControlAgentActionLaunch } from '@/lib/source-control-agent-action-plan'
import {
  agentLaunchOverridesToSessionOptionValues,
  type AgentLaunchOptionSelection
} from '../../../../shared/agent-launch-overrides'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/types'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'
import { buildSourceControlAgentConnectionErrorPlan } from './source-control-agent-action-dialog-support'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'

type BuildSourceControlAgentDeliveryPlanArgs = {
  selectedAgent: TuiAgent | null
  commandInput: string
  agentArgs: string
  launchOptions?: AgentLaunchOptionSelection | null
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  detectedAgents: TuiAgent[]
  connectionUnavailable: boolean
  launchPlatform?: NodeJS.Platform
  /** Why: keep the previewed command label in sync with the real remote launch,
   * which omits the Linux-only `orca-ide` rename for SSH hosts. */
  isRemote?: boolean
}

export function buildSourceControlAgentDeliveryPlan({
  selectedAgent,
  commandInput,
  agentArgs,
  launchOptions,
  promptDelivery,
  detectedAgents,
  connectionUnavailable,
  launchPlatform,
  isRemote
}: BuildSourceControlAgentDeliveryPlanArgs): SourceControlAgentActionDeliveryPlanState {
  if (connectionUnavailable) {
    return buildSourceControlAgentConnectionErrorPlan()
  }
  const settings = useAppStore.getState().settings
  const recipeSessionOptions = launchOptions?.model
    ? agentLaunchOverridesToSessionOptionValues(launchOptions)
    : undefined
  const result = planSourceControlAgentActionLaunch({
    agent: selectedAgent,
    commandInput,
    agentArgs,
    sessionOptions:
      recipeSessionOptions ??
      (selectedAgent
        ? resolveInitialNativeChatSessionOptions(settings, {
            agent: selectedAgent,
            promptDelivery,
            launchDraftText: commandInput.trim(),
            nativeChatTranscriptIsLocalReadable: !isRemote
          })
        : undefined),
    includeSessionOptionCatalogDefaults: recipeSessionOptions ? false : undefined,
    promptDelivery,
    detectedAgents,
    disabledAgents: settings?.disabledTuiAgents,
    cmdOverrides: settings?.agentCmdOverrides,
    terminalWindowsShell: settings?.terminalWindowsShell,
    platform: launchPlatform,
    isRemote
  })
  if (!result.ok) {
    return { status: 'error', error: result.error }
  }
  return {
    status: 'success',
    summary: result.summary,
    commandLabel: result.commandLabel,
    caveat: result.caveat
  }
}
