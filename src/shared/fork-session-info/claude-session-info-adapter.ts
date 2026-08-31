import type { SessionInfo, SessionInfoAdapterInput } from './session-info-types'

function matchesCurrentSession(input: SessionInfoAdapterInput): boolean {
  const providerSessionId = input.status.providerSession?.id
  return Boolean(
    providerSessionId &&
    input.telemetry?.provider === 'claude' &&
    input.telemetry.providerSessionId === providerSessionId
  )
}

/** Fill Claude-owned fields while leaving unavailable capabilities omitted. */
export function buildClaudeSessionInfo(input: SessionInfoAdapterInput): SessionInfo {
  const telemetry =
    input.localTelemetryAvailable !== false && matchesCurrentSession(input)
      ? input.telemetry
      : undefined
  const identityTelemetry = telemetry?.identity
  const usage = telemetry?.usage
  const context = telemetry?.context ?? usage?.contextFallback
  const filesTouched = telemetry?.filesTouched
  return {
    identity: {
      agent: input.status.agentType,
      model: identityTelemetry?.modelDisplayName ?? input.status.model ?? usage?.model,
      sessionId: input.status.providerSession?.id,
      transcriptPath:
        input.status.providerSession?.transcriptPath ?? identityTelemetry?.transcriptPath,
      cwd: identityTelemetry?.cwd ?? usage?.cwd,
      branch: usage?.branch,
      version: identityTelemetry?.agentVersion,
      outputStyle: identityTelemetry?.outputStyle,
      paneKey: input.paneKey,
      worktreeId: input.status.worktreeId,
      startedAt: Math.min(
        input.status.stateStartedAt,
        ...input.status.stateHistory.map((entry) => entry.startedAt)
      ),
      updatedAt: Math.max(input.status.updatedAt, identityTelemetry?.updatedAt ?? 0)
    },
    liveActivity: {
      state: input.status.state,
      toolName: input.status.toolName,
      toolInput: input.status.toolInput,
      subagentCount: input.status.subagents?.length,
      startedAt: input.status.stateStartedAt,
      updatedAt: input.status.updatedAt
    },
    ...(input.localTelemetryAvailable === false
      ? {}
      : {
          usage: usage ? { status: 'ready' as const, ...usage } : { status: 'waiting' as const },
          context: context
            ? {
                status: 'ready' as const,
                usedPercentage: context.usedPercentage,
                remainingPercentage: context.remainingPercentage,
                windowSize: context.windowSize,
                fiveHour: input.planWindows?.fiveHour,
                sevenDay: input.planWindows?.sevenDay,
                updatedAt: Math.max(context.updatedAt, input.planWindows?.updatedAt ?? 0)
              }
            : {
                status: 'waiting' as const,
                fiveHour: input.planWindows?.fiveHour,
                sevenDay: input.planWindows?.sevenDay,
                updatedAt: input.planWindows?.updatedAt
              }
        }),
    ...(filesTouched
      ? {
          filesTouched: {
            linesAdded: filesTouched.linesAdded,
            linesRemoved: filesTouched.linesRemoved,
            updatedAt: filesTouched.updatedAt
          }
        }
      : {})
  }
}
