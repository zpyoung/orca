import type { AgentStatusEntry } from '../agent-status-types'
import type { AgentHookInstallStatus } from '../agent-hook-types'
import type { McpServerSummary } from '../mcp-config'
import type { RateLimitWindow } from '../rate-limit-types'

export type SessionInfoContextTelemetry = {
  usedPercentage: number
  remainingPercentage?: number
  windowSize?: number
  updatedAt: number
}

export type SessionInfoIdentityTelemetry = {
  sessionId?: string
  transcriptPath?: string
  cwd?: string
  modelId?: string
  modelDisplayName?: string
  agentVersion?: string
  outputStyle?: string
  updatedAt: number
}

export type SessionInfoFilesTelemetry = {
  linesAdded?: number
  linesRemoved?: number
  updatedAt: number
}

export type SessionInfoUsageTelemetry = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  turnCount: number
  model?: string
  cwd?: string
  branch?: string
  contextFallback?: SessionInfoContextTelemetry
  freshness?: 'ready' | 'refreshing' | 'stale'
  error?: string
  updatedAt: number
}

export type SessionInfoPaneTelemetry = {
  paneKey: string
  provider: string
  providerSessionId?: string
  identity?: SessionInfoIdentityTelemetry
  context?: SessionInfoContextTelemetry
  filesTouched?: SessionInfoFilesTelemetry
  usage?: SessionInfoUsageTelemetry
  planWindowsAcceptedAt?: number
  updatedAt: number
}

export type SessionInfoTelemetrySnapshot = Record<string, SessionInfoPaneTelemetry>

export type SessionInfoStatusLineChainState =
  | 'managed'
  | 'available'
  | 'chained'
  | 'drifted'
  | 'disabled'
  | 'error'

export type SessionInfoStatusLineChainStatus = {
  state: SessionInfoStatusLineChainState
  detail?: string
}

export type SessionInfoIdentity = {
  agent?: string
  model?: string
  sessionId?: string
  transcriptPath?: string
  cwd?: string
  branch?: string
  version?: string
  outputStyle?: string
  paneKey?: string
  worktreeId?: string
  startedAt?: number
  updatedAt?: number
}

export type SessionInfoUsage =
  | { status: 'waiting' }
  | ({ status: 'ready' } & SessionInfoUsageTelemetry)

export type SessionInfoLiveActivity = {
  state?: AgentStatusEntry['state']
  toolName?: string
  toolInput?: string
  subagentCount?: number
  startedAt?: number
  updatedAt?: number
}

export type SessionInfoContext = {
  status: 'waiting' | 'ready'
  usedPercentage?: number
  remainingPercentage?: number
  windowSize?: number
  fiveHour?: RateLimitWindow | null
  sevenDay?: RateLimitWindow | null
  updatedAt?: number
}

export type SessionInfoFilesTouched = {
  linesAdded?: number
  linesRemoved?: number
  updatedAt?: number
}

export type SessionInfoHooksAndMcp = {
  hookStatus?: AgentHookInstallStatus
  statusLine?: SessionInfoStatusLineChainStatus
  mcpServers?: McpServerSummary[]
  updatedAt: number
}

export type SessionInfo = {
  adapterId?: string
  identity?: SessionInfoIdentity
  usage?: SessionInfoUsage
  liveActivity?: SessionInfoLiveActivity
  context?: SessionInfoContext
  filesTouched?: SessionInfoFilesTouched
  hooksAndMcp?: SessionInfoHooksAndMcp
}

export type SessionInfoAdapterInput = {
  paneKey: string
  status: AgentStatusEntry
  telemetry?: SessionInfoPaneTelemetry
  localTelemetryAvailable?: boolean
  planWindows?: {
    fiveHour: RateLimitWindow | null
    sevenDay: RateLimitWindow | null
    updatedAt: number
  }
}

export type SessionInfoAdapter = {
  id: string
  supports: (agentType: string | undefined) => boolean
  build: (input: SessionInfoAdapterInput) => SessionInfo
}
