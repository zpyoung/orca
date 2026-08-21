import type { TerminalDockSendOutcome } from '../../../../shared/telemetry-events'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { track, tuiAgentToAgentKind } from '../telemetry'

// Deliberately open: callers pass an agent id that may not be a known TuiAgent,
// and resolveAgentKind maps anything unrecognized to 'other'.
export type TerminalDockTelemetryAgent = string | null | undefined

function resolveAgentKind(
  agent: TerminalDockTelemetryAgent
): ReturnType<typeof tuiAgentToAgentKind> {
  return agent ? tuiAgentToAgentKind(agent as TuiAgent) : 'other'
}

export function emitTerminalDockToggled(args: {
  docked: boolean
  agent: TerminalDockTelemetryAgent
}): void {
  track('terminal_dock_toggled', {
    docked: args.docked,
    agent_kind: resolveAgentKind(args.agent)
  })
}

export function emitTerminalDockPassthroughToggled(args: {
  active: boolean
  agent: TerminalDockTelemetryAgent
}): void {
  track('terminal_dock_passthrough_toggled', {
    active: args.active,
    agent_kind: resolveAgentKind(args.agent)
  })
}

export function emitTerminalDockSendOutcome(args: {
  outcome: TerminalDockSendOutcome
  agent: TerminalDockTelemetryAgent
}): void {
  track('terminal_dock_send_outcome', {
    outcome: args.outcome,
    agent_kind: resolveAgentKind(args.agent)
  })
}
