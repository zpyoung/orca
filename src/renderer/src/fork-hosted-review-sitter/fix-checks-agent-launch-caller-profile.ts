import type { AgentLaunchCallerProfile } from '@/lib/agent-launch-caller-profiles-test-harness'

/** The hosted-review sitter's fix-checks launch, profiled like upstream's own fix-checks caller
 *  so the shared agent-launch census and behaviour suites cover it. */
export const HOSTED_REVIEW_FIX_CHECKS_CALLER_PROFILE: AgentLaunchCallerProfile = {
  id: 'hosted-review-fix-checks',
  caller: 'src/renderer/src/fork-hosted-review-sitter/fix-checks-agent-launch.ts',
  args: {
    agent: 'codex',
    worktreeId: 'wt-1',
    groupId: 'group-1',
    prompt: 'Explain the failing check and propose a fix.',
    agentArgs: '--model gpt-5.5',
    promptDelivery: 'submit-after-ready',
    launchPlatform: 'darwin',
    launchSource: 'task_page'
  }
}
