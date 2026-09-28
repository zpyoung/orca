import type { HostedReviewAgentLaunchInput, HostedReviewAgentLaunchResult } from './agent-prompt'

/** Human-initiated fix path. Autonomous watcher preparations never use this channel. */
export const HOSTED_REVIEW_AGENT_CHANNELS = {
  launchFix: 'hostedReviewAgent:launchFix'
} as const

export type HostedReviewAgentApi = {
  launchFix: (input: HostedReviewAgentLaunchInput) => Promise<HostedReviewAgentLaunchResult>
}
