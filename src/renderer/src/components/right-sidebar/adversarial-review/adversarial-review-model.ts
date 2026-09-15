import type { Finding } from '../../../../../shared/review/finding-schema'
import type {
  ReviewDepth,
  ReviewProfile,
  ReviewRunState,
  ReviewVerdict
} from '../../../../../shared/review/stage-schemas'
import type { AgentFamily } from '../../../../../shared/review/agent-family'
import type { TuiAgent } from '../../../../../shared/types'

export type ReviewRunStaleness = {
  target: string
  detectedAt: string
}

export type ReviewPanelRun = {
  id: string
  state: ReviewRunState
  verdict: ReviewVerdict | null
  independence: 'full' | 'reduced' | null
  target: string
  profile: ReviewProfile
  depth: ReviewDepth
  createdAt: string
  updatedAt: string
  stale: ReviewRunStaleness | null
  findings: Finding[]
}

export type ReviewRunTailSnapshot = {
  runs: ReviewPanelRun[]
}

export type ReviewRunTailSource = {
  read: () => Promise<ReviewRunTailSnapshot>
  subscribe: (onChange: () => void) => Promise<() => void> | (() => void)
}

export type ReviewLaunchTargetKind = 'worktree' | 'branch' | 'hosted' | 'commit' | 'path' | 'custom'

export type ReviewLaunchPlan = {
  prepassCommands: string[]
  stageSummary: string
  activeSessionWarning?: string | null
}

export type ReviewLaunchRequest = {
  targetKind: ReviewLaunchTargetKind
  target: string
  criteria: string
  profile: ReviewProfile
  depth: ReviewDepth
  authorFamily: AgentFamily
  reviewer: TuiAgent | null
}

export type ReviewFixAgentSession = {
  id: string
  label: string
  agent: TuiAgent | null
}
