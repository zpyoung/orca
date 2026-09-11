import type {
  SessionInfo,
  SessionInfoAdapter,
  SessionInfoAdapterInput,
  SessionInfoIdentity,
  SessionInfoLiveActivity
} from './session-info-types'

const adapters: SessionInfoAdapter[] = []

function buildNeutralSessionInfo(input: SessionInfoAdapterInput): SessionInfo {
  const identity: SessionInfoIdentity = {
    agent: input.status.agentType,
    model: input.status.model,
    sessionId: input.status.providerSession?.id,
    transcriptPath: input.status.providerSession?.transcriptPath,
    paneKey: input.paneKey,
    worktreeId: input.status.worktreeId,
    startedAt: Math.min(
      input.status.stateStartedAt,
      ...input.status.stateHistory.map((entry) => entry.startedAt)
    ),
    updatedAt: input.status.updatedAt
  }
  const liveActivity: SessionInfoLiveActivity = {
    state: input.status.state,
    toolName: input.status.toolName,
    toolInput: input.status.toolInput,
    subagentCount: input.status.subagents?.length,
    startedAt: input.status.stateStartedAt,
    updatedAt: input.status.updatedAt
  }
  return { identity, liveActivity }
}

/** Register one provider adapter without making the panel provider-aware. */
export function registerSessionInfoAdapter(adapter: SessionInfoAdapter): void {
  if (!adapters.some((candidate) => candidate.id === adapter.id)) {
    adapters.push(adapter)
  }
}

/** Assemble the neutral session contract for the exact focused pane. */
export function buildSessionInfo(input: SessionInfoAdapterInput): SessionInfo {
  const neutral = buildNeutralSessionInfo(input)
  const adapter = adapters.find((candidate) => candidate.supports(input.status.agentType))
  return adapter ? { ...neutral, ...adapter.build(input), adapterId: adapter.id } : neutral
}

export function resetSessionInfoAdaptersForTests(): void {
  adapters.length = 0
}
