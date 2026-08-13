/**
 * Host-dispatched executable presence check for preflight (tech §3.3/§4.3).
 * Integrates three existing detection mechanisms, one per executing-host type:
 * native PATH + install-dir lookup, WSL PATH lookup, and the SSH relay's
 * `preflight.detectAgents`, whose protocol already takes a client-supplied
 * command list.
 */

import { detectCommandsInInstallDirs } from '../../ipc/local-agent-install-dir-detection'
import { isCommandOnPath } from '../../ipc/preflight-command-exec'
import { detectWslCommandsOnPath } from '../../ipc/preflight-wsl-agent-detection'
import { getActiveMultiplexer } from '../../ipc/ssh'
import {
  getTuiAgentDetectionProbeCommands,
  resolveDetectedTuiAgentIds,
  type TuiAgentDetectionCommand
} from '../../../shared/tui-agent-detection-commands'
import type { TuiAgent } from '../../../shared/types'

export type PresenceResult = { ok: true } | { ok: false; transport: boolean }

export type PreflightExecutionHost = { connectionId?: string; wslDistro?: string }

export async function probeAgentPresence(args: {
  agent: TuiAgent
  commands: readonly TuiAgentDetectionCommand[]
  host: PreflightExecutionHost
}): Promise<PresenceResult> {
  if (args.host.connectionId) {
    return probeOverSsh(args.agent, args.commands, args.host.connectionId)
  }
  if (args.host.wslDistro) {
    return probeOverWsl(args.agent, args.commands, args.host.wslDistro)
  }
  return probeNative(args.agent, args.commands)
}

function toPresenceResult(detected: readonly TuiAgent[], agent: TuiAgent): PresenceResult {
  return detected.includes(agent) ? { ok: true } : { ok: false, transport: false }
}

async function probeNative(
  agent: TuiAgent,
  commands: readonly TuiAgentDetectionCommand[]
): Promise<PresenceResult> {
  try {
    const probes = getTuiAgentDetectionProbeCommands(commands, process.platform)
    const pathChecks = await Promise.all(
      probes.map(async (cmd) => ({ cmd, onPath: await isCommandOnPath(cmd) }))
    )
    const missed = pathChecks.filter((check) => !check.onPath).map(({ cmd }) => cmd)
    const installDirHits = detectCommandsInInstallDirs(missed)
    const found = new Set(
      pathChecks
        .filter(({ cmd, onPath }) => onPath || installDirHits.has(cmd))
        .map(({ cmd }) => cmd)
    )
    return toPresenceResult(resolveDetectedTuiAgentIds(commands, found, process.platform), agent)
  } catch {
    return { ok: false, transport: true }
  }
}

async function probeOverWsl(
  agent: TuiAgent,
  commands: readonly TuiAgentDetectionCommand[],
  wslDistro: string
): Promise<PresenceResult> {
  try {
    const probes = getTuiAgentDetectionProbeCommands(commands, 'wsl')
    const found = await detectWslCommandsOnPath({ distro: wslDistro }, probes)
    return toPresenceResult(resolveDetectedTuiAgentIds(commands, found, 'wsl'), agent)
  } catch {
    return { ok: false, transport: true }
  }
}

async function probeOverSsh(
  agent: TuiAgent,
  commands: readonly TuiAgentDetectionCommand[],
  connectionId: string
): Promise<PresenceResult> {
  const mux = getActiveMultiplexer(connectionId)
  if (!mux || mux.isDisposed()) {
    return { ok: false, transport: true }
  }
  try {
    const result = (await mux.request('preflight.detectAgents', { commands })) as {
      agents: string[]
    }
    return result.agents.includes(agent) ? { ok: true } : { ok: false, transport: false }
  } catch {
    return { ok: false, transport: true }
  }
}
