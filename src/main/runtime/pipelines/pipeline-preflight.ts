/**
 * Pipeline node launch preflight (logic L3, E4, L16a stage A; tech §3.3/§4.3).
 * Decides whether a node's configured agent can actually launch on the host that
 * will execute it. Read-only; called at instantiation for every node and reused
 * unchanged as the pre-dispatch revalidation before every dispatch, including
 * retries — a launcher present at one call can vanish before the next.
 */

import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { ResolvedPipelineNode } from '../../../shared/pipeline-template'
import type { TuiAgent } from '../../../shared/types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { resolveWorkerLaunchPreferences } from '../rpc/methods/orchestration-worker-launch-preferences'
import { resolveEffectiveLaunchProbe } from './pipeline-preflight-agent-command'
import {
  probeAgentPresence,
  type PreflightExecutionHost
} from './pipeline-preflight-executable-presence'

export type PipelineNodeLaunchResult =
  | { ok: true; agent: TuiAgent }
  | { ok: false; nodeId: string; field: string; message: string }

function refuse(nodeId: string, field: string, message: string): PipelineNodeLaunchResult {
  return { ok: false, nodeId, field, message }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function launchPreferenceField(message: string): 'model' | 'effort' {
  return /effort/i.test(message) ? 'effort' : 'model'
}

export async function validatePipelineNodeLaunch(args: {
  runtime: OrcaRuntimeService
  node: ResolvedPipelineNode
  host: PreflightExecutionHost
}): Promise<PipelineNodeLaunchResult> {
  const { runtime, node, host } = args

  const harness = node.harness
  if (!isTuiAgent(harness)) {
    return refuse(node.id, 'harness', `Unknown agent "${harness}".`)
  }
  const agent = harness

  try {
    runtime.validateOrchestrationAgentLauncher(agent)
  } catch (error) {
    return refuse(node.id, 'harness', messageOf(error))
  }

  try {
    resolveWorkerLaunchPreferences({ agent, model: node.model, effort: node.effort })
  } catch (error) {
    const message = messageOf(error)
    return refuse(node.id, launchPreferenceField(message), message)
  }

  const cmdOverrides = runtime.getClientSettings().agentCmdOverrides ?? {}
  const probe = resolveEffectiveLaunchProbe(agent, cmdOverrides)
  if (!probe) {
    return refuse(node.id, 'harness', `Agent ${agent}'s configured command override is empty.`)
  }

  const presence = await probeAgentPresence({ agent, commands: probe.commands, host })
  if (!presence.ok) {
    const message = presence.transport
      ? `Could not verify agent ${agent}'s launcher command "${probe.primaryCommand}" on the executing host.`
      : `Agent ${agent}'s launcher command "${probe.primaryCommand}" was not found on the executing host.`
    return refuse(node.id, 'harness', message)
  }

  return { ok: true, agent }
}
