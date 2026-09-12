import type { HostedReviewAgentLaunchInput, HostedReviewAgentLaunchResult } from './agent-prompt'
import type {
  ActionApprovalScope,
  HostedReviewSitterDefinition,
  HostedReviewSitterLedger,
  HostedReviewSitterStatus
} from './types'

export const HOSTED_REVIEW_SITTER_CHANNELS = {
  list: 'hostedReviewSitter:list',
  arm: 'hostedReviewSitter:arm',
  stop: 'hostedReviewSitter:stop',
  stopAll: 'hostedReviewSitter:stopAll',
  approve: 'hostedReviewSitter:approve',
  ledger: 'hostedReviewSitter:ledger'
} as const

export const HOSTED_REVIEW_AGENT_CHANNELS = {
  launchFix: 'hostedReviewAgent:launchFix'
} as const

export type HostedReviewSitterArmInput = Omit<HostedReviewSitterDefinition, 'id' | 'enabled'>

export type HostedReviewSitterListEntry = {
  definition: HostedReviewSitterDefinition
  status: HostedReviewSitterStatus
}

export type HostedReviewSitterIdRequest = {
  id: string
}

export type HostedReviewSitterApprovalRequest = {
  scope: ActionApprovalScope
} & HostedReviewSitterIdRequest

export type HostedReviewSitterApi = {
  list: () => Promise<HostedReviewSitterListEntry[]>
  arm: (input: HostedReviewSitterArmInput) => Promise<HostedReviewSitterListEntry>
  stop: (id: string) => Promise<void>
  stopAll: () => Promise<void>
  approve: (id: string, scope: ActionApprovalScope) => Promise<void>
  ledger: (id: string) => Promise<HostedReviewSitterLedger>
}

export type HostedReviewAgentApi = {
  launchFix: (input: HostedReviewAgentLaunchInput) => Promise<HostedReviewAgentLaunchResult>
}
